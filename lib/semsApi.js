"use strict";

const crypto = require("crypto");
const {
    SemsAuthError,
    SemsRateLimitError,
    SemsNetworkError,
    SemsProtocolError,
} = require("./errors");

/*
 * ---------------------------------------------------------------------------
 * GoodWe / SEMS Portal API client
 * ---------------------------------------------------------------------------
 * IMPORTANT: There is no public, documented API for a normal SEMS Portal
 * account. GoodWe's official "OpenAPI" / "Real-time Data Monitoring API"
 * require a SEMS *organization* account resp. a signed reseller agreement
 * and are not reachable with a regular homeowner login
 * (see https://community.goodwe.com/solution/API).
 *
 * This client instead speaks the same undocumented HTTPS API that the
 * official SEMS mobile app and web portal use. It has been assembled from:
 *  - manual traffic inspection (CrossLogin / GetMonitorDetailByPowerstationId)
 *  - the community projects pygoodwe (github.com/yaleman/pygoodwe),
 *    goodwe-sems-home-assistant (github.com/TimSoethout/...), and the
 *    openHAB SEMSPortal binding, all MIT/EPL licensed reference
 *    implementations of the very same endpoints.
 *
 * Because none of this is contractually guaranteed by GoodWe, treat every
 * field as "best effort" and expect the portal to change without notice.
 * The client is deliberately defensive: unknown/missing fields never throw,
 * they just end up as `undefined` and are skipped by the adapter.
 * ---------------------------------------------------------------------------
 */

// "New" SEMS+ login, in use since ~2024. Needs an MD5(password) hash,
// base64-encoded, plus a few boilerplate flags.
const NEW_LOGIN_URL =
    "https://semsplus.goodwe.com/web/sems/sems-user/api/v1/auth/cross-login";
// Legacy login, kept as a fallback for accounts / regions where the new
// endpoint is unavailable or rejects the credentials.
const LEGACY_LOGIN_URL = "https://www.semsportal.com/api/v3/Common/CrossLogin";

// Both logins return an "api" field with the region-specific base URL to use
// for all further calls. If that field is missing we fall back to these.
const NEW_LOGIN_FALLBACK_API = "https://eu-gateway.semsportal.com/web/sems";
const LEGACY_LOGIN_FALLBACK_API = "https://eu.semsportal.com/api";

const STATION_LIST_PATH = "/PowerStation/GetPowerStationIdByOwner";
const MONITOR_DETAIL_PATH = "/v3/PowerStation/GetMonitorDetailByPowerstationId";

// Observed rate-limit response code. GoodWe does not document a retry-after
// value, community projects settled on a 5 minute cool-down.
const RATE_LIMIT_CODE = "GY0429";
const DEFAULT_RATE_LIMIT_RETRY_SECONDS = 300;

// Response "code"/"msg" values that indicate success across the endpoints we use.
const SUCCESS_CODES = new Set([0, "0", "00000"]);
const SUCCESS_MESSAGES = new Set(["success", "successful", "操作成功"]);

// Mimics a current SEMS iOS app. Some endpoints behave differently (or reject
// requests outright) without a "plausible" mobile user agent / token header.
const DEFAULT_USER_AGENT = "PVMaster/2.9.5 (iPhone; iOS 17.5; Scale/3.00)";
const DEFAULT_CLIENT_TOKEN = JSON.stringify({
    version: "v3.1",
    client: "ios",
    language: "en",
});

/**
 * Thin wrapper around fetch() with a hard timeout and JSON handling.
 *
 * @param {string} url
 * @param {object} init fetch init, `timeoutMs` is consumed here and not passed on
 * @returns {Promise<{status:number, json: any, text: string}>}
 */
async function httpPostJson(url, init) {
    const { timeoutMs, ...fetchInit } = init;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            ...fetchInit,
            signal: controller.signal,
        });
        const text = await response.text();
        let json;
        try {
            json = text ? JSON.parse(text) : {};
        } catch (parseError) {
            throw new SemsProtocolError(
                `Antwort von ${url} war kein gültiges JSON: ${parseError.message}`,
            );
        }
        return { status: response.status, json, text };
    } catch (error) {
        if (error.name === "AbortError") {
            throw new SemsNetworkError(
                `Zeitüberschreitung nach ${timeoutMs} ms bei ${url}`,
            );
        }
        if (error instanceof SemsProtocolError) {
            throw error;
        }
        throw new SemsNetworkError(
            `Netzwerkfehler bei ${url}: ${error.message}`,
        );
    } finally {
        clearTimeout(timer);
    }
}

