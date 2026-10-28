# gatecontrol-drive — Drive

The files of the family and the team on one's own storage — this server, a NAS or S3 — with areas and rights,
versions, a trash, links for people without an account and sync with every device. Released with 1.0.0: the portal
tab "Drive", the admin pages and the services for other plugins; the apps follow. Sold as its own subscription
(Familie, Business or Kombi, five people included, more bookable on callmetechie.de), not part of GateControl
Lifetime.

*Deutsch:* Dateien der Familie und des Teams auf dem eigenen Speicher – Bereiche mit Rechten, Versionen, Papierkorb,
Abgleich mit allen Geräten. Details im CHANGELOG.

Needs GateControl ≥ 1.208.0: `media.areas` (an area per Drive area, paths, `gc.media.move` / `version`, a version back
to its path, the NAS journal and the hook `mediaChanged`), `gc.license.info` (tier and seats), `storage.maxMB` 4096,
`permissions.groups: 'read'` (family groups and their roles, groups of team folders), `permissions.events`,
`media.previews` (since 1.1.0: previews of files, `gc.media.previews`), `permissions.devices` (since 1.2.0: the asking
device of an app request, `user.device` — GateControl passes it only with this permission; see "Delete on all
devices"; since 1.6.0 also the device the ransomware protection watches and stops). The photo frame on kiosk devices
(since 1.7.0) shows pictures only with GateControl ≥ 1.210.0 (preview-only URLs); vault folders in the portal (since
1.9.0: `GC.keys`, `GC.mediaBytes`) and office in the browser (`permissions.publicEndpoints`, `GC.openTab`) need
GateControl ≥ 1.211.0 — the apps use vaults with 1.208.0; everything else works with 1.208.0.

## Areas and rights

| Area | id | Who | Role |
|---|---|---|---|
| Meine Dateien | `mine:<user>` | every person switched on | manage |
| Familie | `family:<group>` | members of a GateControl family group with a family seat | write |
| Kinder · Name | `child:<user>` | the child (family seat) | manage |
| | | its parents with a family seat, while *child_parents_view* is on | read — the child gets a note once a day (topic `child_view`) |
| Team folder | `team:<n>` | people `u:<id>` and groups `g:<id>` an administrator names, with a business seat | read / write / manage |

Roles: `read` (list, download), `write` (also upload, create, rename, move, delete, restore), `manage` (the same; team
folders: reserved for managing members later). An archived team folder is read only.

Each area has its own media area (`u<id>`, `f<group>`, `c<id>`, `t<n>`); an administrator picks its storage under
GateControl › Plugins › Drive › Speicherorte. A file's media lies at the file's path, so on a NAS in the readable form
the files are plain files; changes made there come back through the journal.

## Who may use Drive

An administrator switches people on (`PUT admin/seats/<id> { kind: 'family' | 'business' | null }`). The licence
(`gc.license.info`) says how many: tier `family` (family people only), `business`, `combo` (both, included people
shared); no tier (lifetime, plan) — no limit. At the limit nobody more is switched on (`409 seat_limit`, a kind the
licence lacks: `409 seat_kind`); people already on keep working when the licence gets smaller (`exceeded` in the
overview). Without a valid licence every route but `GET me` answers `403 not_licensed`; a person not switched on gets
`403 no_seat`.

## API

App: `/api/v1/client/plugins/gatecontrol-drive/api/…` · portal: `/api/v1/portal/plugins/gatecontrol-drive/api/…`
(also under `portal/…`). Signed-in people only — never device trust alone (`403 login_required`); a kiosk device
reaches `GET frame` (the photo frame, since 1.7.0) and nothing else (`403 forbidden`). Every answer has `ok`; errors `{ ok: false, code, error }` (+ details).

| Route | Body / query | Answer |
|---|---|---|
| `GET me` | | `me { id, name, seat, deviceId, admin }`, `licence { valid, tier }`, `areas`, `latest` (change log seq), `settings`, `limits { maxBytes }`, `wipes` (entries this device has yet to handle, since 1.2.0), `devices` (my devices a new wipe reaches), `features` (since 1.5.0: `['previews', 'wipes', 'textSearch', 'devices', 'deleteAfter', 'emptyFiles']`, since 1.6.0 also `'links'`, `'guard'`, since 1.7.0 `'timeTravel'`, `'takenAt'`, `'photos'`, `'albums'`, `'frame'`, `'storage'`, since 1.9.0 `'vault'` and — while set up — `'office'`), `links { node, drive } \| null` (since 1.6.0, see "Direct links"), `guard { on, locked, incident }` and `incidents` (since 1.6.0, see "Ransomware protection") |
| `GET areas` | | `areas [{ id, kind, label, role, via, rootId, owner, archived, storage { bytes, quota, form, target, state } }]` |
| `GET nodes/<id>` | | `node` + `path`, `role`, `crumbs [{ id, name }]` |
| `GET nodes/<id>/children` | `sort=name\|mtime\|size\|updated`, `order`, `offset`, `limit` (≤ 1000) | `items` (folders first), `total`, `next`, `role` |
| `GET nodes/by-path` | `area`, `path` | `node` |
| `POST nodes` | `{ parentId, name, rename? }` | `node` (a folder; `409 exists`, or a free name with `rename`) |
| `PATCH nodes/<id>` | `{ name?, parentId? }` | `node` — rename / move, also into another area one writes to |
| `PATCH nodes/<id>` | `{ deleteAt: <ISO \| ms> \| null, device? }` (since 1.5.0, alone — not with `name` / `parentId`) | `node` — set the mark exactly / end it (see "Delete later") |
| `DELETE nodes/<id>` | `everywhere=1` (since 1.2.0) | `{ id, trashed }` — into the trash; with `everywhere=1` also `wipe { id, devices, files }` (see "Delete on all devices") |
| `DELETE nodes/<id>` | `after=<seconds>` (1 … 31 536 000), `device?` (since 1.5.0) | `{ id, marked: true, deleteAt, node }` — into the trash later (see "Delete later"); `after=0` is the plain delete |
| `GET nodes/<id>/content` | | `{ url, name, mime, size, mediaId }` — `url` signed for the viewer, 1 h; an empty file (since 1.5.0): `{ url: 'data:<mime>;base64,', size: 0, mediaId: null, empty: true }` |
| `GET nodes/<id>/versions` | | `{ current, versions [{ id, rev, size, sha256, at, by }] }` |
| `GET nodes/<id>/versions/<vid>/content` | | `{ url, … }` |
| `POST nodes/<id>/versions/<vid>/restore` | | `node` — the version is current again, the current bytes become a version |
| `DELETE nodes/<id>/versions/<vid>` | | `{ id }` |
| `POST uploads/check` | `{ parentId, name, sha256?, size? }` | `{ exists, same, node }` — `same`: no need to upload (two empty files are the same, also without `sha256`) |
| `POST uploads/commit` | `{ mediaId, parentId, name, baseRev?, mtime?, onConflict?: 'rename' \| 'version', text?, entropy?, takenAt? }` — `takenAt` (since 1.7.0): when the picture or video was taken, ISO-8601 or ms (else `400 invalid`, `field: 'takenAt'`; more than a day ahead or before 1900: ignored); — `text`: recognised text of a scan (≤ 100 000 characters, searchable); an empty file (since 1.5.0): `{ parentId, name, size: 0, mime?, sha256?, … }` without `mediaId`; `entropy` (since 1.6.0, optional): how random the device found the bytes, 0–8 bits per byte (else `400 invalid`, `field: 'entropy'`); into a vault (since 1.9.0): `{ mediaId, parentId, encrypted: true, nameCipher, keyVersion, name?, … }` — see "Vault folders" | `{ node, created }` |
| `GET changes` | `since`, `limit` (≤ 1000) | `{ changes [{ seq, op, areaId, nodeId, at, by, device, node }], next, more }` |
| `GET trash` | `area?` | `items` (the deleted node with `from`, folders with `size`, `files`) |
| `POST trash/<id>/restore` | | `node` (a free name; the area's top when its folder is gone) |
| `DELETE trash/<id>` | | `{ id, files }` — gone for good (wipes stay) |
| `GET wipes` | | `{ wipes [{ id, wipeId, nodeId, name, sha256, size, mime, createdAt }], more }` — this device's, oldest first, ≤ 500 (since 1.2.0) |
| `POST wipes/done` | `{ ids: [<entry id>, …] }` (≤ 1000) | `{ done, wipes }` — this device handled them (since 1.2.0) |
| `GET search` | `q` (2–100 characters), `area?` | `items` with `path` and `match` (`name`, then `text` with a `snippet`) (≤ 100) |
| `PUT devices/<id>` | `{ name, platform?, version? }` (since 1.5.0) | `device` — register / update my device (see "Devices") |
| `GET devices` | | `devices` — mine, last seen first |
| `PUT devices/<id>/folders` | `[{ localPath, mode: 'backup' \| 'sync', nodeId, lastBackup }]` or `{ folders: […] }` (≤ 100) | `device` |
| `DELETE devices/<id>` | | `{ id, removed }` — forgets the device; its files and folders stay |
| `POST links` | `{ nodeId, mode: 'view' \| 'download' \| 'upload', expires: '1d' \| '7d' \| '30d' \| 'never', pin?, maxFiles?, maxBytes? }` | `link` (with `url`) |
| `GET links` | `nodeId?` | `{ links, enabled }` — mine, or those of a node I write to |
| `GET links/<token>/events` | `before?` | `events` — the log (newest first, ≤ 100) |
| `DELETE links/<token>` | | `{ ended }` — whoever made it, or who manages the area |
| `GET guard/incidents` | `all=1` (administrators: everyone's) | `{ incidents, admin }` — mine, open ones first (since 1.6.0) |
| `GET guard/incidents/<id>` | | `{ incident, entries [{ op, name, oldName, nodeId, at, flags }] }` (≤ 500) |
| `POST guard/incidents/<id>/release` | | `{ incident, restored: 0, trashed: 0 }` — a false alarm: the device may write again |
| `POST guard/incidents/<id>/undo` | | `{ incident, restored, trashed, failed }` — every file back to how it was before, then released |
| `GET nodes/<id>/timetravel` | `at` (ISO or ms, before now) (since 1.7.0) | `{ at, historySince, restore, revert, trash, move, sample [{ op, name, path }] (≤ 20), limited, lost, ops, max }` — the preview, changes nothing (see "Time travel") |
| `POST nodes/<id>/timetravel` | `{ at }` | `{ at, before, restored, reverted, trashed, moved, failed, lost }` |
| `POST nodes/<id>/office` | | since 1.9.0: `{ url, mode, expiresAt }` — see "Office in the browser" |
| `GET\|POST vaults`, `vaults/<id>/…` | | since 1.9.0 — see "Vault folders" |
| `GET photos` | `area?`, `before?` (ISO), `limit?` (≤ 200, default 100) (since 1.7.0) | `{ items [photo], next }` (see "Photos and albums") |
| `GET photos/months` | `area?` | `{ months [{ month: 'YYYY-MM', count }] }` |
| `GET photos/memories` | `date?` (YYYY-MM-DD) | `{ date, groups [{ yearsAgo, date, items [photo] }] }` |
| `GET albums` | | `{ albums [album] }` |
| `POST albums` | `{ name, areaId? }` | `{ album }` |
| `PATCH albums/<id>` | `{ name?, coverId?, frame? }` | `{ album }` |
| `DELETE albums/<id>` | | `{ ok, id }` — the photos stay |
| `GET albums/<id>` | `before?`, `limit?` | `{ album, items [photo], next }` |
| `POST albums/<id>/items` | `{ ids }` (≤ 500, pictures and videos one reads) | `{ album }`; else `400 invalid { field: 'ids', ids }` |
| `DELETE albums/<id>/items` | `{ ids }` or `?ids=1,2,3` (≤ 500) | `{ album }` |
| `GET storage` | `all=1` (administrators) (since 1.7.0) | see "Storage" |
| `POST storage/versions/prune` | `{ areaId, keep }` (0 … 500) | `{ removed, freedBytes, more }` — administrators and managers of the area |
| `GET frame` | (a kiosk device only) | `{ on, ready, seconds, order, items [{ url, takenAt }] }` (see "Photo frame") |

A node: `{ id, areaId, parentId, name, isDir, size, mime, sha256, mediaId, mtime, rev, createdAt, createdBy, updatedAt,
updatedBy, deleted, takenAt }` (`takenAt` since 1.7.0: ISO, `null` for a folder); a file node also `preview: { url, largeUrl } | null` (since 1.1.0, see "Previews") — in every
answer: `nodes/<id>`, `children`, `by-path`, `search`, `changes`, `versions` (`current`), `uploads/check`,
`uploads/commit`, `trash` (always `null` there). A marked node (since 1.5.0, only while marked) also `deleteAt` (ISO),
`deletedOnDevice` (the device's name or `null`), `deleteMarkedBy` (user id). An empty file: `size: 0`, `mediaId: null`,
`sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'`, `preview: null`.

**Uploading:** GateControl's media upload (`PUT …/plugins/gatecontrol-drive/media`, resumable, ≤ 100 GB, any type)
answers a `mediaId`; for a HEIC photo or a video the app then sends its preview (`PUT …/media/<mediaId>/preview`, see
"Previews"); `POST uploads/commit` makes it a file. A name that exists: with `baseRev` = its `rev` or
`onConflict: 'version'` a new version, with `onConflict: 'rename'` a free name ("Brief (2).pdf"), otherwise `409
conflict { current }` — the device keeps its copy. Names: what a NAS holds (no `/ \ : * ? " < > |`, no trailing dot
or space, ≤ 255 characters, not `.gcdrive`); unique per folder ignoring case.

**Previews** (since 1.1.0, GateControl's media previews — docs/plugins.md "Previews" of GateControl ≥ 1.208.0):

- `preview.url` — the small picture (JPEG, fits 320 × 320 px), `preview.largeUrl` — the large one (fits 1280 × 1280
  px; `url` + `?size=large`). Upright, without metadata, never enlarged. `null`: no preview and none possible
  (documents, a HEIC or video without the device's preview, a file in the trash, a picture the server could not read).
- **App** (`/api/v1/client/plugins/…` callers): `url` is
  `/api/v1/client/plugins/gatecontrol-drive/media/<mediaId>/preview` (relative to the server). Load it with the device
  token (`X-API-Token`, like the file itself); the reader rules are those of the file (hook `mediaAccess`).
  `Cache-Control: private, max-age=31536000, immutable` — cache it by `mediaId` for good (a new version of a file is a
  new `mediaId`). Own rate limit of 1200 per minute and token. Answers: `200 image/jpeg`; `404` none; `503
  preview_pending` with `Retry-After` while GateControl is still making it (ask again later — the list does not need to
  be reloaded); `503 preview_unavailable` (storage target unreachable).
- **Portal** (`/api/v1/portal/…` callers): `url` is a signed `/plugin-media/<token>/preview` for the frame, valid for
  an hour like the file's `content` URL.
- **Made by GateControl** for pictures stored as JPEG, PNG, WebP, GIF (first frame) and AVIF up to 64 MB / 50
  megapixels — in the background right after `uploads/commit`, else on the first request.
- **From the device** for what GateControl cannot read — HEIC / HEIF photos and videos (photo backup): the uploader
  sends a preview of the file it uploaded, best right after the upload and **before** `uploads/commit` (then the
  commit's answer already has `preview`); afterwards works too (the next list has it):

  ```
  PUT /api/v1/client/plugins/gatecontrol-drive/media/<mediaId>/preview     X-API-Token: <the uploader's device token>
    Content-Type: image/jpeg | image/webp | image/png    Content-Length: ≤ 524288 (512 KB; e.g. 640 px long side)
    → 200 { ok: true, ready: true, source: 'client' }
    404 not_found (not this token owner's upload) · 409 preview_by_server (JPEG, PNG, WebP, GIF, AVIF — GateControl makes
    those itself, send nothing) · 411 · 413 too_large · 415 unsupported_type · 400 invalid_image (not decodable,
    over 4096 × 4096 px)
  ```

  GateControl decodes it and makes both sizes from it; sending again replaces it. Only the uploader may (also after
  the commit). On a GateControl before 1.208.0 there are no previews: every `preview` is `null`.

**Sync:** after every change the readers of the area get the live event `changed { areas, seq }` (`gc.events`) and
fetch `GET changes?since=`. `op`: `create`, `update`, `move`, `delete`, `restore`, `purge`, since 1.5.0 `mark` and
`unmark` (the node's `deleteAt` was set or ended; the node is live — an app that knows neither may treat it as an
update of the node's fields); a node that moved to
another area shows as `delete` in the old area (`node: null`) and `create` in the new one; `device` is the device
that made the change (`nas` for changes made on the NAS).

**Delete on all devices** (since 1.2.0): "Nur auf diesem Gerät" is the app's own business (it removes its local copy
and calls nothing). "Auch auf dem Server" is the plain `DELETE nodes/<id>` (into the trash). "Auf allen Geräten" is
`DELETE nodes/<id>?everywhere=1`: the trash as before **plus** a wipe for the person who deleted — every device of that
person removes its local copy (the original the photo backup left in the gallery, a downloaded or synced copy) when it
is next online:

```
DELETE /api/v1/client/plugins/gatecontrol-drive/api/nodes/<id>?everywhere=1        X-API-Token: <device token>
  → 200 { ok: true, id, trashed, wipe: { id, devices, files } }
       wipe.id: the wipe (null when there is nothing to do: no device of mine is known, or no file)
       wipe.devices: my devices that will be asked (the asking one included), wipe.files: its entries
  errors as for DELETE nodes/<id>: 404 not_found · 403 forbidden (no write right, archived) · 400 invalid (the root)
  `everywhere`: 1 | true | yes; anything else is a plain delete.

GET /api/v1/client/plugins/gatecontrol-drive/api/wipes
  → 200 { ok: true, wipes: [{ id, wipeId, nodeId, name, sha256, size, mime, createdAt }], more }
       oldest first, ≤ 500 (more: true — confirm these, then ask again); [] for a request without a device (portal)

POST /api/v1/client/plugins/gatecontrol-drive/api/wipes/done      { "ids": [17, 18] }
  → 200 { ok: true, done, wipes }
       done: entries confirmed now (unknown ids, those of other people and ones confirmed before count 0)
       wipes: what this device has left
  400 invalid { field: 'ids' }: not an array, more than 1000, an id not a positive integer
```

- **Entries:** one per file — a folder: every file below it that was not in the trash already, at most 5000 (by id).
  `nodeId`, `name`, `sha256` (64 hex characters or `null`), `size` (bytes), `mime` are the file as it was deleted;
  `wipeId` is the `wipe.id` of the delete, `createdAt` when it was made. A device finds its copy by `nodeId` (a synced
  or downloaded file) or by `sha256` and `size` (the photo in the gallery), removes it — or has none — and confirms the
  entry with `wipes/done`, also when it had no copy. An entry goes once every target device confirmed it.
- **Which devices:** the device is GateControl's `user.device.id` of the request — the id of the app's device token
  (the same as `me.deviceId` and `device` in `changes`). Drive remembers every device of a person that makes an app
  request (last seen, written at most every 10 minutes). The targets of a wipe are the person's devices Drive saw in the
  last 180 days when it is made, the deleting device included (it confirms like the others, right away if it removed
  its copy already); a device first seen later is no target. The portal (`/api/v1/portal/…`) has no device: it can
  delete everywhere (the targets are then all my devices), `GET wipes` answers `[]` there. Without `permissions.devices`
  (an administrator did not approve the update) there is no device: `me.deviceId` is `null`, no device is remembered.
- **Without a licence or a seat** `GET wipes` and `POST wipes/done` still work (they only remove the person's own
  copies); `GET me` always has `wipes`.
- **Live:** after the delete the person's apps get the live event `wipes { wipe, files }` (`gc.events`, the push
  stream's `event: plugin`). An app that was offline checks `GET me` → `wipes > 0` (on start, on reconnect, with the
  change sync) and then fetches `GET wipes`.
- **Restoring** the node from the trash (`POST trash/<id>/restore`) cancels its wipes: entries not confirmed yet go,
  devices that already deleted their copy stay without it (a synced copy comes back through `changes`). Purging
  (`DELETE trash/<id>`, the trash's days) changes nothing.
- **The end:** a wipe goes after 90 days whatever happened; a device GateControl no longer lists (its token was
  removed) and Drive has not seen for 7 days is not waited for any more (background run).

**Devices** (since 1.5.0): a PC or phone that backs up or syncs folders registers itself and tells Drive its folders;
the portal lists them on the page "Geräte".

```
PUT /api/v1/client/plugins/gatecontrol-drive/api/devices/<id>      { "name": "PC", "platform": "windows", "version": "1.40.0" }
  → 200 { ok: true, device }
  device: { id, name, platform, version, firstSeen, lastSeen, current,
            folder: { id, name, areaId, path, where } | null,                 — Meine Dateien › Geräte › <name>
            folders: [{ localPath, mode, nodeId, lastBackup, node: { id, name, areaId, path, where } | null }] }
  400 invalid { field: 'id' | 'name' | 'platform' | 'version' } · 409 device_limit { max: 50 } · 409 exists (a file
  "Geräte" is in the way) · 403 no_seat / not_licensed
PUT …/devices/<id>/folders     [{ "localPath": "C:\\Users\\Anna\\Pictures", "mode": "backup", "nodeId": 812, "lastBackup": "2026-10-27T08:00:00Z" }]
  → 200 { ok: true, device }    404 not_found (PUT devices/<id> first) · 400 invalid { field: 'folders[0].mode' … }
GET …/devices                 → 200 { ok: true, devices: [device, …] }       last seen first
DELETE …/devices/<id>         → 200 { ok: true, id, removed }                  idempotent; no file or folder goes
```

- **id:** the device's own stable id (`A–Z a–z 0–9 _ . : -`, ≤ 64), per person — the same id of another person is
  another device. It is not the device token's id (`me.deviceId`); the token that made the last PUT counts as the
  device's (`current`, last seen, `deletedOnDevice`).
- **name:** unique per person ignoring case — a second "PC" becomes "PC (2)", so two PCs with the same host name never
  share a folder; the device keeps what it got as long as it asks for the same name. What a folder cannot hold
  (`< > : " / \ | ? *`) becomes `_`, ≤ 60 characters.
- **folder:** made on the first PUT below Meine Dateien › Geräte; an existing folder of that name no other device of
  the person uses is taken over (made by an app before 1.5.0); a free name ("PC (2)") when it is taken. The app backs
  up below `folder.id` (its path is in `path`, readable in `where`). The device renamed: its folder follows while it
  still has the old name. The folder in the trash: the next PUT makes it again (a new id).
- **folders:** what the device keeps where — `localPath` (≤ 1024 characters), `mode` `backup` (Nur sichern) or `sync`
  (Abgleichen), `nodeId` (the Drive folder or `null`), `lastBackup` (ISO or ms or `null`); the list replaces the last
  one. `node` resolves `nodeId` for the viewer (`null` when it is gone or not readable).
- **Last seen:** every PUT, and every request of the token that made the last PUT (at most every 10 minutes).
- **Rights:** a person sees and changes only their own devices; Drive's seat is needed (the folder is in Meine Dateien).

**Delete later** (since 1.5.0): a file deleted on a device that backs it up stays in Drive for a while, then goes into
the trash.

```
DELETE …/nodes/<id>?after=2592000[&device=<registered device id>]
  → 200 { ok: true, id, marked: true, deleteAt, node }
  marked already: the earlier time stays (sending it again changes nothing); after=0: the plain delete (into the trash now)
  400 invalid { field: 'after' } (not 0 … 31536000) · 403 forbidden (no write right, archived) · 404 · 400 invalid (the root)
PATCH …/nodes/<id>    { "deleteAt": "2026-11-26T09:00:00Z" | <ms> | null, "device"?: "<registered device id>" }
  → 200 { ok: true, node }      exactly that time (≤ 365 days ahead; in the past: the next background run) / null ends it
  400 invalid { field: 'deleteAt' } (no time, too far, or together with name / parentId)
```

- Until then the node is an ordinary node — listed, read, synced, shared — with `deleteAt`, `deletedOnDevice` (the
  name of the registered device: `device` of the call, else the device of the asking token, else `null`) and
  `deleteMarkedBy`. The change log has `mark` (set or changed) and `unmark` (ended), with the node as it is now.
- **New content ends a mark:** a new version (`uploads/commit`, a NAS change), a restored version, a rename or a move,
  anything new in a marked folder (a file, a folder — the marks of the folders above end too, `unmark` each), a
  device folder taken over again. Into the trash and back: no mark.
- **The background run** (every 5 minutes) puts what is due into the trash — the node and everything below it, as
  the person who marked it, from their device (`deletedBy`, `device` in the change log); links to it end. A node in an
  archived team folder only loses its mark. From the trash it is purged after *trash_days* like any other.
- Rights: as for `DELETE` — writing in the area, never the root, never in an archived team folder.

**Empty files** (since 1.5.0): GateControl's media upload takes no empty body (`411`), so an empty file has no media
object: `POST uploads/commit { parentId, name, size: 0 }` (or `empty: true`; `mime?` the type to show; `sha256?` must
be that of no bytes) without a `mediaId` makes it — with `baseRev` / `onConflict` as for any file. Its node has `size:
0`, `mediaId: null`, `sha256: e3b0c442…b855`; `GET nodes/<id>/content` answers `empty: true` and `url:
'data:<mime>;base64,'` — an app writes an empty file and downloads nothing. Versions work both ways (an empty version
has `size: 0` and an empty `content`); a share link of a single empty file is `400 invalid` (no media to share). A file
the NAS puts at its path becomes its new content. Apps before 1.5.0 cannot upload empty files; one that meets an
empty file finds `mediaId: null` (nothing to download).

**Links** (GateControl's public links v2, `permissions.publicLinks`; an administrator allows them under Einstellungen ›
Plugins › Drive › Berechtigungen, else `403 links_disabled`): a file (`kind: 'files'`, the file as it is now), a folder
(`'folder'`, its current content) or an upload folder (`'upload'`). Whoever may write in the area may share. `expires:
'never'` only while the administrator allows links without an end (`403 no_unlimited`); no public https address → `409
no_public_url`. A link: `{ token, url, nodeId, areaId, kind, mode, title, name, path, state, active, endedWhy,
expiresAt, pin, opens, downloads, upload?, createdAt, createdBy }`. Drive ends the folder and upload links of a folder
that is renamed or moved (and of the folders below it — `endedWhy: 'moved'`) and every link of what goes into the trash
(`'trashed'`): a folder link points at a path, and a new folder with the old name must never be shared by it. A file
that comes in through an upload link becomes a node at once (hook `publicLinkEvent`, device `link`, made by the link's
owner, who gets the notification `link_upload`); the background run reads `gc.publicLinks.uploads` in case the hook was
missed.

**Files of other apps:** `GET …/media/<mediaId>` (hook `mediaAccess`) — the readers of the area, a fresh upload its
uploader.

**Direct links** (since 1.6.0, `server/address.js`): `GET me` answers `links`

```
links: { node:  "https://gc.example.com/portal?drive={id}#plg-gatecontrol-drive",
         drive: "https://gc.example.com/portal#plg-gatecontrol-drive" }   — or null
```

An app replaces only `{id}` by a node id (a folder opens; a file opens its folder, is marked and shown). The address:
the setting *portal_url* (an administrator's own address of GateControl, its origin), else the public address
GateControl builds its public links on (GC_BASE_URL when it is https and public — Drive learns it from a public link's
URL, there is no host call for it: when a link is made, else by asking `gc.publicLinks.list` at most once an hour);
neither → `null`. `#plg-gatecontrol-drive` opens the Drive tab of the portal; the node travels as the portal's query
parameter `drive`. **GateControl 1.208.0 hands that parameter on to no plugin frame** (the frame's `src` is fixed, it
has an opaque origin and no referrer): there the link opens the Drive tab and the portal tab reads `drive=` from its own
frame address (`location.search` / `location.hash`) as soon as GateControl passes it on. Notifications of Drive
(`link_upload` — the file that came in, `child_view` — the child's folder, `guard`) carry `data.link` (absolute, when
the address is known) and the button `open_portal` "Öffnen" to `/portal?drive=<id>#plg-gatecontrol-drive`.

**Ransomware protection** (since 1.6.0, `server/guard.js`, settings *guard_on* (default on), *guard_files* (50),
*guard_percent* (20), *guard_minutes* (10)):

- Watched: every change of an app request, per device (`user.device` of the token — the registered device's name from
  `devices`): `create` (a new file), `overwrite` (a new version), `rename` (also a move), `delete` (into the trash
  now), `mark` (into the trash later — `?after=` / `{ deleteAt }`, what a backup app sends; counts like a delete). The
  portal, services of other plugins, the NAS and the background run are not watched.
- Signs: `ext` — a known ransomware ending ("Brief.pdf.locked", `.wncry`, `.lockbit` …), an unknown ending after a known
  one ("Brief.pdf.id-1234.eking", not a number like "app.log.1") or a random-looking one; `entropy` — the device's hint
  ≥ 7.5 for a type that is never that dense (text, CSV, HTML, BMP, WAV, old Office …) or for a file whose last hint
  was below 7; `swap` — a file deleted shortly after the same device made "Name.ext.xyz" or "Name.other" (with a sign)
  in its folder. GateControl stores media sealed, the plugin reads no bytes: magic bytes are the device's to check —
  its `entropy` is the hint the server takes.
- Suspicious, checked after each such request: within *guard_minutes* the device changed existing files (`overwrite`,
  `rename`, `delete`, `mark` — new files never count, so uploading many photos is no attack) — at least *guard_files* of them,
  or *guard_percent* % of an area with ≥ 20 files (and at least 5 of them) — and at least half of them, or
  *guard_files* of them, show a sign.
- Then an incident: the device is locked. Its writing requests answer **`423 { ok: false, code: 'device_locked',
  error: 'device_locked', message, incident: <id> }`** — reading, `uploads/check`, `wipes/done`, `devices/…` and
  `guard/…` stay allowed. The person and the administrators get the notification `guard` ("Drive hat ungewöhnliche
  Änderungen von <Gerät> gestoppt", with the direct link); the live event `guard { incident }` goes to them (also
  after a release or an undo — then with `state`).
- `GET me`: `guard { on, locked, incident }` for the asking device, `incidents` — the person's open incidents (≤ 20).
  An incident: `{ id, at, device, deviceName, files, sample: [name …] (≤ 5), user, userName, state: 'open' |
  'released' | 'undone', locked, reasons: ['ext' | 'entropy' | 'swap'], since, endedAt, endedBy }`, undone also
  `undoneAt, undoneBy, restored, trashed, failed`.
- `release`: a false alarm — the device writes again. `undo`: what the incident made goes into the trash, deleted files
  come out of it, marks end, overwritten ones get the version before back, renamed or moved ones their name and folder (a free
  name when it is taken) — then released. Both by the person or an administrator (others `404`), both idempotent (an
  undo again answers the same counts). The undo runs as the person (their rights, their name in the change log). A
  version an incident still needs is not removed by *versions_max* or *versions_days*.

**Time travel** (since 1.7.0, `server/timetravel.js`): a folder — with everything below it — back to how it was at
`at`. The preview (`GET`) and the run (`POST`) compute the same plan; the run's counts are the preview's (less what
failed).

- `restore`: in the trash now, there then — out of the trash (its batch; what of it was not there then goes back in).
  `revert`: a file whose bytes changed — the version that was its content then is current again, the current bytes
  become a version. `move`: a name or folder that changed — the name and folder of then; a node that came into the
  folder from elsewhere goes back there (still there and writable), else into the trash. `trash`: new since then (or
  in the trash then) — into the trash. Counts are nodes (files and folders). Nothing is deleted for good.
- `before` (the run): the moment just before it — a time travel to `before` is its undo.
- `historySince`: since when Drive keeps the history of names and folders (`node_log`, the first start of 1.7.0) —
  older renames and moves cannot be turned back (`limited: true` for an earlier `at`). `lost`: files whose content of
  then is gone (older than *versions_days* or beyond *versions_max*); they stay as they are. What was purged from the
  trash is gone.
- A version a time travel makes is held for its undo at least *trash_days* (and *versions_days*): *versions_max* and
  *versions_days* leave it until then, and so does `storage/versions/prune`.
- Rights: write on the folder (`403 forbidden`, `404`); runs with the person's rights (moves out of the folder need
  write on the target); the ransomware protection does not watch it (no journal rows, no lock). At most `max` (2000)
  operations a run (else `400 invalid { field: 'at', ops, max }`). `at` must be a time before now (`400 invalid
  { field: 'at' }`).

**Photos and albums** (since 1.7.0, `server/photos.js`, `server/albums.js`):

- A photo item: `{ id, name, mime, size, takenAt, areaId, parentId, preview, mediaId, previewUrl, largeUrl }` —
  `preview` is `true` when there is a preview; `previewUrl` / `largeUrl` the same URLs as a node's `preview` (app:
  the endpoint with the device token; portal: signed). Pictures and videos by their type, newest first by `takenAt`,
  the areas the person reads (`area` narrows it, `404` for an area they do not read), never the trash. `next` is the
  `before` of the next page: a page ends after every photo of its last moment, so photos of the same second never fall
  between two pages. Months and memories use the server's time zone; memories: this calendar day ± 1 day of every
  earlier year, ≤ 30 a year, nearest year first. A parent seeing photos of a child's folder: the child is told as for
  the folder.
- An album: `{ id, name, areaId, count, coverId, frame, updatedAt, canEdit, canFrame, coverUrl, createdBy }` — of an
  area (default `mine:<me>`); whoever reads the area sees it, whoever writes in it (not archived) changes it (name ≤
  100 characters, cover — one of its items, items, delete). Items point at nodes: an item the viewer cannot read or
  that is in the trash is left out of `count` and `items`; a purged file leaves its albums.
- `frame` (the photo frame): switched on and off by whoever may change the album, but never by a child of a family,
  never in a child's folder, and in a family's area only by a parent of that family or an administrator (`403
  forbidden { field: 'frame' }`); `canFrame` says whether the viewer may.

**Photo frame** (since 1.7.0, `server/frame.js`, portal section `frame` in GateControl's tab "Zuhause"): a kiosk
device (GateControl's paired wall tablet — `user.kiosk`; Drive needs no `permissions.kiosk`, the Familie plugin's
wall account is one) sees the section while an album is on the frame, the setting *frame_on* is on and its account is
allowed (*frame_accounts*: names or ids, empty = every kiosk device). `GET frame` answers the pictures (not videos) of
every frame album, each once (≤ 1000), as large previews signed for the kiosk account with **preview-only URLs**
(`gc.media.previews { previewOnly }`, GateControl ≥ 1.210.0 — the file itself stays closed); an older GateControl:
`ready: false` and no picture at all. An album shows only what the person who switched it on reads now and while they
still may switch it (no seat, no right: it leaves the frame). Items carry `url` and `takenAt`, no names, no node ids.
*frame_seconds* (20), *frame_order* (`random` | `date`). The kiosk device reaches no other route of Drive and no file
(`mediaAccess` says no).

**Storage** (since 1.7.0, `server/storage.js`): `GET storage` →

```
{ total: { bytes, files, versionsBytes, trashBytes }, limit: { maxBytes } | null, all,
  areas: [{ id, label, kind, bytes, files, versionsBytes, trashBytes, quota, canPrune }],
  people: [{ user, name, bytes, files }],                 — administrators with all=1 (by the files' creator), else []
  largest: [{ id, name, size, areaId, parentId, path, updatedAt, canDelete }],          — the 20 largest
  duplicates: [{ sha256, size, count, wasted, items: [{ id, name, areaId, parentId, path, updatedAt, canDelete }] }] }
```

Without `all`: the areas the person reads (a seat is needed). `all=1` from an administrator (also without a seat):
every area. Duplicates: the same `sha256` and size, empty files not counted, the 20 groups wasting the most, ≤ 50 items
each (oldest first). Cleaning up is `DELETE nodes/<id>`. `POST storage/versions/prune { areaId, keep }`: every file of
the area keeps its newest `keep` versions; administrators (any area) and managers of the area (`403`); what the
ransomware protection or a time travel still needs stays; ≤ 2000 a call (`more`).

## Vault folders (Tresor-Ordner, since 1.9.0, feature `vault`)

A vault is a folder whose **contents and names are encrypted on the devices** (end-to-end). The server (`server/vault.js`)
keeps ciphertext, sizes, times, public keys and wrapped keys only — never a name, a content or a key it could read
(`test/vault.test.js` searches every table, the kv store, every media file, the pushes, events and logs for them).
Who may use a vault: whoever reads its area (see "Areas and rights"); write rights as in the area.

What a vault does **not** have: previews (`preview: null`), recognised text (`text` of a commit is dropped), search
(its nodes are never found), public links (`409 encrypted` for the vault, anything in it and every folder holding one;
a folder link of a folder a vault is made in ends — `endedWhy: 'vault'`),
albums and the photo frame, office in the browser (`409 encrypted`), the type of a file (always
`application/octet-stream`), `takenAt`, the entropy hint of the ransomware protection (a vault's files are random by
design; the protection still counts overwrites, renames and deletes). What works as everywhere: versions, the trash,
the time travel (also an encrypted name of then), the change log, the NAS (opaque names, ciphertext), quotas.

### API

```
POST   vaults                     { id, parentId, nameCipher, recoveryPub, recoveryAuth, recoveryWrap, device: { publicKey, name?, platform? }, wrap }
                                  → { vault, node } — id: 22 characters base64url the device chose (16 random bytes);
                                    not inside another vault; the creating device approved with the wrap of key version 1
GET    vaults                     → { vaults: [Vault] } — the vaults of the areas the person reads (not in the trash)
GET    vaults/<id>                → { vault }
GET    vaults/<id>/keys?deviceId= → { deviceId, state: 'approved'|'pending'|'revoked', keyVersion, keys: [{ keyVersion, wrap }] }
                                    — one of the person's own devices only (another's: 404); keys only when approved
GET    vaults/<id>/recovery       → { recoveryPub, keyVersion, keys: [{ keyVersion, wrap }] } — the recovery key's wraps
PUT    vaults/<id>/recovery       { pub, auth, wraps: [{ keyVersion, wrap }] (every version) } → { vault } — a new recovery key
                                    (write right and an approved device; the person becomes its holder)
GET    vaults/<id>/devices        → { devices: [Device] } — every device of the vault, with its public key (to approve)
POST   vaults/<id>/devices        { publicKey, name?, platform? } → { device } — a device of the person asks (pending; an
                                    approved one stays approved). The people with an approved device get the push
                                    topic `vault` and the live event `vault` { vault, event: 'request', device }
POST   vaults/<id>/devices/<deviceId>/approve  { wraps: [{ keyVersion, wrap }] } or { wrap } (the current version only),
                                    via?: 'recovery', recoveryAuth?
                                  → { device } — at least the current version (better: every version the approver has,
                                    so older files open too). Who: a person with an approved device of this vault, or —
                                    for their own device only — the person with the recovery key (via 'recovery' and its
                                    proof recoveryAuth; a wrong one: 403 { reason: 'recovery_auth' }). Live event 'approved'
DELETE vaults/<id>/devices/<deviceId>  → { device } — declined / removed (its wraps go; an approved one: needsRotation).
                                    The device's person, anyone with an approved device for a request, another
                                    person's approved device only with the write right
POST   vaults/<id>/rotate         { keyVersion: current + 1, wraps: [{ deviceId, wrap }] — exactly every approved device,
                                    recoveryWrap | recovery: { pub, auth, wraps: [{ keyVersion, wrap }] (every version) } }
                                  → { vault } — write right and an approved device. 409 { devices } when the list does not
                                    match, 409 { keyVersion } for another version, 409 { reason: 'recovery_required' }
                                    when the holder of the recovery key no longer reads the area (then `recovery`)

Vault  = { id, nodeId, areaId, parentId, nameCipher, keyVersion, recoveryPub, recoveryHolder, needsRotation, createdAt,
           createdBy, rotatedAt, myDevices: [{ deviceId, state, name }], pending (requests an approved device of mine
           can answer, else 0) }
Device = { deviceId, userId, name, platform, publicKey, state, via: 'create'|'device'|'recovery'|null, createdAt,
           approvedAt, approvedBy, revokedAt }
```

Nodes of a vault (its folder and everything below) carry `encrypted: true`, `vaultId`, `nameCipher`, `keyVersion` (of
the content; `null` after a version was restored — the content's header says it); their `name` is opaque (32 hex
characters, also the file name on a NAS). In a vault:

* `POST nodes { parentId, encrypted: true, nameCipher, keyVersion }` — a folder;
* `POST uploads/commit { mediaId, parentId, encrypted: true, nameCipher, keyVersion, mtime? }` — a file (the upload is
  the ciphertext, any type); a new version of a file: `{ …, name: <its opaque name>, baseRev | onConflict: 'version' }`
  (`nameCipher` optional then). An encrypted file is never empty (its header), so `size: 0` without `mediaId` is
  refused;
* `PATCH nodes/<id> { nameCipher }` renames, `{ parentId }` moves within the same vault (the vault's folder: within
  its area);
* `keyVersion` (and the version in `nameCipher`) must be the vault's current one: `409 { code: 'conflict', reason:
  'stale_key', keyVersion }` — fetch the keys again (after a rotation);
* refused with `400 { field }`: a plain node in a vault, `encrypted` outside one, a `name` that is not opaque, moving
  anything into or out of a vault, a vault inside a vault, a vault (or a folder holding one) into another area.

A device of someone who no longer reads the area (a person left the family or the team, a parent may no longer look
in) is revoked on the next request about the vault — its wraps are deleted, `needsRotation` turns on. The rotation
gives new files the new key; older files stay readable for those who had the old one (every device keeps every
version it got). A file whose folder is gone comes back from the trash into the vault's folder (`409 { reason:
'vault_trashed' }` while that is in the trash too); purging the vault's folder deletes its keys.

### Kryptografie (the format every client builds)

Reference: `ui/vaultcrypto.js` (WebCrypto only); fixed vectors `test/vault-vectors.json` (inputs and outputs, never
changed — a new format gets a new version byte); `test/vault.test.js` reads them with a second implementation using
only Node's `crypto` — the way Android (Keystore + Tink or JCA) and Windows (Node `crypto` + safeStorage) build it.
All strings UTF-8, integers big-endian, binary fields **base64url without padding**. HKDF is HKDF-SHA256 (RFC 5869);
"salt empty" = 32 zero bytes. AES-GCM always with a 16-byte tag.

| Item | Definition |
|---|---|
| Device key | X25519 key pair per device. Portal: WebCrypto, private key **not extractable**, kept by GateControl's page (`GC.keys`, name `drive-device-<userId>`); Android: Keystore (e.g. the X25519 private key wrapped with a Keystore AES-GCM key, or Tink's Android keyset manager); Windows: DPAPI / `safeStorage`. `publicKey` = the raw 32 bytes |
| Device id | `base64url(SHA-256("gcdrive-v1:device:" ‖ publicKey)[0..16])` (22 characters) — the server computes the same |
| Safety number | `SHA-256("gcdrive-v1:fingerprint:" ‖ publicKey)`: the first 16 bytes as 4 uint32, each `mod 100000`, zero-padded to 5 digits, joined by spaces — `44626 75008 87340 28578`. Both devices show it; approve only when equal |
| Vault id | 16 random bytes, base64url (22 characters), chosen by the creating device |
| Vault key TK | 32 random bytes per vault and **key version** (1, 2, …; a rotation adds one) |
| `wrap` | `0x01 ‖ enc (32) ‖ ct (48)` = 81 bytes. HPKE (RFC 9180) mode base, suite DHKEM(X25519, HKDF-SHA256) `0x0020`, HKDF-SHA256 `0x0001`, AES-256-GCM `0x0002`; single-shot `Seal(pkR, info, aad = "", pt = TK)`, `info = "gcdrive-v1:tk:<vaultId>:<keyVersion>"`. Tink: `HybridEncrypt` with these HPKE parameters, output prefix RAW, contextInfo = info; strip / add the 0x01 |
| `nameCipher` | `0x01 ‖ keyVersion (uint32) ‖ nonce (12, random) ‖ AES-256-GCM(nameKey, nonce, aad = the first 5 bytes, plaintext = pad(name))`; `nameKey = HKDF(TK, salt empty, info "gcdrive-v1:name:<vaultId>", 32)`; `pad`: the name in Unicode NFC as UTF-8, then `0x80`, then `0x00` up to a multiple of 32 bytes (unpad: drop trailing zeros, expect 0x80). 65 … 1057 bytes |
| Content | Header (29 bytes) `"GCDV" ‖ 0x01 ‖ keyVersion (uint32) ‖ chunkSize (uint32, 1048576; readers accept 1 KiB … 16 MiB) ‖ salt (16, random)`, then the chunks: the plaintext in pieces of `chunkSize` (the last shorter; an empty file is one empty chunk; a size that is a multiple has no extra empty chunk), chunk *i* = `AES-256-GCM(fileKey, nonce = 0^8 ‖ uint32(i), aad = header ‖ uint32(i) ‖ (last ? 0x01 : 0x00), piece)`; `fileKey = HKDF(TK, salt = the header's salt, info "gcdrive-v1:content:<vaultId>", 32)`. Size = 29 + plaintext + 16 × max(1, ⌈plaintext / chunkSize⌉). Reading: any range of whole chunks |
| Recovery key | 32 random bytes, shown once as Crockford base32 of `key ‖ BLAKE2b-256(key)[0..3]` — 56 characters in 14 groups of 4 joined by `-` (the format of the Vault plugin: accept lower case, spaces, dashes, `O` = `0`, `I`/`L` = `1`; a wrong check refuses it). Its X25519 private key = `HKDF(key, salt empty, info "gcdrive-v1:recovery", 32)` (clamped by X25519); `recoveryPub` its public key. The vault key of every version is wrapped for it like for a device (`recoveryWrap`, device id `recovery` on the server). Its proof `recoveryAuth` = base64url(`HKDF(key, salt empty, info "gcdrive-v1:recovery-auth", 32)`) — the server keeps only its SHA-256 and lets a device approve itself with the recovery key only with it |

Flows: **make** — TK, the vault id, the recovery key (shown, kept — only then `POST vaults`), the name encrypted with
version 1, wraps for the device and the recovery key. **New device** — `POST …/devices`, show the safety number; an
approved device lists `GET …/devices`, compares the number, unwraps its keys, wraps each version for the new public key
and approves. **Recovery** — derive the recovery key pair, check it against `recoveryPub`, unwrap `GET …/recovery`,
register and approve the own device with `via: 'recovery'` and `recoveryAuth`. **Rotation** (`needsRotation`) — a new TK with version + 1,
wrapped for exactly the approved devices and the recovery key (a new recovery key with every version when the server
says `recovery_required`), then new files and names use it.

Security assumptions: the server is trusted to serve the right public keys only as far as the safety number is
compared (otherwise a malicious server could add its own key to a request); a person who once had a vault key can
keep reading what was encrypted with it (rotation protects only new files); names and contents are hidden, not sizes,
times, the folder structure, who changed what, or how many files there are. The portal's device key never leaves
GateControl's page (not extractable), but a vault opened in the browser keeps its keys in the tab's memory until it
is closed.

## Office in the browser (since 1.9.0, feature `office`)

Drive is a **WOPI host** for Collabora Online and OnlyOffice (`server/office.js`). Needs GateControl ≥ 1.211.0
(`permissions.publicEndpoints`: the office server reaches `/plugin-public/gatecontrol-drive/…` without a session) and:

* the setting **office_url** — the office server's address as the browser reaches it;
* the home target **office** (Plugins › Drive › Zugriffsziele) — the same server as GateControl reaches it; Drive reads
  `/hosting/discovery` through it (12 hours, again when the setting changes; the settings show the state);
* the office server must reach GateControl's public address (`GC_BASE_URL`), the WOPI host's base.

`me.features` has `office` only while all that works. Documents: docx, xlsx, pptx, odt, ods, odp, csv (also doc, xls,
ppt, rtf when the server offers them); never a vault's file.

```
POST nodes/<id>/office  → { url, mode: 'edit' | 'view', expiresAt } — `url` (2 minutes) opens the editor in a new tab;
                          the portal uses GC.openTab, an app the system browser. 409 office_unavailable (no setup, an
                          older GateControl, a type it does not open), 409 encrypted (a vault's file)
```

That address answers GateControl's form page: `access_token` (4 hours, bound to the file, the person and the right
`w`/`r`) and `access_token_ttl` posted to the discovery's `urlsrc` (its placeholders filled, the origin of office_url)
with `WOPISrc=<GateControl>/plugin-public/gatecontrol-drive/wopi/files/<id>`. WOPI (each request checks the person's
right again — a token outlives no right):

| Request | |
|---|---|
| `GET wopi/files/<id>` | CheckFileInfo: `BaseFileName`, `Size`, `Version` (rev), `LastModifiedTime`, `OwnerId`, `UserId`, `UserFriendlyName`, `UserCanWrite`, `ReadOnly`, `SupportsLocks`, `SupportsGetLock`, `SupportsUpdate`, `UserCanNotWriteRelative: true`, … |
| `GET wopi/files/<id>/contents` | GetFile (GateControl streams the media) |
| `POST wopi/files/<id>/contents` (`X-WOPI-Override: PUT`) | PutFile → a new version of the file (its type kept), `X-WOPI-ItemVersion`; a foreign lock → 409 with `X-WOPI-Lock`; Collabora's `X-COOL-WOPI-Timestamp` older than the file → 409 `{ COOLStatusCode: 1010 }`; read only → 401 |
| `POST wopi/files/<id>` | `X-WOPI-Override`: `LOCK` (with `X-WOPI-OldLock`: UnlockAndRelock), `GET_LOCK`, `REFRESH_LOCK`, `UNLOCK` — 30 minutes; others 501 |

**Proof keys:** when the discovery has `<proof-key modulus exponent oldmodulus oldexponent>`, every WOPI request must
carry `X-WOPI-Proof` (or `X-WOPI-ProofOld`) and `X-WOPI-TimeStamp` (not older than 20 minutes): RSA-SHA256 over
`len ‖ access_token ‖ len ‖ URL in capitals ‖ len ‖ timestamp (int64)` (each `len` a 4-byte big-endian length), the
current or the old key — else `500`, as WOPI asks. The URL with the token comes from GateControl as `proofUrl` (only for
signed requests; `url` and `originalUrl` never carry the token).

## Portal

The portal tab "Drive" (`ui/portal.*`, rendered inline by `server/ui.js` into GateControl's sandboxed frame): the areas,
tiles or a list, breadcrumbs, search, upload (button, or files and folders dropped; `GC.upload`, then `uploads/commit` —
a name that exists asks; empty files too, since 1.5.0), "In den Papierkorb" with the option "Auch auf allen meinen Geräten löschen" while Drive knows
devices of the person (`me.devices`), the previews of the files on tiles and in the list (HEIC photos: the large preview in the
viewer), a preview for pictures, videos and sound, new folder, rename, move, versions, trash, sharing,
"Geteilte Links", "Geräte" (since 1.5.0: my devices with their folders, the last backup, "Ordner öffnen" and "Gerät
vergessen"), and on a marked node the quiet note "wird am … gelöscht" (with the device in its title) and "Behalten" in
its actions. Live through `GC.on('event')`. Pictures and videos are shown inline by GateControl and cannot be
downloaded from the frame (right-click › Save as); other files download. Since 1.6.0: a direct link (`drive=<id>` in
the frame's address) opens its folder or file, "Direktlink kopieren" in a node's actions (with `me.links`), "Ordner
hochladen" (`<input webkitdirectory>`) besides dropping folders — sub folders are made (empty ones too), with the
overall progress —, a red banner while a device of the person (an administrator: anyone's) is stopped by the
ransomware protection ("Rückgängig machen", "War ich – freigeben", "Alle Änderungen"), and for administrators the page
"Vorfälle". Since 1.7.0: "Fotos" (a timeline by month with previews, "Vor einem Jahr", choosing several to put them
into an album), "Alben" (make, rename, cover, take out, delete, "Im Fotorahmen zeigen"), "Speicher" (per area, an
administrator also everyone and every person; the largest files; duplicates with "Behalten" / "Löschen" — into the
trash after asking; "Alte Versionen aufräumen" for those who may), "Zeitreise" in a folder's tools (the preview, the
run, "Rückgängig machen"), and the date a photo was taken on upload (a JPEG's EXIF DateTimeOriginal, else the file's
date). The section "Fotorahmen" (`ui/frame.*`) is the slide show of a kiosk device. Since 1.9.0: **vault folders**
(`ui/vault.js`, `ui/vaultcrypto.js` — "Tresor-Ordner" in a folder's tools; the recovery key shown, copied or saved as a
text file and confirmed before the vault is made; names decrypted in the list; uploads encrypted in the browser — files
only, ≤ 100 MB; downloads decrypted in the browser; "Freigabe anfragen" with the safety number, "Mit
Wiederherstellungsschlüssel öffnen", the requests of other devices with "Freigeben" / "Ablehnen", "Schlüssel erneuern";
a browser without X25519 or a GateControl without `GC.keys` shows a note) and **"Im Browser bearbeiten"** for documents
while `features` has `office` (`GC.openTab`; a second click when the browser took the first one's moment).

## Admin (GateControl's admin UI)

Pages (`ui.pages`, `ui/admin.*`): **Übersicht** (licence and people, the areas with their storage, the backup hint),
**Personen** (switch people on as family / business), **Team-Ordner** (members picked with `GC.pickPrincipals`).
API `/api/v1/plugins/gatecontrol-drive/api/admin/…`: `GET overview` (`licence`, `limits`, `counts`, `exceeded`,
`backup { level: 'strong' | 'subtle' | 'off', areas }`, `people`, `areas`), `PUT seats/<userId> { kind }`,
`GET|POST teams`, `PUT|DELETE teams/<id>` (members with `label`; a team folder with files is archived, not removed),
`POST license/refresh`, `PUT backup-hint { on }`, since 1.7.0 `overview.storage` (`bytes`, `files`, `versionsBytes`,
`trashBytes`, `duplicates { groups, wastedBytes }` — shown in short on the overview), since 1.6.0 `GET guard/incidents`, `POST guard/incidents/<id>/release |
undo` (the ransomware protection; the overview shows stopped devices on top with "Rückgängig machen" / "Freigeben").

**Backup hint:** GateControl's backup holds Drive's database, never the files of its media areas. While an area lies
on this server, a folder or a NAS (one copy), the overview shows a box and the administrators get the notification
`backup_hint` once a week; every area in S3 → one line; setting `backup_hint` off → nothing.

## Services for other plugins

`services.provides` — the caller lists `"gatecontrol-drive:<service>"` in `permissions.services` and calls with the
person's `userId`; the person needs a seat and write access (a call can do no more than they can):

| Service | Payload | Answer |
|---|---|---|
| `list_areas` | `{ lang? }` | `{ ok, areas: [{ id, kind, label, role, writable }] }` |
| `save_file` | `{ mediaId, area?: 'mine' \| 'family' \| '<area id>', path: 'Schule/Brief.pdf', onConflict?: 'rename' \| 'version' }` or (1.4.0) `{ mediaId, folderId, name, onConflict? }` — a folder the person picked | `{ ok, nodeId, areaId, path, name, created, where }` — `where`: "Meine Dateien › Messenger › Foto.jpg" |

`mediaId`: a file the caller handed over first — `gc.media.handOver(id, { toPlugin: 'gatecontrol-drive', user: userId })`
(unclaimed, owned by that person). The folders on the way are made; a name that exists gets a free name ("Brief
(2).pdf") or, with `onConflict: 'version'`, becomes a new version. Codes: `invalid`, `forbidden`, `not_found`,
`no_seat`, `not_licensed`, `quota`, `upload_invalid` (not the person's fresh file), `exists` (a file where a folder of
the path should be). The change log names the calling plugin as the device.

## Background

Every 5 minutes: the trash after *trash_days*, versions after *versions_days* (and more than *versions_max* per file
at once), the NAS journals (in case the hook was missed), uploads through links the hook did not bring, rows of links
GateControl has forgotten, the weekly backup hint, old notes of `child_view`, wipes after 90 days and the waiting for
devices GateControl no longer lists, marked nodes whose time came (into the trash, since 1.5.0), the ransomware
protection's journal (rows of no incident older than the window) and closed incidents after 30 days, the public address
for direct links (since 1.6.0). A version a time travel made stays until its hold ends (since 1.7.0). Expired WOPI
locks go (since 1.9.0).

## Development

`node tools/test.js gatecontrol-drive` — the mock host as GateControl 1.208.0 with a family group, a team group and a
combo licence (`test/helpers.js`).
