import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { afterEach, test, vi } from 'vitest';
import snoowrap from 'snoowrap';

const require = createRequire(import.meta.url);
/** @type {typeof import('../redditRequestScheduler.js')} */
const scheduler = require('../redditRequestScheduler.js');

const { RedditRequestScheduler, RedditRateLimitError, RedditQueueOverloadError, RedditRequestAbortedError } = scheduler;

afterEach(() => {
    vi.useRealTimers();
});

/** @param {(options: { timeout?: number }) => Promise<unknown>} [rawRequest] */
function createRequester(rawRequest = async () => ({})) {
    return {
        ratelimitExpiration: /** @type {number | null} */ (null),
        rawRequest,
    };
}

test('runs queued operations FIFO and spaces outbound requests', async () => {
    vi.useFakeTimers();
    const startTime = Date.now();
    const starts = [];
    const requester = createRequester(async ({ timeout }) => {
        starts.push({ elapsed: Date.now() - startTime, timeout });
        return {};
    });
    const scheduler = new RedditRequestScheduler(requester, { minRequestIntervalMs: 20 });
    const order = [];
    const { signal } = new AbortController();

    const completed = Promise.all(
        ['first', 'second', 'third'].map((name, index) =>
            scheduler.execute(
                async () => {
                    order.push(name);
                    await requester.rawRequest(index === 1 ? { timeout: 100 } : {});
                },
                { signal },
            ),
        ),
    );
    await vi.advanceTimersByTimeAsync(40);
    await completed;

    assert.deepEqual(order, ['first', 'second', 'third']);
    assert.deepEqual(starts, [
        { elapsed: 0, timeout: 30000 },
        { elapsed: 20, timeout: 100 },
        { elapsed: 40, timeout: 30000 },
    ]);
});

test('a local Snoowrap rate-limit error pauses and rejects queued work', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const requester = createRequester();
    requester.ratelimitExpiration = Date.now() + 10000;
    const scheduler = new RedditRequestScheduler(requester);
    const first = scheduler.execute(() => Promise.reject(new snoowrap.errors.RateLimitError()));
    const second = scheduler.execute(() => Promise.resolve('should not run'));

    await assert.rejects(
        first,
        (error) => error instanceof RedditRateLimitError && error.statusCode === 429 && error.retryAfterSeconds === 10,
    );
    await assert.rejects(second, (error) => error instanceof RedditRateLimitError && error.statusCode === 429);
    await assert.rejects(
        scheduler.execute(() => Promise.resolve('blocked')),
        (error) => error instanceof RedditRateLimitError && error.statusCode === 429,
    );
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

    await assert.rejects(
        Promise.resolve(/** @type {PromiseLike<unknown>} */ (requester.getSubreddit('example').fetch())),
        (error) => {
            assert.ok(error instanceof snoowrap.errors.RateLimitError);
            return true;
        },
    );
});

test('translates Snoowrap local quota exhaustion into a server cooldown error', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
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

    await assert.rejects(
        scheduler.execute(() => requester.getSubreddit('example').fetch()),
        (error) => {
            assert.ok(error instanceof RedditRateLimitError);
            assert.equal(error.statusCode, 429);
            assert.equal(error.retryAfterSeconds, 10);
            return true;
        },
    );
});

test.each([
    {
        name: 'a numeric header takes precedence over the quota reset',
        headers: { 'retry-after': '7' },
        statusCode: 429,
        resetInSeconds: 10,
        seconds: 7,
    },
    { name: 'future HTTP date', headers: { 'Retry-After': 'Wed, 01 Jan 2025 00:00:07 GMT' }, seconds: 7 },
    { name: 'fractional seconds rounded up', headers: { 'Retry-After': '1.25' }, seconds: 2 },
    { name: 'past HTTP date', headers: { 'Retry-After': 'Tue, 31 Dec 2024 23:59:59 GMT' }, seconds: 60 },
    { name: 'invalid header', headers: { 'Retry-After': 'invalid' }, seconds: 60 },
    {
        name: 'missing header with a quota reset',
        headers: { 'Content-Type': 'application/json' },
        resetInSeconds: 10,
        seconds: 10,
    },
    { name: 'missing header without a quota reset', headers: { 'Content-Type': 'application/json' }, seconds: 60 },
])('applies a $seconds-second cooldown for $name', async ({ headers, statusCode, resetInSeconds, seconds }) => {
    vi.useFakeTimers({ now: new Date('2025-01-01T00:00:00.000Z') });
    const requester = createRequester();
    if (resetInSeconds !== undefined) {
        requester.ratelimitExpiration = Date.now() + resetInSeconds * 1000;
    }
    const scheduler = new RedditRequestScheduler(requester);
    const upstreamError = Object.assign(new Error('Too many requests'), {
        statusCode,
        response: { statusCode: statusCode === undefined ? 429 : undefined, headers },
    });

    await assert.rejects(
        scheduler.execute(() => Promise.reject(upstreamError)),
        (error) => error instanceof RedditRateLimitError && error.retryAfterSeconds === seconds,
    );

    await vi.advanceTimersByTimeAsync(seconds * 1000 - 1);
    await assert.rejects(requester.rawRequest({}), (error) => error instanceof RedditRateLimitError);
    await vi.advanceTimersByTimeAsync(1);
    assert.deepEqual(await scheduler.execute(() => requester.rawRequest({})), {});
});

