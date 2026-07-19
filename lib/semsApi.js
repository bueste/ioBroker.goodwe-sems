"use strict";

const crypto = require("node:crypto");
const { SemsAuthError, SemsRateLimitError, SemsNetworkError, SemsProtocolError } = require("./errors");

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
const NEW_LOGIN_URL = "https://semsplus.goodwe.com/web/sems/sems-user/api/v1/auth/cross-login";
// Legacy login, kept as a fallback for accounts / regions where the new
// endpoint is unavailable or rejects the credentials.
const LEGACY_LOGIN_URL = "https://www.semsportal.com/api/v3/Common/CrossLogin";

// Both logins return an "api" field with the region-specific base URL to use
// for all further calls. If that field is missing we fall back to these.
const NEW_LOGIN_FALLBACK_API = "https://eu-gateway.semsportal.com/web/sems";
const LEGACY_LOGIN_FALLBACK_API = "https://eu.semsportal.com/api";

const STATION_LIST_PATH = "/PowerStation/GetPowerStationIdByOwner";
// GoodWe backends have been observed to expose GetMonitorDetailByPowerstationId
// under different API versions depending on account/region/backend generation.
// Community references disagree: pygoodwe (github.com/yaleman/pygoodwe) hardcodes
// "v2", a 2023 write-up (binodmx.medium.com) uses "v1", and our own traffic
// inspection against a SEMS+ account observed "v3". A real-world legacy-login
// account (SEMS+ login rejected with code=C0602) 404'd on BOTH v3 and v2, so
// none of the single hardcoded versions are reliable - we try all three,
// newest first, and use whichever one doesn't 404.
const MONITOR_DETAIL_PATHS = [
    "/v3/PowerStation/GetMonitorDetailByPowerstationId",
    "/v2/PowerStation/GetMonitorDetailByPowerstationId",
    "/v1/PowerStation/GetMonitorDetailByPowerstationId",
];

// --- SEMS+ "gateway" API (eu-gateway.semsportal.com) -----------------------
// Some accounts' session ("api" field from CrossLogin) resolves to a modern
// microservice gateway host instead of the classic semsportal.com backend -
// confirmed against a real account where ALL THREE classic paths above
// 404'd. That gateway speaks a completely different, undocumented API:
// different paths (e.g. "/sems-plant/api/stations/flow"), a different
// response envelope (top-level "code":"00000" instead of 0, "description"
// instead of "msg"), AND every request additionally requires a computed
// "x-signature" header or the gateway silently rejects it. The signature
// scheme was reverse-engineered from ~230 real request/response pairs
// captured from the eu-semsplus.goodwe.com web app (100% match, no
// exceptions found):
//   x-signature = base64( sha256(`${ts}@${uid}@${token}`).hexdigest() + "@" + ts )
// where `ts` is the request's own signing time in epoch milliseconds
// (Date.now() at call time - independent of the token's login timestamp)
// and uid/token are the same values sent in the "token" header.
const GATEWAY_CLIENT = "semsPlusWeb";

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
 * @param {{setTimeout: (cb: () => void, ms: number) => *, clearTimeout: (timer: *) => void}} timerFns adapter-managed
 *   timer functions (falls back to the global ones so this stays unit-testable)
 * @returns {Promise<{status:number, json: object, text: string}>}
 */
async function httpPostJson(url, init, timerFns) {
    const { timeoutMs, ...fetchInit } = init;
    const setTimeoutFn = (timerFns && timerFns.setTimeout) || setTimeout;
    const clearTimeoutFn = (timerFns && timerFns.clearTimeout) || clearTimeout;
    const controller = new AbortController();
    const timer = setTimeoutFn(() => controller.abort(), timeoutMs);
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
            throw new SemsProtocolError(`Antwort von ${url} war kein gültiges JSON: ${parseError.message}`);
        }
        return { status: response.status, json, text };
    } catch (error) {
        if (error.name === "AbortError") {
            throw new SemsNetworkError(`Zeitüberschreitung nach ${timeoutMs} ms bei ${url}`);
        }
        if (error instanceof SemsProtocolError) {
            throw error;
        }
        throw new SemsNetworkError(`Netzwerkfehler bei ${url}: ${error.message}`);
    } finally {
        clearTimeoutFn(timer);
    }
}

