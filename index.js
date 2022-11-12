const createError = require('http-errors');
const express = require('express');
const path = require('path');
const { readFileSync } = require('fs');
const cookieParser = require('cookie-parser');
const logger = require('morgan');
const cors = require('cors');
const db = require('./mongo');

const configFile = path.join(process.cwd(), 'config.json');
const config = JSON.parse(readFileSync(configFile));

require('dotenv').config();

db.connectToMongo(() => {
    console.log('Connected to MongoDB');
    console.log('Config:', config);
    db.getDb()
        .collection(config.submissionsCollection)
        .createIndex(
            { lastUpdateTime: 1 },
            { expireAfterSeconds: config.minutesUntilDelete * 60 }
        );
});

const app = express();

const apiRouter = require('./api/apiRouter');

app.use(cors());
app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', apiRouter);

module.exports = app;
