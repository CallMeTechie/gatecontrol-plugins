# gatecontrol-remote — Fernzugriff / Remote access

GateControl's former **Remote Desktops** as a shop plugin (stage 1 of the plan "Fernzugriff"). GateControl keeps
the transport — guacd, the tunnels, the session page, the key vault, the gateways' L4 ports and wake-on-LAN
(`permissions.remote`, `gc.remote` version 1, GateControl ≥ 1.281.0, docs/plugins.md "Remote access"); the plugin
owns the devices, the rights, the history and the pages. User manual: [HANDBUCH.md](HANDBUCH.md) / [HANDBOOK.md](HANDBOOK.md).

*Deutsch: siehe [unten](#deutsch).*

## Parts

| Part | Where |
|---|---|
| Admin pages Geräte, Berechtigungen, Sitzungen, Einstellungen | `ui/*.html`, `ui/*.js`, API `admin/*` (`server/admin.js`) |
| Portal tab "Fernzugriff", profile section `rights` | `ui/portal.*`, `ui/profile.*`, API below (`server/api.js`) |
| Devices (the settings of `rdp_routes`, JSON per device) | `server/devices.js` |
| Rights and access lists | `server/rights.js` |
| Sessions in the browser (`gc.remote.session` → `GC.openSession`) | `server/connect.js` |
| History (apps and browser) | `server/history.js` |
| Take-over of the built-in data (hook `legacyImport`) | `server/legacy.js` |
| Old app API `/api/v1/client/rdp*` (hook `clientFacade`) | `server/facade.js` |

## Rights

`rdp` "Remote Desktops nutzen" (RDP, VNC), `ssh` "SSH nutzen" (SSH, Telnet), `support` "Support-Codes einlösen" and
`share` "Eigene Geräte freigeben" (both prepared for later stages). Per person and per group (`rights` table, `NULL` =
not set): the person's own value wins, else a group with the right, else the default (`share` on, the rest off).
Administrators have every right and reach every device. A device without an access list is open to everybody with
the right (the old rule); with people or groups only to them; with only API tokens (taken over) only to those tokens —
the old apps. Checked on every connect.

## Person API (portal tab, profile section)

A signed-in person (never a kiosk device, never an automation). Errors: `{ ok: false, code, error }` with the HTTP
status of `server/util.js` `STATUS`.

| Call | Answer |
|---|---|
| `GET overview` | `{ rights: { rdp, ssh, support, share }, devices: [{ id, name, protocol, description, online, lastCheck, browser, maintenance, wake, credentialUnreadable, tags }], hasRemote }` — no address, no secret |
| `POST devices/<id>/connect` | `{ session: { ref, expiresAt, protocol, mode, device } }` → the frame calls `GC.openSession(ref)`; codes `no_right`, `disabled`, `no_browser`, `maintenance`, `credential_unreadable`, `limit`, `unlicensed`, `not_allowed`, `unreachable`, `listener_required` |
| `POST devices/<id>/wake` | `{ wake: { sent, via } }`; `rate_limited` (10 s per MAC) |
| `GET profile` | `{ rights, source, admin, devices: { total, rdp, ssh } }` |

## Admin API (`admin/*`, GateControl's admin UI only)

| Call | Answer |
|---|---|
| `GET devices` | `{ devices: [view], available, gateways: [{ peerId, name, online }], pools: [{ poolId, name }] }` (`available`: `gc.remote.gateways`, GateControl after 1.281.0) |
| `POST devices` / `PUT devices/<id>` | `{ name, protocol, enabled, config: { <fields of devices.js FIELDS> }, credentials: { username, password, privateKey, passphrase } }` (omitted = keep, `''` = clear) → `{ device }`; a gateway device gets the listener `dev-<id>` (taken over: `route-<id>`) |
| `DELETE devices/<id>` | listener and vault entries go, the history stays |
| `POST devices/<id>/check · wake · connect { mode } · rotated · toggle`, `POST devices/check` | |
| `PUT devices/<id>/access` | `{ users: [ids], groups: [ids], tokens?: [ids] }` (empty = everybody with the right) |
| `GET rights` | `{ people: [{ id, name, role, set, effective, source, groups }], groups: [{ id, name, path, set }], devices: [{ id, name, protocol, enabled, access }], defaults }` |
| `PUT rights/user/<id>` · `PUT rights/group/<id>` | `{ rdp?, ssh?, support?, share? }` each `true` / `false` / `null` |
| `GET rights/user/<id>` | what this person may do and reach |
| `GET sessions?status&device&user&before&limit` · `GET sessions/csv` · `POST sessions/<id>/end` | the history; end = `gc.remote.end({ sessionId })` of an open browser session |
| `GET settings` · `PUT settings` | `{ maxPerUser 0…20, maxPerDevice 0…20, historyDays 30…3650, checkMinutes 1…60 }`, licence, take-over |

## Take-over (`legacyImport`, dataset `remote`)

Snapshot of docs/plugins.md "Built-in data import": `routes[]` become devices with the same id (`source: import`),
`credential` / `sftp_credential` stay vault handles, `user_ids` / `group_ids` / `token_ids` the access list, the
maintenance windows the device's; gateway routes get `gc.remote.listener({ key: 'route-<id>', … })` (the core reuses
the old L4 route, `shared`); a failure is recorded on the device (`listenerError`) and counted, never fatal. Whoever
could see a target gets `rdp` or `ssh` (`rights.grant`: only where no value is set). `sessions[]` keep their ids
(`imported`). Again: taken-over devices and sessions are replaced, own devices (ids ≥ 100000) and own sessions
(ids ≥ 1000000000) stay. → `{ ok: true, counts: { devices, sessions, maintenance, listenerErrors, rights, unreadable } }`,
kept in the setting `remote.import` (`{ at, counts, runs }`).

