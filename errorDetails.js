/**
 * @param {unknown} error
 * @param {string} property
 */
function getErrorProperty(error, property) {
    if (error === null || typeof error !== 'object') {
        return undefined;
    }

    // Thrown objects can carry library-specific fields of unknown type.
    return /** @type {Record<string, unknown>} */ (error)[property];
}

/** @param {unknown} error */
function getErrorMessage(error) {
    const message = getErrorProperty(error, 'message');
    return typeof message === 'string' ? message : 'Unknown error';
}

module.exports = { getErrorProperty, getErrorMessage };
