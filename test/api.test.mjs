import { once } from 'node:events';
import { createServer, get } from 'node:http';
import Module, { createRequire } from 'node:module';
import { text } from 'node:stream/consumers';
import { setImmediate } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';

const require = createRequire(import.meta.url);
const imageUrl = 'https://images.example/preview.jpg';
const cacheCheckTime = new Date('2025-01-01T00:00:00.000Z');
const getSubreddit = vi.fn();
const rawRequest = async () => {
    throw new Error('Unexpected network request');
};
const getTop = vi.fn();
const getHot = vi.fn();
const getNew = vi.fn();
const getRising = vi.fn();
const getControversial = vi.fn();
const about = vi.fn();
const subreddit = { fetch: about, getTop, getHot, getNew, getRising, getControversial };
const collection = {
    find: vi.fn(),
    countDocuments: vi.fn(),
    updateOne: vi.fn(),
};

const stubs = new Map([
    [require.resolve('../reddit'), { getSubreddit, rawRequest }],
    [require.resolve('../mongo'), { getDb: async () => ({ collection: () => collection }) }],
]);

function loadApp() {
    // The app uses CommonJS require(), which Vitest's ESM mocks do not intercept.
    const originalModules = new Map();
    for (const [path, exports] of stubs) {
        originalModules.set(path, require.cache[path]);
        require.cache[path] = Object.assign(new Module(path), { exports, loaded: true });
    }
    const loadEnv = vi.spyOn(require('dotenv'), 'config').mockReturnValue({});
    try {
        return require('../index');
    } finally {
        loadEnv.mockRestore();
        for (const [path, original] of originalModules) {
            if (original) {
                require.cache[path] = original;
            } else {
                delete require.cache[path];
            }
        }
    }
}

let server;
let origin;

beforeAll(async () => {
    server = createServer(loadApp());
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') {
        throw new Error('Expected a TCP address for the test server');
    }
    origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
    if (server?.listening) {
        await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve(undefined))));
    }
});

beforeEach(() => {
    vi.resetAllMocks();
    getSubreddit.mockReturnValue(subreddit);
    about.mockResolvedValue({});
    collection.countDocuments.mockResolvedValue(0);
    collection.updateOne.mockResolvedValue({});
});

afterEach(() => {
    vi.useRealTimers();
});

async function request(path) {
    const [response] = await once(get(`${origin}/api${path}`, { agent: false }), 'response');
    return { status: response.statusCode, headers: response.headers, body: await text(response) };
}

test('serves the Express API and validates a subreddit', async () => {
    const root = await request('/');
    expect(root.status).toBe(200);
    expect(root.body).toBe('Subreddit Subscriptions API');

    const response = await request('/valid/subreddit/example');
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({});
    expect(getSubreddit).toHaveBeenCalledWith('example');
    expect(about).toHaveBeenCalledOnce();
});

test('returns a public 404 for a missing subreddit', async () => {
    about.mockRejectedValue(Object.assign(new Error('Upstream response'), { statusCode: 404 }));
    const response = await request('/valid/subreddit/missing');
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body)).toEqual({ error: 'Subreddit not found' });
});

test.each(['/subreddit/example/invalid/day/1', '/subreddit/example/top/invalid/1'])(
    'rejects an invalid sort option at %s',
    async (path) => {
        const response = await request(path);
        expect(response.status).toBe(400);
        expect(JSON.parse(response.body)).toEqual({ error: 'Reddit request failed' });
        expect(getTop).not.toHaveBeenCalled();
        expect(collection.find).not.toHaveBeenCalled();
    },
);

test.each([
    ['hot', 'fixture_hot', getHot],
    ['new', 'fixture_new', getNew],
    ['top', 'fixture_top', getTop],
    ['rising', 'fixture_rising', getRising],
    ['controversial', 'fixture_controversial', getControversial],
])('dispatches the %s sort for %s with the selected time and limit', async (sort, name, getListing) => {
    const post = { id: 'text1', is_self: true };
    getListing.mockResolvedValue([post]);

    const response = await request(`/subreddit/${name}/${sort}/week/1`);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual([post]);
    expect(getSubreddit).toHaveBeenCalledExactlyOnceWith(name);
    expect(getListing).toHaveBeenCalledExactlyOnceWith({ time: 'week', limit: 1 });
    expect(getListing.mock.contexts[0]).toBe(subreddit);
    expect(collection.find).not.toHaveBeenCalled();
});

