# gatecontrol-gatedrop — GateDrop

Sharing like Quick Share through one's own GateControl server: files (1–20 per send, ≤ 2 GB each), a text
(≤ 20 000 characters) or a link go to **people** (a message of the sender in the Messenger), to one's **own
devices** (Android, Windows — directly on the same Wi-Fi when possible, otherwise through the server), into **NAS
folders** (the Synology plugin) or out as a **link for outsiders** (time-limited, optional PIN). Received files stay
7 days on the server.

*Deutsch:* Teilen wie Quick Share über den eigenen Server – an Personen (im Messenger), eigene Geräte (im WLAN direkt,
sonst über den Server), NAS-Ordner oder als Link für Externe. Details im CHANGELOG.

Needs GateControl ≥ 1.193.0: `media` up to 2 GB (`resumable`), `permissions.devices` (`gc.devices.list`,
`user.device`, `gc.notify` `devices` / `silent`), `gc.media.handOver`, `permissions.publicLinks` (`gc.publicLinks`),
`permissions.services` (Messenger `send_file`, Synology `save_file` / `list_drop_folders`, Familie `family_roles`).

## Who may do what

* Every account may send to people and to its own devices — never a kiosk device (`user.kiosk`), never device trust
  alone (`loggedIn: false` → `403 login_required`), never the admin UI.
* Links for outsiders and NAS folders: administrators and Familie's parents (`family_roles`, cached 10 minutes).
  Links also need the administrator's switch *Öffentliche Links erlauben* (default off).

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
| `gone` | 410 | the send expired (files removed) |
| `upload_required` | 409 | `local` items for a target that needs the files on the server |
| `links_disabled` | 409 | public links are off |
| `media_invalid`, `media_in_use` | 409 | a file is missing / not the caller's / already sent |
| `no_device` | 409 | the route needs an app installation (`user.device`) |

Times are ISO-8601 UTC strings unless noted. Files are uploaded first with GateControl's media route
(`PUT /api/v1/client/plugins/gatecontrol-gatedrop/media`, resumable for > 50 MB: `?uploadId=&offset=` + `Content-Range`)
→ `{ mediaId }`. Types: `image/*`, `video/*`, `audio/*`, `application/*`, `text/plain|csv|calendar|vcard|markdown` —
anything else (HTML, XML, JSON, SVG, …) goes up as `application/octet-stream`.

### `GET targets`

```jsonc
{ "ok": true,
  "me": { "id": 2, "name": "Anna", "canLink": true, "canNas": true, "deviceId": "42" },   // deviceId: the asking app or null
  "people": [ { "id": "family", "name": "Familie", "avatar": null, "initials": null, "colorHex": null, "kind": "family" },
              { "id": 3, "name": "Marc", "avatar": "/avatars/….webp", "initials": "MA", "colorHex": "#84CC16", "kind": "user" } ],
  "devices": [ { "id": "43", "name": "Büro-PC", "platform": "windows", "online": true, "direct": true, "mode": "push" } ],
  "nas": [ { "id": 1, "label": "Ablage", "path": "/Familie/Ablage" } ],                   // [] unless canNas
  "links": { "enabled": true },                                                           // the administrator's switch
  "messenger": true,                                                                      // people get a chat message
  "limits": { "maxItems": 20, "maxBytes": 2147483648, "types": ["image/*", …], "textMax": 20000, "noteMax": 500,
              "retentionDays": 7, "linkExpires": ["1h", "1d", "7d", "once"], "directPort": 47731,
              "presenceEveryS": 300, "ticketS": 600 },
  "storage": { "bytes": 1503238553, "quota": 10737418240 },
  "serverTime": "…" }
```

`family` is listed for members of Familie's family (parents and children). `devices`: the person's app installations
(`gc.devices.list`, no web clients, not the asking one); `direct` = both have a presence report younger than 15 minutes
with addresses in the same private IPv4 network (10/8, 172.16/12, 192.168/16; the shorter prefix of both), the target is
online, and one side listens (`mode`: `push` = the target listens, `pull` = the asking device listens). Show the link
target only when `me.canLink && links.enabled`.

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
                  { "id": 4, "kind": "link", "target": "<token>", "label": "angebot.pdf", "status": "delivered", … } ],
  "link": { "token": "…", "url": "https://gc.example.com/s/<token>", "pin": "4819" | null, "expiresAt": "…",
            "maxDownloads": 1 | null } | null,                                 // the PIN is shown once, GateDrop keeps no copy
  "direct": [ { "deviceId": "43", "transferId": "<24 hex>", "mode": "push" | "pull",
                "candidates": ["192.168.1.20:47731"], "key": "<base64, 32 bytes>", "ticket": "<base64url, 32 bytes>",
                "expiresAt": "…" } ] }
