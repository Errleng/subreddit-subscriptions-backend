const snoowrap = require('snoowrap');
const readRedditCredentials = require('./redditCredentials');

const { clientId, clientSecret, refreshToken } = readRedditCredentials();
if (clientSecret === undefined || refreshToken === undefined) {
    throw new Error('The Reddit client secret and refresh token are required to start the API');
}

const reddit = new snoowrap({
    userAgent: 'personal user agent for personal app for accessibility',
    clientId,
    clientSecret,
    refreshToken,
});
const requestTimeoutMs = 30000;
reddit.config({
    requestDelay: 0,
    requestTimeout: requestTimeoutMs,
    continueAfterRatelimitError: false,
    // Keep the retry status filters configured, but disable Snoowrap retries.
    // An empty retryErrorCodes array makes its catch handler mis-handle local
    // RateLimitError instances that have no HTTP response.
    maxRetryAttempts: 1,
});

// Snoowrap applies requestTimeout to authenticated API calls, but not to the
// credentialed request it uses to refresh an OAuth access token.
// Its declarations use the unbundled request package types. The wrapper reads only timeout.
/** @type {(options: { timeout?: number, [option: string]: unknown }) => Promise<unknown>} */
const rawRequest = reddit.rawRequest.bind(reddit);
Object.assign(reddit, {
    /** @type {typeof rawRequest} */
    rawRequest: (options) =>
        rawRequest({
            ...options,
            timeout: options.timeout ?? requestTimeoutMs,
        }),
});

module.exports = reddit;