/**
 * Converts the gateway API's metadata-driven "factors" arrays (used by both
 * the telemetry and telecounting endpoints) into a flat {code: rawValue}
 * lookup. Each response is an array of named groups (e.g. "ac_parameters",
 * "telecounting_today"), each holding a "factors" array of
 * {code, data, dataType, unit, alias, ...} entries - we only need the inner
 * code/data pairs. A field simply being absent from "data" (observed e.g.
 * at night, when a value is omitted entirely instead of being sent as 0) is
 * preserved as `undefined` rather than guessed at.
 *
 * @param {Array<{code?:string, factors?: Array<{code:string, data?: *}>}>} groups
 * @returns {Record<string, *>}
 */
function flattenGatewayFactors(groups) {
    const flat = {};
    if (!Array.isArray(groups)) {
        return flat;
    }
    for (const group of groups) {
        const factors = Array.isArray(group && group.factors) ? group.factors : [group];
        for (const factor of factors) {
            if (factor && factor.code !== undefined) {
                flat[factor.code] = factor.data;
            }
        }
    }
    return flat;
}

/**
 * Minimal numeric coercion for gateway values we need to do arithmetic on
 * (kW->W scaling, summing across inverters).
 *
 * @param {*} value
 */
function gatewayNum(value) {
    if (value === undefined || value === null || value === "") {
        return undefined;
    }
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
}

class SemsApi {
    /**
     * @param {object} opts
     * @param {string} opts.account SEMS portal login (e-mail)
     * @param {string} opts.password SEMS portal password (plain text, hashed internally as required)
     * @param {number} [opts.requestTimeoutMs] per-request timeout
     * @param {(level:string, message:string)=>void} opts.log adapter logger bridge, called as log(level, message)
     * @param {(cb: () => void, ms: number) => *} [opts.setTimeoutFn] adapter-managed setTimeout (e.g. adapter.setTimeout.bind(adapter)),
     *   so request-timeout timers get cleaned up automatically on adapter unload. Falls back to the global one.
     * @param {(timer: *) => void} [opts.clearTimeoutFn] matching adapter-managed clearTimeout
     */
    constructor({ account, password, requestTimeoutMs = 15000, log, setTimeoutFn, clearTimeoutFn }) {
        if (!account || !password) {
            throw new SemsAuthError("SEMS-Zugangsdaten (Benutzer/Passwort) fehlen in der Adapter-Konfiguration.");
        }
        this.account = account;
        this.password = password;
        this.requestTimeoutMs = requestTimeoutMs;
        this.log = log || (() => {});
        this._timerFns = {
            setTimeout: setTimeoutFn || setTimeout,
            clearTimeout: clearTimeoutFn || clearTimeout,
        };

        this.session = null;
    }

    /** MD5(password), base64 encoded - required by the "new" SEMS+ login endpoint. */
    _hashPasswordForNewLogin() {
        const md5Hex = crypto.createHash("md5").update(this.password, "utf8").digest("hex");
        return Buffer.from(md5Hex, "utf8").toString("base64");
    }

    _defaultHeaders(extraTokenPayload) {
        return {
            "Content-Type": "application/json",
            Accept: "application/json, */*;q=0.5",
            "User-Agent": DEFAULT_USER_AGENT,
            Token: extraTokenPayload ? JSON.stringify(extraTokenPayload) : DEFAULT_CLIENT_TOKEN,
        };
    }

    _authHeaders() {
        if (!this.session) {
            throw new SemsAuthError("Keine aktive SEMS-Session - login() wurde nicht (erfolgreich) aufgerufen.");
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
            this.log("debug", `SEMS-Login über SEMS+ (neue API) erfolgreich. API-Basis: ${session.api}`);
            this.session = session;
            return session;
        } catch (newLoginError) {
            this.log(
                "debug",
                `SEMS+-Login fehlgeschlagen (${newLoginError.message}), versuche Legacy-Login als Fallback.`,
            );
        }

        const session = await this._loginLegacy();
        this.log("debug", `SEMS-Login über Legacy-API erfolgreich. API-Basis: ${session.api}`);
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

        const { json } = await httpPostJson(
            NEW_LOGIN_URL,
            {
                method: "POST",
                headers: this._defaultHeaders(),
                body,
                timeoutMs: this.requestTimeoutMs,
            },
            this._timerFns,
        );

        return this._extractSession(json, NEW_LOGIN_FALLBACK_API, "SEMS+");
    }

