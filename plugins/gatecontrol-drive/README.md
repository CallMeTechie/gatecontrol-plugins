# gatecontrol-drive — Drive

The files of the family and the team on one's own storage — this server, a NAS or S3 — with areas and rights,
versions, a trash, links for people without an account and sync with every device. The portal tab "Drive" is here
(0.2.0); the apps and the admin pages follow.

*Deutsch:* Dateien der Familie und des Teams auf dem eigenen Speicher – Bereiche mit Rechten, Versionen, Papierkorb,
Abgleich mit allen Geräten. Details im CHANGELOG.

Needs GateControl ≥ 1.207.0: `media.areas` (an area per Drive area, paths, `gc.media.move` / `version`, a version back
to its path, the NAS journal and the hook `mediaChanged`), `gc.license.info` (tier and seats), `storage.maxMB` 4096,
`permissions.groups: 'read'` (family groups and their roles, groups of team folders), `permissions.events`.

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
| `GET me` | | `me { id, name, seat, deviceId }`, `licence { valid, tier }`, `areas`, `latest` (change log seq), `settings`, `limits { maxBytes }` |
| `GET areas` | | `areas [{ id, kind, label, role, via, rootId, owner, archived, storage { bytes, quota, form, target, state } }]` |
| `GET nodes/<id>` | | `node` + `path`, `role`, `crumbs [{ id, name }]` |
| `GET nodes/<id>/children` | `sort=name\|mtime\|size\|updated`, `order`, `offset`, `limit` (≤ 1000) | `items` (folders first), `total`, `next`, `role` |
| `GET nodes/by-path` | `area`, `path` | `node` |
| `POST nodes` | `{ parentId, name, rename? }` | `node` (a folder; `409 exists`, or a free name with `rename`) |
| `PATCH nodes/<id>` | `{ name?, parentId? }` | `node` — rename / move, also into another area one writes to |
| `DELETE nodes/<id>` | | `{ id, trashed }` — into the trash |
| `GET nodes/<id>/content` | | `{ url, name, mime, size, mediaId }` — `url` signed for the viewer, 1 h |
| `GET nodes/<id>/versions` | | `{ current, versions [{ id, rev, size, sha256, at, by }] }` |
| `GET nodes/<id>/versions/<vid>/content` | | `{ url, … }` |
| `POST nodes/<id>/versions/<vid>/restore` | | `node` — the version is current again, the current bytes become a version |
| `DELETE nodes/<id>/versions/<vid>` | | `{ id }` |
| `POST uploads/check` | `{ parentId, name, sha256?, size? }` | `{ exists, same, node }` — `same`: no need to upload |
| `POST uploads/commit` | `{ mediaId, parentId, name, baseRev?, mtime?, onConflict?: 'rename' \| 'version' }` | `{ node, created }` |
| `GET changes` | `since`, `limit` (≤ 1000) | `{ changes [{ seq, op, areaId, nodeId, at, by, device, node }], next, more }` |
| `GET trash` | `area?` | `items` (the deleted node with `from`, folders with `size`, `files`) |
| `POST trash/<id>/restore` | | `node` (a free name; the area's top when its folder is gone) |
| `DELETE trash/<id>` | | `{ id, files }` — gone for good |
| `GET search` | `q` (2–100 characters), `area?` | `items` with `path` (≤ 100) |
| `POST links` | `{ nodeId, mode: 'view' \| 'download' \| 'upload', expires: '1d' \| '7d' \| '30d' \| 'never', pin?, maxFiles?, maxBytes? }` | `link` (with `url`) |
| `GET links` | `nodeId?` | `{ links, enabled }` — mine, or those of a node I write to |
| `GET links/<token>/events` | `before?` | `events` — the log (newest first, ≤ 100) |
| `DELETE links/<token>` | | `{ ended }` — whoever made it, or who manages the area |

A node: `{ id, areaId, parentId, name, isDir, size, mime, sha256, mediaId, mtime, rev, createdAt, createdBy, updatedAt,
updatedBy, deleted }`.

**Uploading:** GateControl's media upload (`PUT …/plugins/gatecontrol-drive/media`, resumable, ≤ 100 GB, any type)
answers a `mediaId`; `POST uploads/commit` makes it a file. A name that exists: with `baseRev` = its `rev` or
`onConflict: 'version'` a new version, with `onConflict: 'rename'` a free name ("Brief (2).pdf"), otherwise `409
conflict { current }` — the device keeps its copy. Names: what a NAS holds (no `/ \ : * ? " < > |`, no trailing dot
or space, ≤ 255 characters, not `.gcdrive`); unique per folder ignoring case.

**Sync:** after every change the readers of the area get the live event `changed { areas, seq }` (`gc.events`) and
fetch `GET changes?since=`. `op`: `create`, `update`, `move`, `delete`, `restore`, `purge`; a node that moved to
another area shows as `delete` in the old area (`node: null`) and `create` in the new one; `device` is the device
that made the change (`nas` for changes made on the NAS).

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
a name that exists asks), a preview for pictures, videos and sound, new folder, rename, move, versions, trash, sharing,
"Geteilte Links". Live through `GC.on('event')`. Pictures and videos are shown inline by GateControl and cannot be
downloaded from the frame (right-click › Save as); other files download.

## Admin (GateControl's admin UI)

`/api/v1/plugins/gatecontrol-drive/api/admin/…`: `GET overview`, `PUT seats/<userId>`, `GET|POST teams`,
`PUT|DELETE teams/<id>` (a team folder with files is archived, not removed), `POST license/refresh` (after booking
more people).

## Background

Every 5 minutes: the trash after *trash_days*, versions after *versions_days* (and more than *versions_max* per file
at once), the NAS journals (in case the hook was missed), uploads through links the hook did not bring, rows of links
GateControl has forgotten, old notes of `child_view`.

## Development

`node tools/test.js gatecontrol-drive` — the mock host as GateControl 1.207.0 with a family group, a team group and a
combo licence (`test/helpers.js`).
