const { MongoClient } = require('mongodb');
const config = require('./config');

const mongoConnectionString = process.env.MONGODB_URI;
if (!mongoConnectionString) {
    throw new Error('MONGODB_URI is required. Set it in your environment or .env file.');
}
const client = new MongoClient(mongoConnectionString);

/** @type {Promise<import('mongodb').Db> | null} */
let initialization = null;

async function initializeDatabase() {
    const connection = await client.connect();
    const database = connection.db(process.env.MONGODB_DATABASE || 'SubmissionsData');
    await database
        .collection(config.submissionsCollection)
        .createIndex({ lastUpdateTime: 1 }, { expireAfterSeconds: config.minutesUntilDelete * 60 });
    console.log('Connected to MongoDB');
    return database;
}

function getDb() {
    initialization ??= initializeDatabase().catch((error) => {
        initialization = null;
        throw error;
    });
    return initialization;
}

module.exports = {
    async connectToMongo() {
        await getDb();
    },
    getDb,
};
