![Logo](admin/goodwe-sems.png)

# ioBroker.goodwe-sems

[![NPM version](https://img.shields.io/npm/v/iobroker.goodwe-sems.svg)](https://www.npmjs.com/package/iobroker.goodwe-sems)
[![Downloads](https://img.shields.io/npm/dm/iobroker.goodwe-sems.svg)](https://www.npmjs.com/package/iobroker.goodwe-sems)
![Test and Release](https://github.com/bueste/ioBroker.goodwe-sems/actions/workflows/test-and-release.yml/badge.svg)

Liest Wechselrichter-, Batterie- und Energiefluss-Daten aus dem **GoodWe SEMS Portal (Cloud)** – für Anlagen, die (z. B. weil kein LAN-Zugriff auf den Wechselrichter besteht) **nicht** mit dem lokalen [ioBroker.goodwe](https://github.com/FossyTom/ioBroker.goodwe)-Adapter (Modbus/UDP, Port 8899) abgefragt werden können.

Login erfolgt mit dem **ganz normalen SEMS-Portal-Konto** (dasselbe wie unter semsportal.com / in der SEMS-App). Ein GoodWe-"Organization"/OpenAPI-Konto wird **nicht** benötigt.

## Inhaltsverzeichnis

- [Warum dieser Adapter?](#warum-dieser-adapter)
- [API-Herkunft und Grenzen (bitte lesen)](#api-herkunft-und-grenzen-bitte-lesen)
- [Installation](#installation)
- [Konfiguration](#konfiguration)
- [Objekt-/State-Struktur](#objekt-state-struktur)
- [Fehlerbehandlung, Backoff und Rate-Limits](#fehlerbehandlung-backoff-und-rate-limits)
- [Pushover-Benachrichtigungen](#pushover-benachrichtigungen)
- [Sicherheit & Datenschutz](#sicherheit--datenschutz)
- [Entwicklung](#entwicklung)
- [Changelog](#changelog)
- [Lizenz](#lizenz)

## Warum dieser Adapter?

GoodWe ET/EH/BH/BT-Wechselrichter lassen sich normalerweise lokal per Modbus/UDP auslesen (siehe [ioBroker.goodwe](https://github.com/FossyTom/ioBroker.goodwe)). Steht kein LAN-Zugriff auf den Wechselrichter zur Verfügung (z. B. weil nur ein WLAN/LTE-Stick mit dem SEMS-Portal verbunden ist und das Zielnetz nicht erreichbar ist), bleibt nur der Umweg über die Cloud: das **SEMS Portal** (semsportal.com), über das die Anlage ohnehin schon überwacht wird.

## API-Herkunft und Grenzen (bitte lesen)

GoodWe bietet offiziell drei APIs an (siehe [GoodWe API Technical Document](https://community.goodwe.com/solution/API)):

- **OpenAPI** – nur für SEMS-*Organization*-Konten, erfordert Freischaltung durch GoodWe.
- **Real-time Data Monitoring API** – für Drittanbieter, erfordert Lizenzvertrag + Geräte-Whitelist.
- **Batch Remote Control Interface** – Kafka-basiert, nur Fernsteuerung.

Für ein **normales** SEMS-Portal-Konto (wie es die meisten Privatanwender haben) ist keine davon zugänglich. Dieser Adapter spricht stattdessen dieselbe **undokumentierte HTTPS-API**, die auch die offizielle SEMS-App/Webseite verwendet (Login via `CrossLogin`/`SEMS+ cross-login`, Datenabfrage via `GetMonitorDetailByPowerstationId`). Diese Endpunkte wurden nicht von GoodWe für Drittnutzung freigegeben oder dokumentiert; die Implementierung basiert auf eigener Analyse sowie den quelloffenen Referenzprojekten:

- [pygoodwe](https://github.com/yaleman/pygoodwe) (MIT)
- [goodwe-sems-home-assistant](https://github.com/TimSoethout/goodwe-sems-home-assistant)
- [openHAB SEMSPortal-Binding](https://www.openhab.org/addons/bindings/semsportal/)

**Konsequenzen:**

- GoodWe kann die API jederzeit ohne Vorankündigung ändern - der Adapter kann dadurch (temporär) ausfallen.
- Es gibt **kein dokumentiertes Echtzeit-/Push-Verfahren** (Websocket/SignalR) für Drittanbieter. Ein `msgSocketAdr`-Feld taucht in älteren Login-Antworten auf, wird aber von keinem der oben genannten Referenzprojekte tatsächlich genutzt - es wäre reines Reverse-Engineering ohne belastbare Dokumentation und ein deutlich höheres Risiko (Kontosperrung, instabile Verbindung). Dieser Adapter pollt daher bewusst per HTTPS in konfigurierbarem Intervall (Default 5 Minuten) statt eine ungetestete Websocket-Verbindung vorzutäuschen.
- Es wurde ein **Rate-Limit-Code (`GY0429`)** beobachtet (u. a. in der Home-Assistant-Integration dokumentiert). Der Adapter erkennt diesen Code und pausiert automatisch (Default 5 Minuten Cool-down), statt das Konto durch wiederholte Anfragen zu gefährden.
- Nutzung erfolgt auf eigenes Risiko, siehe [LICENSE](LICENSE) (MIT, ohne Gewährleistung).

## Installation

Solange der Adapter noch nicht im offiziellen ioBroker-Repository gelistet ist:

```
cd /opt/iobroker
npm install https://github.com/bueste/ioBroker.goodwe-sems/tarball/main
iobroker add goodwe-sems
```

## Konfiguration

| Feld | Beschreibung |
|---|---|
| SEMS-Konto / Passwort | Dieselben Zugangsdaten wie auf semsportal.com. Passwort wird von ioBroker verschlüsselt gespeichert. |
| Anlagen-ID (optional) | Leer lassen für automatische Erkennung (`GetPowerStationIdByOwner`). Bei mehreren Anlagen pro Konto: ID manuell aus der Portal-URL übernehmen (`.../powerstation/powerstatussnmin/<ID>`). |
| Poll-Intervall | Default 300 s. Der Adapter erzwingt ein Minimum von 60 s, unabhängig von der Konfiguration. |
| Pushover | Siehe [Pushover-Benachrichtigungen](#pushover-benachrichtigungen). |

## Objekt-/State-Struktur

```
goodwe-sems.0.info.connection              SEMS Portal erreichbar (bool)
goodwe-sems.0.info.lastSuccess             Zeitstempel letzter erfolgreicher Poll
goodwe-sems.0.info.lastError               Letzte Fehlermeldung
goodwe-sems.0.info.consecutiveErrors       Anzahl aufeinanderfolgender Fehlversuche
goodwe-sems.0.info.rateLimited             SEMS Portal limitiert aktuell (bool)
goodwe-sems.0.info.activePollInterval      Aktuell wirksames Intervall inkl. Backoff (s)
goodwe-sems.0.info.rawResponse             Rohe JSON-Antwort (nur wenn Debug-Option aktiv)

goodwe-sems.0.Station.Name / .Capacity / .Address / .Latitude / .Longitude / .PortalTimestamp / .Status / .StationId
goodwe-sems.0.KPI.CurrentPower / .TodayGeneration / .MonthGeneration / .TotalGeneration / .TodayIncome / .TotalIncome / .Currency
goodwe-sems.0.PowerFlow.PV / .Load / .Grid / .Battery / .LoadStatus / .GridStatus / .PvStatus / .BatteryStatus
goodwe-sems.0.Battery.SOC / .Status
goodwe-sems.0.EVCharger.*                  (nur wenn vom Portal gemeldet)

goodwe-sems.0.Inverters.<Seriennummer>.Name / .Model / .Status / .WarningCode
goodwe-sems.0.Inverters.<Seriennummer>.CurrentPower / .TodayGeneration / .TotalGeneration / .Temperature
goodwe-sems.0.Inverters.<Seriennummer>.PV1..4.Voltage / .Current
goodwe-sems.0.Inverters.<Seriennummer>.AC_L1..3.Voltage / .Current / .Frequency
goodwe-sems.0.Inverters.<Seriennummer>.Battery.SOC / .Voltage / .Current
```

Bei zwei Wechselrichtern (wie in der ursprünglichen Anforderung) entstehen automatisch zwei `Inverters.<SN>.*`-Zweige - die Anzahl ist nicht fest codiert, sondern richtet sich nach dem, was das Portal für das jeweilige Konto zurückliefert.

Felder, die das Portal liefert, aber dieser Adapter (noch) nicht kennt, gehen nicht verloren: Mit aktivierter Debug-Option landet die komplette Rohantwort in `info.rawResponse` (JSON), sodass sie inspiziert und bei Bedarf per PR ergänzt werden können.

## Fehlerbehandlung, Backoff und Rate-Limits

- Jeder Poll-Zyklus ist vollständig try/catch-abgesichert; ein einzelner Fehler kann die Polling-Schleife nicht dauerhaft stoppen.
- Fehlerklassen (`SemsAuthError`, `SemsRateLimitError`, `SemsNetworkError`, `SemsProtocolError`) steuern das Verhalten gezielt:
  - **Rate-Limit (`GY0429`)** → sofortige Pause (Default 300 s), `info.rateLimited = true`.
  - **Login-Fehler** → exponentielles Backoff (bis 1 h Deckel), damit falsche Zugangsdaten das Konto nicht zusätzlich belasten.
  - **Netzwerk-/Protokollfehler** → moderates Backoff.
- Nach konfigurierbar vielen aufeinanderfolgenden Fehlversuchen (Default 3) gilt die Anlage als "offline" und es wird - falls aktiviert - eine Pushover-Meldung ausgelöst.
- Alles wird zusätzlich strukturiert ins ioBroker-Log geschrieben (`error`/`warn`/`debug` je nach Schweregrad).

## Pushover-Benachrichtigungen

Konfigurierbar in drei Modi:

1. **Über eine bestehende `ioBroker.pushover`-Instanz** (`sendTo`) - empfohlen, keine doppelte Zugangsdatenverwaltung.
2. **Direkt über die Pushover-API** (eigener User-Key + API-/App-Token, verschlüsselt gespeichert) - funktioniert auch ohne separate Pushover-Instanz.
3. **Beides gleichzeitig.**

Ausgelöst wird bei: SEMS-Login-Fehler, SEMS-Rate-Limit, länger andauerndem Ausfall, unerwartetem Adapterfehler - jeweils einzeln aktivierbar. Eine interne Sperrfrist (Default 1 h pro Kategorie) verhindert Spam bei andauernden Störungen.

## Sicherheit & Datenschutz

- SEMS-Passwort und Pushover-API-Token sind in `io-package.json` als `encryptedNative`/`protectedNative` markiert und werden von ioBroker verschlüsselt abgelegt, nicht im Klartext geloggt (Kontoname wird in Log-Meldungen maskiert, z. B. `st***@gmail.com`).
- Der Adapter führt **ausschließlich lesende** Zugriffe aus (`GetMonitorDetailByPowerstationId`, `GetPowerStationIdByOwner`). Es gibt bewusst **keine** Fernsteuerungs-/Schreibfunktion (`SaveRemoteControlInverter`) - das wäre ein deutlich größeres Sicherheits- und Haftungsrisiko und war nicht Teil der Anforderung.
- Keine Drittanbieter-Abhängigkeiten für den HTTP-Zugriff: Es wird das in Node.js ≥18 eingebaute `fetch` verwendet statt einer zusätzlichen HTTP-Bibliothek - kleinere Angriffsfläche, weniger Supply-Chain-Risiko.
- Alle Netzwerkfehler werden typisiert abgefangen; es werden keine ungeprüften Daten aus der API-Antwort ausgeführt (`eval`, `Function`, o. ä. werden nirgends verwendet).

## Entwicklung

```
npm install
npm run lint
npm test          # Unit-Tests (lib/mapping.js, lib/semsApi.js, lib/notify.js) + Package-Konsistenz-Check
```

Empfehlung vor jedem Release zusätzlich lokal:

```
npx @iobroker/adapter-checker@latest .
```

Pull Requests willkommen, insbesondere um zusätzliche, vom Portal gelieferte Felder zu ergänzen (siehe `info.rawResponse` mit aktivierter Debug-Option) oder Übersetzungen zu verbessern.

## Changelog

### **WORK IN PROGRESS**

### 0.1.1 (2026-07-18)

- (Stefan Bühler) fix `repository.url` field format in package.json (removed npm-publish normalization warning)

### 0.1.0 (2026-07-18)

- (Stefan Bühler) initial release: SEMS-Portal-Login (SEMS+ mit Legacy-Fallback), automatische Anlagen-Erkennung, vollständiges Monitoring (Station/KPI/PowerFlow/Battery/EV-Charger/pro Wechselrichter), Rate-Limit-Handling, Backoff, Pushover-Alarmierung, Admin6-JSON-Config, i18n (11 Sprachen), Unit-Tests.

## Lizenz

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