    async _loginLegacy() {
        const body = JSON.stringify({
            account: this.account,
            pwd: this.password,
        });

        const { json } = await httpPostJson(
            LEGACY_LOGIN_URL,
            {
                method: "POST",
                headers: this._defaultHeaders(),
                body,
                timeoutMs: this.requestTimeoutMs,
            },
            this._timerFns,
        );

        return this._extractSession(json, LEGACY_LOGIN_FALLBACK_API, "Legacy");
    }

    _extractSession(json, fallbackApi, variantName) {
        const code = json && json.code;
        if (!SUCCESS_CODES.has(code) && !(json && SUCCESS_MESSAGES.has(String(json.msg).toLowerCase()))) {
            const msg = (json && (json.msg || json.message || json.error_msg)) || "unbekannter Fehler";
            throw new SemsAuthError(`SEMS-${variantName}-Login abgelehnt: ${msg} (code=${code})`);
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
            api: this._validateApiBase((json && json.api) || data.api, fallbackApi),
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
        const { json } = await httpPostJson(
            url,
            {
                method: "POST",
                headers: this._authHeaders(),
                body: JSON.stringify(payload),
                timeoutMs: this.requestTimeoutMs,
            },
            this._timerFns,
        );

        // Always log the raw envelope (with the full request URL, not just the relative
        // path) at debug level - not just on error. Some SEMS endpoints use success/error
        // conventions, or even entirely different API bases/paths, that differ from the
        // ones this adapter was originally built and tested against, so this is the
        // fastest way to diagnose reports from real accounts without needing access to
        // the account's credentials.
        this.log("debug", `SEMS-API-Antwort ${url}: ${JSON.stringify(json)}`);

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
            this.log("debug", "SEMS-Session abgelaufen, erneuere Token und wiederhole Anfrage einmalig.");
            this.session = null;
            await this.login();
            return this._authenticatedPost(path, payload, true);
        }

        if (!SUCCESS_CODES.has(code) && !(json && SUCCESS_MESSAGES.has(String(json.msg).toLowerCase()))) {
            const msg = (json && (json.msg || json.message || json.error_msg)) || "unbekannter Fehler";
            throw new SemsProtocolError(`SEMS-API-Aufruf ${path} fehlgeschlagen: ${msg} (code=${code})`);
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
                .filter(entry => entry && typeof entry === "object")
                .map(entry => ({
                    id: entry.powerStationId || entry.id || entry.PowerStationId,
                    name: entry.stationName || entry.name || entry.powerStationName || "",
                }))
                .filter(entry => entry.id);
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
            throw new SemsProtocolError("getMonitorDetail() ohne powerStationId aufgerufen.");
        }
        let lastError;
        for (let i = 0; i < MONITOR_DETAIL_PATHS.length; i++) {
            const path = MONITOR_DETAIL_PATHS[i];
            try {
                return await this._authenticatedPost(path, { powerStationId });
            } catch (error) {
                lastError = error;
                const is404 = error instanceof SemsProtocolError && /404|route not found/i.test(error.message);
                if (!is404) {
                    throw error;
                }
                const nextPath = MONITOR_DETAIL_PATHS[i + 1];
                if (nextPath) {
                    this.log(
                        "debug",
                        `${path} nicht gefunden (404) - versuche ${nextPath} als Fallback (API-Version unterschiedlich je nach Konto/Backend).`,
                    );
                } else {
                    this.log(
                        "debug",
                        `${path} nicht gefunden (404) - alle klassischen PowerStation-Pfade fehlgeschlagen, versuche die SEMS+-Gateway-API als letzten Fallback.`,
                    );
                }
            }
        }
        try {
            return await this._getMonitorDetailGateway(powerStationId);
        } catch (gatewayError) {
            this.log(
                "debug",
                `SEMS+-Gateway-Fallback ebenfalls fehlgeschlagen (${gatewayError.message}) - melde den ursprünglichen Fehler.`,
            );
            throw lastError;
        }
    }

