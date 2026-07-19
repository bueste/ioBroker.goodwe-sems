"use strict";

/*
 * Pure data-mapping helpers: turn one GetMonitorDetailByPowerstationId
 * response into a flat list of ioBroker state points. Deliberately kept
 * free of any ioBroker/adapter-core dependency so it can be unit-tested
 * with plain fixtures (see test/unit/mapping.test.js).
 *
 * The exact field names used by the SEMS portal are not documented and
 * have been observed to differ slightly between portal versions/regions
 * (see README "API-Herkunft"). Every lookup therefore tries several
 * candidate keys and silently skips anything it cannot find instead of
 * throwing - a missing field must never break the whole poll cycle.
 */

function toNumber(value) {
    if (value === null || value === undefined) {
        return undefined;
    }
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : undefined;
    }
    if (typeof value === "string") {
        // Try the untouched string first so scientific notation ("1e5",
        // "2.5E3") is parsed correctly instead of being mangled by the
        // unit-stripping fallback below.
        const direct = Number(value.trim());
        if (value.trim() !== "" && Number.isFinite(direct)) {
            return direct;
        }
        const cleaned = value.replace(/[^0-9.+-]/g, "");
        if (cleaned === "" || cleaned === "-" || cleaned === "+") {
            return undefined;
        }
        const n = Number(cleaned);
        return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
}

function pick(obj, keys) {
    if (!obj) {
        return undefined;
    }
    for (const key of keys) {
        if (obj[key] !== undefined && obj[key] !== null && obj[key] !== "") {
            return obj[key];
        }
    }
    return undefined;
}

function pickNumber(obj, keys) {
    return toNumber(pick(obj, keys));
}

/**
 * Parses GoodWe's "MM/DD/YYYY HH:mm:ss" timestamp format into epoch ms.
 * Falls back to Date.parse() for other formats, returns undefined instead
 * of throwing if nothing works.
 *
 * @param {string} value
 */
function parsePortalTimestamp(value) {
    if (!value || typeof value !== "string") {
        return undefined;
    }
    const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
    if (!match) {
        const fallback = Date.parse(value);
        return Number.isNaN(fallback) ? undefined : fallback;
    }
    const [month, day, year, hour, minute, second] = match.slice(1).map(Number);
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
        return undefined;
    }
    return new Date(year, month - 1, day, hour, minute, second).getTime();
}

/**
 * ioBroker object IDs must not contain the characters []*,;'"`<>\? or dots
 * (dots create hierarchy levels) or whitespace. Inverter serials come from
 * the (untrusted) portal response and are used as part of state IDs, so any
 * forbidden character is replaced to prevent broken or unexpectedly nested
 * object trees ("state-ID injection").
 *
 * @param {string} raw
 * @returns {string}
 */
function sanitizeObjectId(raw) {
    const cleaned = String(raw).replace(/[^0-9A-Za-z_-]/g, "_");
    return cleaned || "_";
}

const NUM = (unit, role = "value") => ({
    type: "number",
    role,
    unit,
    read: true,
    write: false,
});
const STR = (role = "text") => ({
    type: "string",
    role,
    read: true,
    write: false,
});
const BOOL = (role = "indicator") => ({
    type: "boolean",
    role,
    read: true,
    write: false,
});

/**
 * @param {object} detail raw "data" object from GetMonitorDetailByPowerstationId
 * @returns {{points: Array<{id:string, name:string, common:object, value:unknown}>, inverterSerials: string[]}}
 */
