const express = require('express');

const router = express.Router();
const reddit = require('../reddit');
const redditRequestScheduler = require('../redditRequestSchedulerInstance');
const config = require('../config');
const db = require('../mongo');
const {
    hasProp,
    isGallerySubmission,
    getExpectedMediaError,
    extractSubmissionMedia,
    cachedMediaSatisfiesExpectedType,
    mergeMediaWithCache,
} = require('./submissionMedia');

const MAX_ATTEMPTS = 4;
const SORT_TIMES = /** @type {const} */ (['hour', 'day', 'week', 'month', 'year', 'all']);

class SubmissionMediaError extends Error {}

/**
 * Express 4 expects a synchronous handler and does not forward rejected promises.
 * @param {(req: import('express').Request, res: import('express').Response) => Promise<void>} handler
 * @returns {import('express').RequestHandler}
 */
function handleAsync(handler) {
    return (req, res, next) => {
        handler(req, res).catch(next);
    };
}

function createRequestAbortController(req, res) {
    const controller = new AbortController();
    const abortIfDisconnected = () => {
        if (!res.writableEnded) {
            controller.abort();
        }
    };

    req.on('aborted', abortIfDisconnected);
    res.on('close', abortIfDisconnected);

    return {
        signal: controller.signal,
        cleanup: () => {
            req.off('aborted', abortIfDisconnected);
            res.off('close', abortIfDisconnected);
        },
    };
}

function getErrorStatus(error) {
    if (error instanceof redditRequestScheduler.RedditRateLimitError) {
        return 429;
    }
    if (error instanceof redditRequestScheduler.RedditQueueOverloadError) {
        return 503;
    }
    if (error instanceof SubmissionMediaError) {
        return 502;
    }
    const errorCode = error.code || (error.cause && error.cause.code);
    if (errorCode === 'ETIMEDOUT' || errorCode === 'ESOCKETTIMEDOUT' || error.name === 'TimeoutError') {
        return 504;
    }

    const upstreamStatus = Number(error.statusCode || (error.response && error.response.statusCode));
    if (upstreamStatus === 404) {
        return upstreamStatus;
    }
    if (upstreamStatus >= 400) {
        // Preserve the route's own invalid-parameter response, but report
        // failures returned by Reddit as a bad gateway.
        if (upstreamStatus === 400 && !error.response) {
            return 400;
        }
        return 502;
    }
    if (errorCode && ['ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND'].includes(errorCode)) {
        return 502;
    }
    return 500;
}

function sendRouteError(res, error) {
    if (res.destroyed || res.headersSent) {
        return;
    }

    const status = getErrorStatus(error);
    if (status === 429 || status === 503) {
        const retryAfterSeconds = Number.isFinite(error.retryAfterSeconds)
            ? Math.max(1, Math.ceil(error.retryAfterSeconds))
            : 5;
        res.set('Retry-After', String(retryAfterSeconds));
    }

    if (status >= 500) {
        console.error('Reddit route failed:', error.message);
    }

    const message =
        error instanceof SubmissionMediaError
            ? error.message
            : status === 404
              ? 'Subreddit not found'
              : 'Reddit request failed';
    res.status(status).send({ error: message });
}

function throwIfRequestAborted(signal) {
    if (signal && signal.aborted) {
        throw new redditRequestScheduler.RedditRequestAbortedError();
    }
}

router.get('/', (_req, res) => {
    res.send('Subreddit Subscriptions API');
});

router.get(
    '/valid/subreddit/:subredditName',
    handleAsync(async (req, res) => {
        const request = createRequestAbortController(req, res);
        try {
            await redditRequestScheduler.execute(() => reddit.getSubreddit(req.params.subredditName).fetch(), {
                signal: request.signal,
            });
            if (!request.signal.aborted) {
                res.status(200).send({});
            }
        } catch (error) {
            if (!request.signal.aborted) {
                sendRouteError(res, error);
            }
        } finally {
            request.cleanup();
        }
    }),
);

/**
 * @param {{ num_images?: number } | null} cachedSubmission
 */
