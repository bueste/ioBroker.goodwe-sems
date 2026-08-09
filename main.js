"use strict";

const utils = require("@iobroker/adapter-core");
const { SemsApi } = require("./lib/semsApi");
const { Notifier } = require("./lib/notify");
const { mapMonitorDetail } = require("./lib/mapping");
const { SemsAuthError, SemsRateLimitError, SemsNetworkError, SemsProtocolError } = require("./lib/errors");

// Hard floor for the poll interval, independent of user configuration.
// Protects the SEMS account from being rate-limited/locked even if someone
// sets an unreasonably low value in the admin UI.
const MIN_POLL_INTERVAL_SEC = 60;
// Hard ceiling for the poll interval. Node's setTimeout() silently wraps delays
// beyond ~2,147,483,647ms (~24.8 days), firing immediately instead of after the
// intended delay - an extreme user-configured value would otherwise cause rapid,
// unintended polling and risk a SEMS account lockout. 1 day is already far beyond
// any sensible polling need for this adapter, so it doubles as a sane operational
// ceiling, well clear of the technical Node.js limit.
const MAX_POLL_INTERVAL_SEC = 86400;
// Ceiling for the exponential backoff on repeated errors.
const MAX_BACKOFF_SEC = 3600;

class GoodweSems extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options]
     */
    constructor(options) {
        super({ ...options, name: "goodwe-sems" });

        this.on("ready", this.onReady.bind(this));
        this.on("unload", this.onUnload.bind(this));

        this.pollTimer = null;
        this.api = null;
        this.notifier = null;
        this.consecutiveErrors = 0;
        this.stationOfflineNotified = false;
        this.lastSuccessTs = 0;
        this.startTs = 0;
        this.knownObjectIds = new Set();
        this.stationId = null;
        this.destroyed = false;
        this.basePollIntervalSec = 300;
        this.stationOfflineMs = 30 * 60000;
    }

    /**
     * Force-corrects the common.unit of an existing info.activePollInterval object from the
     * old "s" to the "sec" string required by the value.interval role. Objects declared under
     * io-package.json's instanceObjects are only auto-created, not reliably kept in sync with
     * io-package.json changes on every js-controller version an installation might run
     * (see https://github.com/ioBroker/ioBroker.js-controller/issues/769) - so an already-running
     * installation upgrading from <=1.0.1 could otherwise keep the old, incorrect unit forever.
     */
    async _migrateActivePollIntervalUnit() {
        try {
            const obj = await this.getObjectAsync("info.activePollInterval");
            if (obj && obj.common && obj.common.unit !== "sec") {
                await this.extendObjectAsync("info.activePollInterval", { common: { unit: "sec" } });
                this.log.info('Migration: corrected info.activePollInterval unit to "sec".');
            }
        } catch (error) {
            // Never let a migration failure block adapter startup.
            this.log.warn(`Migration of info.activePollInterval unit failed (non-fatal): ${error.message}`);
        }
    }

    async onReady() {
        await this._migrateActivePollIntervalUnit();
        await this.setStateAsync("info.connection", false, true);
        this.startTs = Date.now();

        if (!this.config.account || !this.config.password) {
            this.log.error(
                "SEMS credentials are missing (username/password). Please enter them in the instance configuration and restart the instance afterwards.",
            );
            return;
        }

        const configuredPollInterval = Number(this.config.pollInterval) || 300;
        this.basePollIntervalSec = Math.min(
            Math.max(MIN_POLL_INTERVAL_SEC, configuredPollInterval),
            MAX_POLL_INTERVAL_SEC,
        );
        if (configuredPollInterval < MIN_POLL_INTERVAL_SEC) {
            this.log.warn(
                `Configured poll interval (${this.config.pollInterval}s) is below the minimum of ${MIN_POLL_INTERVAL_SEC}s ` +
                    `and was raised to ${this.basePollIntervalSec}s to protect against SEMS rate limits.`,
            );
        } else if (configuredPollInterval > MAX_POLL_INTERVAL_SEC) {
            this.log.warn(
                `Configured poll interval (${this.config.pollInterval}s) exceeds the maximum of ${MAX_POLL_INTERVAL_SEC}s ` +
                    `and was capped to ${this.basePollIntervalSec}s (an unbounded Node.js timer delay would otherwise wrap and fire immediately).`,
            );
        }
        this.maxConsecutiveErrors = Math.max(1, Number(this.config.maxConsecutiveErrors) || 3);
        this.stationOfflineMs = Math.max(1, Number(this.config.stationOfflineMinutes) || 30) * 60000;

        this.notifier = new Notifier(this, this.config);
        this.api = new SemsApi({
            account: this.config.account,
            password: this.config.password,
            requestTimeoutMs: Math.max(5, Number(this.config.requestTimeout) || 15) * 1000,
            log: (level, message) => {
                if (typeof this.log[level] === "function") {
                    this.log[level](message);
                } else {
                    this.log.debug(message);
                }
            },
            // Use the adapter's managed timers so HTTP-request-timeout
            // timers are automatically cleaned up on adapter unload/compact
            // mode shutdown instead of leaking a bare Node.js timer.
            setTimeoutFn: this.setTimeout.bind(this),
            clearTimeoutFn: this.clearTimeout.bind(this),
        });

        await this.setStateAsync("info.activePollInterval", this.basePollIntervalSec, true);
        this.log.info(
            `GoodWe SEMS adapter started. Poll interval: ${this.basePollIntervalSec}s, account: ${this._maskAccount(this.config.account)}.`,
        );

        this._schedulePoll(0);
    }

    onUnload(callback) {
        try {
            this.destroyed = true;
            if (this.pollTimer) {
                this.clearTimeout(this.pollTimer);
                this.pollTimer = null;
            }
            callback();
        } catch (error) {
            this.log.error(`Error while shutting down the adapter: ${error.message}`);
            callback();
        }
    }

    _schedulePoll(delayMs) {
        if (this.destroyed) {
            return;
        }
        if (this.pollTimer) {
            this.clearTimeout(this.pollTimer);
        }
        this.pollTimer = this.setTimeout(() => {
            this._pollCycle().catch(error => {
                // _pollCycle already handles its own errors; this is a last-resort
                // safety net so a programming mistake can never silently kill the
                // polling loop.
                this.log.error(`Unhandled error in poll cycle: ${error.stack || error.message}`);
                this._schedulePoll(this.basePollIntervalSec * 1000);
            });
        }, delayMs);
    }

    async _pollCycle() {
        if (this.destroyed) {
            return;
        }
        const startedAt = Date.now();
        try {
            await this._resolveStationId();
            const detail = await this.api.getMonitorDetail(this.stationId);
            if (this.destroyed) {
                return;
            }
            await this._applyMonitorDetail(detail);

            this.consecutiveErrors = 0;
            this.stationOfflineNotified = false;
            this.lastSuccessTs = Date.now();
            this.notifier.resetDedupe("stationOffline");
            this.notifier.resetDedupe("loginFailure");
            this.notifier.resetDedupe("rateLimit");
            this.notifier.resetDedupe("adapterError");

            await this.setStateAsync("info.connection", true, true);
            await this.setStateAsync("info.lastSuccess", this.lastSuccessTs, true);
            await this.setStateAsync("info.lastError", "", true);
            await this.setStateAsync("info.consecutiveErrors", 0, true);
            await this.setStateAsync("info.rateLimited", false, true);
            await this.setStateAsync("info.activePollInterval", this.basePollIntervalSec, true);

            this.log.debug(
                `Poll cycle successful (${Date.now() - startedAt} ms), next poll in ${this.basePollIntervalSec}s.`,
            );
            this._schedulePoll(this.basePollIntervalSec * 1000);
        } catch (error) {
            await this._handlePollError(error);
        }
    }

    async _resolveStationId() {
        if (this.stationId) {
            return;
        }

        const configuredId = (this.config.powerStationId || "").trim();
        if (configuredId) {
            this.stationId = configuredId;
            this.log.debug(`Using powerStationId from the configuration: ${configuredId}`);
            return;
        }

        this.log.info("No powerStationId configured - attempting automatic discovery via the SEMS account.");
        const stations = await this.api.getOwnedPowerStations();
        if (!stations.length) {
            throw new SemsProtocolError(
                "Automatic plant discovery returned no plant for this SEMS account. Please enter powerStationId manually in the instance configuration (from the SEMS portal URL after login).",
            );
        }
        if (stations.length > 1) {
            this.log.warn(
                `Found ${stations.length} plants on this SEMS account. Using the first one (${stations[0].id}). ` +
                    "To use a specific plant, set powerStationId manually in the instance configuration.",
            );
        }
        this.stationId = stations[0].id;
        await this._ensureState(
            "Station.StationId",
            "Power station ID used by this instance",
            { type: "string", role: "text", read: true, write: false },
            this.stationId,
        );
    }

    async _applyMonitorDetail(detail) {
        const { points } = mapMonitorDetail(detail);

        await this._ensureChannel("Station", "Station information");
        await this._ensureChannel("KPI", "Key performance indicators");
        await this._ensureChannel("PowerFlow", "Current plant power flow");
        await this._ensureChannel("Battery", "Overall battery state");

        const hasEvCharger = points.some(p => p.id.startsWith("EVCharger."));
        if (hasEvCharger) {
            await this._ensureChannel("EVCharger", "EV charger");
        }

        const inverterSerials = new Set(points.filter(p => p.id.startsWith("Inverters.")).map(p => p.id.split(".")[1]));
        if (inverterSerials.size) {
            await this._ensureChannel("Inverters", "One channel per inverter reported by the portal");
            const GROUP_LABELS = {
                AC_L1: "AC phase 1",
                AC_L2: "AC phase 2",
                AC_L3: "AC phase 3",
                PV1: "PV string 1",
                PV2: "PV string 2",
                PV3: "PV string 3",
                PV4: "PV string 4",
                Battery: "Battery (this inverter)",
            };
            for (const sn of inverterSerials) {
                await this._ensureChannel(`Inverters.${sn}`, `Inverter ${sn}`);
                // mapMonitorDetail() creates 3-level-deep state IDs for these sub-groups
                // (e.g. Inverters.<sn>.AC_L1.Voltage). ioBroker requires every intermediate
                // path segment to exist as its own channel object, not just be implied by the
                // dotted state ID (E3009 "missing intermediate object"). Only create a group's
                // channel when at least one of its states was actually mapped for this inverter,
                // matching the same presence-driven pattern already used for EVCharger above.
                for (const [group, label] of Object.entries(GROUP_LABELS)) {
                    const prefix = `Inverters.${sn}.${group}.`;
                    if (points.some(p => p.id.startsWith(prefix))) {
                        await this._ensureChannel(`Inverters.${sn}.${group}`, label);
                    }
                }
            }
        }

        for (const point of points) {
            await this._ensureState(point.id, point.name, point.common, point.value);
        }

        if (this.config.debugRawResponse) {
            await this.setStateAsync("info.rawResponse", JSON.stringify(detail), true);
        }
    }

    /**
     * Creates (once) and updates a state, minimising redundant object writes across poll cycles.
     *
     * @param id
     * @param name
     * @param common
     * @param value
     */
    async _ensureState(id, name, common, value) {
        if (!this.knownObjectIds.has(id)) {
            await this.setObjectNotExistsAsync(id, {
                type: "state",
                common: { name, ...common },
                native: {},
            });
            this.knownObjectIds.add(id);
        }
        await this.setStateAsync(id, value, true);
    }

    async _ensureChannel(id, name) {
        if (this.knownObjectIds.has(`channel:${id}`)) {
            return;
        }
        await this.setObjectNotExistsAsync(id, {
            type: "channel",
            common: { name },
            native: {},
        });
        this.knownObjectIds.add(`channel:${id}`);
    }

    async _handlePollError(error) {
        this.consecutiveErrors++;
        await this.setStateAsync("info.connection", false, true);
        await this.setStateAsync("info.lastError", error.message, true);
        await this.setStateAsync("info.consecutiveErrors", this.consecutiveErrors, true);

        let nextDelaySec = this.basePollIntervalSec;

        if (error instanceof SemsRateLimitError) {
            this.log.warn(`SEMS portal rate limit reached: ${error.message}`);
            await this.setStateAsync("info.rateLimited", true, true);
            nextDelaySec = error.retryAfterSeconds;
            {
                const t = this._notifyText("rateLimit", { nextDelaySec });
                await this.notifier.notify("rateLimit", t.title, t.message);
            }
        } else if (error instanceof SemsAuthError) {
            this.log.error(`SEMS login failed: ${error.message}`);
            nextDelaySec = Math.min(
                this.basePollIntervalSec * Math.pow(2, Math.min(this.consecutiveErrors, 5)),
                MAX_BACKOFF_SEC,
            );
            {
                const t = this._notifyText("loginFailure", { errorMessage: error.message });
                await this.notifier.notify("loginFailure", t.title, t.message);
            }
        } else if (error instanceof SemsNetworkError || error instanceof SemsProtocolError) {
            this.log.warn(`SEMS API error: ${error.message}`);
            await this.setStateAsync("info.rateLimited", false, true);
            nextDelaySec = Math.min(
                this.basePollIntervalSec * Math.pow(1.5, Math.min(this.consecutiveErrors, 6)),
                MAX_BACKOFF_SEC / 2,
            );
        } else {
            this.log.error(`Unexpected error in poll cycle: ${error.stack || error.message}`);
            await this.setStateAsync("info.rateLimited", false, true);
            nextDelaySec = Math.min(this.basePollIntervalSec * 2, MAX_BACKOFF_SEC / 2);
            {
                const t = this._notifyText("adapterError", { errorMessage: error.message });
                await this.notifier.notify("adapterError", t.title, t.message);
            }
        }

        // "Anlage offline" is only alarmiert, wenn BEIDE Kriterien erfüllt sind:
        // genug aufeinanderfolgende Fehlversuche UND lange genug kein Erfolg mehr
        // (konfigurierbar über stationOfflineMinutes). Verhindert Fehlalarme bei
        // kurzen Intervallen und wartet nicht unnötig lange bei langen Intervallen.
        const referenceTs = this.lastSuccessTs || this.startTs;
        const downMs = Date.now() - referenceTs;
        if (
            this.consecutiveErrors >= this.maxConsecutiveErrors &&
            downMs >= this.stationOfflineMs &&
            !this.stationOfflineNotified
        ) {
            const downMinutes = Math.round(downMs / 60000);
            {
                const t = this._notifyText("stationOffline", {
                    consecutiveErrors: this.consecutiveErrors,
                    downMinutes,
                    errorMessage: error.message,
                });
                await this.notifier.notify("stationOffline", t.title, t.message);
            }
            this.stationOfflineNotified = true;
        }

        await this.setStateAsync("info.activePollInterval", nextDelaySec, true);
        this._schedulePoll(nextDelaySec * 1000);
    }

    _maskAccount(account) {
        if (!account) {
            return "(not set)";
        }
        const at = account.indexOf("@");
        if (at <= 1) {
            return "***";
        }
        return `${account.slice(0, 2)}***${account.slice(at)}`;
    }

    /**
     * Returns the {title, message} pair for a notify() category in the configured
     * notification language (notificationLanguage config field), falling back to
     * English for any language not explicitly supported here. This is separate from
     * ioBroker log messages, which are always English regardless of this setting.
     *
     * @param {"rateLimit"|"loginFailure"|"adapterError"|"stationOffline"} category
     * @param {object} params values interpolated into the message template
     */
    _notifyText(category, params) {
        const lang = this.config.notificationLanguage === "de" ? "de" : "en";
        const templates = {
            rateLimit: {
                en: {
                    title: "SEMS rate limit reached",
                    message:
                        `The SEMS portal rejected requests with the rate-limit code. Polling paused for ${params.nextDelaySec}s. ` +
                        "If this happens often, increase the poll interval in the instance configuration.",
                },
                de: {
                    title: "SEMS Rate-Limit erreicht",
                    message:
                        `Das SEMS-Portal hat Anfragen mit dem Rate-Limit-Code abgelehnt. Polling pausiert für ${params.nextDelaySec}s. ` +
                        "Falls das öfter vorkommt, das Poll-Intervall in der Instanzkonfiguration erhöhen.",
                },
            },
            loginFailure: {
                en: {
                    title: "SEMS login failed",
                    message:
                        `Login to the SEMS portal for account "${this._maskAccount(this.config.account)}" is failing: ${params.errorMessage}. ` +
                        "Please check username/password in the instance configuration.",
                },
                de: {
                    title: "SEMS-Login fehlgeschlagen",
                    message:
                        `Anmeldung am SEMS-Portal für Konto "${this._maskAccount(this.config.account)}" schlägt fehl: ${params.errorMessage}. ` +
                        "Bitte Benutzername/Passwort in der Instanzkonfiguration prüfen.",
                },
            },
            adapterError: {
                en: { title: "Unexpected adapter error", message: params.errorMessage },
                de: { title: "Unerwarteter Adapterfehler", message: params.errorMessage },
            },
            stationOffline: {
                en: {
                    title: "GoodWe plant unreachable",
                    message:
                        `${params.consecutiveErrors} consecutive poll attempts have failed (no data from the SEMS portal for approx. ${params.downMinutes} minutes). ` +
                        `Last error: ${params.errorMessage}`,
                },
                de: {
                    title: "GoodWe-Anlage nicht erreichbar",
                    message:
                        `${params.consecutiveErrors} aufeinanderfolgende Poll-Versuche sind fehlgeschlagen (seit ca. ${params.downMinutes} Minuten keine Daten vom SEMS-Portal). ` +
                        `Letzter Fehler: ${params.errorMessage}`,
                },
            },
        };
        return templates[category][lang] || templates[category].en;
    }
}

if (require.main !== module) {
    module.exports = options => new GoodweSems(options);
} else {
    new GoodweSems();
}
