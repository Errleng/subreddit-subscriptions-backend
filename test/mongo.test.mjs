import { createRequire } from 'node:module';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const require = createRequire(import.meta.url);
/** @type {typeof import('mongodb')} */
const { Collection, MongoClient } = require('mongodb');
const modulePath = require.resolve('../mongo');
const fixtureUri = 'mongodb://127.0.0.1:27017';
// The driver also exposes callback overloads. These tests use the promise overloads.
const clientPrototype = /** @type {{ connect: () => Promise<import('mongodb').MongoClient> }} */ (
    MongoClient.prototype
);
const collectionPrototype = /** @type {{
    createIndex: (keys: import('mongodb').IndexSpecification, options: import('mongodb').CreateIndexesOptions) => Promise<string>
}} */ (Collection.prototype);

beforeEach(() => {
    vi.stubEnv('MONGODB_URI', fixtureUri);
    vi.stubEnv('MONGODB_DATABASE', 'fixture');
});

afterEach(() => {
    delete require.cache[modulePath];
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

function mockConnect() {
    return vi.spyOn(clientPrototype, 'connect').mockImplementation(
        /** @this {import('mongodb').MongoClient} */ async function () {
            return this;
        },
    );
}

function loadDatabase() {
    /** @type {typeof import('../mongo.js')} */
    const database = require('../mongo');
    return database;
}

test('initializes the database and TTL index once for concurrent callers', async () => {
    const connect = mockConnect();
    const createIndex = vi.spyOn(collectionPrototype, 'createIndex').mockResolvedValue('lastUpdateTime_1');
    const database = loadDatabase();

    const [first, second] = await Promise.all([database.getDb(), database.getDb()]);
    expect(first).toBe(second);
    expect(connect).toHaveBeenCalledOnce();
    expect(createIndex).toHaveBeenCalledExactlyOnceWith({ lastUpdateTime: 1 }, { expireAfterSeconds: 604800 });
});

test('retries initialization when TTL index creation fails', async () => {
    const connect = mockConnect();
    const createIndex = vi
        .spyOn(collectionPrototype, 'createIndex')
        .mockRejectedValueOnce(new Error('Index creation failed'))
        .mockResolvedValueOnce('lastUpdateTime_1');
    const database = loadDatabase();

    await expect(database.getDb()).rejects.toThrow('Index creation failed');
    await expect(database.getDb()).resolves.toHaveProperty('databaseName', 'fixture');
    expect(connect).toHaveBeenCalledTimes(2);
    expect(createIndex).toHaveBeenCalledTimes(2);
});
