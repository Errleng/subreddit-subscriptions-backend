const fs = require('fs');
const path = require('path');
const { getErrorProperty } = require('./errorDetails');

const configFile = path.join(process.cwd(), 'config.json');
let config = null;
try {
    config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
} catch (err) {
    if (getErrorProperty(err, 'code') !== 'ENOENT') {
        console.error('Error when reading config file', err);
    }
}
module.exports = config;
