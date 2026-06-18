const express = require('express');
const snoowrap = require('snoowrap');
const fs = require('fs');
require('dotenv').config();

const PORT = 8080;
const secretsPath = './secrets.json';

const app = express();

let secrets = null;
try {
    secrets = fs.readFileSync(secretsPath);
} catch (err) {
    if (err.code !== 'ENOENT') {
        console.error('Error when reading secrets file', err);
    }
}

if (secrets === null) {
    secrets = {
        clientId: process.env.REDDIT_CLIENT,
        clientSecret: process.env.REDDIT_SECRET,
        refreshToken: process.env.REDDIT_REFRESH_TOKEN
    };
} else {
    secrets = JSON.parse(secrets);
}

const REDIRECT_URI = `http://localhost:${PORT}`;

// 1. Generate the Reddit Authorization Link using the environment variables
const authUrl = snoowrap.getAuthUrl({
    clientId: secrets.clientId,
    scope: ['*'],
    redirectUri: REDIRECT_URI,
    permanent: true, // Crucial to get a refresh token back
    state: 'etnhaetsahetsnhaoslolasoh'
});

console.log('\n================================================================');
console.log('1. Copy and paste this URL into your web browser:\n');
console.log(authUrl);
console.log('================================================================\n');

// 2. Catch the callback and exchange it using your environment secrets
app.get('/', (req, res) => {
    const code = req.query.code;

    if (!code) {
        return res.send('No code found in the query parameters.');
    }

    snoowrap.fromAuthCode({
        code: code,
        clientId: secrets.clientId,
        clientSecret: secrets.clientSecret,
        redirectUri: REDIRECT_URI,
        userAgent: 'personal user agent for personal app for accessibility'
    }).then(requester => {
        console.log('\n================ SUCCESS! ================');
        console.log('Your NEW Refresh Token is:\n');
        console.log(requester.refreshToken);
        console.log('\nSave this to your REDDIT_REFRESH_TOKEN environment variable!');
        console.log('==========================================\n');

        res.send('Successfully authenticated! Check your terminal console for the refresh token.');
        process.exit(0);
    }).catch(err => {
        console.error('Error exchanging authorization code:', err);
        res.status(500).send('Authentication failed.');
    });
});

app.listen(PORT, () => {
    console.log(`Waiting for browser redirect on port ${PORT}...`);
});
