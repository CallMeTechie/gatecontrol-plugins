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
devices").

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
(also under `portal/…`). Signed-in people only — never a kiosk device, never device trust alone (`403
login_required`). Every answer has `ok`; errors `{ ok: false, code, error }` (+ details).

| Route | Body / query | Answer |
|---|---|---|
| `GET me` | | `me { id, name, seat, deviceId }`, `licence { valid, tier }`, `areas`, `latest` (change log seq), `settings`, `limits { maxBytes }`, `wipes` (entries this device has yet to handle, since 1.2.0), `devices` (my devices a new wipe reaches) |
| `GET areas` | | `areas [{ id, kind, label, role, via, rootId, owner, archived, storage { bytes, quota, form, target, state } }]` |
| `GET nodes/<id>` | | `node` + `path`, `role`, `crumbs [{ id, name }]` |
| `GET nodes/<id>/children` | `sort=name\|mtime\|size\|updated`, `order`, `offset`, `limit` (≤ 1000) | `items` (folders first), `total`, `next`, `role` |
| `GET nodes/by-path` | `area`, `path` | `node` |
| `POST nodes` | `{ parentId, name, rename? }` | `node` (a folder; `409 exists`, or a free name with `rename`) |
| `PATCH nodes/<id>` | `{ name?, parentId? }` | `node` — rename / move, also into another area one writes to |
| `DELETE nodes/<id>` | `everywhere=1` (since 1.2.0) | `{ id, trashed }` — into the trash; with `everywhere=1` also `wipe { id, devices, files }` (see "Delete on all devices") |
| `GET nodes/<id>/content` | | `{ url, name, mime, size, mediaId }` — `url` signed for the viewer, 1 h |
| `GET nodes/<id>/versions` | | `{ current, versions [{ id, rev, size, sha256, at, by }] }` |
| `GET nodes/<id>/versions/<vid>/content` | | `{ url, … }` |
| `POST nodes/<id>/versions/<vid>/restore` | | `node` — the version is current again, the current bytes become a version |
| `DELETE nodes/<id>/versions/<vid>` | | `{ id }` |
| `POST uploads/check` | `{ parentId, name, sha256?, size? }` | `{ exists, same, node }` — `same`: no need to upload |
| `POST uploads/commit` | `{ mediaId, parentId, name, baseRev?, mtime?, onConflict?: 'rename' \| 'version', text? }` — `text`: recognised text of a scan (≤ 100 000 characters, searchable) | `{ node, created }` |
| `GET changes` | `since`, `limit` (≤ 1000) | `{ changes [{ seq, op, areaId, nodeId, at, by, device, node }], next, more }` |
| `GET trash` | `area?` | `items` (the deleted node with `from`, folders with `size`, `files`) |
| `POST trash/<id>/restore` | | `node` (a free name; the area's top when its folder is gone) |
| `DELETE trash/<id>` | | `{ id, files }` — gone for good (wipes stay) |
| `GET wipes` | | `{ wipes [{ id, wipeId, nodeId, name, sha256, size, mime, createdAt }], more }` — this device's, oldest first, ≤ 500 (since 1.2.0) |
| `POST wipes/done` | `{ ids: [<entry id>, …] }` (≤ 1000) | `{ done, wipes }` — this device handled them (since 1.2.0) |
| `GET search` | `q` (2–100 characters), `area?` | `items` with `path` and `match` (`name`, then `text` with a `snippet`) (≤ 100) |
| `POST links` | `{ nodeId, mode: 'view' \| 'download' \| 'upload', expires: '1d' \| '7d' \| '30d' \| 'never', pin?, maxFiles?, maxBytes? }` | `link` (with `url`) |
| `GET links` | `nodeId?` | `{ links, enabled }` — mine, or those of a node I write to |
| `GET links/<token>/events` | `before?` | `events` — the log (newest first, ≤ 100) |
| `DELETE links/<token>` | | `{ ended }` — whoever made it, or who manages the area |

A node: `{ id, areaId, parentId, name, isDir, size, mime, sha256, mediaId, mtime, rev, createdAt, createdBy, updatedAt,
updatedBy, deleted }`; a file node also `preview: { url, largeUrl } | null` (since 1.1.0, see "Previews") — in every
answer: `nodes/<id>`, `children`, `by-path`, `search`, `changes`, `versions` (`current`), `uploads/check`,
`uploads/commit`, `trash` (always `null` there).

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
fetch `GET changes?since=`. `op`: `create`, `update`, `move`, `delete`, `restore`, `purge`; a node that moved to
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

## Portal

The portal tab "Drive" (`ui/portal.*`, rendered inline by `server/ui.js` into GateControl's sandboxed frame): the areas,
tiles or a list, breadcrumbs, search, upload (button, or files and folders dropped; `GC.upload`, then `uploads/commit` —
a name that exists asks), "In den Papierkorb" with the option "Auch auf allen meinen Geräten löschen" while Drive knows
devices of the person (`me.devices`), the previews of the files on tiles and in the list (HEIC photos: the large preview in the
viewer), a preview for pictures, videos and sound, new folder, rename, move, versions, trash, sharing,
"Geteilte Links". Live through `GC.on('event')`. Pictures and videos are shown inline by GateControl and cannot be
downloaded from the frame (right-click › Save as); other files download.

## Admin (GateControl's admin UI)

Pages (`ui.pages`, `ui/admin.*`): **Übersicht** (licence and people, the areas with their storage, the backup hint),
**Personen** (switch people on as family / business), **Team-Ordner** (members picked with `GC.pickPrincipals`).
API `/api/v1/plugins/gatecontrol-drive/api/admin/…`: `GET overview` (`licence`, `limits`, `counts`, `exceeded`,
`backup { level: 'strong' | 'subtle' | 'off', areas }`, `people`, `areas`), `PUT seats/<userId> { kind }`,
`GET|POST teams`, `PUT|DELETE teams/<id>` (members with `label`; a team folder with files is archived, not removed),
`POST license/refresh`, `PUT backup-hint { on }`.

**Backup hint:** GateControl's backup holds Drive's database, never the files of its media areas. While an area lies
on this server, a folder or a NAS (one copy), the overview shows a box and the administrators get the notification
`backup_hint` once a week; every area in S3 → one line; setting `backup_hint` off → nothing.

## Services for other plugins

`services.provides` — the caller lists `"gatecontrol-drive:<service>"` in `permissions.services` and calls with the
person's `userId`; the person needs a seat and write access (a call can do no more than they can):

| Service | Payload | Answer |
|---|---|---|
| `list_areas` | `{ lang? }` | `{ ok, areas: [{ id, kind, label, role, writable }] }` |
| `save_file` | `{ mediaId, area?: 'mine' \| 'family' \| '<area id>', path: 'Schule/Brief.pdf', onConflict?: 'rename' \| 'version' }` | `{ ok, nodeId, areaId, path, name, created }` |

`mediaId`: a file the caller handed over first — `gc.media.handOver(id, { toPlugin: 'gatecontrol-drive', user: userId })`
(unclaimed, owned by that person). The folders on the way are made; a name that exists gets a free name ("Brief
(2).pdf") or, with `onConflict: 'version'`, becomes a new version. Codes: `invalid`, `forbidden`, `not_found`,
`no_seat`, `not_licensed`, `quota`, `upload_invalid` (not the person's fresh file), `exists` (a file where a folder of
the path should be). The change log names the calling plugin as the device.

## Background

Every 5 minutes: the trash after *trash_days*, versions after *versions_days* (and more than *versions_max* per file
at once), the NAS journals (in case the hook was missed), uploads through links the hook did not bring, rows of links
GateControl has forgotten, the weekly backup hint, old notes of `child_view`, wipes after 90 days and the waiting for
devices GateControl no longer lists.

## Development

`node tools/test.js gatecontrol-drive` — the mock host as GateControl 1.208.0 with a family group, a team group and a
combo licence (`test/helpers.js`).
