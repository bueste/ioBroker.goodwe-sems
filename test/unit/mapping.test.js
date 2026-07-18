"use strict";

const { expect } = require("chai");
const { mapMonitorDetail, pickNumber, parsePortalTimestamp, toNumber } = require("../../lib/mapping");

function findPoint(points, id) {
    return points.find((p) => p.id === id);
}

describe("lib/mapping", () => {
    describe("toNumber / pickNumber", () => {
        it("parses plain numbers", () => {
            expect(toNumber(42)).to.equal(42);
        });
        it("parses numeric strings", () => {
            expect(toNumber("12.5")).to.equal(12.5);
        });
        it("strips units like '(W)'", () => {
            expect(toNumber("1234(W)")).to.equal(1234);
        });
        it("returns undefined for garbage", () => {
            expect(toNumber("n/a")).to.equal(undefined);
            expect(toNumber(null)).to.equal(undefined);
            expect(toNumber(undefined)).to.equal(undefined);
        });
        it("picks the first present candidate key", () => {
            expect(pickNumber({ b: "7" }, ["a", "b", "c"])).to.equal(7);
        });
    });

    describe("parsePortalTimestamp", () => {
        it("parses the MM/DD/YYYY HH:mm:ss portal format", () => {
            const ms = parsePortalTimestamp("03/21/2026 14:05:09");
            const d = new Date(ms);
            expect(d.getFullYear()).to.equal(2026);
            expect(d.getMonth()).to.equal(2); // March -> index 2
            expect(d.getDate()).to.equal(21);
            expect(d.getHours()).to.equal(14);
        });
        it("returns undefined for unparsable input", () => {
            expect(parsePortalTimestamp("not-a-date")).to.equal(undefined);
            expect(parsePortalTimestamp(undefined)).to.equal(undefined);
        });
    });

    describe("mapMonitorDetail", () => {
        const fixture = {
            info: {
                stationname: "Testanlage Schwiegervater",
                capacity: "9.9",
                address: "Musterstrasse 1",
                latitude: 47.1,
                longitude: 8.5,
                time: "03/21/2026 14:05:09",
                status: 1,
            },
            kpi: {
                pac: "3450(W)",
                power: "12.3",
                month_generation: "210.4",
                total_power: "9821.6",
                day_income: "3.20",
                total_income: "1980.10",
                currency: "CHF",
            },
            powerflow: {
                pv: "3450(W)",
                load: "980(W)",
                bettery: "-500(W)",
                grid: "1970(W)",
                loadStatus: -1,
                gridStatus: 1,
                pvStatus: 1,
                betteryStatus: -1,
            },
            soc: { power: "76", status: 1 },
            isEvCharge: false,
            inverter: [
                {
                    sn: "9020KETU229W0001",
                    name: "Inverter 1",
                    status: 1,
                    warning: 0,
                    pac: 1720,
                    eday: 6.1,
                    etotal: 4821.3,
                    tempperature: 41.2,
                    soc: 76,
                    invert_full: {
                        vpv1: 320.5,
                        ipv1: 4.1,
                        vpv2: 318.2,
                        ipv2: 3.9,
                        vac1: 231.2,
                        iac1: 6.2,
                        fac1: 50.01,
                        vbattery1: 52.3,
                        ibattery1: -1.1,
                    },
                },
                {
                    sn: "9020KETU229W0002",
                    name: "Inverter 2",
                    status: 1,
                    warning: 0,
                    pac: 1730,
                    eday: 6.2,
                    etotal: 4790.8,
                    tempperature: 40.8,
                    invert_full: {
                        vpv1: 321.0,
                        ipv1: 4.2,
                        vac1: 231.0,
                        iac1: 6.3,
                        fac1: 50.0,
                    },
                },
            ],
        };

        it("maps station/KPI/powerflow/battery level fields", () => {
            const { points } = mapMonitorDetail(fixture);
            expect(findPoint(points, "Station.Name").value).to.equal("Testanlage Schwiegervater");
            expect(findPoint(points, "KPI.CurrentPower").value).to.equal(3450);
            expect(findPoint(points, "KPI.TodayGeneration").value).to.equal(12.3);
            expect(findPoint(points, "PowerFlow.Battery").value).to.equal(-500);
            expect(findPoint(points, "Battery.SOC").value).to.equal(76);
        });

        it("does not create an EVCharger section when absent", () => {
            const { points } = mapMonitorDetail(fixture);
            expect(points.some((p) => p.id.startsWith("EVCharger."))).to.equal(false);
        });

        it("maps both inverters into separate namespaces keyed by serial", () => {
            const { points, inverterSerials } = mapMonitorDetail(fixture);
            expect(inverterSerials).to.deep.equal(["9020KETU229W0001", "9020KETU229W0002"]);
            expect(findPoint(points, "Inverters.9020KETU229W0001.CurrentPower").value).to.equal(1720);
            expect(findPoint(points, "Inverters.9020KETU229W0002.CurrentPower").value).to.equal(1730);
            expect(findPoint(points, "Inverters.9020KETU229W0001.PV1.Voltage").value).to.equal(320.5);
            expect(findPoint(points, "Inverters.9020KETU229W0001.Battery.SOC").value).to.equal(76);
            // inverter 2 has no battery telemetry in the fixture -> must be skipped, not written as null/0
            expect(findPoint(points, "Inverters.9020KETU229W0002.Battery.SOC")).to.equal(undefined);
        });

        it("maps EV charger fields when the portal reports a charger", () => {
            const withEv = { ...fixture, isEvCharge: true, evCharge: { power: 4200, status: 2 } };
            const { points } = mapMonitorDetail(withEv);
            expect(findPoint(points, "EVCharger.Present").value).to.equal(true);
            expect(findPoint(points, "EVCharger.Power").value).to.equal(4200);
        });

        it("never throws on a completely empty/garbage payload", () => {
            expect(() => mapMonitorDetail({})).to.not.throw();
            expect(() => mapMonitorDetail(null)).to.not.throw();
            expect(() => mapMonitorDetail({ inverter: "not-an-array" })).to.not.throw();
            const { points, inverterSerials } = mapMonitorDetail({});
            expect(points).to.deep.equal([]);
            expect(inverterSerials).to.deep.equal([]);
        });

        it("falls back to an UNKNOWN_n serial if the portal omits the SN", () => {
            const { points } = mapMonitorDetail({ inverter: [{ pac: 100 }] });
            expect(findPoint(points, "Inverters.UNKNOWN_1.CurrentPower").value).to.equal(100);
        });
    });
});
