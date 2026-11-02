const snoowrap = require('snoowrap');

const MIN_REQUEST_INTERVAL_MS = 1001;
const MAX_PENDING_REQUESTS = 50;
const MAX_QUEUE_WAIT_MS = 20000;
const OVERLOAD_RETRY_AFTER_SECONDS = 5;
const DEFAULT_RATE_LIMIT_RETRY_AFTER_SECONDS = 60;

class RedditRateLimitError extends Error {
    constructor(retryAfterSeconds, cause) {
        super('Reddit rate limit reached');
        this.name = 'RedditRateLimitError';
        this.statusCode = 429;
        this.retryAfterSeconds = retryAfterSeconds;
        this.cause = cause;
    }
}

class RedditQueueOverloadError extends Error {
    constructor() {
        super('Reddit request queue is busy');
        this.name = 'RedditQueueOverloadError';
        this.statusCode = 503;
        this.retryAfterSeconds = OVERLOAD_RETRY_AFTER_SECONDS;
    }
}

class RedditRequestAbortedError extends Error {
    constructor() {
        super('Reddit request was cancelled');
        this.name = 'RedditRequestAbortedError';
        this.code = 'ABORT_ERR';
    }
}

function getRetryAfterHeader(error) {
    const headers = error && error.response && error.response.headers;
    if (!headers || typeof headers !== 'object') {
        return null;
    }

    const headerName = Object.keys(headers).find((name) => name.toLowerCase() === 'retry-after');
    return headerName ? headers[headerName] : null;
}

function parseRetryAfter(value, now = Date.now()) {
    if (typeof value !== 'string' && typeof value !== 'number') {
        return null;
    }

    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds > 0) {
        return Math.max(1, Math.ceil(seconds));
    }

    const retryAt = Date.parse(value);
    if (!Number.isNaN(retryAt) && retryAt > now) {
        return Math.max(1, Math.ceil((retryAt - now) / 1000));
    }

    return null;
}

function isRateLimitError(error) {
    return error instanceof RedditRateLimitError
        || error instanceof snoowrap.errors.RateLimitError
        || (error && (error.statusCode === 429
            || (error.response && error.response.statusCode === 429)));
}

function createAbortError() {
    return new RedditRequestAbortedError();
}

function delay(milliseconds, signal) {
    if (milliseconds <= 0) {
        return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            resolve();
        }, milliseconds);

        const onAbort = () => {
            clearTimeout(timer);
            cleanup();
            reject(createAbortError());
        };

        const cleanup = () => {
            if (signal) {
                signal.removeEventListener('abort', onAbort);
            }
        };

        if (signal) {
            if (signal.aborted) {
                onAbort();
            } else {
                signal.addEventListener('abort', onAbort, { once: true });
            }
        }
    });
}

class RedditRequestScheduler {
    constructor(redditRequester, options = {}) {
        this.reddit = redditRequester;
        this.minRequestIntervalMs = options.minRequestIntervalMs ?? MIN_REQUEST_INTERVAL_MS;
        this.maxPendingRequests = options.maxPendingRequests ?? MAX_PENDING_REQUESTS;
        this.maxQueueWaitMs = options.maxQueueWaitMs ?? MAX_QUEUE_WAIT_MS;
        this.pending = [];
        this.activeJob = null;
        this.nextRequestAt = 0;
        this.pausedUntil = 0;

        const rawRequest = this.reddit.rawRequest.bind(this.reddit);
        this.reddit.rawRequest = (requestOptions) => this.beforeRedditRequest()
            .then(() => rawRequest({
                ...requestOptions,
                timeout: requestOptions.timeout ?? 30000,
            }));
    }

    execute(operation, options = {}) {
        const { signal } = options;
        const cooldownError = this.getCooldownError();
        if (cooldownError) {
            return Promise.reject(cooldownError);
        }
        if (signal && signal.aborted) {
            return Promise.reject(createAbortError());
        }
        if (this.pending.length >= this.maxPendingRequests) {
            const overloadError = new RedditQueueOverloadError();
            this.rejectPendingForSignal(signal, overloadError);
            return Promise.reject(overloadError);
        }

        return new Promise((resolve, reject) => {
            const job = {
                operation,
                signal,
                resolve,
                reject,
                started: false,
                settled: false,
                expirationTimer: null,
                abortHandler: null,
            };

            if (signal) {
                job.abortHandler = () => this.abortJob(job);
                signal.addEventListener('abort', job.abortHandler, { once: true });
            }

            job.expirationTimer = setTimeout(() => {
                this.expireJob(job);
            }, this.maxQueueWaitMs);

            this.pending.push(job);
            this.processNext();
        });
    }