function mapMonitorDetail(detail) {
    const points = [];
    const push = (id, name, common, value) => {
        if (value === undefined || value === null) {
            return;
        }
        points.push({ id, name, common, value });
    };

    const info = detail && detail.info;
    push("Station.Name", "Station name", STR(), pick(info, ["stationname", "name"]));
    push("Station.Capacity", "Installed capacity", NUM("kWp"), pickNumber(info, ["capacity"]));
    push("Station.Address", "Address", STR(), pick(info, ["address"]));
    push("Station.Latitude", "Latitude", NUM("°", "value.gps"), pickNumber(info, ["latitude"]));
    push("Station.Longitude", "Longitude", NUM("°", "value.gps"), pickNumber(info, ["longitude"]));
    push(
        "Station.PortalTimestamp",
        "Last update time reported by portal",
        NUM("", "value.time"),
        parsePortalTimestamp(pick(info, ["time"])),
    );
    push("Station.Status", "Station status code reported by portal", NUM(), pickNumber(info, ["status"]));

    const kpi = detail && detail.kpi;
    push("KPI.CurrentPower", "Current output power", NUM("W", "value.power"), pickNumber(kpi, ["pac"]));
    push("KPI.TodayGeneration", "Today's generation", NUM("kWh", "value.energy"), pickNumber(kpi, ["power"]));
    push(
        "KPI.MonthGeneration",
        "This month's generation",
        NUM("kWh", "value.energy"),
        pickNumber(kpi, ["month_generation", "monthGeneration"]),
    );
    push(
        "KPI.TotalGeneration",
        "Total generation since installation",
        NUM("kWh", "value.energy"),
        pickNumber(kpi, ["total_power", "totalPower"]),
    );
    push("KPI.TodayIncome", "Today's income", NUM("", "value"), pickNumber(kpi, ["day_income", "dayIncome"]));
    push("KPI.TotalIncome", "Total income", NUM("", "value"), pickNumber(kpi, ["total_income", "totalIncome"]));
    push("KPI.Currency", "Currency of the income values", STR(), pick(kpi, ["currency"]));

    const powerflow = detail && detail.powerflow;
    push("PowerFlow.PV", "PV generation power", NUM("W", "value.power"), pickNumber(powerflow, ["pv"]));
    push("PowerFlow.Load", "House load power", NUM("W", "value.power"), pickNumber(powerflow, ["load"]));
    push("PowerFlow.Grid", "Grid import/export power", NUM("W", "value.power"), pickNumber(powerflow, ["grid"]));
    push(
        "PowerFlow.Battery",
        "Battery charge/discharge power",
        NUM("W", "value.power"),
        pickNumber(powerflow, ["bettery", "battery"]),
    );
    push("PowerFlow.LoadStatus", "Load flow direction code", NUM(), pickNumber(powerflow, ["loadStatus"]));
    push("PowerFlow.GridStatus", "Grid flow direction code", NUM(), pickNumber(powerflow, ["gridStatus"]));
    push("PowerFlow.PvStatus", "PV flow status code", NUM(), pickNumber(powerflow, ["pvStatus"]));
    push(
        "PowerFlow.BatteryStatus",
        "Battery flow direction code",
        NUM(),
        pickNumber(powerflow, ["betteryStatus", "batteryStatus"]),
    );

    const soc = detail && detail.soc;
    push("Battery.SOC", "Overall battery state of charge", NUM("%", "value.battery"), pickNumber(soc, ["power"]));
    push("Battery.Status", "Battery status code", NUM(), pickNumber(soc, ["status"]));

    const evCharge = detail && (detail.evChargeInfo || detail.evCharge);
    if (evCharge || (detail && detail.isEvCharge)) {
        push(
            "EVCharger.Present",
            "EV charger present according to portal",
            BOOL(),
            Boolean(detail.isEvCharge || evCharge),
        );
        push("EVCharger.Power", "EV charger power", NUM("W", "value.power"), pickNumber(evCharge, ["power", "pac"]));
        push("EVCharger.Status", "EV charger status code", NUM(), pickNumber(evCharge, ["status"]));
    }

    const inverters = Array.isArray(detail && detail.inverter) ? detail.inverter : [];
    const inverterSerials = [];

    inverters.forEach((rawInv, index) => {
        // The portal has been observed to include null/garbage entries in the
        // inverter array; one broken entry must never kill the whole cycle.
        const inv = rawInv && typeof rawInv === "object" ? rawInv : {};
        const rawSn = pick(inv, ["sn", "SN", "invertersn"]) || `UNKNOWN_${index + 1}`;
        const sn = sanitizeObjectId(rawSn);
        inverterSerials.push(sn);
        const full = inv.invert_full || inv.d || {};
        const base = `Inverters.${sn}`;

        push(`${base}.Name`, "Inverter name", STR(), pick(inv, ["name"]));
        push(`${base}.Model`, "Inverter model", STR(), pick(inv, ["model_type", "modelType"]));
        push(`${base}.Status`, "Inverter status code reported by portal", NUM(), pickNumber(inv, ["status"]));
        push(`${base}.WarningCode`, "Warning code", NUM(), pickNumber(inv, ["warning", "warningCode"]));

        const pac = pickNumber(inv, ["pac"]) ?? pickNumber(full, ["pac"]);
        push(`${base}.CurrentPower`, "Current AC output power", NUM("W", "value.power"), pac);
        const eday = pickNumber(inv, ["eday"]) ?? pickNumber(full, ["eday"]);
        push(`${base}.TodayGeneration`, "Today's generation of this inverter", NUM("kWh", "value.energy"), eday);
        const etotal = pickNumber(inv, ["etotal"]) ?? pickNumber(full, ["etotal"]);
        push(`${base}.TotalGeneration`, "Total generation of this inverter", NUM("kWh", "value.energy"), etotal);
        const temp = pickNumber(inv, ["tempperature", "temperature"]) ?? pickNumber(full, ["tempperature"]);
        push(`${base}.Temperature`, "Inverter temperature", NUM("°C", "value.temperature"), temp);

        for (let mppt = 1; mppt <= 4; mppt++) {
            const v = pickNumber(full, [`vpv${mppt}`]);
            const i = pickNumber(full, [`ipv${mppt}`]);
            push(`${base}.PV${mppt}.Voltage`, `PV string ${mppt} voltage`, NUM("V", "value.voltage"), v);
            push(`${base}.PV${mppt}.Current`, `PV string ${mppt} current`, NUM("A", "value.current"), i);
        }
        for (let phase = 1; phase <= 3; phase++) {
            const v = pickNumber(full, [`vac${phase}`]);
            const i = pickNumber(full, [`iac${phase}`]);
            const f = pickNumber(full, [`fac${phase}`]);
            push(`${base}.AC_L${phase}.Voltage`, `AC phase ${phase} voltage`, NUM("V", "value.voltage"), v);
            push(`${base}.AC_L${phase}.Current`, `AC phase ${phase} current`, NUM("A", "value.current"), i);
            push(`${base}.AC_L${phase}.Frequency`, `AC phase ${phase} frequency`, NUM("Hz", "value.frequency"), f);
        }

        const batSoc = pickNumber(inv, ["soc"]) ?? pickNumber(full, ["soc"]);
        push(`${base}.Battery.SOC`, "Battery state of charge (this inverter)", NUM("%", "value.battery"), batSoc);
        push(`${base}.Battery.Voltage`, "Battery voltage", NUM("V", "value.voltage"), pickNumber(full, ["vbattery1"]));
        push(`${base}.Battery.Current`, "Battery current", NUM("A", "value.current"), pickNumber(full, ["ibattery1"]));
    });

    return { points, inverterSerials };
}

module.exports = {
    mapMonitorDetail,
    pick,
    pickNumber,
    parsePortalTimestamp,
    toNumber,
    sanitizeObjectId,
};
