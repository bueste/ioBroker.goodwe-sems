"use strict";

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

    it("logs in via the new SEMS+ endpoint when it succeeds", async () => {
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
        expect(fetchStub.firstCall.args[0]).to.include("semsplus.goodwe.com");
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

    it("raises SemsRateLimitError with the documented retry-after on GY0429", async () => {
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
            await api.getMonitorDetail("station-1");
        } catch (error) {
            caught = error;
        }
        expect(caught).to.be.instanceOf(SemsRateLimitError);
        expect(caught.retryAfterSeconds).to.equal(300);
    });

    it("transparently re-logs in once when the session looks expired, then retries the call", async () => {
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
            jsonResponse(200, { code: 0, msg: "success", data: { info: { stationname: "OK" } } }),
        );

        const api = newApi();
        await api.login();
        const detail = await api.getMonitorDetail("station-1");

        expect(detail.info.stationname).to.equal("OK");
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

    it("getMonitorDetail() falls back from the v3 to the v2 API path on a 404 (legacy-backend accounts)", async () => {
        fetchStub.onCall(0).resolves(
            jsonResponse(200, {
                code: 0,
                msg: "success",
                api: "https://eu.semsportal.com/api",
                data: { uid: "u1", token: "t1", timestamp: 1 },
            }),
        );
        // v3 path: this backend doesn't know it, responds with a bare {"error_msg": ...} 404 envelope
        fetchStub.onCall(1).resolves(jsonResponse(200, { error_msg: "404 Route Not Found" }));
        // v2 path: succeeds
        fetchStub.onCall(2).resolves(
            jsonResponse(200, { code: 0, msg: "success", data: { info: { stationname: "OK" } } }),
        );

        const api = newApi();
        await api.login();
        const detail = await api.getMonitorDetail("station-1");

        expect(detail.info.stationname).to.equal("OK");
        expect(fetchStub.callCount).to.equal(3);
        expect(fetchStub.getCall(1).args[0]).to.include("/v3/PowerStation/GetMonitorDetailByPowerstationId");
        expect(fetchStub.getCall(2).args[0]).to.include("/v2/PowerStation/GetMonitorDetailByPowerstationId");
    });

    it("getMonitorDetail() surfaces error_msg from a 404 envelope if the v2 fallback also fails", async () => {
        fetchStub.onCall(0).resolves(
            jsonResponse(200, {
                code: 0,
                msg: "success",
                api: "https://eu.semsportal.com/api",
                data: { uid: "u1", token: "t1", timestamp: 1 },
            }),
        );
        fetchStub.onCall(1).resolves(jsonResponse(200, { error_msg: "404 Route Not Found" }));
        fetchStub.onCall(2).resolves(jsonResponse(200, { error_msg: "404 Route Not Found" }));

        const api = newApi();
        await api.login();

        let caught;
        try {
            await api.getMonitorDetail("station-1");
        } catch (error) {
            caught = error;
        }
        expect(caught).to.be.instanceOf(SemsProtocolError);
        expect(caught.message).to.include("404 Route Not Found");
        expect(fetchStub.callCount).to.equal(3);
    });
});
