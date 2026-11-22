const fs = require('fs');
const path = require('path');

const configFile = path.join(process.cwd(), 'config.json');
/** @type {unknown} */
const rawConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
if (rawConfig === null || typeof rawConfig !== 'object') {
    throw new Error('config.json must contain an object');
}

// The JSON object can contain arbitrary fields. Validate the settings used by the service.
const { minutesUntilUpdate, minutesUntilDelete, submissionsCollection } = /** @type {Record<string, unknown>} */ (
    rawConfig
);
if (typeof minutesUntilUpdate !== 'number' || !Number.isFinite(minutesUntilUpdate)) {
    throw new Error('config.json minutesUntilUpdate must be a finite number');
}
if (typeof minutesUntilDelete !== 'number' || !Number.isFinite(minutesUntilDelete)) {
    throw new Error('config.json minutesUntilDelete must be a finite number');
}
if (typeof submissionsCollection !== 'string' || submissionsCollection.length === 0) {
    throw new Error('config.json submissionsCollection must be a nonempty string');
}

/** @type {{ minutesUntilUpdate: number, minutesUntilDelete: number, submissionsCollection: string }} */
const config = { minutesUntilUpdate, minutesUntilDelete, submissionsCollection };
module.exports = config;
