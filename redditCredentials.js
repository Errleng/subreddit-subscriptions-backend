const fs = require('fs');
const { getErrorProperty } = require('./errorDetails');

function readRedditCredentials() {
    let fileContents = null;
    try {
        fileContents = fs.readFileSync('./secrets.json', 'utf8');
    } catch (error) {
        if (getErrorProperty(error, 'code') !== 'ENOENT') {
            console.error('Error when reading secrets file', error);
        }
    }

    /** @type {unknown} */
    let credentials = {
        clientId: process.env.REDDIT_CLIENT,
        clientSecret: process.env.REDDIT_SECRET,
        refreshToken: process.env.REDDIT_REFRESH_TOKEN,
    };
    if (fileContents !== null) {
        try {
            credentials = JSON.parse(fileContents);
        } catch {
            throw new Error('Invalid JSON in secrets.json');
        }
    }

    if (credentials === null || typeof credentials !== 'object') {
        throw new Error('secrets.json must contain an object');
    }
    // The credentials file is external input, so check its fields before passing them to Snoowrap.
    const { clientId, clientSecret, refreshToken } = /** @type {Record<string, unknown>} */ (credentials);
    if (typeof clientId !== 'string') {
        throw new Error('Set REDDIT_CLIENT or provide a clientId in secrets.json');
    }
    if (clientSecret != null && typeof clientSecret !== 'string') {
        throw new Error('The Reddit client secret must be a string');
    }
    if (refreshToken != null && typeof refreshToken !== 'string') {
        throw new Error('The Reddit refresh token must be a string');
    }

    return {
        clientId,
        // Snoowrap uses an empty password for an installed Reddit app without a client secret.
        clientSecret: clientSecret === null ? '' : clientSecret,
        refreshToken: refreshToken ?? undefined,
    };
}

module.exports = readRedditCredentials;