test('retries a short listing and saves extracted media for new posts', async () => {
    const textPost = { id: 'text1', is_self: true, title: 'Example text post' };
    const imagePost = {
        id: 'image1',
        title: 'Example image post',
        post_hint: 'image',
        preview: { images: [{ source: { url: imageUrl } }] },
    };
    getTop.mockResolvedValueOnce([textPost]).mockResolvedValueOnce([textPost, imagePost]);

    const response = await request('/subreddit/example/top/day/2');
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject([textPost, { id: imagePost.id, imageUrls: [imageUrl] }]);
    expect(getTop).toHaveBeenCalledTimes(2);
    expect(getTop).toHaveBeenCalledWith({ time: 'day', limit: 2 });
    expect(collection.updateOne).toHaveBeenCalledExactlyOnceWith(
        { id: imagePost.id },
        { $set: expect.objectContaining({ id: imagePost.id, imageUrls: [imageUrl] }) },
        { upsert: true },
    );
});

test('refreshes listing metrics while preserving fresh cached media and its timestamp', async () => {
    vi.useFakeTimers({ now: cacheCheckTime, toFake: ['Date'] });
    const lastUpdateTime = new Date('2024-12-31T23:00:00.000Z');
    const cachedPost = { id: 'image1', imageUrls: [imageUrl], score: 1, lastUpdateTime };
    getTop.mockResolvedValue([{ id: cachedPost.id, post_hint: 'image', score: 7 }]);
    collection.countDocuments.mockResolvedValue(1);
    collection.find.mockReturnValue({ next: async () => cachedPost });

    const response = await request('/subreddit/example/top/day/1');

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject([
        { id: cachedPost.id, score: 7, imageUrls: [imageUrl], lastUpdateTime: lastUpdateTime.toISOString() },
    ]);
    const query = { id: cachedPost.id };
    expect(collection.find).toHaveBeenCalledExactlyOnceWith(query);
    expect(collection.countDocuments).toHaveBeenCalledExactlyOnceWith(query);
    expect(collection.updateOne).toHaveBeenCalledExactlyOnceWith(
        query,
        { $set: expect.objectContaining({ score: 7, imageUrls: [imageUrl], lastUpdateTime }) },
        { upsert: true },
    );
});

test('refreshes stale cached media and writes a new cache timestamp', async () => {
    vi.useFakeTimers({ now: cacheCheckTime, toFake: ['Date'] });
    const lastUpdateTime = new Date('2024-12-29T00:00:00.000Z');
    const cached = { id: 'image1', imageUrls: ['https://images.example/old.jpg'], lastUpdateTime };
    const post = { id: cached.id, post_hint: 'image', thumbnail: imageUrl, score: 4 };
    getTop.mockResolvedValue([post]);
    collection.countDocuments.mockResolvedValue(1);
    collection.find.mockReturnValue({ next: async () => cached });

    const response = await request('/subreddit/example/top/day/1');

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject([
        { id: cached.id, imageUrls: [imageUrl], score: 4, lastUpdateTime: cacheCheckTime.toISOString() },
    ]);
    expect(collection.updateOne).toHaveBeenCalledExactlyOnceWith(
        { id: cached.id },
        { $set: expect.objectContaining({ imageUrls: [imageUrl], lastUpdateTime: cacheCheckTime }) },
        { upsert: true },
    );
});

test('preserves complete legacy gallery media and fills missing cache metadata', async () => {
    const cached = { id: 'gallery1', imageUrls: [imageUrl] };
    const post = {
        id: cached.id,
        is_gallery: true,
        gallery_data: { items: [{ media_id: 'first' }] },
        score: 9,
        fetch: vi.fn(),
    };
    getTop.mockResolvedValue([post]);
    collection.countDocuments.mockResolvedValue(1);
    collection.find.mockReturnValue({ next: async () => cached });

    const response = await request('/subreddit/example/top/day/1');

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject([
        { id: cached.id, imageUrls: [imageUrl], num_images: 1, score: 9, lastUpdateTime: expect.any(String) },
    ]);
    expect(post.fetch).not.toHaveBeenCalled();
    expect(collection.updateOne).toHaveBeenCalledExactlyOnceWith(
        { id: cached.id },
        { $set: expect.objectContaining({ imageUrls: [imageUrl], num_images: 1, lastUpdateTime: expect.any(Date) }) },
        { upsert: true },
    );
});

