const { MongoClient } = require('mongodb');
const config = require('./config');

const mongoConnectionString = 'mongodb+srv://SubscriptionsAdmin:CxPeLkJ2Hz8GZm@submissionsdata.r9zuj.mongodb.net/myFirstDatabase?retryWrites=true&w=majority';
const client = new MongoClient(mongoConnectionString, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
});

let database = null;
module.exports = {
    async connectToMongo() {
        const connection = await client.connect();
        database = connection.db('SubmissionsData');
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