    /**
     * SHA-256-based request signature required by the SEMS+ gateway API - see the GATEWAY_CLIENT comment above.
     *
     * @param {string} uid
     * @param {string} token
     */
    _gatewaySignature(uid, token) {
        const ts = Date.now();
        const hash = crypto.createHash("sha256").update(`${ts}@${uid}@${token}`, "utf8").digest("hex");
        return Buffer.from(`${hash}@${ts}`, "utf8").toString("base64");
    }

    /** Derives the gateway host from the current session's (already validated) API base. */
    _gatewayBase() {
        if (!this.session) {
            throw new SemsAuthError("Keine aktive SEMS-Session - login() wurde nicht (erfolgreich) aufgerufen.");
        }
        let host;
        try {
            host = new URL(this.session.api).hostname;
        } catch {
            host = "eu-gateway.semsportal.com";
        }
        return `https://${host}/web/sems`;
    }

    _gatewayHeaders(gatewayBase) {
        const tokenPayload = {
            uid: this.session.uid,
            timestamp: String(this.session.timestamp),
            token: this.session.token,
            client: GATEWAY_CLIENT,
            version: "",
            language: "en",
            api: gatewayBase,
            region: "eu",
        };
        return {
            "Content-Type": "application/json",
            Accept: "application/json, text/plain, */*",
            "User-Agent": DEFAULT_USER_AGENT,
            token: JSON.stringify(tokenPayload),
            "x-signature": this._gatewaySignature(this.session.uid, this.session.token),
        };
    }

    /**
     * Authenticated request against the SEMS+ gateway API (a different
     * backend from the classic PowerStation API - see the GATEWAY_CLIENT
     * comment above). No automatic re-login-and-retry here (unlike
     * _authenticatedPost): if the gateway session is stale, getMonitorDetail()
     * will simply fall through to its own caller's retry/re-login handling
     * on the next poll cycle.
     *
     * @param {"GET"|"POST"} method
     * @param {string} path e.g. "/sems-plant/api/stations/flow"
     * @param {object} [query] query-string params
     */
    async _gatewayRequest(method, path, query) {
        if (!this.session) {
            await this.login();
        }
        const base = this._gatewayBase();
        const qs = query && Object.keys(query).length ? new URLSearchParams(query).toString() : "";
        const url = base + path + (qs ? `?${qs}` : "");

        const { json } = await httpPostJson(
            url,
            {
                method,
                headers: this._gatewayHeaders(base),
                timeoutMs: this.requestTimeoutMs,
            },
            this._timerFns,
        );

        this.log("debug", `SEMS-Gateway-Antwort ${url}: ${JSON.stringify(json)}`);

        const code = json && json.code;
        if (!SUCCESS_CODES.has(code)) {
            const msg = (json && (json.description || json.msg || json.message)) || "unbekannter Fehler";
            throw new SemsProtocolError(`SEMS-Gateway-Aufruf ${path} fehlgeschlagen: ${msg} (code=${code})`);
        }
        return json.data;
    }