## Old app API (`clientFacade`)

Active in GateControl after the take-over. The plugin answers `list`, `status`, `connect`, `browserSession`,
`sessionStart`, `sessionHeartbeat`, `sessionEnd` in the old shape (booleans as booleans, `user_ids` & co. as the old
JSON text, `connect_address` / `connect_port` like `resolveConnectEndpoint` — a gateway target with
`payload.server.connectHost`). Scope `client:rdp` or `full-access`; the right of the person (administrators included)
and the access list as before (no administrator bypass for apps); never the app's own computer (`user.selfIp`).
`connect` names the vault handle (`fields`: `username, domain` for `user_only`) and the core encrypts with ECDH only
(`400 ecdh_required` without `ecdhPublicKey`). `browserSession` answers `{ guac }`, the core makes the token. A
GateControl without `payload.server` (1.281.0) gets `{ handled: false }` for every call: the core keeps answering from
its own tables. The admin API of the core (`/api/v1/rdp/:id/wol`, `/status`) that the Windows app also calls is not
part of the facade — it keeps working for taken-over ids.

## Deutsch

Das frühere **Remote Desktops** von GateControl als Shop-Plugin **Fernzugriff** (Stufe 1). GateControl behält den
Transport (guacd, Tunnel, Sitzungsseite, Tresor, L4-Ports der Gateways, Wake-on-LAN – `gc.remote` Version 1, ab
1.281.0); das Plugin hat Geräte, Rechte, Verlauf und Oberflächen. Seiten: Geräte, Berechtigungen, Sitzungen,
Einstellungen; Portal-Tab „Fernzugriff“; Profil-Abschnitt „Fernzugriff“. Übernahme aus „Remote Desktops“ über
„Daten übernehmen“ / „Erneut übernehmen“ (IDs bleiben, Zugangsdaten als Griffe). Die alte App-Schnittstelle
beantwortet das Plugin über `clientFacade` (nur ECDH), sobald GateControl `payload.server` mitgibt; davor antwortet
der Kern. Eigene Lizenz `gatecontrol-remote` – nicht im Plan, nicht in einer Server-Lifetime; ohne Lizenz bleiben die
Daten, neue Sitzungen gibt es nicht. Handbuch: [HANDBUCH.md](HANDBUCH.md).
