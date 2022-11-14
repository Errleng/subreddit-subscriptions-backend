const fs = require('fs');
const path = require('path');

const configFile = path.join(process.cwd(), 'config.json');
let config = null;
try {
    config = JSON.parse(fs.readFileSync(configFile));
} catch (err) {
    if (err.code !== 'ENOENT') {
        console.error('Error when reading config file', err);
    }
}
module.exports = config;