    /**
     * Gateway equivalent of the classic GetMonitorDetailByPowerstationId call:
     * fetches station basic info, the device list and per-device
     * telemetry/telecounting from the SEMS+ gateway API, and reshapes the
     * result into the SAME "detail" object shape the classic API returns
     * (info/kpi/inverter[]/...), so lib/mapping.js's mapMonitorDetail() does
     * not need to know (or care) which backend the data actually came from.
     *
     * Deliberately conservative for its first version: only fields with a
     * confirmed unit/shape (from the gateway's own response metadata or
     * direct observation) are populated. In particular, the station-level
     * "stations/flow" endpoint (PV/load/grid/battery power split) is NOT
     * used yet - every real-account capture so far happened at night, where
     * it returns an empty object, so neither its field names nor its unit
     * could be confirmed. kpi.pac/power/total_power are instead computed by
     * summing the per-inverter telemetry/telecounting values, which DO carry
     * confirmed units ("kW"/"kWh") in the API's own response metadata.
     *
     * @param {string} powerStationId
     */
    async _getMonitorDetailGateway(powerStationId) {
        const basicInfo =
            (await this._gatewayRequest("POST", "/sems-plant/api/portal/stations/basic/info", {
                stationId: powerStationId,
            })) || {};

        let deviceList = [];
        try {
            const allStatus = await this._gatewayRequest("GET", "/sems-plant/api/stations/device/all-status", {
                stationId: powerStationId,
            });
            const detailLists = (allStatus && allStatus.deviceDetailList) || [];
            for (const typeGroup of detailLists) {
                const statusDetails = Array.isArray(typeGroup && typeGroup.statusDetailList)
                    ? typeGroup.statusDetailList
                    : [];
                for (const statusDetail of statusDetails) {
                    const detailMap = (statusDetail && statusDetail.detailMap) || {};
                    for (const sn of Object.keys(detailMap)) {
                        deviceList.push({
                            sn,
                            deviceType: (typeGroup && typeGroup.deviceType) || "INVERTER",
                            ...detailMap[sn],
                        });
                    }
                }
            }
        } catch (error) {
            this.log("debug", `SEMS-Gateway: Geräteliste nicht verfügbar (${error.message}).`);
        }

        const inverters = [];
        for (const device of deviceList) {
            const sn = device && device.sn;
            if (!sn) {
                continue;
            }
            const deviceType = device.deviceType || "INVERTER";
            let telemetryFlat = {};
            let telecountingFlat = {};
            try {
                const telemetry = await this._gatewayRequest(
                    "GET",
                    `/sems-plant/api/equipments/${encodeURIComponent(sn)}/telemetry`,
                    { deviceType, pwId: powerStationId },
                );
                telemetryFlat = flattenGatewayFactors(telemetry);
            } catch (error) {
                this.log("debug", `SEMS-Gateway: telemetry für ${sn} fehlgeschlagen (${error.message}).`);
            }
            try {
                const telecounting = await this._gatewayRequest(
                    "GET",
                    `/sems-plant/api/equipments/${encodeURIComponent(sn)}/telecounting`,
                    { deviceType, pwId: powerStationId },
                );
                telecountingFlat = flattenGatewayFactors(telecounting);
            } catch (error) {
                this.log("debug", `SEMS-Gateway: telecounting für ${sn} fehlgeschlagen (${error.message}).`);
            }

            const pacKw = gatewayNum(telemetryFlat.pAc);
            inverters.push({
                sn,
                name: device.name,
                status: device.status,
                pac: pacKw === undefined ? undefined : pacKw * 1000,
                eday: gatewayNum(telecountingFlat.proPvStatsToday),
                etotal: gatewayNum(telecountingFlat.proPvStatsTotal),
                temperature: telemetryFlat.Temperature,
                invert_full: {
                    vpv1: telemetryFlat["MPPT-1:Vpv"],
                    ipv1: telemetryFlat["MPPT-1:Ipv"],
                    vpv2: telemetryFlat["MPPT-2:Vpv"],
                    ipv2: telemetryFlat["MPPT-2:Ipv"],
                    vac1: telemetryFlat["PHASE-A:Vac"],
                    iac1: telemetryFlat["PHASE-A:Iac"],
                    fac1: telemetryFlat.Fac,
                    vac2: telemetryFlat["PHASE-B:Vac"],
                    iac2: telemetryFlat["PHASE-B:Iac"],
                    fac2: telemetryFlat.Fac,
                    vac3: telemetryFlat["PHASE-C:Vac"],
                    iac3: telemetryFlat["PHASE-C:Iac"],
                    fac3: telemetryFlat.Fac,
                },
            });
        }

        const totalPac = inverters.length
            ? inverters.reduce((sum, inv) => sum + (Number.isFinite(inv.pac) ? inv.pac : 0), 0)
            : undefined;
        const totalToday = inverters.length
            ? inverters.reduce((sum, inv) => sum + (Number.isFinite(inv.eday) ? inv.eday : 0), 0)
            : undefined;
        const totalLifetime = inverters.length
            ? inverters.reduce((sum, inv) => sum + (Number.isFinite(inv.etotal) ? inv.etotal : 0), 0)
            : undefined;

        return {
            info: {
                stationname: basicInfo.name,
                capacity: basicInfo.pvCapacity !== undefined ? basicInfo.pvCapacity : basicInfo.installedPower,
                address: basicInfo.googleAddress || basicInfo.address,
                latitude: basicInfo.latitude,
                longitude: basicInfo.longitude,
                status: basicInfo.status,
            },
            kpi: {
                pac: totalPac,
                power: totalToday,
                total_power: totalLifetime,
            },
            inverter: inverters,
        };
    }
}

module.exports = {
    SemsApi,
    RATE_LIMIT_CODE,
};
