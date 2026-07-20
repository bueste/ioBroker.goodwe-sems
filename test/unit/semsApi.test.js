"use strict";

const crypto = require("node:crypto");
const { expect } = require("chai");
const sinon = require("sinon");
const { SemsApi } = require("../../lib/semsApi");
const { SemsAuthError, SemsRateLimitError, SemsNetworkError, SemsProtocolError } = require("../../lib/errors");

function jsonResponse(status, body) {
    return {
        status,
        text: async () => JSON.stringify(body),
    };
}

describe("lib/semsApi SemsApi", () => {
    let fetchStub;
    let noopLog;

    beforeEach(() => {
        fetchStub = sinon.stub(global, "fetch");
        noopLog = sinon.spy();
    });

    afterEach(() => {
        fetchStub.restore();
    });

    function newApi() {
        return new SemsApi({ account: "test@example.com", password: "s3cret", requestTimeoutMs: 1000, log: noopLog });
    }

    it("throws SemsAuthError immediately if credentials are missing", () => {
        expect(() => new SemsApi({ account: "", password: "", log: noopLog })).to.throw(SemsAuthError);
    });

    it("logs in via the new SEMS+ endpoint (EU-regional host, not the global one) when it succeeds", async () => {
        fetchStub.resolves(
            jsonResponse(200, {
                code: 0,
                msg: "success",
                api: "https://eu.semsportal.com/api",
                data: { uid: "u1", token: "t1", timestamp: 123 },
            }),
        );

        const api = newApi();
        const session = await api.login();

        expect(session.token).to.equal("t1");
        expect(fetchStub.calledOnce).to.equal(true);
        // Must be the EU-regional host - the global "semsplus.goodwe.com" host
        // (without the "eu-" prefix) has been confirmed to reject valid
        // credentials for real accounts (see comment above NEW_LOGIN_URL).
        expect(fetchStub.firstCall.args[0]).to.equal(
            "https://eu-semsplus.goodwe.com/web/sems/sems-user/api/v1/auth/cross-login",
        );
        // Must identify as the real semsPlusWeb browser client (not the
        // iOS-app identity used for the classic/legacy endpoints) and carry
        // an x-signature header, matching real browser traffic exactly -
        // sending the wrong client identity to this web-only endpoint is a
        // plausible cause of real "C0602 account_login_abnormal" rejections.
        const headers = fetchStub.firstCall.args[1].headers;
        expect(headers).to.have.property("x-signature");
        expect(headers["User-Agent"]).to.not.include("PVMaster");
        const tokenHeader = JSON.parse(headers.token);
        expect(tokenHeader.client).to.equal("semsPlusWeb");
    });

    it("falls back to the legacy CrossLogin endpoint if the new one fails", async () => {
        fetchStub.onCall(0).resolves(jsonResponse(200, { code: 100, msg: "unsupported client" }));
        fetchStub.onCall(1).resolves(
            jsonResponse(200, {
                code: 0,
                msg: "success",
                api: "https://eu.semsportal.com/api",
                data: { uid: "u2", token: "t2", timestamp: 456 },
            }),
        );

        const api = newApi();
        const session = await api.login();

        expect(session.token).to.equal("t2");
        expect(fetchStub.callCount).to.equal(2);
        expect(fetchStub.secondCall.args[0]).to.include("semsportal.com/api/v3/Common/CrossLogin");
    });

    it("throws SemsAuthError if both login variants are rejected", async () => {
        fetchStub.resolves(jsonResponse(200, { code: 999, msg: "invalid password" }));

        const api = newApi();
        await expect(api.login()).to.be.rejectedWith(SemsAuthError);
    });

    it("raises SemsRateLimitError with the documented retry-after on GY0429 (classic _authenticatedPost path, exercised via getOwnedPowerStations)", async () => {
        fetchStub.onCall(0).resolves(
            jsonResponse(200, {
                code: 0,
                msg: "success",
                api: "https://eu.semsportal.com/api",
                data: { uid: "u1", token: "t1", timestamp: 1 },
            }),
        );
        fetchStub.onCall(1).resolves(jsonResponse(200, { code: "GY0429", msg: "too many requests" }));

        const api = newApi();
        await api.login();

        let caught;
        try {
            await api.getOwnedPowerStations();
        } catch (error) {
            caught = error;
        }
        expect(caught).to.be.instanceOf(SemsRateLimitError);
        expect(caught.retryAfterSeconds).to.equal(300);
    });

    it("transparently re-logs in once when the classic session looks expired, then retries the call (via getOwnedPowerStations)", async () => {
        fetchStub.onCall(0).resolves(
            jsonResponse(200, {
                code: 0,
                msg: "success",
                api: "https://eu.semsportal.com/api",
                data: { uid: "u1", token: "t1", timestamp: 1 },
            }),
        );
        // first data call: session expired
        fetchStub.onCall(1).resolves(jsonResponse(200, { code: 100002, msg: "Authorization expired, please re-login" }));
        // re-login
        fetchStub.onCall(2).resolves(
            jsonResponse(200, {
                code: 0,
                msg: "success",
                api: "https://eu.semsportal.com/api",
                data: { uid: "u1", token: "t-new", timestamp: 2 },
            }),
        );
        // retried data call succeeds
        fetchStub.onCall(3).resolves(
            jsonResponse(200, { code: 0, msg: "success", data: [{ powerStationId: "id-1", stationName: "Anlage 1" }] }),
        );

        const api = newApi();
        await api.login();
        const stations = await api.getOwnedPowerStations();

        expect(stations).to.deep.equal([{ id: "id-1", name: "Anlage 1" }]);
        expect(fetchStub.callCount).to.equal(4);
    });

    it("wraps network failures (timeout/abort) as SemsNetworkError", async () => {
        fetchStub.onCall(0).resolves(
            jsonResponse(200, {
                code: 0,
                msg: "success",
                api: "https://eu.semsportal.com/api",
                data: { uid: "u1", token: "t1", timestamp: 1 },
            }),
        );
        fetchStub.onCall(1).rejects(Object.assign(new Error("aborted"), { name: "AbortError" }));

        const api = newApi();
        await api.login();
        await expect(api.getMonitorDetail("station-1")).to.be.rejectedWith(SemsNetworkError);
    });

    it("wraps non-JSON responses as SemsProtocolError", async () => {
        fetchStub.resolves({ status: 200, text: async () => "<html>not json</html>" });
        const api = newApi();
        await expect(api.login()).to.be.rejectedWith(SemsProtocolError);
    });

    it("getOwnedPowerStations() normalises array responses", async () => {
        fetchStub.onCall(0).resolves(
            jsonResponse(200, {
                code: 0,
                msg: "success",
                api: "https://eu.semsportal.com/api",
                data: { uid: "u1", token: "t1", timestamp: 1 },
            }),
        );
        fetchStub.onCall(1).resolves(
            jsonResponse(200, {
                code: 0,
                msg: "success",
                data: [{ powerStationId: "id-1", stationName: "Anlage 1" }],
            }),
        );

        const api = newApi();
        await api.login();
        const stations = await api.getOwnedPowerStations();
        expect(stations).to.deep.equal([{ id: "id-1", name: "Anlage 1" }]);
    });

    it("getMonitorDetail() calls the SEMS+ gateway API directly (no classic PowerStation probing), using the real signature scheme", async () => {
        fetchStub.onCall(0).resolves(
            jsonResponse(200, {
                code: 0,
                msg: "success",
                api: "https://eu-gateway.semsportal.com/sems",
                data: { uid: "u1", token: "t1", timestamp: 1784490221381 },
            }),
        );
        fetchStub.onCall(1).resolves(
            jsonResponse(200, {
                code: "00000",
                description: "成功",
                data: { name: "Test Station", pvCapacity: 12.18, googleAddress: "Somewhere 1", status: "0" },
            }),
        );
        fetchStub.onCall(2).resolves(
            jsonResponse(200, {
                code: "00000",
                description: "成功",
                data: {
                    total: 1,
                    deviceDetailList: [
                        {
                            deviceType: "INVERTER",
                            statusDetailList: [
                                {
                                    detailMap: {
                                        SN123: { sn: "SN123", name: "Garage", deviceType: "INVERTER", status: 0 },
                                    },
                                },
                            ],
                        },
                    ],
                },
            }),
        );
        fetchStub.onCall(3).resolves(
            jsonResponse(200, {
                code: "00000",
                description: "成功",
                data: [{ code: "ac", factors: [{ code: "pAc", data: "2.5", unit: "kW" }] }],
            }),
        );
        fetchStub.onCall(4).resolves(
            jsonResponse(200, {
                code: "00000",
                description: "成功",
                data: [{ code: "telecounting_today", factors: [{ code: "proPvStatsToday", data: "12.3" }] }],
            }),
        );

        const api = newApi();
        await api.login();
        const detail = await api.getMonitorDetail("station-1");

        // Only 5 calls total: login + basic/info + device list + telemetry +
        // telecounting - no classic /v3//v2//v1 PowerStation probing at all.
        expect(fetchStub.callCount).to.equal(5);
        expect(fetchStub.getCall(1).args[0]).to.include("/sems-plant/api/portal/stations/basic/info");

        expect(detail.info.stationname).to.equal("Test Station");
        expect(detail.info.capacity).to.equal(12.18);
        expect(detail.kpi.pac).to.equal(2500);
        expect(detail.kpi.power).to.equal(12.3);
        expect(detail.inverter).to.have.lengthOf(1);
        expect(detail.inverter[0].sn).to.equal("SN123");
        expect(detail.inverter[0].pac).to.equal(2500);

        // Verify the x-signature header on the gateway calls matches the
        // real, empirically reverse-engineered formula (see GATEWAY_CLIENT
        // comment in lib/semsApi.js): base64(sha256(`${ts}@${uid}@${token}`) + "@" + ts).
        const basicInfoCall = fetchStub.getCall(1);
        const headers = basicInfoCall.args[1].headers;
        expect(headers).to.have.property("x-signature");
        const decoded = Buffer.from(headers["x-signature"], "base64").toString("utf8");
        const [hash, ts] = decoded.split("@");
        const expectedHash = crypto.createHash("sha256").update(`${ts}@u1@t1`).digest("hex");
        expect(hash).to.equal(expectedHash);
        const tokenHeader = JSON.parse(headers.token);
        expect(tokenHeader).to.include({ uid: "u1", token: "t1", client: "semsPlusWeb" });
    });

    it("getMonitorDetail() re-logins once and retries on a stale gateway session, then succeeds", async () => {
        fetchStub.onCall(0).resolves(
            jsonResponse(200, {
                code: 0,
                msg: "success",
                api: "https://eu-gateway.semsportal.com/sems",
                data: { uid: "u1", token: "t1", timestamp: 1 },
            }),
        );
        // First basic/info call: stale session, rejected.
        fetchStub.onCall(1).resolves(
            jsonResponse(200, { code: "C0602", description: "账号登录异常", translationCode: "account_login_abnormal" }),
        );
        // Automatic re-login...
        fetchStub.onCall(2).resolves(
            jsonResponse(200, {
                code: 0,
                msg: "success",
                api: "https://eu-gateway.semsportal.com/sems",
                data: { uid: "u2", token: "t2", timestamp: 2 },
            }),
        );
        // ...then the SAME basic/info call retried with the fresh session succeeds.
        fetchStub.onCall(3).resolves(
            jsonResponse(200, { code: "00000", description: "成功", data: { name: "Recovered Station" } }),
        );
        // Device list: empty, so no further per-device calls are made.
        fetchStub.onCall(4).resolves(jsonResponse(200, { code: "00000", description: "成功", data: { total: 0 } }));

        const api = newApi();
        await api.login();
        const detail = await api.getMonitorDetail("station-1");

        expect(detail.info.stationname).to.equal("Recovered Station");
        expect(fetchStub.callCount).to.equal(5);
        // The retried basic/info call must use the NEW session's credentials.
        const retriedTokenHeader = JSON.parse(fetchStub.getCall(3).args[1].headers.token);
        expect(retriedTokenHeader).to.include({ uid: "u2", token: "t2" });
    });

    it("getMonitorDetail() throws if the gateway fails again even after the one automatic re-login retry", async () => {
        fetchStub.onCall(0).resolves(
            jsonResponse(200, {
                code: 0,
                msg: "success",
                api: "https://eu-gateway.semsportal.com/sems",
                data: { uid: "u1", token: "t1", timestamp: 1 },
            }),
        );
        fetchStub.onCall(1).resolves(jsonResponse(200, { code: "C0602", description: "账号登录异常" }));
        fetchStub.onCall(2).resolves(
            jsonResponse(200, {
                code: 0,
                msg: "success",
                api: "https://eu-gateway.semsportal.com/sems",
                data: { uid: "u2", token: "t2", timestamp: 2 },
            }),
        );
        // Retry fails too - must give up after exactly one retry, not loop forever.
        fetchStub.onCall(3).resolves(jsonResponse(200, { code: "C0602", description: "账号登录异常" }));

        const api = newApi();
        await api.login();

        let caught;
        try {
            await api.getMonitorDetail("station-1");
        } catch (error) {
            caught = error;
        }
        expect(caught).to.be.instanceOf(SemsProtocolError);
        expect(caught.message).to.include("账号登录异常");
        expect(fetchStub.callCount).to.equal(4);
    });
});
