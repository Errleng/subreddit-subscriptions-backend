import { once } from 'node:events';
import { createServer, get } from 'node:http';
import Module, { createRequire } from 'node:module';
import { text } from 'node:stream/consumers';
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';

const require = createRequire(import.meta.url);
const imageUrl = 'https://images.example/preview.jpg';
const getSubreddit = vi.fn();
const rawRequest = async () => {
    throw new Error('Unexpected network request');
};
const getTop = vi.fn();
const about = vi.fn();
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
    getSubreddit.mockReturnValue({ fetch: about, getTop });
    about.mockResolvedValue({});
    collection.countDocuments.mockResolvedValue(0);
    collection.updateOne.mockResolvedValue({});
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

test('uses cached media and refreshes metrics from the listing', async () => {
    const cachedPost = { id: 'image1', imageUrls: [imageUrl], score: 1, lastUpdateTime: new Date() };
    getTop.mockResolvedValue([{ id: cachedPost.id, post_hint: 'image', score: 7 }]);
    collection.countDocuments.mockResolvedValue(1);
    collection.find.mockReturnValue({ next: async () => cachedPost });

    const response = await request('/subreddit/example/top/day/1');
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject([{ id: cachedPost.id, score: 7, imageUrls: [imageUrl] }]);
    expect(collection.updateOne).toHaveBeenCalledExactlyOnceWith(
        { id: cachedPost.id },
        { $set: expect.objectContaining({ score: 7, imageUrls: [imageUrl] }) },
        { upsert: true },
    );
});

test('returns a public 504 when the upstream request times out', async () => {
    about.mockRejectedValue(Object.assign(new Error('Upstream timed out'), { code: 'ETIMEDOUT' }));
    const response = await request('/valid/subreddit/example');
    expect(response.status).toBe(504);
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