test('uses the cached gallery count to recover media when the listing lacks the gallery flag', async () => {
    const cached = { id: 'gallery1', imageUrls: [], num_images: 1, lastUpdateTime: new Date() };
    const fetch = vi.fn().mockResolvedValue({
        id: cached.id,
        gallery_data: { items: [{ media_id: 'first' }] },
        media_metadata: { first: { s: { u: imageUrl } } },
    });
    getTop.mockResolvedValue([{ id: cached.id, fetch }]);
    collection.countDocuments.mockResolvedValue(1);
    collection.find.mockReturnValue({ next: async () => cached });

    const response = await request('/subreddit/example/top/day/1');

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject([{ id: cached.id, imageUrls: [imageUrl], num_images: 1 }]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(collection.updateOne).toHaveBeenCalledExactlyOnceWith(
        { id: cached.id },
        { $set: expect.objectContaining({ imageUrls: [imageUrl], num_images: 1 }) },
        { upsert: true },
    );
});

test.each([
    { failure: { code: 'ETIMEDOUT' }, status: 504 },
    { failure: { code: 'ESOCKETTIMEDOUT' }, status: 504 },
    { failure: { name: 'TimeoutError' }, status: 504 },
    { failure: { cause: { code: 'ECONNRESET' } }, status: 502 },
    { failure: { response: { statusCode: 400 } }, status: 502 },
    { failure: { statusCode: 503 }, status: 502 },
])('returns a public $status for upstream failure $failure', async ({ failure, status }) => {
    about.mockRejectedValue(Object.assign(new Error('Synthetic upstream failure'), failure));

    const response = await request('/valid/subreddit/example');

    expect(response.status).toBe(status);
    expect(JSON.parse(response.body)).toEqual({ error: 'Reddit request failed' });
});

test('returns a retry interval when the scheduler rejects an overloaded request', async () => {
    const { RedditQueueOverloadError } = require('../redditRequestScheduler.js');
    about.mockRejectedValue(new RedditQueueOverloadError());

    const response = await request('/valid/subreddit/example');

    expect(response.status).toBe(503);
    expect(response.headers['retry-after']).toBe('5');
    expect(JSON.parse(response.body)).toEqual({ error: 'Reddit request failed' });
});

test('exposes the upstream cooldown and blocks new Reddit requests', async () => {
    const scheduler = require('../redditRequestSchedulerInstance');
    about.mockRejectedValue(
        Object.assign(new Error('Upstream quota exhausted'), {
            statusCode: 429,
            response: { headers: { 'Retry-After': '7' } },
        }),
    );
    try {
        for (const name of ['example', 'another']) {
            const response = await request(`/valid/subreddit/${name}`);
            expect(response.status).toBe(429);
            expect(response.headers['retry-after']).toBe('7');
            expect(response.headers['access-control-expose-headers']).toBe('Retry-After');
            expect(JSON.parse(response.body)).toEqual({ error: 'Reddit request failed' });
        }
        expect(about).toHaveBeenCalledOnce();
    } finally {
        scheduler.pausedUntil = 0;
    }
});

test('repairs missing gallery media from the submission detail', async () => {
    const gallery = {
        id: 'gallery1',
        is_gallery: true,
        gallery_data: { items: [{ media_id: 'first' }] },
        score: 7,
    };
    const fetch = vi.fn().mockResolvedValue({
        ...gallery,
        score: 3,
        media_metadata: { first: { s: { u: imageUrl } } },
    });
    getTop.mockResolvedValue([{ ...gallery, fetch }]);

    const response = await request('/subreddit/example/top/day/1');

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject([
        { id: gallery.id, score: 7, imageUrls: [imageUrl], num_images: 1 },
    ]);
    expect(fetch).toHaveBeenCalledOnce();
});

test('reports missing media after a detail fetch also returns an incomplete gallery', async () => {
    const gallery = { id: 'gallery1', is_gallery: true };
    const fetch = vi.fn().mockResolvedValue(gallery);
    getTop.mockResolvedValue([{ ...gallery, fetch }]);

    const response = await request('/subreddit/example/top/day/1');

    expect(response.status).toBe(502);
    expect(JSON.parse(response.body)).toEqual({ error: expect.stringContaining('Could not extract expected media') });
    expect(collection.updateOne).not.toHaveBeenCalled();
});

test('reports missing video when the detail has no usable embed metadata', async () => {
    const post = { id: 'video1', post_hint: 'hosted:video', url: 'https://videos.example/post' };
    const fetch = vi.fn().mockResolvedValue({ ...post, media: { reddit_video: {} } });
    getTop.mockResolvedValue([{ ...post, fetch }]);

    const response = await request('/subreddit/example/top/day/1');

    expect(response.status).toBe(502);
    expect(JSON.parse(response.body)).toEqual({ error: expect.stringContaining('has no video or embed metadata') });
    expect(collection.updateOne).not.toHaveBeenCalled();
});

test.each([
    { failure: new Error('Synthetic detail failure'), status: 502, message: 'Could not fetch expected media' },
    {
        failure: new Error('Synthetic detail timeout', { cause: { code: 'ESOCKETTIMEDOUT' } }),
        status: 504,
        message: 'Reddit request failed',
    },
])('reports $status when fetching missing media fails with $failure', async ({ failure, status, message }) => {
    const fetch = vi.fn().mockRejectedValue(failure);
    getTop.mockResolvedValue([{ id: 'image1', post_hint: 'image', url: imageUrl, fetch }]);

    const response = await request('/subreddit/example/top/day/1');

    expect(response.status).toBe(status);
    expect(JSON.parse(response.body)).toEqual({ error: expect.stringContaining(message) });
    expect(fetch).toHaveBeenCalledOnce();
    expect(collection.updateOne).not.toHaveBeenCalled();
});

test('rejects duplicate cache records without updating either record', async () => {
    const id = 'image1';
    const toArray = vi.fn().mockResolvedValue([{ id }, { id }]);
    getTop.mockResolvedValue([{ id }]);
    collection.countDocuments.mockResolvedValue(2);
    collection.find.mockReturnValue({ toArray });

    const response = await request('/subreddit/example/top/day/1');

    expect(response.status).toBe(500);
    expect(JSON.parse(response.body)).toEqual({ error: 'Reddit request failed' });
    expect(toArray).toHaveBeenCalledOnce();
    expect(collection.updateOne).not.toHaveBeenCalled();
});

test('skips media fetches and cache writes when the client disconnects during a cache lookup', async () => {
    const lookupStarted = Promise.withResolvers();
    const lookup = Promise.withResolvers();
    const responseClosed = Promise.withResolvers();
    const fetch = vi.fn();
    getTop.mockResolvedValue([{ id: 'image1', post_hint: 'image', fetch }]);
    collection.countDocuments.mockImplementation(() => {
        lookupStarted.resolve(undefined);
        return lookup.promise;
    });
    server.once('request', (_request, response) => {
        response.once('close', () => responseClosed.resolve(undefined));
    });

    const client = get(`${origin}/api/subreddit/example/top/day/1`, { agent: false });
    const clientError = once(client, 'error');
    try {
        await lookupStarted.promise;
        client.destroy();
        await Promise.all([clientError, responseClosed.promise]);
    } finally {
        client.destroy();
        lookup.resolve(0);
    }

    // Let the handler resume after the cache lookup resolves.
    await setImmediate();
    expect(fetch).not.toHaveBeenCalled();
    expect(collection.updateOne).not.toHaveBeenCalled();
});

test('returns the longest listing when the retry budget runs out', async () => {
    const posts = [
        { id: 'text1', is_self: true },
        { id: 'text2', is_self: true },
    ];
    getTop.mockResolvedValueOnce(posts).mockResolvedValue(posts.slice(0, 1));

    const response = await request('/subreddit/example/top/day/3');

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual(posts);
    expect(getTop).toHaveBeenCalledTimes(5);
});

test('returns 500 when a post cache write fails', async () => {
    getTop.mockResolvedValue([{ id: 'post1' }]);
    collection.updateOne.mockRejectedValue(new Error('Fixture write failed'));

    const response = await request('/subreddit/example/top/day/1');

    expect(response.status).toBe(500);
    expect(JSON.parse(response.body)).toEqual({ error: 'Reddit request failed' });
});
