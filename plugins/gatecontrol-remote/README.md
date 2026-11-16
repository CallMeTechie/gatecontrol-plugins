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
| 1.2: SSH in GateControl's terminal (engine `term`), tmux, recording policy | `server/connect.js`, `server/rights.js` (`policyFor`) |
| 1.2: recordings (list, watch, delete, retention) | `server/recordings.js` |

## Rights

`rdp` "Remote Desktops nutzen" (RDP, VNC), `ssh` "SSH nutzen" (SSH, Telnet), `support` "Support-Codes einlösen" and
`share` "Eigene Geräte freigeben" (both prepared for later stages). Per person and per group (`rights` table, `NULL` =
not set): the person's own value wins, else a group with the right, else the default (`share` on, the rest off).
Administrators have every right and reach every device. A device without an access list is open to everybody with
the right (the old rule); with people or groups only to them; with only API tokens (taken over) only to those tokens —
the old apps. Checked on every connect.

1.2: `recording` per person and group (`off` | `optional` | `always`, `NULL` = not set; the own row, else the strictest
group). For a session the stricter of the device's `config.recording` and the person's holds (`rights.policyFor`).

## SSH in GateControl's terminal and recordings (1.2, `gc.remote` version 3)

* `config.ssh_engine`: `term` (GateControl's terminal: xterm.js in the browser, the apps' native terminal; protocol
  `gc-term.v1`) or `guac` (Guacamole). New SSH devices `term`; devices of 1.0/1.1 and taken-over ones `guac`
  (migration `003_terminal.sql`, `legacy.js`; a re-run of the take-over keeps the plugin's choice). With a GateControl
  before version 3 every SSH device uses Guacamole and nothing is recorded.
* `config.tmux_enabled` (default on), `config.tmux_name` (`^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$`, default `gc-<slug>`):
  the ticket carries `options.tmux: { create | attach }`; GateControl runs `tmux new -A -s '<name>'`.
* Host keys: GateControl pins on the first connection after the person confirmed the fingerprint; the plugin shows the
  pin (`gc.remote.hostKeys.list`) and resets it (`remove`). A blocked connection (`host_key_mismatch`) reaches the
  plugin as an `abort` event → protocol `remote_host_key_changed`.
* `POST admin/devices/<id>/key` → `gc.remote.vault.generate` (ed25519; the private key stays in GateControl's vault,
  the device keeps the handle, username and password stay) → `{ publicKey }`.
* Recording: `decideRecording` — `off`: never (`record: true` → `invalid`); `optional`: when the caller sends
  `record: true`; `always`: always — the browser gets GateControl's hint page, an app must send `record: true`
  (`recording_required`). `recording_unavailable` when GateControl cannot record for the engine.
* Recordings: `gc.remote.recordings.list` filtered to the devices the person may watch (administrators all, the owner
  of a PC its PC's), `stream(id, { user })` → a playback ticket for that person (`GC.openSession(ref)`), `remove`;
  hourly `recordingDays` (default 30). Events `recording_viewed` → protocol `remote_recording_viewed`.

## Person API (portal tab, profile section)

A signed-in person (never a kiosk device, never an automation). Errors: `{ ok: false, code, error }` with the HTTP
status of `server/util.js` `STATUS`.

| Call | Answer |
|---|---|
| `GET overview` | `{ rights: { rdp, ssh, support, share }, devices: [{ id, name, protocol, description, online, lastCheck, browser, maintenance, wake, credentialUnreadable, tags }], hasRemote }` — no address, no secret |
| `POST devices/<id>/connect` | `{ session: { ref, expiresAt, protocol, mode, device } }` → the frame calls `GC.openSession(ref)`; codes `no_right`, `disabled`, `no_browser`, `maintenance`, `credential_unreadable`, `limit`, `unlicensed`, `not_allowed`, `unreachable`, `listener_required` |
| `POST devices/<id>/wake` | `{ wake: { sent, via } }`; `rate_limited` (10 s per MAC) |
| `GET profile` | `{ rights, source, admin, devices: { total, rdp, ssh }, hosts: [own PCs], history: [share log of them] }` |
| `POST code/redeem` | 1.1: `{ code, mode: control\|view, via: browser\|app, deviceId? }` → `{ request: { id, device, state: 'waiting', mode, via, expiresAt } }`; `code_invalid`, `code_locked`, `rate_limited`, `no_right`, `offline`, `rdp_off` |
| `GET requests/<id>` · `POST requests/<id>/connect` | the helper waits (`waiting` → `allowed` \| `denied` \| `expired`); connect after `allowed`: browser `{ session }`, app `{ connection }`; `request_waiting`, `request_expired`, `firewall_timeout`, `firewall_failed` |
| `GET devices` (apps) | like `overview`: `{ devices, rights, codeEntry }`; a PC with `kind: 'host'`, `owner`, `connect: { mode: code\|open }`, `ready`, `state`; 1.2: an SSH device with `engine: term\|guac`, `tmux` (the default session name or `null`), every device with `recording: off\|optional\|always` for this person |
| `GET devices/<id>/tmux` | 1.2: `{ sessions: [{ name, windows, attached, created, activity, attachable }], tmux, hostKey: pinned\|unpinned }` — right `ssh` and access; `tmux_unavailable`, `host_key_mismatch`, `credential_required`, `offline` (GateControl before version 3) |
| `POST devices/<id>/connect` (1.2) | `{ via?: browser\|app, tmux?: { attach\|create: name }, record?: bool }` → `{ session: { ref, expiresAt, protocol, mode, engine, recording, tmux, device } }`. `via: app` (app requests only, engine `term` only — no browser switch needed): the app sends `ref` to `POST /api/v1/client/remote/term-token` and opens `/api/v1/remote/ssh-tunnel` (`gc-term.v1`). Codes `recording_required`, `recording_unavailable`, `credential_required`, `invalid` (`tmux`, `record`, `via`) |
| `GET recordings?device&limit` · `POST recordings/<id>/play` | 1.2: the recordings this person may watch (administrators all, owners of a PC its own) `{ recordings: [{ id, deviceId, deviceName, userId, userName, protocol, format, status, startedAt, durationSeconds, bytes }] }` · `{ ref, url, expiresAt, format }` (`not_found` for anybody else) |

## The PC's app (1.1, `host/*`, app requests only)

`req.user.device = { id, platform, vpnIp }` (gc.remote version 2). Signals to the PC: silent pushes on the topic
`remote_signal` (`notifyTopics[].signal`) — `remote.request`, `remote.request.cancel`, `remote.firewall.open`
`{ sessionKey, allow, port, until }`, `remote.firewall.close`, `remote.code.void`.

| Call | Answer |
|---|---|
| `POST host/register` | `{ name, edition, rdp: { available, enabled, port: 3389 }, osUser, appVersion, shareMode? }` → `{ host: { deviceId, shareMode, allowOpen, state }, codeRequired }`; `no_share_right`, `home_edition`, `no_vpn` |
| `POST host/state` | `{ rdp: { enabled }, osUser, online }` → `{ shareMode, allowOpen, pending: [request] }` (every 60 s; 3 missed = offline) |
| `PUT host/share` | `{ shareMode: code\|open }` → `{ shareMode }`; `not_allowed` when the admin locked "ohne Code" |
| `DELETE host` | `{ removed }` — "abgemeldet", requests and rules end, the code goes |
| `POST host/code` | `{ code: '482-913-075', expiresAt }` (≤ 10 min, once, HMAC only) |
| `GET` / `PUT host/access` | `{ users, groups }` → `{ access }` (the owner stays) |
| `POST host/requests/<id>` | `{ decision: allow\|deny, mode? }` → `{ request }`; `request_expired` |
| `GET host/firewall` · `POST host/firewall` | `{ open: [{ sessionKey, allow, port, until }] }` · `{ sessionKey, state: open\|closed\|failed, reason? }` |

### The phone's app (1.3, gc.remote version 4 — only watching)

An Android phone ("Bildschirm freigeben") uses the same calls with `platform: 'android'`: a device `kind: 'host'`,
`platform: 'android'`, `protocol: 'screen'`, no VPN address, no firewall (the phone connects to GateControl's relay
`gc-screen.v1` itself). A request to a phone is always `mode: 'view'`, `kind: 'screen'` and always asked at the phone
(also "ohne Code"); signals add `remote.screen.end { requestId, reason }` (the helper or the plugin ended it).

| Call | Answer |
|---|---|
| `POST host/register` | `{ platform: 'android', name, appVersion, screen: { view, control }, shareMode? }` → `{ host: { deviceId, platform, shareMode, allowOpen, state }, codeRequired }`; `no_share_right`, `screen_unavailable` (GateControl without `gc.remote.screen`) |
| `POST host/state` | `{ online: true }` → `{ shareMode, allowOpen, pending: [{ requestId, from, mode, via, kind, expiresAt }] }` — offline 20 min after the last one |
| `POST host/requests/<id>` | `{ decision: allow\|deny }` → `{ request, screen?: { ref, expiresAt, wsPath: '/api/v1/remote/screen-relay' } }` — `screen.ref` is the sending side: `POST /api/v1/client/remote/screen-token { ref }` at GateControl |
| `POST host/screen/<id>/end` | `{ reason: consent_denied\|stopped\|failed }` → `{ ended }` |

Helpers: `POST code/redeem` → `{ request }` (`kind: 'screen'`, `mode: 'view'`); a phone "ohne Code": `POST devices/<id>/connect`
→ `{ request }`; `POST requests/<id>/connect` → `{ session: { ref, expiresAt, protocol: 'screen', engine: 'screen', mode: 'view', device } }`.

## Admin API (`admin/*`, GateControl's admin UI only)

| Call | Answer |
|---|---|
| `GET devices` | `{ devices: [view], available, gateways: [{ peerId, name, online }], pools: [{ poolId, name }] }` (`available`: `gc.remote.gateways`, GateControl after 1.281.0) |
| `POST devices` / `PUT devices/<id>` | `{ name, protocol, enabled, config: { <fields of devices.js FIELDS> }, credentials: { username, password, privateKey, passphrase } }` (omitted = keep, `''` = clear) → `{ device }`; a gateway device gets the listener `dev-<id>` (taken over: `route-<id>`) |
| `DELETE devices/<id>` | listener and vault entries go, the history stays |
| `POST devices/<id>/check · wake · connect { mode } · rotated · toggle`, `POST devices/check` | a PC (`kind: 'host'`): connect only "ohne Code" (`code_required`), no check |
| `POST devices/<id>/allow-open` | 1.1: `{ allowOpen }` — lock or allow "ohne Code" for a PC |
| `PUT devices/<id>/access` | `{ users: [ids], groups: [ids], tokens?: [ids] }` (empty = everybody with the right) |
| `GET rights` | `{ people: [{ id, name, role, set, effective, source, groups }], groups: [{ id, name, path, set }], devices: [{ id, name, protocol, enabled, access }], defaults }` |
| `PUT rights/user/<id>` · `PUT rights/group/<id>` | `{ rdp?, ssh?, support?, share? }` each `true` / `false` / `null` |
| `GET rights/user/<id>` | what this person may do and reach |
| `GET sessions?status&device&user&before&limit` · `GET sessions/csv` · `POST sessions/<id>/end` | the history; end = `gc.remote.end({ sessionId })` of an open browser session |
| `GET sessions/shares?device&before&limit` | 1.1: the protocol of the sharing `{ entries: [{ id, at, type, deviceId, deviceName, userId, userName, details }] }` |
| `GET settings` · `PUT settings` | `{ maxPerUser 0…20, maxPerDevice 0…20, historyDays 30…3650, checkMinutes 1…60, recordingDays 1…3650 }`, licence, take-over, `recordings` (GateControl's `recordings.available()`) |
| `POST devices/ssh-engine` | 1.2: `{ engine: term\|guac, ids?: [ids] }` (no ids: every SSH device) → `{ switched, devices }`; protocol `remote_ssh_engine_changed` |
| `POST devices/<id>/connect { engine: 'term' }` | 1.2: try GateControl's terminal on a Guacamole device; a successful start sets `config.term_tested_at` |
| `POST devices/<id>/key` · `DELETE devices/<id>/hostkey` | 1.2: `{ username? }` → `{ publicKey, device }` · `{ removed, device }` (protocol `remote_host_key_reset`); `GET devices/<id>` has `ssh: { engine, tmux, hostKey, publicKey, termTestedAt, available }` |
| `GET recordings?device&limit` · `POST recordings/<id>/play` · `DELETE recordings/<id>` | 1.2: `{ recordings, available }` · `{ ref, url, expiresAt, format }` · `{ removed }` (protocol `remote_recording_deleted`) |
| `PUT rights/user/<id>` · `PUT rights/group/<id>` with `recording` | 1.2: `off` \| `optional` \| `always` \| `null` |

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
its own tables. Since 1.1 (gc.remote version 2) also `wake`, `statusAdmin`, `statusAll` — the admin API of the core
(`/api/v1/rdp/:id/wol`, `/:id/status`, `/status`) that the Windows app calls. A PC of the app is in `list` only while
it is shared "ohne Code" and ready; `connect` opens its firewall for `user.selfIp` first, `sessionEnd` closes it,
`browserSession` is refused for it.

## Deutsch

Das frühere **Remote Desktops** von GateControl als Shop-Plugin **Fernzugriff** (Stufe 1). GateControl behält den
Transport (guacd, Tunnel, Sitzungsseite, Tresor, L4-Ports der Gateways, Wake-on-LAN – `gc.remote` Version 1, ab
1.281.0); das Plugin hat Geräte, Rechte, Verlauf und Oberflächen. Seiten: Geräte, Berechtigungen, Sitzungen,
Einstellungen; Portal-Tab „Fernzugriff“; Profil-Abschnitt „Fernzugriff“. Übernahme aus „Remote Desktops“ über
„Daten übernehmen“ / „Erneut übernehmen“ (IDs bleiben, Zugangsdaten als Griffe). Die alte App-Schnittstelle
beantwortet das Plugin über `clientFacade` (nur ECDH), sobald GateControl `payload.server` mitgibt; davor antwortet
der Kern. Eigene Lizenz `gatecontrol-remote` – nicht im Plan, nicht in einer Server-Lifetime; ohne Lizenz bleiben die
Daten, neue Sitzungen gibt es nicht. Seit 1.1 (Stufe 2) melden sich Windows-PCs aus der GateControl-App an
(„Remote Desktop erlauben“): nur mit Code und Bestätigung am PC oder „ohne Code für Berechtigte“, Firewall je Sitzung.
Seit 1.2 (Stufe 3, `gc.remote` Version 3) läuft SSH im eigenen Terminal von GateControl (Browser und Apps nativ) mit
tmux und geprüftem Host-Schlüssel; alte Guacamole-SSH-Geräte stellt der Admin wählbar um. Aufzeichnung je Gerät und je
Person/Gruppe (aus, wählbar, immer – „immer“ nur mit Hinweis), Abspielen und Löschen unter Sitzungen.
Handbuch: [HANDBUCH.md](HANDBUCH.md).