test('rejects new work when the pending queue is full', async () => {
    const inFlight = Promise.withResolvers();
    const scheduler = new RedditRequestScheduler(createRequester(), { maxPendingRequests: 1 });
    const active = scheduler.execute(() => inFlight.promise);
    const pending = scheduler.execute(() => Promise.resolve('second'));

    await assert.rejects(
        scheduler.execute(() => Promise.resolve('overflow')),
        (error) => {
            assert.ok(error instanceof RedditQueueOverloadError);
            assert.equal(error.statusCode, 503);
            return true;
        },
    );

    inFlight.resolve('done');
    assert.equal(await active, 'done');
    assert.equal(await pending, 'second');
});

test('expires queued work that waits too long and removes it from the queue', async () => {
    vi.useFakeTimers();
    const inFlight = Promise.withResolvers();
    const scheduler = new RedditRequestScheduler(createRequester(), { maxQueueWaitMs: 20 });
    const active = scheduler.execute(() => inFlight.promise);
    const pending = scheduler.execute(() => Promise.resolve('expired'));
    const rejected = assert.rejects(pending, (error) => error instanceof RedditQueueOverloadError);

    await vi.advanceTimersByTimeAsync(19);
    assert.equal(scheduler.pending.length, 1);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    inFlight.resolve('done');
    assert.equal(await active, 'done');
    assert.equal(scheduler.pending.length, 0);
});

test('drops queued work for the failed request while preserving other requests', async () => {
    const inFlight = Promise.withResolvers();
    const scheduler = new RedditRequestScheduler(createRequester());
    const { signal } = new AbortController();
    const failed = scheduler.execute(() => inFlight.promise, { signal });
    const siblingOperation = vi.fn();
    const sibling = scheduler.execute(siblingOperation, { signal });
    const other = scheduler.execute(() => 'unrelated');
    const error = new Error('Synthetic upstream failure');
    const rejected = Promise.all([assert.rejects(failed, error), assert.rejects(sibling, error)]);

    inFlight.reject(error);

    await rejected;
    assert.equal(await other, 'unrelated');
    assert.equal(siblingOperation.mock.calls.length, 0);
});

test('preserves a rejection without a reason', async () => {
    const scheduler = new RedditRequestScheduler(createRequester());

    await assert.rejects(
        scheduler.execute(() => Promise.reject(undefined)),
        (reason) => reason === undefined,
    );
});

test('refuses work when the signal is already aborted', async () => {
    const operation = vi.fn();
    const scheduler = new RedditRequestScheduler(createRequester());

    await assert.rejects(scheduler.execute(operation, { signal: AbortSignal.abort() }), RedditRequestAbortedError);
    assert.equal(operation.mock.calls.length, 0);
});

test('does not run an operation aborted just before it starts', async () => {
    const operation = vi.fn();
    const scheduler = new RedditRequestScheduler(createRequester());
    const controller = new AbortController();
    const job = scheduler.execute(operation, { signal: controller.signal });
    controller.abort();

    await assert.rejects(job, RedditRequestAbortedError);
    assert.equal(await scheduler.execute(() => 'next'), 'next');
    assert.equal(operation.mock.calls.length, 0);
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
    const dispatched = Promise.withResolvers();
    const inFlight = Promise.withResolvers();
    const scheduler = new RedditRequestScheduler(createRequester());
    const controller = new AbortController();
    let nextStarted = false;
    const active = scheduler.execute(
        () => {
            dispatched.resolve(undefined);
            return inFlight.promise;
        },
        { signal: controller.signal },
    );
    const next = scheduler.execute(() => {
        nextStarted = true;
        return 'next';
    });

    await dispatched.promise;
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

test('cancels a transport call that is waiting for the request spacing interval', async () => {
    vi.useFakeTimers();
    const transport = vi.fn().mockResolvedValue({});
    const requester = createRequester(transport);
    const scheduler = new RedditRequestScheduler(requester, { minRequestIntervalMs: 100 });
    const controller = new AbortController();

    await requester.rawRequest({});
    const job = scheduler.execute(() => requester.rawRequest({}), { signal: controller.signal });
    const rejected = assert.rejects(job, RedditRequestAbortedError);
    await vi.advanceTimersByTimeAsync(20);
    assert.equal(vi.getTimerCount(), 1);
    controller.abort();
    await rejected;
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(vi.getTimerCount(), 0);
    await vi.advanceTimersByTimeAsync(100);

    assert.equal(transport.mock.calls.length, 1);
    assert.equal(await scheduler.execute(() => 'next'), 'next');
});

test('blocks further transport calls from an aborted in-flight operation', async () => {
    const transport = vi.fn().mockResolvedValue({});
    const requester = createRequester(transport);
    const scheduler = new RedditRequestScheduler(requester);
    const controller = new AbortController();
    const dispatched = Promise.withResolvers();
    const continueOperation = Promise.withResolvers();
    const transportResult = Promise.withResolvers();
    const job = scheduler.execute(
        async () => {
            dispatched.resolve(undefined);
            await continueOperation.promise;
            const request = requester.rawRequest({});
            transportResult.resolve(request);
            await request;
        },
        { signal: controller.signal },
    );
    const rejected = assert.rejects(job, RedditRequestAbortedError);

    await dispatched.promise;
    controller.abort();
    await rejected;
    const blocked = assert.rejects(transportResult.promise, RedditRequestAbortedError);
    continueOperation.resolve(undefined);

    await blocked;
    assert.equal(transport.mock.calls.length, 0);
    assert.equal(await scheduler.execute(() => 'next'), 'next');
});
