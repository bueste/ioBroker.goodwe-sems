"use strict";

/**
 * Base class for all errors raised by the SEMS API client.
 * Keeping a dedicated hierarchy lets main.js react differently
 * (log level, Pushover severity, retry behaviour) per error type
 * instead of parsing error message strings.
 */
class SemsError extends Error {
    constructor(message) {
        super(message);
        this.name = this.constructor.name;
    }
}

/** Login failed (wrong credentials, portal changed its login contract, ...). */
class SemsAuthError extends SemsError {}

/** The portal answered with its rate-limit code (observed: GY0429). */
class SemsRateLimitError extends SemsError {
    /**
     * @param {string} message
     * @param {number} retryAfterSeconds recommended cool-down before the next request
     */
    constructor(message, retryAfterSeconds = 300) {
        super(message);
        this.retryAfterSeconds = retryAfterSeconds;
    }
}

/** Network-level failure (timeout, DNS, connection reset, non-2xx, ...). */
class SemsNetworkError extends SemsError {}

/** The portal answered but the payload did not look like what we expected. */
class SemsProtocolError extends SemsError {}

module.exports = {
    SemsError,
    SemsAuthError,
    SemsRateLimitError,
    SemsNetworkError,
    SemsProtocolError,
};
