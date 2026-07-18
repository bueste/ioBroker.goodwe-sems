"use strict";

/*
 * Regression tests for the findings of the security/quality audit:
 *  - state-ID injection via untrusted inverter serials
 *  - crash on null entries in the inverter array
 *  - toNumber mangling scientific notation
 *  - parsePortalTimestamp accepting rollover garbage dates
 *  - session API base URL validation (token exfiltration hardening)
 *  - station discovery returning entries without an id
 */

const { expect } = require("chai");
const sinon = require("sinon");
const {
    mapMonitorDetail,
    toNumber,
    parsePortalTimestamp,
    sanitizeObjectId,
} = require("../../lib/mapping");
const { SemsApi } = require("../../lib/semsApi");

describe("quality gate regressions", () => {
    describe("sanitizeObjectId / state-ID injection", () => {
        it("replaces all ioBroker-forbidden characters in serials", () => {
            expect(sanitizeObjectId("evil.sn*with]chars")).to.equal(
                "evil_sn_with_chars",
            );
            expect(sanitizeObjectId('a b;c\'d"e`f<g>h\\i?j,k')).to.not.match(
                /[^0-9A-Za-z_-]/,
            );
        });

        it("never returns an empty id", () => {
            expect(sanitizeObjectId("...")).to.equal("___");
            expect(sanitizeObjectId("")).to.equal("_");
        });

        it("keeps normal GoodWe serials untouched", () => {
            expect(sanitizeObjectId("9010KETU229W1234")).to.equal(
                "9010KETU229W1234",
            );
        });

        it("uses the sanitized serial in generated state IDs", () => {
            const { points } = mapMonitorDetail({
                inverter: [{ sn: "bad.sn*1", pac: 100 }],
            });
            const ids = points.map((p) => p.id);
            expect(ids).to.include("Inverters.bad_sn_1.CurrentPower");
            for (const id of ids) {
                expect(id).to.not.match(/[*\]\[;'"`<>\\?, ]/);
            }
        });
    });

    describe("broken inverter array entries", () => {
        it("survives null/garbage entries without throwing", () => {
            for (const bad of [null, undefined, 42, "x", []]) {
                expect(() =>
                    mapMonitorDetail({ inverter: [bad] }),
                ).to.not.throw();
            }
        });

        it("still maps the healthy inverters of the same payload", () => {
            const { points, inverterSerials } = mapMonitorDetail({
                inverter: [null, { sn: "GOOD1", pac: 1500 }],
            });
            expect(inverterSerials).to.include("GOOD1");
            expect(
                points.find((p) => p.id === "Inverters.GOOD1.CurrentPower")
                    .value,
            ).to.equal(1500);
        });
    });

    describe("toNumber scientific notation", () => {
        it("parses exponent notation correctly", () => {
            expect(toNumber("1e5")).to.equal(100000);
            expect(toNumber("2.5E3")).to.equal(2500);
            expect(toNumber("-1.5e2")).to.equal(-150);
        });

        it("still strips units from plain values", () => {
            expect(toNumber("1234.5 kWh")).to.equal(1234.5);
        });
    });

    describe("parsePortalTimestamp validation", () => {
        it("rejects rollover garbage instead of producing a bogus epoch", () => {
            expect(parsePortalTimestamp("99/99/9999 99:99:99")).to.equal(
                undefined,
            );
            expect(parsePortalTimestamp("13/01/2026 10:00:00")).to.equal(
                undefined,
            );
            expect(parsePortalTimestamp("01/32/2026 10:00:00")).to.equal(
                undefined,
            );
            expect(parsePortalTimestamp("01/01/2026 24:00:00")).to.equal(
                undefined,
            );
        });

        it("still accepts valid portal timestamps", () => {
            const ts = parsePortalTimestamp("07/18/2026 12:30:45");
            expect(ts).to.be.a("number");
            expect(new Date(ts).getFullYear()).to.equal(2026);
        });
    });

    describe("SemsApi._validateApiBase (token exfiltration hardening)", () => {
        let api;
        beforeEach(() => {
            api = new SemsApi({
                account: "a@b.c",
                password: "x",
                log: sinon.stub(),
            });
        });

        it("accepts GoodWe-owned HTTPS hosts", () => {
            expect(
                api._validateApiBase(
                    "https://eu.semsportal.com/api",
                    "FALLBACK",
                ),
            ).to.equal("https://eu.semsportal.com/api");
            expect(
                api._validateApiBase(
                    "https://semsplus.goodwe.com/web/sems",
                    "FALLBACK",
                ),
            ).to.equal("https://semsplus.goodwe.com/web/sems");
        });

        it("rejects foreign hosts, plain http and lookalike domains", () => {
            for (const bad of [
                "https://evil.example.com/api",
                "http://eu.semsportal.com/api",
                "https://semsportal.com.evil.net/api",
                "https://notsemsportal.com/api",
                "ftp://eu.semsportal.com/api",
                "not a url",
            ]) {
                expect(api._validateApiBase(bad, "FALLBACK")).to.equal(
                    "FALLBACK",
                );
            }
        });

        it("falls back when the field is missing entirely", () => {
            expect(api._validateApiBase(undefined, "FALLBACK")).to.equal(
                "FALLBACK",
            );
            expect(api._validateApiBase(null, "FALLBACK")).to.equal(
                "FALLBACK",
            );
        });
    });

    describe("getOwnedPowerStations id filtering", () => {
        it("drops entries without a usable id", async () => {
            const api = new SemsApi({
                account: "a@b.c",
                password: "x",
                log: sinon.stub(),
            });
            sinon
                .stub(api, "_authenticatedPost")
                .resolves([
                    null,
                    { stationName: "no id here" },
                    { powerStationId: "PS-1", stationName: "Home" },
                ]);
            const stations = await api.getOwnedPowerStations();
            expect(stations).to.deep.equal([{ id: "PS-1", name: "Home" }]);
        });
    });
});