```

Delivery `status`: `pending` (waiting: NAS upload running, or a failed direct transfer waits for the files), `direct`
(direct transfer brokered), `delivered`, `opened`, `failed`, `expired`; `via`: `direct` | `server`; `error` (a code,
informational when delivered): `direct_failed`, `push_failed`, `file_type` / `file_too_large` / `unavailable` (the
Messenger did not take it — the person got a push instead), `no_space`, `permission`, `unreachable`, `upload_failed`
(NAS), `links_disabled`, `no_public_url`, `revoked`. `conversationId` (person via the Messenger), `paths` (NAS).

`local: true` items stay on the sender's device; every target must then be one of its own devices reached directly
(else `409 upload_required`). Links and NAS folders need files.

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
  ticket, expiresAt, items: [{ index, name, bytes, mime }] } }` — `key` / `ticket` only while open.
* `POST transfers/<id>/result` `{ ok, bytes?, error? ([a-z0-9_.-]{1,64}) }` (both ends) → `{ transfer: { id, status, side },
  delivery: { id, kind, target, status, via, error, at }, fallback: null | "server" | "upload", missing?: [indexes] }`.
  `ok: true` → delivered via direct. A failure: all files on the server → `fallback: "server"` (a push to the device
  now); files still local → `fallback: "upload"`, `missing` = the item indexes: the sender uploads them and calls
* `POST sends/<id>/items` `{ items: [{ index, mediaId }] }` (sender) → `{ send }`; once all files are there the waiting
  device deliveries go through the server.
* No result within 10 minutes: the background does the same as a failure.

### Deliveries through the server

A visible push on topic `received` — to the device (`devices: [id]`) or the person — titled "Pixel hat dir eine Datei
geschickt" / "Anna hat dir 3 Dateien geschickt" / "… einen Text" / "… einen Link" (the recipient's language), body:
file names or the text's start, `collapseKey` `gatedrop:<sendId>`, `data`:

```json
{ "route": "plg-gatecontrol-gatedrop", "gatedrop": { "send": "<24 hex>" } }
```

The app then reads `GET sends/<id>` and downloads each file with `GET items/<mediaId>`.

### Reading

* `GET sends/<id>` → `{ send }` — the sender's view (`role: "sent"`, every delivery) or a recipient's (`role:
  "received"`, only its own deliveries).
  `send = { id, role, createdAt, expiresAt, expired, from: { userId, name, avatarUrl, deviceId, deviceName }, text, link,
  note, items: [{ index, mediaId (null when not on the server), name, mime, bytes, local, available }], deliveries }`.
* `GET inbox?kind=received|sent|links&before=<ISO>&limit=1…100` (default 50, newest first) → `{ kind, items, hasMore }`.
  `received`: sends to one's devices and to oneself as a person (not those that arrived as a chat message), with the
  family's ones; `sent`: one's own sends; `links`: `[{ token, url, sendId, title, pin, maxDownloads, downloads, locked,
  revoked, state ("active"|"expired"|"revoked"|"locked"|"used"|"gone"), active, createdAt, expiresAt }]`.
* `GET items/<mediaId>` → `{ item: { sendId, index, mediaId, name, mime, bytes, local, available }, url }` — `url`: the
  apps' media route `/api/v1/client/plugins/gatecontrol-gatedrop/media/<mediaId>` (Range, the hook `mediaAccess`
  allows the sender and the recipients until the send expires), in the portal a signed `/plugin-media/…` URL.
* `POST sends/<id>/opened` (recipient; from an app only that device's delivery) → `{ send }`.
* `DELETE links/<token>` (the link's owner) → `{ revoked }`.

### Notifications

Topics `received` ("Empfangen": deliveries, silent transfer pushes) and `link` ("Link geladen": `Link geladen: <title>`,
`<n>× heruntergeladen`; `Link gesperrt: <title>` after 5 wrong PINs; data `{ gatedrop: { link: <token>, send } }`).

## Admin page

"Übersicht" (`admin/overview`): storage (`gc.media.usage`), retention (7 days), active links, sends of 7 days, whether
links are on (with the way to the switch), Messenger / NAS / Familie available. No content.

## Development

`GATECONTROL_DIR=… node tools/test.js gatecontrol-gatedrop` — the tests use the mock host as GateControl 1.193.0 with
the real Messenger and NAS plugins linked (hand-over, services, File Station upload against a fake DSM).