    async beforeRedditRequest() {
        const cooldownError = this.getCooldownError();
        if (cooldownError) {
            throw cooldownError;
        }
        const signal = this.activeJob && this.activeJob.signal;
        if (signal && signal.aborted) {
            throw createAbortError();
        }

        const now = Date.now();
        const startAt = Math.max(now, this.nextRequestAt);
        this.nextRequestAt = startAt + this.minRequestIntervalMs;
        await delay(startAt - now, signal);

        const pendingCooldown = this.getCooldownError();
        if (pendingCooldown) {
            throw pendingCooldown;
        }
        if (signal && signal.aborted) {
            throw createAbortError();
        }
    }

    processNext() {
        if (this.activeJob) {
            return;
        }

        while (this.pending.length > 0) {
            const nextJob = this.pending.shift();
            if (nextJob.settled) {
                continue;
            }

            if (nextJob.signal && nextJob.signal.aborted) {
                this.settle(nextJob, createAbortError());
                continue;
            }

            const cooldownError = this.getCooldownError();
            if (cooldownError) {
                this.settle(nextJob, cooldownError);
                continue;
            }

            this.startJob(nextJob);
            return;
        }
    }

    startJob(job) {
        this.activeJob = job;
        job.started = true;
        clearTimeout(job.expirationTimer);

        Promise.resolve()
            .then(() => {
                if (job.signal && job.signal.aborted) {
                    throw createAbortError();
                }
                return job.operation();
            })
            .then((result) => this.settle(job, null, result))
            .catch((error) => {
                if (isRateLimitError(error)) {
                    const rateLimitError = this.startCooldown(error);
                    this.rejectPending(rateLimitError);
                    this.settle(job, rateLimitError);
                    return;
                }
                this.rejectPendingForSignal(job.signal, error);
                this.settle(job, error);
            })
            .finally(() => {
                this.activeJob = null;
                this.processNext();
            });
    }

    startCooldown(cause) {
        const now = Date.now();
        const headerDelay = parseRetryAfter(getRetryAfterHeader(cause), now);
        const resetDelay = this.reddit.ratelimitExpiration > now
            ? Math.ceil((this.reddit.ratelimitExpiration - now) / 1000)
            : null;
        const retryAfterSeconds = headerDelay
            || resetDelay
            || DEFAULT_RATE_LIMIT_RETRY_AFTER_SECONDS;

        this.pausedUntil = Math.max(this.pausedUntil, now + retryAfterSeconds * 1000);
        return new RedditRateLimitError(
            Math.max(1, Math.ceil((this.pausedUntil - now) / 1000)),
            cause,
        );
    }

    getCooldownError() {
        const remainingMs = this.pausedUntil - Date.now();
        if (remainingMs <= 0) {
            return null;
        }
        return new RedditRateLimitError(Math.max(1, Math.ceil(remainingMs / 1000)));
    }

    rejectPending(error) {
        const pendingJobs = this.pending.splice(0);
        pendingJobs.forEach((job) => this.settle(job, error));
    }

    rejectPendingForSignal(signal, error) {
        if (!signal) {
            return;
        }

        const retainedJobs = [];
        this.pending.forEach((job) => {
            if (job.signal === signal) {
                this.settle(job, error);
            } else {
                retainedJobs.push(job);
            }
        });
        this.pending = retainedJobs;
    }

    expireJob(job) {
        if (job.settled || job.started) {
            return;
        }

        const index = this.pending.indexOf(job);
        if (index !== -1) {
            this.pending.splice(index, 1);
        }
        const overloadError = new RedditQueueOverloadError();
        this.rejectPendingForSignal(job.signal, overloadError);
        this.settle(job, overloadError);
        this.processNext();
    }

    abortJob(job) {
        if (job.settled) {
            return;
        }

        if (!job.started) {
            const index = this.pending.indexOf(job);
            if (index !== -1) {
                this.pending.splice(index, 1);
            }
        }

        // A dispatched request cannot be cancelled through Snoowrap, but the
        // route can stop waiting for it while the scheduler stays single-flight.
        this.settle(job, createAbortError());
        this.processNext();
    }

    settle(job, error, result) {
        if (job.settled) {
            return;
        }
        job.settled = true;
        clearTimeout(job.expirationTimer);
        if (job.signal && job.abortHandler) {
            job.signal.removeEventListener('abort', job.abortHandler);
        }
        if (error) {
            job.reject(error);
        } else {
            job.resolve(result);
        }
    }
}

module.exports = {
    RedditRequestScheduler,
    RedditRateLimitError,
    RedditQueueOverloadError,
    RedditRequestAbortedError,
};
