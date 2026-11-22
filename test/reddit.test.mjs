import { createRequire } from 'node:module';
import fs from 'node:fs';
import snoowrap from 'snoowrap';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const require = createRequire(import.meta.url);
const modulePath = require.resolve('../reddit');
const readFileSync = fs.readFileSync;

beforeEach(() => {
    vi.stubEnv('REDDIT_CLIENT', 'fixture-client');
    vi.stubEnv('REDDIT_SECRET', 'fixture-secret');
    vi.stubEnv('REDDIT_REFRESH_TOKEN', 'fixture-refresh-token');
});

afterEach(() => {
    delete require.cache[modulePath];
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

/** @param {string | Error} fixture */
function stubSecretsFile(fixture) {
    vi.spyOn(fs, 'readFileSync').mockImplementation((path, options) => {
        if (path === './secrets.json') {
            if (fixture instanceof Error) {
                throw fixture;
            }
            return fixture;
        }
        return readFileSync(path, options);
    });
}

function loadClient() {
    // The transport uses CommonJS, and a fixture can change before each module load.
    return /** @type {typeof import('../reddit.js')} */ (require('../reddit'));
}

test('passes a timeout to the transport for default and explicit requests', async () => {
    stubSecretsFile(Object.assign(new Error('No secrets fixture'), { code: 'ENOENT' }));
    const rawRequest = vi.spyOn(snoowrap.prototype, 'rawRequest').mockResolvedValue({});
    const client = loadClient();
    const uri = '/fixture';

    await client.rawRequest({ uri });
    await client.rawRequest({ uri, timeout: 300 });

    expect(rawRequest).toHaveBeenNthCalledWith(1, { uri, timeout: 30000 });
    expect(rawRequest).toHaveBeenNthCalledWith(2, { uri, timeout: 300 });
});

test('prefers the credentials file and supports an installed app with an empty client secret', () => {
    stubSecretsFile('{"clientId":"fixture-file-client","clientSecret":null,"refreshToken":"fixture-file-token"}');

    const client = loadClient();

    expect(client).toMatchObject({
        clientId: 'fixture-file-client',
        clientSecret: '',
        refreshToken: 'fixture-file-token',
    });
});

test('uses the environment when the credentials file cannot be read', () => {
    stubSecretsFile(Object.assign(new Error('Synthetic read failure'), { code: 'EACCES' }));

    expect(loadClient().clientId).toBe('fixture-client');
});

test.each([
    ['null', 'secrets.json must contain an object'],
    ['false', 'secrets.json must contain an object'],
    ['{}', 'Set REDDIT_CLIENT or provide a clientId in secrets.json'],
    ['{"clientId":"fixture-client","clientSecret":1}', 'The Reddit client secret must be a string'],
    ['{"clientId":"fixture-client","refreshToken":1}', 'The Reddit refresh token must be a string'],
    ['{"clientId":"fixture-client"}', 'The Reddit client secret and refresh token are required'],
    [
        '{"clientId":"fixture-client","clientSecret":"fixture-secret"}',
        'The Reddit client secret and refresh token are required',
    ],
])('rejects invalid credentials input with %s', (contents, message) => {
    stubSecretsFile(contents);

    expect(loadClient).toThrow(message);
});

test('reports malformed credentials JSON without including any input', () => {
    stubSecretsFile('{"clientSecret":"fixture-secret",');

    expect(loadClient).toThrow(new Error('Invalid JSON in secrets.json'));
});
