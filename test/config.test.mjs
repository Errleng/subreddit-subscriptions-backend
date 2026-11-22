import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';

const require = createRequire(import.meta.url);
const modulePath = require.resolve('../config.js');
const configFile = path.join(process.cwd(), 'config.json');
const readFileSync = fs.readFileSync;

afterEach(() => {
    delete require.cache[modulePath];
    vi.restoreAllMocks();
});

test.each([
    ['null', 'must contain an object'],
    ['1', 'must contain an object'],
    ['{"minutesUntilUpdate":"1"}', 'minutesUntilUpdate must be a finite number'],
    ['{"minutesUntilUpdate":1e400}', 'minutesUntilUpdate must be a finite number'],
    ['{"minutesUntilUpdate":1}', 'minutesUntilDelete must be a finite number'],
    ['{"minutesUntilUpdate":1,"minutesUntilDelete":1e400}', 'minutesUntilDelete must be a finite number'],
    ['{"minutesUntilUpdate":1,"minutesUntilDelete":2}', 'submissionsCollection must be a nonempty string'],
    [
        '{"minutesUntilUpdate":1,"minutesUntilDelete":2,"submissionsCollection":""}',
        'submissionsCollection must be a nonempty string',
    ],
])('rejects invalid configuration %s at startup', (contents, message) => {
    vi.spyOn(fs, 'readFileSync').mockImplementation((file, options) =>
        file === configFile ? contents : readFileSync(file, options),
    );

    expect(() => require('../config.js')).toThrow(message);
});
