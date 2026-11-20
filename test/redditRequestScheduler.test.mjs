import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'vitest';
import snoowrap from 'snoowrap';

const require = createRequire(import.meta.url);
/** @type {typeof import('../redditRequestScheduler.js')} */
const scheduler = require('../redditRequestScheduler.js');

const {
    RedditRequestScheduler,
    RedditRateLimitError,
    RedditQueueOverloadError,
    RedditRequestAbortedError,
} = scheduler;

/** @param {(options: { timeout?: number }) => Promise<unknown>} [rawRequest] */
function createRequester(rawRequest = async () => ({})) {
    return {
        ratelimitExpiration: /** @type {number | null} */ (null),
        rawRequest,
    };
}

test('runs queued operations FIFO and spaces outbound requests', async () => {
    const starts = [];
    const requester = createRequester(async () => {
        starts.push(Date.now());
        return {};
    });
    const scheduler = new RedditRequestScheduler(requester, { minRequestIntervalMs: 20 });
    const order = [];

    await Promise.all(['first', 'second', 'third'].map((name) => scheduler.execute(async () => {
        order.push(name);
        await requester.rawRequest({});
    })));

    assert.deepEqual(order, ['first', 'second', 'third']);
    assert.equal(starts.length, 3);
    assert.ok(starts[1] - starts[0] >= 15);
    assert.ok(starts[2] - starts[1] >= 15);
});

test('a local Snoowrap rate-limit error pauses and rejects queued work', async () => {
    const requester = createRequester();
    requester.ratelimitExpiration = Date.now() + 10000;
    const scheduler = new RedditRequestScheduler(requester);
    const first = scheduler.execute(() => Promise.reject(new snoowrap.errors.RateLimitError()));
    const second = scheduler.execute(() => Promise.resolve('should not run'));

    await assert.rejects(first, (error) => error instanceof RedditRateLimitError
        && error.statusCode === 429
        && error.retryAfterSeconds >= 1);
    await assert.rejects(second, (error) => error instanceof RedditRateLimitError && error.statusCode === 429);
    await assert.rejects(scheduler.execute(() => Promise.resolve('blocked')), (error) => error instanceof RedditRateLimitError && error.statusCode === 429);
});

test('Snoowrap preserves its local RateLimitError when automatic retries are disabled', async () => {
    const requester = new snoowrap({
        userAgent: 'scheduler test',
        clientId: 'placeholder',
        clientSecret: 'placeholder',
        refreshToken: 'placeholder',
    });
    requester.config({ requestDelay: 0, maxRetryAttempts: 1 });
    requester.rawRequest = async () => {
        throw new Error('Unexpected network request');
    };
    requester.ratelimitRemaining = 0;
    requester.ratelimitExpiration = Date.now() + 10000;

    await assert.rejects(Promise.resolve(/** @type {PromiseLike<unknown>} */ (requester.getSubreddit('example').fetch())), (error) => {
        assert.ok(error instanceof snoowrap.errors.RateLimitError);
        return true;
    });
});

test('translates Snoowrap local quota exhaustion into a server cooldown error', async () => {
    const requester = new snoowrap({
        userAgent: 'scheduler test',
        clientId: 'placeholder',
        clientSecret: 'placeholder',
        refreshToken: 'placeholder',
    });
    requester.config({ requestDelay: 0, maxRetryAttempts: 1 });
    requester.rawRequest = async () => {
        throw new Error('Unexpected network request');
    };
    requester.ratelimitRemaining = 0;
    requester.ratelimitExpiration = Date.now() + 10000;
    const scheduler = new RedditRequestScheduler(requester);

    await assert.rejects(scheduler.execute(() => requester.getSubreddit('example').fetch()), (error) => {
        assert.ok(error instanceof RedditRateLimitError);
        assert.equal(error.statusCode, 429);
        assert.ok(error.retryAfterSeconds >= 1);
        return true;
    });
});

test('uses an upstream Retry-After header for cooldown duration', async () => {
    const scheduler = new RedditRequestScheduler(createRequester());
    const upstreamError = Object.assign(new Error('Too many requests'), {
        statusCode: 429,
        response: { headers: { 'retry-after': '7' } },
    });

    await assert.rejects(scheduler.execute(() => Promise.reject(upstreamError)), (error) => {
        assert.ok(error instanceof RedditRateLimitError);
        assert.equal(error.retryAfterSeconds, 7);
        return true;
    });
});

test('rejects new work when the pending queue is full', async () => {
    const inFlight = Promise.withResolvers();
    const scheduler = new RedditRequestScheduler(createRequester(), { maxPendingRequests: 1 });
    const active = scheduler.execute(() => inFlight.promise);
    const pending = scheduler.execute(() => Promise.resolve('second'));

    await assert.rejects(scheduler.execute(() => Promise.resolve('overflow')), (error) => {
        assert.ok(error instanceof RedditQueueOverloadError);
        assert.equal(error.statusCode, 503);
        return true;
    });

    inFlight.resolve('done');
    assert.equal(await active, 'done');
    assert.equal(await pending, 'second');
});

test('expires queued work that waits too long and removes it from the queue', async () => {
    const inFlight = Promise.withResolvers();
    const scheduler = new RedditRequestScheduler(createRequester(), { maxQueueWaitMs: 20 });
    const active = scheduler.execute(() => inFlight.promise);
    const pending = scheduler.execute(() => Promise.resolve('expired'));

    await assert.rejects(pending, (error) => error instanceof RedditQueueOverloadError);
    inFlight.resolve('done');
    assert.equal(await active, 'done');
    assert.equal(scheduler.pending.length, 0);
});

test('removes queued work when its request is aborted', async () => {
    const inFlight = Promise.withResolvers();
    const scheduler = new RedditRequestScheduler(createRequester());
    const active = scheduler.execute(() => inFlight.promise);
    const controller = new AbortController();
    const pending = scheduler.execute(() => Promise.resolve('cancelled'), { signal: controller.signal });
    controller.abort();

    await assert.rejects(pending, (error) => error instanceof RedditRequestAbortedError);
    inFlight.resolve('done');
    assert.equal(await active, 'done');
    assert.equal(scheduler.pending.length, 0);
});

test('does not dispatch another operation until an aborted in-flight call settles', async () => {
    const inFlight = Promise.withResolvers();
    const scheduler = new RedditRequestScheduler(createRequester());
    const controller = new AbortController();
    let nextStarted = false;
    const active = scheduler.execute(() => inFlight.promise, { signal: controller.signal });
    const next = scheduler.execute(() => {
        nextStarted = true;
        return 'next';
    });

    controller.abort();
    await assert.rejects(active, (error) => error instanceof RedditRequestAbortedError);
    assert.equal(scheduler.activeJob !== null, true);
    assert.equal(nextStarted, false);

    inFlight.resolve('ignored');
    assert.equal(await next, 'next');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(nextStarted, true);
    assert.equal(scheduler.activeJob, null);
});
