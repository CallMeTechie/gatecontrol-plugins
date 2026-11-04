# gatecontrol-gatedrop — GateDrop

Sharing like Quick Share through one's own GateControl server: files (1–20 per send, ≤ 2 GB each), a text
(≤ 20 000 characters) or a link go to **people** (a message of the sender in the Messenger), to one's **own
devices** (Android, Windows — directly on the same Wi-Fi when possible, otherwise through the server), into **NAS
folders** (the Synology plugin), into one's **own Drive** (the Drive plugin, since 1.3.0) or out as a **link for
outsiders** (time-limited, optional PIN). Received files stay on the server until they are picked up — as long as an
administrator sets (since 1.5.0; default 7 days, see "Retention").

*Deutsch:* Teilen wie Quick Share über den eigenen Server – an Personen (im Messenger), eigene Geräte (im WLAN direkt,
sonst über den Server), NAS-Ordner, ins eigene Drive oder als Link für Externe. Details im CHANGELOG.

Needs GateControl ≥ 1.193.0: `media` up to 2 GB (`resumable`), `permissions.devices` (`gc.devices.list`,
`user.device`, `gc.notify` `devices` / `silent`), `gc.media.handOver`, `permissions.publicLinks` (`gc.publicLinks`),
`permissions.services` (Messenger `send_file`, Synology `save_file` / `list_drop_folders`, Drive `save_file` /
`list_areas` (Drive ≥ 1.4.0), Familie `family_roles`).

## Who may do what

* Every account may send to people and to its own devices — never a kiosk device (`user.kiosk`), never device trust
  alone (`loggedIn: false` → `403 login_required`), never the admin UI.
* Another person's device only when its owner opened it on that device (`PUT device { receiveFrom: 'everyone' }`,
  default `self`); kiosk accounts' devices are never listed for others.
* Links for outsiders and NAS folders: administrators and Familie's parents (`family_roles`, cached 10 minutes).
  Links also need the administrator's switch *Öffentliche Links erlauben* (default off).
* One's own Drive: every account with a Drive seat (Drive's `list_areas` for the person answers with a writable own
  area `mine`; cached 30 minutes per person).

## App-API

Apps: `/api/v1/client/plugins/gatecontrol-gatedrop/api/<path>` (device token; with GateControl ≥ 1.193.0 every request
carries `user.device = { id, platform }` — the asking installation). Portal frame: `GC.call(method, '<path>')` →
`/api/v1/portal/plugins/gatecontrol-gatedrop/api/<path>` (the same routes are also accepted under `portal/<path>`).
Answers: `{ ok: true, … }`; errors `{ ok: false, code, error }` (localized text) with

| code | HTTP | |
|---|---|---|
| `invalid` | 400 | bad body / query |
| `login_required`, `forbidden` | 403 | see above; links / NAS for others than admins and parents |
| `not_found` | 404 | unknown or not yours |
| `gone` | 410 | the send expired or an administrator removed its files |
| `upload_required` | 409 | `local` items for a target that needs the files on the server |
| `unavailable` | 409 | the target is gone: a device closed for others, Drive not installed / no seat / no licence |
| `links_disabled` | 409 | public links are off |
| `media_invalid`, `media_in_use` | 409 | a file is missing / not the caller's / already sent |
| `no_device` | 409 | the route needs an app installation (`user.device`): `PUT presence`, `GET pending`, `transfers/…` |

Times are ISO-8601 UTC strings unless noted. Files are uploaded first with GateControl's media route
(`PUT /api/v1/client/plugins/gatecontrol-gatedrop/media`, resumable for > 50 MB: `?uploadId=&offset=` + `Content-Range`)
→ `{ mediaId }`. Types: `image/*`, `video/*`, `audio/*`, `application/*`, `text/plain|csv|calendar|vcard|markdown` —
anything else (HTML, XML, JSON, SVG, …) goes up as `application/octet-stream`.

