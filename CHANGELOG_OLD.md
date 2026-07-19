# Older changes

Changelog entries older than what is kept in [README.md](README.md) are archived here.
See [README.md](README.md#changelog) for the current changelog.

## 0.1.4 (2026-07-18)

- (Stefan Bühler) docs: added PayPal donation link to README

## 0.1.3 (2026-07-18)

- (Stefan Bühler) CI: fixed OIDC trusted publishing - the Node 22 runner ships npm 10.9.x, which is below the version required for trusted publishing (>=11.5.1). The release job now upgrades npm explicitly before `npm publish`.

## 0.1.2 (2026-07-18)

- (Stefan Bühler) CI: switched npm publishing from a long-lived `NPM_TOKEN` to OIDC trusted publishing (no secret stored in the repository anymore)

## 0.1.1 (2026-07-18)

- (Stefan Bühler) fix `repository.url` field format in package.json (removed npm-publish normalization warning)

## 0.1.0 (2026-07-18)

- (Stefan Bühler) initial release: SEMS Portal login (SEMS+ with legacy fallback), automatic plant discovery, full monitoring (station/KPI/power flow/battery/EV charger/per inverter), rate-limit handling, backoff, Pushover alerting, Admin6 JSON config, i18n (11 languages), unit tests.
