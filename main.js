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

    async onReady() {
        await this.setStateAsync("info.connection", false, true);
        this.startTs = Date.now();

        if (!this.config.account || !this.config.password) {
            this.log.error(
                "SEMS-Zugangsdaten fehlen (Benutzer/Passwort). Bitte in der Instanzkonfiguration eintragen und die Instanz danach neu starten.",
            );
            return;
        }

        this.basePollIntervalSec = Math.max(MIN_POLL_INTERVAL_SEC, Number(this.config.pollInterval) || 300);
        if (Number(this.config.pollInterval) && Number(this.config.pollInterval) < MIN_POLL_INTERVAL_SEC) {
            this.log.warn(
                `Konfiguriertes Poll-Intervall (${this.config.pollInterval}s) liegt unter dem Minimum von ${MIN_POLL_INTERVAL_SEC}s ` +
                    `und wurde zum Schutz vor SEMS-Rate-Limits auf ${this.basePollIntervalSec}s angehoben.`,
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
            `GoodWe SEMS Adapter gestartet. Poll-Intervall: ${this.basePollIntervalSec}s, Konto: ${this._maskAccount(this.config.account)}.`,
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
            this.log.error(`Fehler beim Beenden des Adapters: ${error.message}`);
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
                this.log.error(`Unbehandelter Fehler im Poll-Zyklus: ${error.stack || error.message}`);
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
                `Poll-Zyklus erfolgreich (${Date.now() - startedAt} ms), nächster Abruf in ${this.basePollIntervalSec}s.`,
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
            this.log.debug(`Verwende in der Konfiguration hinterlegte powerStationId: ${configuredId}`);
            return;
        }

        this.log.info("Keine powerStationId konfiguriert - versuche automatische Erkennung über das SEMS-Konto.");
        const stations = await this.api.getOwnedPowerStations();
        if (!stations.length) {
            throw new SemsProtocolError(
                "Automatische Anlagen-Erkennung lieferte keine Anlage für dieses SEMS-Konto. Bitte powerStationId manuell in der Instanzkonfiguration eintragen (aus der SEMS-Portal-URL nach dem Login).",
            );
        }
        if (stations.length > 1) {
            this.log.warn(
                `Es wurden ${stations.length} Anlagen auf diesem SEMS-Konto gefunden. Verwende die erste (${stations[0].id}). ` +
                    "Für eine bestimmte Anlage bitte powerStationId manuell in der Instanzkonfiguration setzen.",
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
            for (const sn of inverterSerials) {
                await this._ensureChannel(`Inverters.${sn}`, `Inverter ${sn}`);
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
            this.log.warn(`SEMS-Portal Rate-Limit erreicht: ${error.message}`);
            await this.setStateAsync("info.rateLimited", true, true);
            nextDelaySec = error.retryAfterSeconds;
            await this.notifier.notify(
                "rateLimit",
                "SEMS Rate-Limit erreicht",
                `Das SEMS-Portal hat Anfragen mit dem Rate-Limit-Code abgelehnt. Polling pausiert für ${nextDelaySec}s. ` +
                    "Falls das öfter vorkommt, das Poll-Intervall in der Instanzkonfiguration erhöhen.",
            );
        } else if (error instanceof SemsAuthError) {
            this.log.error(`SEMS-Login fehlgeschlagen: ${error.message}`);
            nextDelaySec = Math.min(
                this.basePollIntervalSec * Math.pow(2, Math.min(this.consecutiveErrors, 5)),
                MAX_BACKOFF_SEC,
            );
            await this.notifier.notify(
                "loginFailure",
                "SEMS-Login fehlgeschlagen",
                `Anmeldung am SEMS-Portal für Konto "${this._maskAccount(this.config.account)}" schlägt fehl: ${error.message}. ` +
                    "Bitte Benutzername/Passwort in der Instanzkonfiguration prüfen.",
            );
        } else if (error instanceof SemsNetworkError || error instanceof SemsProtocolError) {
            this.log.warn(`SEMS-API-Fehler: ${error.message}`);
            await this.setStateAsync("info.rateLimited", false, true);
            nextDelaySec = Math.min(
                this.basePollIntervalSec * Math.pow(1.5, Math.min(this.consecutiveErrors, 6)),
                MAX_BACKOFF_SEC / 2,
            );
        } else {
            this.log.error(`Unerwarteter Fehler im Poll-Zyklus: ${error.stack || error.message}`);
            await this.setStateAsync("info.rateLimited", false, true);
            nextDelaySec = Math.min(this.basePollIntervalSec * 2, MAX_BACKOFF_SEC / 2);
            await this.notifier.notify("adapterError", "Unerwarteter Adapterfehler", error.message);
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
            await this.notifier.notify(
                "stationOffline",
                "GoodWe-Anlage nicht erreichbar",
                `${this.consecutiveErrors} aufeinanderfolgende Poll-Versuche sind fehlgeschlagen (seit ca. ${downMinutes} Minuten keine Daten vom SEMS-Portal). ` +
                    `Letzter Fehler: ${error.message}`,
            );
            this.stationOfflineNotified = true;
        }

        await this.setStateAsync("info.activePollInterval", nextDelaySec, true);
        this._schedulePoll(nextDelaySec * 1000);
    }

    _maskAccount(account) {
        if (!account) {
            return "(nicht gesetzt)";
        }
        const at = account.indexOf("@");
        if (at <= 1) {
            return "***";
        }
        return `${account.slice(0, 2)}***${account.slice(at)}`;
    }
}

if (require.main !== module) {
    module.exports = options => new GoodweSems(options);
} else {
    new GoodweSems();
}
