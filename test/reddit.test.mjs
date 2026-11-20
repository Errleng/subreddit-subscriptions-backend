import { createRequire } from 'node:module';
import fs from 'node:fs';
import snoowrap from 'snoowrap';
import { afterEach, expect, test, vi } from 'vitest';

const require = createRequire(import.meta.url);
const modulePath = require.resolve('../reddit');

afterEach(() => {
    delete require.cache[modulePath];
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

test('passes a timeout to the transport for default and explicit requests', async () => {
    const readFileSync = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation((path, options) => {
        if (path === './secrets.json') {
            throw Object.assign(new Error('No secrets fixture'), { code: 'ENOENT' });
        }
        return readFileSync(path, options);
    });
    vi.stubEnv('REDDIT_CLIENT', 'fixture-client');
    vi.stubEnv('REDDIT_SECRET', 'fixture-secret');
    vi.stubEnv('REDDIT_REFRESH_TOKEN', 'fixture-refresh-token');
    const rawRequest = vi.spyOn(snoowrap.prototype, 'rawRequest').mockResolvedValue({});
    /** @type {typeof import('../reddit.js')} */
    const client = require('../reddit');
    const uri = '/fixture';

    await client.rawRequest({ uri });
    await client.rawRequest({ uri, timeout: 300 });

    expect(rawRequest).toHaveBeenNthCalledWith(1, { uri, timeout: 30000 });
    expect(rawRequest).toHaveBeenNthCalledWith(2, { uri, timeout: 300 });
});
