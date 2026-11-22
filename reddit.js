const snoowrap = require('snoowrap');
const fs = require('fs');
const { getErrorProperty } = require('./errorDetails');

const secretsPath = './secrets.json';
let secrets = null;
try {
    secrets = fs.readFileSync(secretsPath, 'utf8');
} catch (err) {
    if (getErrorProperty(err, 'code') !== 'ENOENT') {
        console.error('Error when reading secrets file', err);
    }
}

if (secrets === null) {
    secrets = {
        clientId: process.env.REDDIT_CLIENT,
        clientSecret: process.env.REDDIT_SECRET,
        refreshToken: process.env.REDDIT_REFRESH_TOKEN,
    };
} else {
    secrets = JSON.parse(secrets);
}

const reddit = new snoowrap({
    userAgent: 'personal user agent for personal app for accessibility',
    clientId: secrets.clientId,
    clientSecret: secrets.clientSecret,
    refreshToken: secrets.refreshToken,
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