### `GET targets`

```jsonc
{ "ok": true,
  "me": { "id": 2, "name": "Anna", "canLink": true, "canNas": true, "deviceId": "42",     // deviceId: the asking app or null
          "receiveFrom": "self" },                                                        // this device's setting (null: portal)
  "people": [ { "id": "family", "name": "Familie", "avatar": null, "initials": null, "colorHex": null, "kind": "family" },
              { "id": 3, "name": "Marc", "avatar": "/avatars/….webp", "initials": "MA", "colorHex": "#84CC16", "kind": "user" } ],
  "devices": [ { "id": "43", "name": "Büro-PC", "platform": "windows", "online": true, "direct": true, "mode": "push" } ],
  "peopleDevices": [ { "id": "51", "name": "Surface", "platform": "windows", "online": false, "direct": false,   // since 1.2.0
                       "owner": { "id": 3, "name": "Marc" } } ],
  "nas": [ { "id": 1, "label": "Ablage", "path": "/Familie/Ablage" } ],                   // [] unless canNas
  "links": { "enabled": true },                                                           // the administrator's switch
  "drive": true,                                                                          // since 1.3.0: "Mein Drive" offered
  "messenger": true,                                                                      // people get a chat message
  "limits": { "maxItems": 20, "maxBytes": 2147483648, "types": ["image/*", …], "textMax": 20000, "noteMax": 500,
              "retentionDays": 7, "linkExpires": ["1h", "1d", "7d", "once"], "directPort": 47731,
              "presenceEveryS": 300, "ticketS": 600,
              "retention": { "afterPickupDays": 7, "unpickedDays": 7 } },                 // since 1.5.0, see "Retention"
  "storage": { "bytes": 1503238553, "quota": 10737418240 },
  "serverTime": "…" }
```

`family` is listed for members of Familie's family (parents and children). `devices`: the person's app installations
(`gc.devices.list`, no web clients, not the asking one) — since 1.5.0 only those that used GateDrop's app API at least once
(any request with `user.device`; the migration took over what was known: presence, sends, receipts, direct transfers,
`PUT device`), so an app without GateDrop is no longer offered; `POST sends` still takes any own device id; `direct` = both have a presence report younger than 15 minutes
with addresses in the same private IPv4 network (10/8, 172.16/12, 192.168/16; the shorter prefix of both), the target is
online, and one side listens (`mode`: `push` = the target listens, `pull` = the asking device listens). Show the link
target only when `me.canLink && links.enabled`.

`drive` (since 1.3.0): `true` when the Drive plugin is installed and reachable (`save_file`, `list_areas`) and the
person has a Drive seat with a writable own area — offer the target **"Mein Drive"** then (send with `to.drive`).
Cached per person for 30 minutes (GateDrop has 60 service calls an hour); a delivery that Drive refuses with `no_seat`
or `not_licensed` sets it to `false` right away.

