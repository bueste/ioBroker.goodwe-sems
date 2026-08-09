"use strict";

const PUSHOVER_API_URL = "https://api.pushover.net/1/messages.json";

// Do not re-send the *same* critical condition more often than this, even if
// every poll cycle keeps failing. Prevents Pushover-spam during a longer
// outage while still re-alerting periodically in case the first push got lost.
const DEFAULT_DEDUPE_MS = 60 * 60 * 1000; // 1 hour

/**
 * Sends critical adapter events to Pushover, either via an existing
 * ioBroker.pushover adapter instance (sendTo), directly against the Pushover
 * HTTPS API, or both - configurable per installation. Never throws: a
 * notification failure must not take down the polling logic.
 */
class Notifier {
    /**
     * @param {ioBroker.Adapter} adapter
     * @param {object} config effective (decrypted) adapter config (this.config)
     */
    constructor(adapter, config) {
        this.adapter = adapter;
        this.config = config;
        /** last-sent timestamp per dedupe key */
        this._lastSent = new Map();
    }

    /**
     * @param {"loginFailure"|"rateLimit"|"stationOffline"|"adapterError"} category
     * @param {string} title
     * @param {string} message
     * @param {object} [opts]
     * @param {string} [opts.dedupeKey] override key used for spam-protection (defaults to category)
     * @param {number} [opts.dedupeMs] override cool-down window in ms
     * @param {number} [opts.priority] Pushover priority (-2..2), defaults to configured value
     */
    async notify(category, title, message, opts = {}) {
        // Log entry is English-only per the adapter checklist; title/message stay in the
        // configured language for the actual Pushover push (read by the end user on their
        // phone) and are intentionally NOT embedded into the log line at all.
        this.adapter.log.error(`Notification triggered (category: ${category})`);

        if (!this._categoryEnabled(category)) {
            return;
        }

        const dedupeKey = opts.dedupeKey || category;
        const dedupeMs = opts.dedupeMs || DEFAULT_DEDUPE_MS;
        const last = this._lastSent.get(dedupeKey) || 0;
        if (Date.now() - last < dedupeMs) {
            this.adapter.log.debug(
                `Pushover notification "${dedupeKey}" suppressed (last sent ${Math.round((Date.now() - last) / 1000)}s ago, cooldown ${dedupeMs / 1000}s).`,
            );
            return;
        }

        const mode = this.config.pushoverMode || "none";
        if (mode === "none") {
            return;
        }

        const priority = typeof opts.priority === "number" ? opts.priority : Number(this.config.pushoverPriority) || 0;
        let sentAny = false;

        if (mode === "instance" || mode === "both") {
            sentAny = (await this._sendViaInstance(title, message, priority)) || sentAny;
        }
        if (mode === "direct" || mode === "both") {
            sentAny = (await this._sendDirect(title, message, priority)) || sentAny;
        }

        if (sentAny) {
            this._lastSent.set(dedupeKey, Date.now());
        }
    }

    /**
     * Clears the dedupe-timer for a category, e.g. once the adapter recovers.
     *
     * @param category
     */
    resetDedupe(category) {
        this._lastSent.delete(category);
    }

    _categoryEnabled(category) {
        switch (category) {
            case "loginFailure":
                return this.config.notifyOnLoginFailure !== false;
            case "rateLimit":
                return this.config.notifyOnRateLimit !== false;
            case "stationOffline":
                return this.config.notifyOnStationOffline !== false;
            case "adapterError":
                return this.config.notifyOnAdapterError !== false;
            default:
                return true;
        }
    }

    async _sendViaInstance(title, message, priority) {
        const instance = this.config.pushoverInstance;
        if (!instance) {
            this.adapter.log.warn("Pushover mode 'instance'/'both' is active, but no Pushover instance is configured.");
            return false;
        }
        try {
            await this.adapter.sendToAsync(instance, "send", {
                message,
                title: `GoodWe SEMS: ${title}`,
                priority,
            });
            return true;
        } catch (error) {
            this.adapter.log.warn(
                `Could not send Pushover notification via instance "${instance}" (is the adapter installed and running?): ${error.message}`,
            );
            return false;
        }
    }

    async _sendDirect(title, message, priority) {
        const userKey = this.config.pushoverUserKey;
        const apiToken = this.config.pushoverApiToken;
        if (!userKey || !apiToken) {
            this.adapter.log.warn(
                "Pushover mode 'direct'/'both' is active, but user key/API token are missing in the configuration.",
            );
            return false;
        }
        try {
            const params = new URLSearchParams({
                token: apiToken,
                user: userKey,
                title: `GoodWe SEMS: ${title}`,
                message,
                priority: String(priority),
            });
            const controller = new AbortController();
            // Use the adapter's managed setTimeout/clearTimeout instead of the
            // global ones, so this timer is cleaned up automatically if the
            // adapter gets unloaded while the request is still in flight.
            const timer = this.adapter.setTimeout(() => controller.abort(), 10000);
            try {
                const response = await fetch(PUSHOVER_API_URL, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                    body: params.toString(),
                    signal: controller.signal,
                });
                if (!response.ok) {
                    const text = await response.text();
                    throw new Error(`HTTP ${response.status}: ${text}`);
                }
            } finally {
                this.adapter.clearTimeout(timer);
            }
            return true;
        } catch (error) {
            this.adapter.log.warn(`Direct Pushover API call failed: ${error.message}`);
            return false;
        }
    }
}

module.exports = { Notifier };
