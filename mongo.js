const { MongoClient } = require('mongodb');
const config = require('./config');

const mongoConnectionString = process.env.MONGODB_URI;
if (!mongoConnectionString) {
    throw new Error('MONGODB_URI is required. Set it in your environment or .env file.');
}
const client = new MongoClient(mongoConnectionString, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
});

let database = null;
module.exports = {
    async connectToMongo() {
        const connection = await client.connect();
        database = connection.db(process.env.MONGODB_DATABASE || 'SubmissionsData');
    },
    async getDb() {
        if (database === null) {
            await module.exports.connectToMongo();
            console.log('Connected to MongoDB');
            console.log('Config:', config);
            database.collection(config.submissionsCollection).createIndex({ lastUpdateTime: 1 }, { expireAfterSeconds: config.minutesUntilDelete * 60 });
        }
        return database;
    },
};