A send's `from` (and a transfer's, and the silent push's) carries `own`: `true` when it came from the viewer's own
account (one's own device: name it by `deviceName`), `false` from another person (name them by `name`).

`peopleDevices` (since 1.2.0): other people's devices whose owner opened them for everyone (`PUT device`), same fields
as `devices` plus `owner`; sorted by owner and name. Send to them like to own devices (`to.devices`); the delivery then
belongs to the owner (`ownerId` in the sender's view, label `"Surface (Marc)"`), the owner's device gets the push
("Marc hat dir … geschickt"), `GET pending`, `GET transfers/<id>` as the receiving end, and the send in its inbox
(`received`). A device closed meanwhile → `409 unavailable`.

### `GET device`, `PUT device` (apps only, since 1.2.0)

Who may send to the asking app installation: `{ "receiveFrom": "self" | "everyone" }` → `{ ok, device: { id,
receiveFrom } }`. `self` (default): only its owner; `everyone`: every account of this GateControl (not kiosk devices)
sees it under `peopleDevices` and may send to it. Set on the device itself (the Android app's and the Windows client's
GateDrop page).

### `PUT presence` (apps only)

`{ "lan": [{ "ip": "192.168.1.20", "prefix": 24 }], "port": 47731, "listening": true }` — every 5 minutes and on a
network change (IPv6 and invalid entries are ignored, ≤ 8 kept). → `{ ok, presence: { lan, port, listening, everyS: 300,
freshS: 900 } }`. Windows: `listening: true` always (port 47731); Android: `true` only while it waits for a pull.

### `POST sends`

```jsonc
{ "items": [ { "mediaId": "<32 hex>", "name": "angebot.pdf" },                 // uploaded before
             { "name": "IMG_2041.jpg", "bytes": 3100000, "mime": "image/jpeg", "local": true } ],  // only for direct targets
  "text": "…", "link": "https://…", "note": "…",                               // each optional; something to send is required
  "to": { "people": [3, "family"], "devices": ["43"], "nas": [{ "id": 1, "path": "Rechnungen/2026" }],
          "drive": true | { "folderId": 12 },                                  // since 1.3.0: one's own Drive
          "link": { "expires": "1h" | "1d" | "7d" | "once", "pin": true } } }
```

→
```jsonc
{ "ok": true, "id": "<24 hex>",
  "send": { /* the send, see below */ },
  "deliveries": [ { "id": 1, "kind": "device", "target": "43", "label": "Büro-PC", "status": "direct", "via": "direct",
                    "at": "…", "error": null, "openedAt": null },
                  { "id": 2, "kind": "person", "target": "3", "label": "Marc", "status": "delivered", "via": "server",
                    "conversationId": 17, … },
                  { "id": 3, "kind": "nas", "target": "/Familie/Ablage/Rechnungen/2026", "label": "Ablage/Rechnungen/2026",
                    "status": "pending", … },                                  // saved after the answer → GET sends/<id>
                  { "id": 5, "kind": "drive", "target": "mine", "label": "Mein Drive", "status": "pending",
                    "files": [], "where": [], … },                             // saved after the answer → GET sends/<id>
                  { "id": 4, "kind": "link", "target": "<token>", "label": "angebot.pdf", "status": "delivered", … } ],
  "link": { "token": "…", "url": "https://gc.example.com/s/<token>", "pin": "4819" | null, "expiresAt": "…",
            "maxDownloads": 1 | null } | null,                                 // the PIN is shown once, GateDrop keeps no copy
  "direct": [ { "deviceId": "43", "transferId": "<24 hex>", "mode": "push" | "pull",
                "candidates": ["192.168.1.20:47731"], "key": "<base64, 32 bytes>", "ticket": "<base64url, 32 bytes>",
                "expiresAt": "…" } ] }
```

Delivery `status`: `pending|direct|waiting|delivered|opened|failed|expired` — `pending` (NAS upload running, or a failed
direct transfer waits for the files, or since 1.4.1 with `error: 'scan_pending'` a hand-over waits for GateControl's virus
check — see "Virus scan"), `direct` (direct transfer brokered), `waiting` (an own device that was **offline**
when sent: the send is kept on the server, the push is queued by GateControl; the device fetches it with `GET pending` —
not a failure, retention treats it like `delivered`), `delivered`, `opened`, `failed`, `expired`; `via`: `direct` |
`server`; `pickedAt` (since 1.5.0): when the recipient **confirmed** it has the send (see "Pick-up") — `delivered`
without it only means provided (pushed, waiting for the app); `error` (a code,
informational when delivered): `direct_failed`, `incomplete` (1.5.0: the receiving end of a direct transfer reported fewer
bytes), `removed` (1.5.0: with `status: 'expired'` — an administrator removed the files before this recipient picked them
up), `push_failed`, `file_type` / `file_too_large` / `unavailable` (the
Messenger did not take it — the person got a push instead), `no_space`, `permission`, `unreachable`, `upload_failed`
(NAS), `links_disabled`, `no_public_url`, `revoked`; Drive passes its codes through: `no_seat`, `not_licensed`,
`not_found` (the folder is gone), `forbidden` (no write access to it), `quota`, `upload_invalid`, `invalid`, `exists`,
`internal`, plus `unavailable`, `rate_limited`, `timeout`; since 1.4.0 `quarantined`, `scan_pending`, `scan_blocked` (the virus
scan held the file back, see "Virus scan"). `conversationId` (person via the Messenger), `paths` (NAS),
`files` / `where` (Drive).

**People:** with the Messenger, files ≤ 25 MB (≤ 100 MB per send in all, ≤ 200 hand-overs per sender and day,
Messenger, NAS and Drive together) are handed over and sent with `send_file` as the sender's message; larger files and types
the Messenger does not take stay in GateDrop (the person gets the `received` push for them, they are in `GET inbox`, the
chat message names them "+2 Dateien in GateDrop: …"; the delivery has `conversationId` and is `delivered`). A refusal of
the Messenger (`forbidden` for a block or not a member, `readonly`, …) **fails** the delivery — no push, nothing in the
recipient's inbox. Only without the Messenger (not installed / not reachable) the person gets everything through GateDrop.
`family` goes to the family's members **at sending** (only they ever see it).

`local: true` items stay on the sender's device; every target must then be one of its own devices reached directly
(else `409 upload_required`). Links, NAS folders and Drive need files.

**Drive** (since 1.3.0): `to.drive` = `true` (or `{}`) → every file goes into the **sender's own** Drive as
`GateDrop/<name>` in their own area (`area: 'mine'`, the folder is made when missing); `{ "folderId": 12 }` → into that
folder (one the sender picked in Drive's own API — any area they may write to). A name taken → `"<name> (2)"`. A text, a
link or a note is not saved (it stays in GateDrop like for NAS); a send to Drive needs at least one file. Checked before
the answer: Drive available and a seat (`GET targets`' `drive`), else `409 unavailable`; a bad `drive` / `folderId`
→ `400 invalid`. Each file is handed over (`gc.media.handOver`, a copy — GateDrop keeps its own for 7 days) and saved
with Drive's `save_file` for the sender **after the answer** (the delivery is `pending`, then `delivered` or `failed`;
poll `GET sends/<id>`). Delivery: `target` `"mine"` | `"folder:<id>"`; `label` `"Mein Drive"` until saved, then the
folder as Drive names it (`"Meine Dateien › GateDrop"`); `files: [{ nodeId, areaId, name, where }]` and `where:
["Meine Dateien › GateDrop › Foto.jpg", …]` (in the sender's language, for "Gespeichert in …") — the files saved, also
for a delivery that failed partway. `error` is Drive's code of the first file that failed; after `no_seat`,
`not_licensed`, `not_found`, `forbidden` the remaining files are not tried.

### Direct transfers (protocol v1, contract C)

The sender gets `direct[]`; the receiving device gets a **silent data push** (topic `received`, only that device; the app
receives `kind: "data"`, `silent: true`) whose `data` is

```jsonc
{ "route": "plg-gatecontrol-gatedrop",
  "gatedrop": { "transfer": "<24 hex>", "send": "<24 hex>", "mode": "push" | "pull",
                "from": { "userId": 2, "name": "Anna", "deviceId": "42", "deviceName": "Pixel" },
                "items": [ { "index": 0, "name": "IMG_2041.jpg", "bytes": 3100000, "mime": "image/jpeg" } ],  // null if too long →
                "itemCount": 20,                                                                            //   then GET transfers/<id>
                "candidates": ["192.168.1.20:47731"], "key": "<base64 32 B>", "ticket": "<base64url>", "expiresAt": "…" } }
```

* `push`: the sender `POST http://<candidate>/gatedrop/v1/transfer/<transferId>` per item with `X-GD-Ticket`,
  `X-GD-Item: <index>`, `X-GD-Name` (base64url UTF-8), `X-GD-Size`; `pull`: the receiver `GET
  http://<candidate>/gatedrop/v1/transfer/<transferId>/<index>` with `X-GD-Ticket`. AES-256-GCM with `key`, 1 MiB
  blocks, nonce = first 4 bytes of SHA-256(transferId) ‖ 8-byte block counter (big-endian), block = ciphertext ‖ tag.
  2 s connect timeout per candidate, then the server way. The ticket is valid once, for 10 minutes.
* `GET transfers/<id>` (either end, apps only) → `{ transfer: { id, sendId, side: "sender"|"receiver", mode, status:
  "open"|"done"|"failed"|"expired", fromDevice, toDevice, from: { userId, deviceId, deviceName }, candidates, key,
  ticket, expiresAt, peer, items: [{ index, name, bytes, mime }] } }` — `key` / `ticket` only while open (deleted from the
  database once the transfer is done, failed or expired). `peer` (since 1.2.1): what the other end reported,
  `{ ok, error }` or `null` — the end that waits (pull: the sender's listener, push: the receiver's) polls this every
  few seconds and takes the server way as soon as the other end gave up (`status: "failed"`).
* `POST transfers/<id>/result` `{ ok, bytes?, error? ([a-z0-9_.-]{1,64}) }` (both ends) → `{ transfer: { id, status, side },
  delivery: { id, kind, target, status, via, error, at }, fallback: null | "server" | "upload", missing?: [indexes] }`.
  `ok: true` → delivered via direct. Since 1.5.0 the **receiving end** decides: its `ok` with `bytes` below the files'
  size counts as a failure (`incomplete`, stored as its result) — also after the sender's `ok`; its `ok` with every byte (or
  without `bytes`, older apps) is the pick-up (`pickedAt`). The sender's `ok` alone makes the delivery `delivered` via
  direct (as before) but not picked up, and no longer undoes a server way the receiver's failure started. The answer's
  `delivery` carries `pickedAt`. A failure: all files on the server → `fallback: "server"` (a push to the device
  now); files still local → `fallback: "upload"`, `missing` = the item indexes: the sender uploads them and calls
* `POST sends/<id>/items` `{ items: [{ index, mediaId }] }` (sender) → `{ send }`; once all files are there the waiting
  device deliveries go through the server.
* No result within 10 minutes: the background does the same as a failure.

### Deliveries through the server

An own device that is online (`online` in `gc.devices.list`) gets the delivery as `delivered` (provided — picked up
only once that device calls `POST sends/<id>/opened`, see "Pick-up"); one that is offline as
`waiting` — the push below is sent all the same (GateControl queues it), but an app that comes back does not act on
pushes it missed: it polls `GET pending` (below). Direct transfers stay limited to online devices.

A visible push on topic `received` — to the device (`devices: [id]`) or the person — titled "Pixel hat dir eine Datei
geschickt" / "Anna hat dir 3 Dateien geschickt" / "… einen Text" / "… einen Link" (the recipient's language), body:
file names or the text's start, `collapseKey` `gatedrop:<sendId>`, `data`:

```json
{ "route": "plg-gatecontrol-gatedrop", "gatedrop": { "send": "<24 hex>" } }
```

The app then reads `GET sends/<id>` and downloads each file with `GET items/<mediaId>`.

### `GET pending` (apps only)

What the calling device still has to fetch — for apps that were offline (poll it on start, on reconnect and now and
then; it is cheap). Needs `user.device`, else `409 no_device`.

```jsonc
{ "ok": true, "items": [ /* send, exactly as GET sends/<id> returns it */ ] }
```

Listed: sends with a device delivery whose target is the calling device, `via: "server"` and `status` `waiting` or
`delivered`, whose send is not expired (`expiresAt` in the future, files not removed), with at least one file on the
server (`items[].available`) **or** a `text` / `link` (sends without files are listed too — the queued push is not acted
on after a reconnect) — oldest first (`createdAt`), at most 50. Sends to one's own devices are one's own sends,
so `role` is `"sent"` and `deliveries` lists every target (the calling device's entry: `target` = its id).
The call itself means the device is online: its `waiting` deliveries (of sends not expired) become `delivered` with
`at` = now (the sender sees it). A send stays listed until the device calls `POST sends/<id>/opened` (its "received"
acknowledgement, for file sends and text / link sends alike: that device's delivery becomes `opened`). Download the
files with `GET items/<mediaId>` as usual.

### Reading

* `GET sends/<id>` → `{ send }` — the sender's view (`role: "sent"`, every delivery) or a recipient's (`role:
  "received"`, only its own deliveries).
  `send = { id, role, createdAt, expiresAt, expired, removed, removedAt, pickedAt, from: { userId, name, avatarUrl,
  deviceId, deviceName }, text, link, note, items: [{ index, mediaId (null when not on the server), name, mime, bytes, local,
  available, scan? }], deliveries }` — `scan` since 1.4.0, see "Virus scan"; `removed` / `removedAt` / `pickedAt` since
  1.5.0: an administrator removed the files ("Vom Admin entfernt" — `expired` is `true` too), every recipient picked it up.
  `expiresAt` follows the administrator's retention and may change (a pick-up, a new setting).
* `GET inbox?kind=received|sent|links&before=<ISO>&limit=1…100` (default 50, newest first) → `{ kind, items, hasMore }`.
  `received`: sends to one's devices and to oneself as a person (not those that arrived as a chat message), with the
  family's ones; `sent`: one's own sends; `links`: `[{ token, url, sendId, title, pin, maxDownloads, downloads, locked,
  revoked, state ("active"|"expired"|"revoked"|"locked"|"used"|"gone"), active, createdAt, expiresAt }]`.
* `GET items/<mediaId>` → `{ item: { sendId, index, mediaId, name, mime, bytes, local, available, scan? }, url }` (a file the
  virus scan holds back: `423 quarantined | scan_pending | scan_blocked { scan }`, since 1.4.0) — `url`: the
  apps' media route `/api/v1/client/plugins/gatecontrol-gatedrop/media/<mediaId>` (Range, the hook `mediaAccess`
  allows the sender and the recipients until the send expires), in the portal a signed `/plugin-media/…` URL.
* `POST sends/<id>/opened` (recipient) → `{ send }`: the person deliveries, and a device delivery only when that device
  itself calls (`waiting` or `delivered` → `opened`; the portal or another device never marks it). The apps call it once a send is received (files saved, or a text / link shown) — it takes the send off `GET pending`.
* `DELETE links/<token>` (the link's owner) → `{ revoked }`.

A link with a PIN gets a generic title ("Geteilte Dateien" / "Shared files"), so no file name shows before the PIN.

### Virus scan (since 1.4.0)

GateControl checks every uploaded file right after it is stored (the GateControl version after 1.222.0 — Einstellungen ›
Sicherheit › Virenscan, source "GateDrop"; contract: GateControl's `docs/feature-malware-scan-contract.md`). GateDrop
reads the result where the host gives one (`scan` of `gc.media.info`) and changes nothing with an older GateControl; the
minimum stays 1.193.0.

* **Uploading:** the upload itself may already refuse a file — `422 { code: 'infected', finding }` (the administrator's
  action "Sofort löschen": the file is gone; the apps show „<name> abgelehnt – Schadsoftware gefunden“) or `503
  scan_unavailable` (the scanner is away and uploads wait: try later). A stored file carries `scan { state, blocked,
  finding }` in the upload's answer (of a resumable upload the last part).
* **`POST sends`** / **`POST sends/<id>/items`:** a file the scan holds back is not sent — `422 infected` (malware,
  quarantined), `423 scan_pending` (a big file is still being checked: send the same body again after a few seconds — the
  portal does so every 5 s for up to 10 minutes and shows „Wird auf Viren geprüft …“), `423 scan_blocked` (not
  checkable and blocked); each with the item's `name`. Nothing of the send is stored then.
* **Items** carry `scan { state, blocked, finding }` once a result is known (`state` `pending` | `clean` | `infected` |
  `unscannable` | `unchecked`). **`blocked` decides:** a held-back item is `available: false` with `mediaId: null` — no
  download, no forwarding. A later check (the nightly re-check with new signatures, an administrator's release or
  delete — the hook `mediaScanned`) changes the item; `GET items/<mediaId>` then answers `423 quarantined | scan_pending |
  scan_blocked { scan }`, and GateControl's media route answers `423` itself. `infected` with `blocked: false`: the
  administrator only marks findings — the file is usable, the clients warn before opening it.
* **Deliveries:** a hand-over (Messenger, NAS, Drive) of a file blocked in between fails with the delivery `error`
  `quarantined` / `scan_blocked`; a public link's ZIP or file answers `423` while a file is held back.
* **Waiting for the check (since 1.4.1):** a hand-over that only a **running** check holds back (`ERR_MEDIA_SCAN_PENDING`,
  or the target plugin answers `scan_pending`) does not fail: the delivery stays `status: 'pending'` with
  `error: 'scan_pending'` — not a failure, nothing is handed on yet (no half chat message, no file saved twice), a person
  sees nothing of it yet. Clients show it like any `pending` delivery („ausstehend“; the portal: „wartet auf die
  Virenprüfung“) and must not treat a `pending` delivery's `error` as a failure. When GateControl reports the result
  (hook `mediaScanned`), GateDrop delivers it: clean or only marked → `delivered`; quarantined or deleted → `failed`
  `quarantined`; not checkable and blocked → `failed` `scan_blocked` (NAS and Drive save the other files). The background
  tries a waiting delivery again every 5 minutes (a missed result) and gives up 24 hours after the send: `failed`
  `scan_pending`. Before 1.4.1 such a delivery failed at once with `scan_pending`.
* **Portal:** an upload the scan refuses says „<name> abgelehnt – Schadsoftware gefunden.“, the history marks received
  files „Gesperrt – Schadsoftware“, „Gesperrt – nicht prüfbar“, „Wird geprüft …“ or „Warnung – Schadsoftware“ (no
  download for held-back files; a marked file asks first).

### Notifications

Topics `received` ("Empfangen": deliveries, silent transfer pushes) and `link` ("Link geladen": `Link geladen: <title>`,
`<n>× heruntergeladen`; `Link gesperrt: <title>` after 5 wrong PINs; data `{ gatedrop: { link: <token>, send } }`).

### Pick-up (since 1.5.0)

`deliveries[].pickedAt` is set only by a real confirmation — `delivered` alone no longer counts as picked up:

| target | confirmed by |
|---|---|
| device (server) | that device's `POST sends/<id>/opened` (not another device, not the portal) |
| device (direct) | the receiving device's `POST transfers/<id>/result { ok: true, bytes }` with every byte (or without `bytes`) |
| person | the person's `POST sends/<id>/opened`; `family`: every member at sending (the delivery's `status` becomes `opened` at the first, as before) |
| person via the Messenger | the message carries every file (no "+N Dateien in GateDrop") |
| NAS, Drive | saved (`delivered`) |
| link | never — a link keeps its time; a send of links only counts as picked up with its first download |

The send's `pickedAt`: every delivery that needs the server copy (not links, not failed / expired ones) is picked up.
The retention after the pick-up counts from then.

### Retention (since 1.5.0)

An administrator sets on the page "Übersicht" how long files of sends through the server stay: **after the pick-up**
0 (at once — 15 minutes so a running download ends), 1, 3 or 7 days, and **not picked up** 3, 7, 14 or 30 days from
sending. Default 7 / 7: the files go 7 days after sending, as before 1.5.0. A send picked up never stays longer than one
that is not. The setting applies to existing sends too (their `expiresAt` changes). A link for outsiders keeps the time
chosen when it was made (no longer cut by the retention); the send's files stay while it is active. The background
deletes the files at `expiresAt` (`expired: true`), the history 30 days after sending. `GET targets` → `limits.retention
{ afterPickupDays, unpickedDays }` and `limits.retentionDays` (= `unpickedDays`, the longest a send waits).

## Admin page

"Übersicht" — administrators in the admin UI only (`/api/v1/plugins/gatecontrol-gatedrop/api/admin/…`; the portal, the
apps, kiosk devices and other people get `403 forbidden`). People and device names are shown — **never** a file name, a
MIME type, a text, a link, a note, a NAS path below the drop folder, a Drive folder or a link's title / URL.

* `GET admin/overview` → `{ storage (gc.media.usage), held: { picked: { count, bytes }, unpicked: { count, bytes, oldestAt } },
  week: { sends, arrived, waiting, failed, direct, server }, retention: { afterDays, unpickedDays, after, unpicked },
  retentionDays, sends7d, activeLinks, linksEnabled, integrations }`.
* `GET admin/sends?range=7d|30d|server&filter=all|problems|waiting|direct|server|links&q=&cursor=&limit=1…100` (default 50,
  newest first) → `{ items, hasMore, cursor, counts: { all, problems, waiting, direct, server, links } }` (counts in the
  range and search). `q`: a person (sender, recipient, family member) or a device name. A row: `{ id, createdAt, from:
  { userId, name, device, portal }, to: [{ kind: device|person|family|nas|drive|link, name?, platform?, owner?, online?,
  lastSeen?, members?, messenger?, pin?, maxDownloads? }], files, bytes, way: direct|server|fallback|mixed|link,
  status: { state: picked|partial|waiting|pending|failed|expired|removed|link, how?, picked?, total?, open?, since?,
  offline?, lastSeen?, scan?, error?, at?, downloads?, active?, expiresAt? }, problem, server: { state:
  held|never|none|after|expired|removed, bytes?, until? }, canDelete }`. Problems: a failure, waiting for more than a day,
  expired without the pick-up.
* `DELETE admin/sends/<id>` → `{ removed, bytes }` (`410 gone` without files on the server).
* `PUT admin/retention { afterDays: 0|1|3|7, unpickedDays: 3|7|14|30 }` → `{ retention }`.
* `GET admin/cleanup?olderDays=1|3|7` → `{ unpicked: { olderDays, count, bytes }, picked: { count, bytes } }`;
  `POST admin/cleanup { unpicked: 1|3|7|null, picked: true|false }` → `{ removed, bytes }` — "schon abgeholt" leaves sends
  with an active link alone.

Removing (cleanup or one send): the send is `removed` and expires at once (nobody reads a file any more); deliveries not
picked up become `expired` with `error: 'removed'` — those recipients no longer see the send (not in `GET pending`,
`GET inbox`, `GET sends/<id>`); open transfers end, links are revoked; the files are deleted in the background in
batches. Recipients that picked it up keep it in their history. Only GateDrop's copies go: what is on devices, in the NAS,
in Drive or in the Messenger stays.

## Development

`GATECONTROL_DIR=… node tools/test.js gatecontrol-gatedrop` — the tests use the mock host as GateControl 1.193.0 with
the real Messenger and NAS plugins linked (hand-over, services, File Station upload against a fake DSM) and a fake
of Drive's `list_areas` / `save_file` (`test/helpers.js` `fakeDrive`).