class SemsApi {
    /**
     * @param {object} opts
     * @param {string} opts.account SEMS portal login (e-mail)
     * @param {string} opts.password SEMS portal password (plain text, hashed internally as required)
     * @param {number} [opts.requestTimeoutMs] per-request timeout
     * @param {(level:string, message:string)=>void} opts.log adapter logger bridge, called as log(level, message)
     */
    constructor({ account, password, requestTimeoutMs = 15000, log }) {
        if (!account || !password) {
            throw new SemsAuthError(
                "SEMS-Zugangsdaten (Benutzer/Passwort) fehlen in der Adapter-Konfiguration.",
            );
        }
        this.account = account;
        this.password = password;
        this.requestTimeoutMs = requestTimeoutMs;
        this.log = log || (() => {});

        this.session = null;
    }

    /** MD5(password), base64 encoded - required by the "new" SEMS+ login endpoint. */
    _hashPasswordForNewLogin() {
        const md5Hex = crypto
            .createHash("md5")
            .update(this.password, "utf8")
            .digest("hex");
        return Buffer.from(md5Hex, "utf8").toString("base64");
    }

    _defaultHeaders(extraTokenPayload) {
        return {
            "Content-Type": "application/json",
            Accept: "application/json, */*;q=0.5",
            "User-Agent": DEFAULT_USER_AGENT,
            Token: extraTokenPayload
                ? JSON.stringify(extraTokenPayload)
                : DEFAULT_CLIENT_TOKEN,
        };
    }

    _authHeaders() {
        if (!this.session) {
            throw new SemsAuthError(
                "Keine aktive SEMS-Session - login() wurde nicht (erfolgreich) aufgerufen.",
            );
        }
        return this._defaultHeaders({
            version: "v3.1",
            client: "ios",
            language: "en",
            timestamp: this.session.timestamp,
            uid: this.session.uid,
            token: this.session.token,
        });
    }

    /**
     * Try the current SEMS+ login first, fall back to the legacy CrossLogin.
     * Both variants are kept because GoodWe has migrated accounts between the
     * two backends without prior notice in the past.
     */
    async login() {
        try {
            const session = await this._loginNew();
            this.log("debug", "SEMS-Login über SEMS+ (neue API) erfolgreich.");
            this.session = session;
            return session;
        } catch (newLoginError) {
            this.log(
                "debug",
                `SEMS+-Login fehlgeschlagen (${newLoginError.message}), versuche Legacy-Login als Fallback.`,
            );
        }

        const session = await this._loginLegacy();
        this.log("debug", "SEMS-Login über Legacy-API erfolgreich.");
        this.session = session;
        return session;
    }

    async _loginNew() {
        const body = JSON.stringify({
            account: this.account,
            pwd: this._hashPasswordForNewLogin(),
            agreement: 1,
            isChinese: false,
            isLocal: false,
        });

        const { json } = await httpPostJson(NEW_LOGIN_URL, {
            method: "POST",
            headers: this._defaultHeaders(),
            body,
            timeoutMs: this.requestTimeoutMs,
        });

        return this._extractSession(json, NEW_LOGIN_FALLBACK_API, "SEMS+");
    }

    async _loginLegacy() {
        const body = JSON.stringify({
            account: this.account,
            pwd: this.password,
        });

        const { json } = await httpPostJson(LEGACY_LOGIN_URL, {
            method: "POST",
            headers: this._defaultHeaders(),
            body,
            timeoutMs: this.requestTimeoutMs,
        });

        return this._extractSession(json, LEGACY_LOGIN_FALLBACK_API, "Legacy");
    }

    _extractSession(json, fallbackApi, variantName) {
        const code = json && json.code;
        if (
            !SUCCESS_CODES.has(code) &&
            !(json && SUCCESS_MESSAGES.has(String(json.msg).toLowerCase()))
        ) {
            const msg =
                (json && (json.msg || json.message)) || "unbekannter Fehler";
            throw new SemsAuthError(
                `SEMS-${variantName}-Login abgelehnt: ${msg} (code=${code})`,
            );
        }

        const data = json && json.data;
        if (!data || !data.token || !data.uid) {
            throw new SemsProtocolError(
                `SEMS-${variantName}-Login lieferte keine verwertbaren Session-Daten (Antwortschlüssel: ${Object.keys(json || {}).join(", ")}).`,
            );
        }

        return {
            uid: data.uid,
            token: data.token,
            timestamp: data.timestamp || Date.now(),
            api: this._validateApiBase(
                (json && json.api) || data.api,
                fallbackApi,
            ),
        };
    }