async function updateSubmissionMedia(submission, cachedSubmission = null, signal) {
    const startTime = performance.now();
    const galleryExpected =
        isGallerySubmission(submission) ||
        (cachedSubmission !== null &&
            Number.isInteger(cachedSubmission.num_images) &&
            (cachedSubmission.num_images ?? 0) > 0);
    let sourceSubmission = submission;
    let mediaData;
    let extractionError = null;

    try {
        mediaData = extractSubmissionMedia(sourceSubmission, galleryExpected);
    } catch (error) {
        extractionError = error;
        mediaData = { imageUrls: [], mediaVideo: null, mediaHtml: null, num_images: 0 };
    }

    let expectedMediaError =
        extractionError || getExpectedMediaError(submission, sourceSubmission, mediaData, galleryExpected);
    if (expectedMediaError && !cachedMediaSatisfiesExpectedType(submission, cachedSubmission)) {
        try {
            sourceSubmission = await redditRequestScheduler.execute(() => submission.fetch(), { signal });
        } catch (error) {
            if (
                error instanceof redditRequestScheduler.RedditRateLimitError ||
                error instanceof redditRequestScheduler.RedditQueueOverloadError ||
                error.code === 'ETIMEDOUT' ||
                error.code === 'ESOCKETTIMEDOUT' ||
                (error.cause && ['ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(error.cause.code)) ||
                error.name === 'TimeoutError' ||
                (signal && signal.aborted)
            ) {
                throw error;
            }
            throw new SubmissionMediaError(
                `Could not fetch expected media for submission ${submission.id} (${submission.url})`,
            );
        }

        try {
            mediaData = extractSubmissionMedia(sourceSubmission, galleryExpected);
        } catch (error) {
            throw new SubmissionMediaError(
                `Could not extract expected media for submission ${submission.id} (${submission.url}): ${error.message}`,
            );
        }

        expectedMediaError = getExpectedMediaError(submission, sourceSubmission, mediaData, galleryExpected);
        if (expectedMediaError) {
            throw new SubmissionMediaError(
                `Could not extract expected media for submission ${submission.id} (${submission.url}): ${expectedMediaError.message}`,
            );
        }
        console.log(`Fetched missing media for submission ${submission.id} - ${submission.title}`);
    }

    const modifiedSubmission = {
        ...sourceSubmission,
        score: submission.score,
        upvote_ratio: submission.upvote_ratio,
        num_comments: submission.num_comments,
        removed_by_category: submission.removed_by_category,
        created_utc: submission.created_utc,
        ...mediaData,
    };

    const result = mergeMediaWithCache(modifiedSubmission, cachedSubmission);
    console.log(
        `Extracting media for submission ${submission.id} - ${submission.title} took: ${performance.now() - startTime}ms`,
    );
    return result;
}

async function updateSubmissionInDb(submission) {
    const dbConnect = await db.getDb();
    const submissionObj = {
        lastUpdateTime: submission.lastUpdateTime,
        imageUrls: Array.isArray(submission.imageUrls) ? submission.imageUrls : [],
        mediaVideo: hasProp(submission, 'mediaVideo') ? submission.mediaVideo : null,
        mediaHtml: hasProp(submission, 'mediaHtml') ? submission.mediaHtml : null,
        id: submission.id,
        title: submission.title,
        score: submission.score,
        upvote_ratio: submission.upvote_ratio,
        num_comments: submission.num_comments,
        num_images: Number.isInteger(submission.num_images) ? submission.num_images : 0,
        removed_by_category: submission.removed_by_category,
        created_utc: submission.created_utc,
    };

    const filter = { id: submissionObj.id };
    const updateDocument = { $set: submissionObj };
    const options = { upsert: true }; // create new document if it does not exist
    try {
        await dbConnect.collection(config.submissionsCollection).updateOne(filter, updateDocument, options);
        console.log(`Updated submission ${submissionObj.id} in database`);
    } catch (error) {
        console.error(`Error inserting submission ${submissionObj.id} into database:`, error);
        throw error;
    }
}

async function updateOldSubmissionInDb(snoowrapSubmission, dbSubmission, signal) {
    const newUpdateTime = new Date();
    let isStale = false;

    if (hasProp(dbSubmission, 'lastUpdateTime')) {
        const oldUpdateTime = new Date(dbSubmission.lastUpdateTime);
        const msSinceUpdate = newUpdateTime.getTime() - oldUpdateTime.getTime();
        const minsSinceUpdate = msSinceUpdate / 1000 / 60;
        isStale = minsSinceUpdate > config.minutesUntilUpdate;
        if (isStale) {
            console.log(`Updating ${minsSinceUpdate} minutes old submission ${snoowrapSubmission.id}`);
        }
    }

    const cachedMediaIsIncomplete = !cachedMediaSatisfiesExpectedType(snoowrapSubmission, dbSubmission);
    if (isStale || cachedMediaIsIncomplete) {
        const mediaSubmission = await updateSubmissionMedia(snoowrapSubmission, dbSubmission, signal);
        throwIfRequestAborted(signal);
        mediaSubmission.lastUpdateTime = newUpdateTime;
        await updateSubmissionInDb(mediaSubmission);
        return mediaSubmission;
    }

    const updatedSubmission = {
        ...dbSubmission,
        lastUpdateTime: hasProp(dbSubmission, 'lastUpdateTime') ? dbSubmission.lastUpdateTime : newUpdateTime,
        score: snoowrapSubmission.score,
        upvote_ratio: snoowrapSubmission.upvote_ratio,
        num_comments: snoowrapSubmission.num_comments,
        removed_by_category: snoowrapSubmission.removed_by_category,
        created_utc: snoowrapSubmission.created_utc,
    };
    if (
        isGallerySubmission(snoowrapSubmission) &&
        hasProp(snoowrapSubmission, 'gallery_data') &&
        Array.isArray(snoowrapSubmission.gallery_data.items) &&
        snoowrapSubmission.gallery_data.items.length > 0
    ) {
        const cachedImageCount = Number.isInteger(dbSubmission.num_images) ? dbSubmission.num_images : 0;
        updatedSubmission.num_images = Math.max(cachedImageCount, snoowrapSubmission.gallery_data.items.length);
    }

    throwIfRequestAborted(signal);
    await updateSubmissionInDb(updatedSubmission);
    return updatedSubmission;
}

router.get(
    '/subreddit/:subredditName/:sortType/:sortTime/:numSubmissions',
    handleAsync(async (req, res) => {
        const request = createRequestAbortController(req, res);
        const operationController = new AbortController();
        const abortOperations = () => operationController.abort();
        request.signal.addEventListener('abort', abortOperations, { once: true });

        try {
            const { sortType } = req.params;
            const sortTime = SORT_TIMES.find((time) => time === req.params.sortTime);
            const numSubmissions = parseInt(req.params.numSubmissions, 10);
            const subredditName = req.params.subredditName;
            const subreddit = reddit.getSubreddit(subredditName);

            let sortFunction = null;
            switch (sortType) {
                case 'hot':
                    sortFunction = subreddit.getHot.bind(subreddit);
                    break;
                case 'new':
                    sortFunction = subreddit.getNew.bind(subreddit);
                    break;
                case 'top':
                    sortFunction = subreddit.getTop.bind(subreddit);
                    break;
                case 'rising':
                    sortFunction = subreddit.getRising.bind(subreddit);
                    break;
                case 'controversial':
                    sortFunction = subreddit.getControversial.bind(subreddit);
                    break;
                default: {
                    throw Object.assign(new Error(`Invalid sort type: ${sortType}`), { statusCode: 400 });
                }
            }

            if (sortTime === undefined) {
                throw Object.assign(new Error(`Invalid sort time: ${req.params.sortTime}`), { statusCode: 400 });
            }
            const listingOptions = { time: sortTime, limit: numSubmissions };

            const dbConnect = await db.getDb();
            const submissionsCollection = dbConnect.collection(config.submissionsCollection);
            let numAttempts = 0;
            let longestData = [];

            while (true) {
                numAttempts++;
                const data = await redditRequestScheduler.execute(() => sortFunction({ ...listingOptions }), {
                    signal: operationController.signal,
                });
                if (data.length > longestData.length) {
                    longestData = data;
                }
                if (data.length < numSubmissions) {
                    console.warn(
                        `Retrieved only ${data.length} out of ${numSubmissions} submissions for ${subredditName}`,
                    );
                    if (numAttempts <= MAX_ATTEMPTS) {
                        continue;
                    }
                    console.error(
                        `Max attempts ${MAX_ATTEMPTS} reached for retrying fetching submissions from ${subredditName}. Will return longest API response.`,
                    );
                }

                const modifiedData = await Promise.all(
                    longestData.map(async (submission) => {
                        if (operationController.signal.aborted) {
                            throw new redditRequestScheduler.RedditRequestAbortedError();
                        }
                        if (submission.is_self) {
                            return submission;
                        }
                        const query = { id: submission.id };
                        const cursor = submissionsCollection.find(query);
                        const count = await submissionsCollection.countDocuments(query);
                        if (operationController.signal.aborted) {
                            throw new redditRequestScheduler.RedditRequestAbortedError();
                        }
                        if (count === 0) {
                            const mediaSubmission = await updateSubmissionMedia(
                                submission,
                                null,
                                operationController.signal,
                            );
                            throwIfRequestAborted(operationController.signal);
                            mediaSubmission.lastUpdateTime = new Date();
                            await updateSubmissionInDb(mediaSubmission);
                            return mediaSubmission;
                        }
                        if (count === 1) {
                            const dbSubmission = await cursor.next();
                            throwIfRequestAborted(operationController.signal);
                            return updateOldSubmissionInDb(submission, dbSubmission, operationController.signal);
                        }
                        const duplicates = await cursor.toArray();
                        console.log('Duplicate submissions:', duplicates);
                        throw new Error(`Found ${count} submissions with same id ${submission.id}`);
                    }),
                );

                if (!request.signal.aborted) {
                    res.send(modifiedData);
                }
                return;
            }
        } catch (error) {
            operationController.abort();
            if (!request.signal.aborted) {
                sendRouteError(res, error);
            }
        } finally {
            request.signal.removeEventListener('abort', abortOperations);
            request.cleanup();
        }
    }),
);

module.exports = router;
