![Logo](admin/goodwe-sems.png)

*[Auf Deutsch lesen](README.de.md)*

# ioBroker.goodwe-sems

[![NPM version](https://img.shields.io/npm/v/iobroker.goodwe-sems.svg)](https://www.npmjs.com/package/iobroker.goodwe-sems)
[![Downloads](https://img.shields.io/npm/dm/iobroker.goodwe-sems.svg)](https://www.npmjs.com/package/iobroker.goodwe-sems)
![Test and Release](https://github.com/bueste/ioBroker.goodwe-sems/actions/workflows/test-and-release.yml/badge.svg)
[![Donate](https://img.shields.io/badge/Donate-PayPal-00457C?style=flat&logo=paypal&logoColor=white)](https://www.paypal.com/ncp/payment/TT6MTBLXX9L9U)

Reads inverter, battery and power-flow data from the **[GoodWe](https://www.goodwe.com) [SEMS Portal](https://www.semsportal.com) (cloud)** - for installations that (e.g. because there is no LAN access to the inverter) **cannot** be polled with the local [ioBroker.goodwe](https://github.com/FossyTom/ioBroker.goodwe) adapter (Modbus/UDP, port 8899).

Login uses your **normal SEMS Portal account** (the same one you use at semsportal.com / in the SEMS app). A GoodWe "organization"/OpenAPI account is **not** required.

## Table of contents

- [Why this adapter?](#why-this-adapter)
- [API origin and limitations (please read)](#api-origin-and-limitations-please-read)
- [Installation](#installation)
- [Configuration](#configuration)
- [Object/state structure](#objectstate-structure)
- [Error handling, backoff and rate limits](#error-handling-backoff-and-rate-limits)
- [Pushover notifications](#pushover-notifications)
- [Security & privacy](#security--privacy)
- [Development](#development)
- [Changelog](#changelog)
- [License](#license)

## Why this adapter?

GoodWe ET/EH/BH/BT inverters can normally be read out locally via Modbus/UDP (see [ioBroker.goodwe](https://github.com/FossyTom/ioBroker.goodwe)). If there is no LAN access to the inverter (e.g. because only a WLAN/LTE stick is connected to the SEMS Portal and the target network is otherwise unreachable), the only remaining option is the cloud detour via the **[SEMS Portal](https://www.semsportal.com)** ([GoodWe](https://www.goodwe.com)) that the installation is already being monitored through anyway.

## API origin and limitations (please read)

GoodWe officially offers three APIs (see the [GoodWe API technical document](https://community.goodwe.com/solution/API)):

- **OpenAPI** - only for SEMS *organization* accounts, requires activation by GoodWe.
- **Real-time Data Monitoring API** - for third parties, requires a license agreement plus a device whitelist.
- **Batch Remote Control Interface** - Kafka-based, remote control only.

None of these are accessible with a **normal** SEMS Portal account (the kind most private users have). This adapter instead speaks the same **undocumented HTTPS API** that the official SEMS app/website itself uses (login via `CrossLogin`/`SEMS+ cross-login`, data retrieval via `GetMonitorDetailByPowerstationId`). These endpoints have not been released or documented by GoodWe for third-party use; the implementation is based on independent traffic analysis as well as the following open-source reference projects:

- [pygoodwe](https://github.com/yaleman/pygoodwe) (MIT)
- [goodwe-sems-home-assistant](https://github.com/TimSoethout/goodwe-sems-home-assistant)
- [openHAB SEMSPortal binding](https://www.openhab.org/addons/bindings/semsportal/)

**Consequences:**

- GoodWe can change the API at any time without notice - the adapter may (temporarily) break as a result.
- There is **no documented real-time/push mechanism** (websocket/SignalR) for third parties. An `msgSocketAdr` field appears in some older login responses but is not actually used by any of the reference projects above - using it would be pure reverse engineering without reliable documentation and a significantly higher risk (account lockout, unstable connection). This adapter therefore deliberately polls over HTTPS at a configurable interval (default 5 minutes) instead of faking an untested websocket connection.
- A **rate-limit code (`GY0429`)** has been observed (documented, among others, in the Home Assistant integration). The adapter recognizes this code and automatically pauses (default 5-minute cool-down) instead of endangering the account with repeated requests.
- Use at your own risk, see [LICENSE](LICENSE) (MIT, no warranty).

## Installation

Once this adapter is listed in the official ioBroker adapter repository, install it the normal way: **Admin -> Adapters -> search for "goodwe-sems" -> install**.

Until then, an ioBroker administrator can add it manually on the ioBroker host:

```
iobroker url iobroker.goodwe-sems
```

## Configuration

| Field | Description |
|---|---|
| SEMS account / password | Same credentials as at semsportal.com. The password is stored encrypted by ioBroker. |
| Plant ID (optional) | Leave empty for automatic detection (`GetPowerStationIdByOwner`). For accounts with several plants: copy the ID manually from the portal URL (`.../powerstation/powerstatussnmin/<ID>`). |
| Poll interval | Default 300 s. The adapter enforces a minimum of 60 s regardless of configuration. |
| Pushover | See [Pushover notifications](#pushover-notifications). |

## Object/state structure

```
goodwe-sems.0.info.connection              SEMS Portal reachable (bool)
goodwe-sems.0.info.lastSuccess             Timestamp of the last successful poll
goodwe-sems.0.info.lastError               Last error message
goodwe-sems.0.info.consecutiveErrors       Number of consecutive failed attempts
goodwe-sems.0.info.rateLimited             SEMS Portal is currently rate-limiting (bool)
goodwe-sems.0.info.activePollInterval      Currently effective interval incl. backoff (s)
goodwe-sems.0.info.rawResponse             Raw JSON response (only when the debug option is enabled)

goodwe-sems.0.Station.Name / .Capacity / .Address / .Latitude / .Longitude / .PortalTimestamp / .Status / .StationId
goodwe-sems.0.KPI.CurrentPower / .TodayGeneration / .MonthGeneration / .TotalGeneration / .TodayIncome / .TotalIncome / .Currency
goodwe-sems.0.PowerFlow.PV / .Load / .Grid / .Battery / .LoadStatus / .GridStatus / .PvStatus / .BatteryStatus
goodwe-sems.0.Battery.SOC / .Status
goodwe-sems.0.EVCharger.*                  (only if reported by the portal)

goodwe-sems.0.Inverters.<serial>.Name / .Model / .Status / .WarningCode
goodwe-sems.0.Inverters.<serial>.CurrentPower / .TodayGeneration / .TotalGeneration / .Temperature
goodwe-sems.0.Inverters.<serial>.PV1..4.Voltage / .Current
goodwe-sems.0.Inverters.<serial>.AC_L1..3.Voltage / .Current / .Frequency
goodwe-sems.0.Inverters.<serial>.Battery.SOC / .Voltage / .Current
```

With two inverters (as in the original requirement this adapter was built for), two `Inverters.<serial>.*` branches are created automatically - the number is not hardcoded, it is driven entirely by what the portal returns for the configured account.

Fields that the portal delivers but this adapter does not (yet) know about are not lost: with the debug option enabled, the full raw response ends up in `info.rawResponse` (JSON), so it can be inspected and added via PR if needed.

## Error handling, backoff and rate limits

- Every poll cycle is fully wrapped in try/catch; a single failure can never permanently stop the polling loop.
- Dedicated error classes (`SemsAuthError`, `SemsRateLimitError`, `SemsNetworkError`, `SemsProtocolError`) drive targeted behaviour:
  - **Rate limit (`GY0429`)** -> immediate pause (default 300 s), `info.rateLimited = true`.
  - **Login failure** -> exponential backoff (capped at 1 h) so that wrong credentials do not put additional strain on the account.
  - **Network/protocol errors** -> moderate backoff.
- After a configurable number of consecutive failures (default 3), the plant is considered "offline" and, if enabled, a Pushover notification is triggered.
- Everything is additionally written to the ioBroker log in a structured way (`error`/`warn`/`debug` depending on severity).

## Pushover notifications

Configurable in three modes:

1. **Via an existing `ioBroker.pushover` instance** (`sendTo`) - recommended, no duplicate credential management.
2. **Directly via the Pushover API** (your own user key + API/app token, stored encrypted) - also works without a separate Pushover instance.
3. **Both at the same time.**

Triggered on: SEMS login failure, SEMS rate limit, a prolonged outage, unexpected adapter error - each individually toggleable. An internal cool-down (default 1 h per category) prevents spam during ongoing issues.

## Security & privacy

- The SEMS password and the Pushover API token are marked as `encryptedNative`/`protectedNative` at the root of `io-package.json` and are stored encrypted by ioBroker, never logged in plain text (the account name is masked in log messages, e.g. `st***@gmail.com`).
- The adapter performs **read-only** access only (`GetMonitorDetailByPowerstationId`, `GetPowerStationIdByOwner`). There is deliberately **no** remote-control/write function (`SaveRemoteControlInverter`) - that would be a considerably larger security and liability risk and was not part of the requirement.
- No third-party dependency for HTTP access: the built-in `fetch` of Node.js >=22 is used instead of an additional HTTP library - a smaller attack surface, less supply-chain risk.
- The API base URL returned by the login response is validated (HTTPS on GoodWe-owned domains only) before any further request uses it, so a manipulated login response cannot redirect the session token to a foreign host.
- All network errors are caught in a typed way; no unchecked data from the API response is ever executed (`eval`, `Function`, and similar are not used anywhere).

## Development

```
npm install
npm run lint
npm test          # unit tests (lib/mapping.js, lib/semsApi.js, lib/notify.js) + package consistency check
```

Recommended additionally before every release:

```
npx @iobroker/repochecker@latest .
```

Pull requests are welcome, especially to add further fields delivered by the portal (see `info.rawResponse` with the debug option enabled) or to improve translations.

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->
### **WORK IN PROGRESS**

### 0.1.13 (2026-07-19)

- (Stefan Bühler) diagnostics: log the raw JSON envelope of every SEMS API call at debug level, not just the monitor-detail call. Real-account testing surfaced a `SEMS-API-Fehler: ... GetPowerStationIdByOwner ... unbekannter Fehler (code=undefined)` report - the success/error code convention this adapter assumes (`code: 0`/`"0"`/`"00000"`) was only ever validated against test fixtures, not this specific endpoint on a live account. This logging is the fastest way to see the actual response shape and fix the real bug without needing access to anyone's SEMS credentials

### 0.1.12 (2026-07-19)

Further fixes from a repochecker recheck on the `ioBroker.repositories` listing PR:

- (Stefan Bühler) **[E2004]** removed the `0.1.10` entry from `common.news` in `io-package.json` - that version's CI failed before the deploy step, so it was never actually published to npm
- (Stefan Bühler) **[S3014]** declared `needs: check-and-lint` on the `adapter-tests` job so it only runs after linting succeeds
- (Stefan Bühler) **[W0066]** pinned `@types/node` to `^22` (was the open-ended `>=22`, which could resolve to a newer major with mismatched typings)
- (Stefan Bühler) **[W4040]/[W4042]** fixed the JSON schema associations in `.vscode/settings.json`: `fileMatch` entries must not have a leading slash, and the jsonConfig schema must also match `admin/jsonCustom.json` and `admin/jsonTab.json`
- (Stefan Bühler) **[S8913]** added `.github/workflows/automerge-dependabot.yml` (using `iobroker-bot-orga/action-automerge-dependabot@v1`) and `.github/auto-merge.yml` so patch updates (and minor updates for dev dependencies) from Dependabot are merged automatically

### 0.1.11 (2026-07-19)

- (Stefan Bühler) fixed a real CI break introduced in 0.1.10: removed Node.js 20.x from the `adapter-tests` matrix in `.github/workflows/test-and-release.yml`. It is incompatible with `engines.node >=22` (also introduced in 0.1.10) once the official `ioBroker/testing-action-adapter@v1` action runs `npm ci` with `engine-strict` enabled, which crashed that matrix job and cancelled every other job via fail-fast

### 0.1.10 (2026-07-19)

Second round of fixes, addressing further findings from a stricter automated `@iobroker/repochecker` recheck on the `ioBroker.repositories` listing PR:

- (Stefan Bühler) **[W0028]** raised `engines.node` to `>=22`
- (Stefan Bühler) **[W0063]** removed `chai`, `chai-as-promised`, `mocha`, `sinon` from devDependencies (already provided by `@iobroker/testing`)
- (Stefan Bühler) **[S0065]/[S0085]/[S0087]** added `@types/node`, `@tsconfig/node22` and `/tsconfig.json` for editor type-checking support
- (Stefan Bühler) **[S5026]** added the `@alcalzone/release-script-plugin-manual-review` release plugin
- (Stefan Bühler) **[W3013]/[W3015]/[W3017]** rewrote `.github/workflows/test-and-release.yml` to use the official shared `ioBroker/testing-action-check@v1`, `ioBroker/testing-action-adapter@v1` and `ioBroker/testing-action-deploy@v1` GitHub Actions instead of hand-written steps
- (Stefan Bühler) added `test/integration.js` (adapter startup smoke test via `@iobroker/testing`'s integration harness) so `npm run test:integration` succeeds
- (Stefan Bühler) **[E1032]** trimmed `common.news` in `io-package.json` to the 7 entries kept by the repository builder
- (Stefan Bühler) **[E5512]** added the required `size` property to the Pushover section header in `admin/jsonConfig.json`
- (Stefan Bühler) **[S5601]** migrated `admin/i18n` from the long `{lang}/translations.json` format to the short `{lang}.json` format
- (Stefan Bühler) **[S4036]** added `.vscode/settings.json` with JSON schema associations for `io-package.json` and `admin/jsonConfig.json`
- (Stefan Bühler) **[S8901]** added `.github/dependabot.yml` (npm + github-actions, weekly, with a cooldown and an `@types/node` major/minor ignore rule)

### 0.1.9 (2026-07-19)

Addressed the stricter automated `@iobroker/repochecker` findings surfaced on the `ioBroker.repositories` listing PR:

- (Stefan Bühler) **[E1057]** moved `encryptedNative`/`protectedNative` from `common` to the `io-package.json` root, matching the current schema
- (Stefan Bühler) **[E3009]/[E3010]/[E3011]/[E3012]** raised `engines.node` to `>=20`, `@iobroker/adapter-core` to `^3.4.1`, `js-controller` dependency to `>=6.0.11`, `admin` globalDependency to `>=7.6.20`
- (Stefan Bühler) **[E3040]** updated devDependencies (`@iobroker/adapter-dev`, `@iobroker/testing`, mocha, esbuild and others) to current major versions
- (Stefan Bühler) **[E3000-series]** rewrote `.github/workflows/test-and-release.yml` to the current official template: renamed jobs (`check-and-lint`, `adapter-tests`, `adapter-check`, `deploy`), full OS/Node test matrix (ubuntu/windows/macos x 20/22/24), `concurrency` group, deploy job pinned to Node 24
- (Stefan Bühler) **[E5005]** replaced global `setTimeout`/`clearTimeout` with adapter-managed timers (`adapter.setTimeout`/`adapter.clearTimeout`) in `lib/notify.js` and `lib/semsApi.js`
- (Stefan Bühler) **[E5043]** switched to `require("node:crypto")`
- (Stefan Bühler) **[E5507]/[E5510]/[E5512]/[E5612]** fixed `admin/jsonConfig.json`: added missing `lg`/`xl` responsive sizes on every item, replaced a literal label string with a proper i18n key (`loginTab`, added to all 11 translation files)
- (Stefan Bühler) **[E6004]/[E6015]/[W0037]/[W0076]** translated `README.md` to English (required language), moved the previous German content to `README.de.md`, added `CHANGELOG_OLD.md` for older entries
- (Stefan Bühler) **[W9501]** removed the redundant `.npmignore` (superseded by package.json `files`)
- (Stefan Bühler) **[E9006]** added `.commitinfo` to `.gitignore`
- (Stefan Bühler) **[S4036]/[S5026]** added `prettier.config.mjs`, re-formatted the codebase, disabled `jsdoc/reject-any-type` for the opaque Node timer-handle type with a justifying comment

### 0.1.8 (2026-07-19)

Addressed ioBroker adapter-check findings:

- (Stefan Bühler) **[E254]** removed changelog entries for 0.1.1/0.1.2 - those tags were pushed but their npm-publish CI job failed at the time (missing `NPM_TOKEN` / npm CLI too old for OIDC), so the versions never existed on npm
- (Stefan Bühler) **[W132]** this automatically brought the entry count under the repository builder's 7-entry truncation limit for `common.news`
- (Stefan Bühler) **[W184]** removed deprecated `common.title` (superseded by `common.titleLang`) and deprecated/ignored `common.main` (the entry point comes from `package.json`)
- (Stefan Bühler) **[W034]** raised `@iobroker/adapter-core` from ^3.1.6 to ^3.2.2
- (Stefan Bühler) **[W173]/[W174]/[E999]/[W401]**: `password` was already correctly listed in `encryptedNative`/`protectedNative` (verified against the published tarball) - these findings, together with the global axios 404 when fetching `sources-dist-latest.json`, are side effects of the adapter not yet being listed in the official ioBroker repository

### 0.1.7 (2026-07-19)

- (Stefan Bühler) branding: replaced the placeholder icon with the official GoodWe logo (used with permission from GoodWe)

### 0.1.6 (2026-07-18)

- (Stefan Bühler) updated the dev toolchain: mocha 11, sinon 22, @alcalzone/release-script 5, @iobroker/eslint-config 2; remaining transitive CVEs (adm-zip, diff, esbuild, serialize-javascript) resolved via npm `overrides` - `npm audit`: 0 vulnerabilities (including dev dependencies)

Security/quality audit (security tester, maintainer review, fuzzing of the mapping layer):

- (Stefan Bühler) **Security:** inverter serial numbers from the (untrusted) portal response are sanitized before becoming part of ioBroker object IDs (prevents broken/unexpectedly nested object trees caused by special characters such as `.` `*` `]`)
- (Stefan Bühler) **Security:** the API base URL returned by the login server is validated - HTTPS on GoodWe-owned domains only (`*.semsportal.com`, `*.goodwe.com`), otherwise falls back to the known regional URL. A manipulated login response can no longer redirect the session token to a foreign host
- (Stefan Bühler) **Fix:** `null`/broken entries in the portal's `inverter[]` array crashed the entire poll cycle - now skipped, healthy inverters from the same response are still processed
- (Stefan Bühler) **Fix:** numbers in scientific notation (`"1e5"`) were parsed incorrectly (yielded 15 instead of 100000)
- (Stefan Bühler) **Fix:** obviously invalid portal timestamps (`99/99/9999 ...`) produced absurd epoch values via JavaScript's `Date` rollover behaviour - now rejected
- (Stefan Bühler) **Fix:** automatic plant discovery now filters out entries without a usable ID (previously caused permanently failing poll cycles)
- (Stefan Bühler) **Robustness:** no more state writes after adapter unload; the `adapterError` notification dedupe window is also reset after recovery
- (Stefan Bühler) 14 new regression tests (42 unit tests in total); `npm audit`: 0 vulnerabilities in production dependencies (remaining findings were dev-toolchain only)

### 0.1.5 (2026-07-18)

- (Stefan Bühler) fix: corrected the PayPal donation link in the README (button link instead of the old donate link)

Older changelog entries can be found in [CHANGELOG_OLD.md](CHANGELOG_OLD.md).

## License

MIT License

Copyright (c) 2026 Stefan Bühler

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