    /**
     * The login response dictates the base URL for all further (token-carrying)
     * requests. Only accept HTTPS URLs on GoodWe-owned domains; anything else
     * falls back to the known-good regional default. Prevents a manipulated
     * login payload from redirecting the session token to a foreign host.
     *
     * @param {string|undefined} candidate
     * @param {string} fallbackApi
     * @returns {string}
     */
    _validateApiBase(candidate, fallbackApi) {
        if (!candidate || typeof candidate !== "string") {
            return fallbackApi;
        }
        try {
            const url = new URL(candidate);
            const host = url.hostname.toLowerCase();
            const allowed =
                url.protocol === "https:" &&
                (host === "semsportal.com" ||
                    host.endsWith(".semsportal.com") ||
                    host === "goodwe.com" ||
                    host.endsWith(".goodwe.com"));
            if (allowed) {
                return candidate;
            }
        } catch {
            // fall through to fallback
        }
        this.log(
            "warn",
            `SEMS-Login lieferte eine unerwartete API-Basis-URL ("${candidate}") - verwende stattdessen ${fallbackApi}.`,
        );
        return fallbackApi;
    }

    /**
     * Generic authenticated POST against the current session's API base,
     * with a single transparent re-login retry on auth failure.
     *
     * @param {string} path
     * @param {object} payload
     * @param {boolean} [isRetry]
     */
    async _authenticatedPost(path, payload, isRetry = false) {
        if (!this.session) {
            await this.login();
        }

        const url = this.session.api.replace(/\/$/, "") + path;
        const { json } = await httpPostJson(url, {
            method: "POST",
            headers: this._authHeaders(),
            body: JSON.stringify(payload),
            timeoutMs: this.requestTimeoutMs,
        });

        const code = json && json.code;

        if (String(code) === RATE_LIMIT_CODE) {
            throw new SemsRateLimitError(
                `SEMS Portal hat die Anfrage mit Rate-Limit-Code ${RATE_LIMIT_CODE} abgelehnt.`,
                DEFAULT_RATE_LIMIT_RETRY_SECONDS,
            );
        }

        const looksExpired =
            !SUCCESS_CODES.has(code) &&
            typeof (json && (json.msg || json.message)) === "string" &&
            /expired|re-?login|authoriz/i.test(json.msg || json.message);

        if (looksExpired && !isRetry) {
            this.log(
                "debug",
                "SEMS-Session abgelaufen, erneuere Token und wiederhole Anfrage einmalig.",
            );
            this.session = null;
            await this.login();
            return this._authenticatedPost(path, payload, true);
        }

        if (
            !SUCCESS_CODES.has(code) &&
            !(json && SUCCESS_MESSAGES.has(String(json.msg).toLowerCase()))
        ) {
            const msg =
                (json && (json.msg || json.message)) || "unbekannter Fehler";
            throw new SemsProtocolError(
                `SEMS-API-Aufruf ${path} fehlgeschlagen: ${msg} (code=${code})`,
            );
        }

        return json.data;
    }

    /**
     * Auto-discovers the power station(s) owned by the logged-in account.
     * Used when no powerStationId is configured, so the user only ever has
     * to supply the normal SEMS login (requirement: "muss mit dem normalen
     * SEMS Login machbar sein").
     *
     * @returns {Promise<Array<{id:string, name:string}>>}
     */
    async getOwnedPowerStations() {
        const data = await this._authenticatedPost(STATION_LIST_PATH, {});
        if (Array.isArray(data)) {
            return data
                .filter((entry) => entry && typeof entry === "object")
                .map((entry) => ({
                    id:
                        entry.powerStationId ||
                        entry.id ||
                        entry.PowerStationId,
                    name:
                        entry.stationName ||
                        entry.name ||
                        entry.powerStationName ||
                        "",
                }))
                .filter((entry) => entry.id);
        }
        if (data && typeof data === "object") {
            // Some regions return a single object instead of an array for accounts with one plant.
            const id = data.powerStationId || data.id || data.PowerStationId;
            if (id) {
                return [{ id, name: data.stationName || data.name || "" }];
            }
        }
        return [];
    }

    /**
     * Fetches the full monitor detail payload (info / kpi / powerflow / soc /
     * inverter[] / evChargeInfo / ...) for one power station.
     *
     * @param {string} powerStationId
     */
    async getMonitorDetail(powerStationId) {
        if (!powerStationId) {
            throw new SemsProtocolError(
                "getMonitorDetail() ohne powerStationId aufgerufen.",
            );
        }
        return this._authenticatedPost(MONITOR_DETAIL_PATH, { powerStationId });
    }
}

module.exports = {
    SemsApi,
    RATE_LIMIT_CODE,
};
