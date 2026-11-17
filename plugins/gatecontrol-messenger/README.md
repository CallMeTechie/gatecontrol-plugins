# gatecontrol-messenger — Messenger

Chats between the GateControl accounts: direct and group chats with text,
pictures, videos, voice messages, files and location, replies with quote, reactions,
editing and deleting, read receipts, "typing …", disappearing chats and chat
pushes with a reply field. The apps (Android, Windows) draw their own tab
"Chats" from the API below; the portal has a tab "Chats" (sandboxed frame);
administrators get two pages (Übersicht, Protokoll) without any message
content. Paid plugin (`license.required`), needs **GateControl ≥ 1.191.0**
(plugin media, realtime events, chat notifications, services; since 1.4.0
interactive home actions `permissions.actions { interactive: true }` and
service payloads up to 512 KB; since 1.6.0 the chat sink of the notification
center, `permissions.notifySink`). 1.4.0 adds status and stories, privacy
settings, last seen, blocks, archive, pins, chat lists, export, "remind me",
suggestions, polls, events, live arrival, home actions and plugin cards — see
"Since 1.4.0" in the App-API. 1.6.0 makes the chats the place for
GateControl's notifications — see "Notifications in chats (since 1.6.0)".
1.10.0 saves a chat's pictures, voice messages and files into the Drive plugin
— see "Save to Drive (since 1.10.0)".

* Version 1 is internal only (GateControl ↔ GateControl); bridges (WhatsApp,
  Signal, Matrix, ntfy, Gotify) and end-to-end encryption come later.
* Every enabled GateControl account may chat. Accounts seen on a kiosk device
  (wall tablet) are not offered as people and kiosk devices get no tab.
* The pinned chat "GateControl" in the apps is the GateControl inbox (core
  notifications) — not part of this plugin. Since 1.6.0 a person may route a
  kind of notification (a push topic) into the family chat or a chat of its
  own instead (GateControl ≥ 1.191.0 decides, this plugin delivers).

## Privacy and storage

* Texts, locations, file names and group titles are stored encrypted with
  AES-256-GCM (`v1.` + base64url(nonce 12 | tag 16 | ciphertext)). The key is
  created on the first start and kept as a secret setting of the plugin
  (`gc.settings.setSecret('enc_key')` — GateControl encrypts it with the server
  key, never sends it to a browser and re-keys it in backups). Honest limit:
  whoever has root on the server can decrypt; the encryption protects against
  the admin UI, copies of the database and backups.
* Files are stored by GateControl (`gc.media`, encrypted per file, quota
  10 GB by default, 25 MB per file — changed by the administrator under
  Settings → Plugins → Messenger → Overview → Media). Files are not in
  backups unless "Plugin-Medien im Backup" is on.
* The admin API and the log never contain a text, a title, a file name, a
  member list or who writes to whom.

## Admin pages

* **Übersicht**: accounts (active today), chats (direct / groups / from
  plugins), messages today, storage (GateControl's usage and quota, per type:
  pictures, files, voice), settings: max. voice message length, retention
  (unlimited, 30, 90, 180, 365, 730 days), allow disappearing chats, the window
  for editing / deleting for everyone (not allowed, 5, 15, 60 min, 1 day;
  default 15 min), defaults for new accounts (read receipts, "typing …",
  content in notifications). The media limits are shown read-only.
  Since 1.4.0 a card with counts only (active statuses / stories, open polls,
  upcoming events, live arrivals, home actions and plugin cards of the last 7
  days, blocks, pending reminders) and the switches "Storys erlauben" and
  "Haus-Aktionen in Chats" (both on by default). Since 1.5.0 also: how long a
  request stays open (`requestTtlMin`: 5, 10, 15, 30, 60, 120, 240 min, 1 day;
  default 15 min), who approves a request that names nobody
  (`requestApproversDefault`: `auto` = parents when the Familie plugin offers
  `family_roles`, else everyone with the right; `parents`; `rights`), "Kinder
  dürfen anfragen" (`childrenMayRequest`, default on) and the longest "Gerät
  teilen" (`grantMaxDays`: 1, 2, 3, 7, 14, 30 days; default 7).
* **Gruppenchats für GateControl-Gruppen** (since 1.9.0, GateControl ≥ 1.200.0,
  `permissions.groups: "read"`): the administrator picks groups with
  GateControl's picker (`GC.pickPrincipals`; an older GateControl without it:
  a select fed by `gc.groups.list`). For each chosen group the messenger keeps
  a managed group chat (`managedBy: "gatecontrol-messenger"`, `coreGroupId`)
  in step: its effective members (members of subgroups included, archived
  subgroups and disabled accounts not), the group's path as title (longer
  than 80 characters: its name), its direct leads, deputies and group admins
  as chat admins. Members cannot change members, title or picture, nor leave.
  In step right after the choice, on the hook `groupsChanged`, after a start
  and every 6 hours (only what differs is written). A group that is
  deselected, archived or deleted (hook `groupDeleting`, before it goes) hands
  its chat back like `release_group`: a normal group chat without sync whose
  admins are the former leads; an archived or deleted group leaves the
  selection. The family group (kind `family`) is never offered for this:
  Familie keeps the family chat itself (`sync_group`); choosing it is refused
  with a note. `groupUsage` reports "Gruppenchat <Titel>" — "bleibt als
  normaler Chat ohne Abgleich". Admin API: `GET admin/group-chats`,
  `PUT admin/group-chats { groupIds }` (≤ 50; `skipped` names family and
  archived groups).
* **Protokoll**: errors and limits only (push limit, live event limit, file
  clean-up, decryption, refused service calls, failed background steps, since
  1.4.0 failed home actions, since 1.9.0 group chats that could not be kept
  in step).
* **Brücken zu anderen Messengern** (since 1.12.0, card on „Übersicht“) — only on
  a GateControl that offers `gc.bridges` (a preview there, see "Bridges to other
  messengers" below); on every other server the card stays hidden. The switch
  for the bridges (off by default), where they run (the server), where their
  database and session keys are kept (always where they run), per bridge the
  state (Aus / Startet / Läuft / Fehler), version, the memory the container
  really uses and how many people linked an account; a note when the server's
  compose file does not know the service yet or its update script is too old.
  No number, no contact, no content.

## App-API

Base path (apps, device token): `/api/v1/client/plugins/gatecontrol-messenger/api/`
— the portal frame uses `/api/v1/portal/plugins/gatecontrol-messenger/api/`
with the same routes. JSON bodies ≤ 64 KB. Every answer carries `ok`. Times are
ISO-8601 UTC strings with milliseconds (`"2026-10-17T10:00:00.000Z"`).
Conversation ids and message ids are **integers** (in push payloads the
conversation id is the same number **as a string**, see "Push").

Who may call: the owner of an app token (`user.app`) or a signed-in portal
viewer (`user.loggedIn`). The admin UI → `403 forbidden`, portal with device
trust only → `403 login_required`, a kiosk device → `403 forbidden`.

### Errors

`{ ok: false, code, error }` (`error` a text in the caller's language):

| HTTP | code | when |
|---|---|---|
| 400 | `invalid` | a body or query value is missing or out of range |
| 403 | `login_required` / `forbidden` | see above |
| 403 | `not_admin` | adding/removing others, roles: group admins only |
| 403 | `not_sender` | edit / delete for everyone: the sender only |
| 403 | `managed` | title, picture, members of a group kept by another plugin |
| 403 | `readonly` | sending into a plugin's notice channel |
| 403 | `edit_window` | edit / delete for everyone after the window (or window 0) |
| 403 | `disappearing_off` | the administrator switched disappearing chats off |
| 404 | `not_found` | unknown route — and **every** conversation/message the caller is not an active member of |
| 409 | `peer_unavailable` | direct chat with an account that no longer exists |
| 409 | `deleted` | editing / reacting to a message deleted for everyone |
| 409 | `media_invalid` | `mediaId` unknown, not uploaded by the caller, wrong type, preview > 64 KB (a file's preview: not WebP/JPEG/PNG) |
| 409 | `media_in_use` | the upload is already used by another message |
| 409 | `too_many` | a group over 256 members |
| 422 | `infected` | since 1.11.0: the file is in GateControl's quarantine (malware) — not sent; `finding` names the find |
| 423 | `scan_blocked` / `quarantined` / `scan_pending` | since 1.11.0: GateControl's virus scan holds the file back (not checkable and blocked / malware / still being checked — "In Drive speichern") |
| 409 | `bridge_off` | since 1.12.0: the bridges are switched off or not offered by this GateControl (`reason`: `off`, `preview_off`, `no_host`) |
| 409 | `consent_required` | since 1.12.0: the notes before linking were not confirmed (`POST bridges/:network/consent`) |
| 403 | `bridge_locked` | since 1.12.0: a child whose parents did not allow this network |
| 409 | `bridge_unsupported` | since 1.12.0: the service asks for a step GateControl cannot show (a passkey) — offer the other way |
| 502 | `bridge_failed` | since 1.12.0: the bridge refused (`reason`, e.g. `m_bad_json` — a wrong number, `fi_mau_whatsapp_login_timeout` — the code ran out): start again |
| 503 | `bridge_unreachable` | since 1.12.0: the bridge does not answer (`reason`: `not_running`, `timeout`) |
| 500 | `internal` | |

The host's own answers (404 plugin not usable, 413 body > 64 KB, 429, 502–504)
are described in GateControl's docs/plugins.md "App".

### Objects

**Person** (`people`, `members[]`, `peer`):
`{ userId (in people: id), name, avatarUrl, initials, colorHex, color, gone }` —
`avatarUrl` a `/avatars/…` path of the server or null; `gone: true` = the
account no longer exists (name null → show "Gelöschtes Konto").

**Conversation**:

```json
{
  "id": 12, "kind": "direct" | "group",
  "title": "Familie",                    // group title; direct: the other person's name (null if gone)
  "peer": Person | null,                 // direct only
  "avatarUrl": "/avatars/…" | "/plugin-media/…" | null, // direct: peer's picture; group: signed URL (portal only)
  "avatarMediaId": "<32 hex>" | null,    // group picture — apps load GET /api/v1/client/plugins/gatecontrol-messenger/media/<id>
  "managedBy": "gatecontrol-familie" | "gatecontrol-messenger" | null,
  "coreGroupId": 7 | null,               // since 1.9.0: the chat of a GateControl group (managedBy "gatecontrol-messenger") —
                                         // suggested wording "Gruppe · aus einer GateControl-Gruppe abgeglichen"
  "readonly": false,                     // a plugin's notice channel: members cannot send
  "listPinned": false,                   // since 1.6.0: true for Familie's group — show it under "Angeheftet" after "GateControl"
  "notice": { "source": "plugin:gatecontrol-schule", "label": "Schule" } | null, // since 1.6.0: a notice channel of GateControl's notifications (mark it "Mitteilungen")
  "disappearingS": 0 | 86400 | 604800 | 2592000,
  "createdBy": 7 | null, "createdAt": "…", "updatedAt": "…",
  "lastMessageId": 4711 | null,          // highest message id ever assigned in this chat
  "members": [ Person + { "role": "admin" | "member", "joinedAt": "…" } ],
  "me": { "role", "mutedUntil": "…" | null, "notify": "all" | "none", "lastReadId", "lastDeliveredId" },
  "muted": false,                        // notify none or mutedUntil in the future
  "unread": 3,                           // others' messages (and plugin notices) after me.lastReadId, not deleted
  "lastMessage": Message | null,         // the newest message the caller sees
  "typing": [7],                         // user ids typing now (empty when the caller switched "typing" off)
  "readUpTo": 4710 | null,               // see "Read receipts"
  "deliveredUpTo": 4711 | null,
  "receipts": [ { "userId", "lastReadId", "lastDeliveredId" } ],
  "can": { "send", "editInfo", "manageMembers", "leave", "setDisappearing" }
}
```

**Message**:

```json
{
  "id": 4711, "conversationId": 12,
  "senderId": 7 | null,                  // null = system message ("GateControl")
  "clientId": "…" | null, "kind": "text" | "image" | "voice" | "file" | "location" | "system",
  "via": "gatecontrol-familie" | null,   // sent by another plugin (service send_message)
  "mine": true,
  "createdAt": "…", "editedAt": "…" | null, "deletedAt": "…" | null, "expiresAt": "…" | null,
  "deleted": false,                      // deleted for everyone: text/media/meta/location/replyTo null, reactions []
  "undecryptable": false,                // stored text could not be decrypted (text null)
  "text": "…" | null,                    // text, or the caption of image/file, or a plugin notice
  "replyTo": { "id", "senderId", "kind", "text" (≤ 200), "deleted", "missing" } | null,
  "media": { "id", "mime", "bytes", "url", "thumbId", "thumbUrl", "scan"? } | null, // url/thumbUrl: signed URLs for the portal frame only, null in the apps; scan since 1.11.0 (see "Virus scan")
  "thumbMediaId": "<32 hex>" | null,     // since 1.3.0: the preview picture (image or file message) — same as media.thumbId
  "video": { "durationMs", "width", "height" } | null, // since 1.3.0: file messages with video meta; each value null when not sent
  "meta": { "durationMs", "waveform": [0…255 ×≤64], "w", "h", "fileName" } | null, // keys present only when set
  "location": { "lat", "lon", "label" | null, "accuracy"? } | null,
  "system": { "event", … } | null,       // kind system only, see below
  "reactions": [ { "emoji", "count", "userIds": [..] } ],
  "status": "sent" | "delivered" | "read" | null   // own messages only (see "Read receipts")
}
```

System messages (`kind: "system"`, `system.event`): `created { by, title }`,
`member_added { by, userIds }`, `member_removed { by, userIds }`,
`member_left { userId }`, `title { by, title }`, `avatar { by }`,
`disappearing { by, seconds }` (0 = off), `notice` (a plugin's message, the
text in `text`, `via` the plugin), `released { by: null }` (since 1.1.0: the
plugin that managed the group handed it over — it is a normal group now,
`managedBy` null; suggested wording "GateControl hat die Gruppe freigegeben –
sie ist jetzt eine normale Gruppe"). `by: null` = GateControl (a managed group).
Show an unknown `event` as a neutral line (newer versions may add events).
Suggested wording: "Anna hat Lena hinzugefügt", "Anna hat den Namen in
„Familie" geändert", … (`texts.json` `sys.*` of this plugin). Only `notice`
counts as unread and is pushed.

### Routes

| Method & path | Body / query | Answer |
|---|---|---|
| `GET me` | | since 1.4.0 also `integrations` (since 1.10.0 `integrations.drive`), more `prefs`, `features` and `limits` (see "Since 1.4.0"); `{ user: { id, name, avatarUrl, initials, colorHex }, prefs: { readReceipts, typing, preview }, license: { licensed, state, expiresAt }, features: { direct, groups, voice, files, location, reactions, edit, search, disappearing, bridges: false, e2e: false, video_meta: true, file_thumbs: true, scan: true }, limits: { maxBytes, types[], quotaFull, editWindowS, maxVoiceS, textMax: 4000, thumbMaxBytes: 65536, thumbMaxSide: 640, imageMaxSide: 2048, groupMax: 256, titleMax: 80, pageMax: 100, typingS: 6, typingEveryS: 3, activeS: 30, disappearingS: [0, 86400, 604800, 2592000], retentionDays }, serverTime }` — `video_meta`, `file_thumbs`, `thumbMaxSide` since 1.3.0, see "Videos and file previews"; `scan` since 1.11.0 (`media.scan` on messages, see "Virus scan") |
| `PUT prefs` | `{ readReceipts?, typing?, preview? }` (booleans) | `{ prefs }` |
| `GET people` | | `{ people: [ { id, name, avatarUrl, initials, colorHex, color } ] }` — enabled accounts but the caller and kiosk accounts, by name |
| `GET conversations` | `?since=<ISO>` (optional) | `{ conversations: [Conversation] (newest activity first), removed: [ids] (left/removed since), serverTime }` — with `since` only conversations changed after it; use the answer's `serverTime` as the next `since`. A direct chat without messages is listed only for the person who opened it. Marks the newest message of each listed chat as delivered. |
| `POST conversations` | `{ kind: "direct", userIds: [peerId] }` or `{ kind: "group", userIds: [ids] (1…255 others), title (1…80), avatarMediaId? }` | `{ conversation, created }` — direct: the existing chat with that person when there is one (`created: false`) |
| `GET conversations/:id` | | `{ conversation }` |
| `PATCH conversations/:id` | `{ title?, avatarMediaId? (null removes), disappearingS?, mutedUntil? (ISO or null), notify? ("all"\|"none"), add?: [ids], remove?: [ids], role?: { userId, role } }` | `{ conversation, left }` — `conversation: null, left: true` after leaving (`remove: [ownId]`). Rules: mutedUntil/notify are the caller's own; title/avatar any group member; add/remove others/role admins only; direct chats only disappearingS/mute/notify; managed groups not title/avatar/members (`managed`), no leaving; notice channels only mute/notify. A group always keeps an admin. |
| `GET conversations/:id/messages` | `?limit=1…100 (50)` and one of `before=<id>` (older), `after=<id>` (newer, oldest first), `changedSince=<ISO>` (edited, deleted, reactions changed — by change time), `around=<id>` (since 1.1.0, see below) | `{ messages (ascending by id; changedSince: by change time), hasMore, readUpTo, deliveredUpTo, receipts, serverTime }` — without before/after/around: the newest page. Marks the newest returned message as delivered. A member sees messages from joining on. `serverTime` (since 1.1.0, every mode): the server's time of this answer — use it as the next `changedSince` (like `since` of the conversation list). |
| `POST conversations/:id/messages` | `{ clientId ([A-Za-z0-9_-]{8,64}, required), kind (default "text"), text?, replyTo?, mediaId?, thumbMediaId?, video?: { durationMs, width, height } (since 1.3.0, file only), location?: { lat, lon, label?, accuracy? }, meta?: { durationMs, waveform[≤64 × 0…255], w, h, fileName } }` | `{ message, duplicate }` — see "Sending" |
| `PATCH messages/:id` | `{ text }` | `{ message }` — sender only, kinds text/image/file (caption; a text message needs a text), within `editWindowS` |
| `DELETE messages/:id` | `?for=me` (default) or `?for=all` | `{ forAll, message }` — `me`: hidden for the caller only (any message); `all`: sender only, within the window → tombstone (`message` the tombstone, `null` for `me`) |
| `PUT messages/:id/reaction` | `{ emoji }` (1…16 UTF-16 units, an emoji) or `{ emoji: null }` | `{ reactions }` — one reaction per person (a new one replaces it); not on system or deleted messages |
| `POST conversations/:id/read` | `{ upTo: <message id> }` | `{ lastReadId, unread }` — never moves back; clamped to the newest message |
| `POST conversations/:id/typing` | `{}` or `{ stop: true }` | `{ until }` — call at most every 3 s while typing; valid 6 s; `until: null` when the caller switched "typing" off (nothing sent) or stopped |
| `POST conversations/:id/active` | `{}` or `{ active: false }` | `{ until }` — the conversation is open on a device: send on open and **every 20 s** while it is open and visible, `{ active: false }` on leaving; counts 30 s; such a person gets no push for this chat |
| `GET conversations/:id/search` | `?q=` (2…100 characters) | `{ results: [Message] (newest first, ≤ 50), scanned (≤ 2000), truncated }` — texts, captions, file names and place labels, decrypted on the server |
| `GET conversations/:id/media` | `?kind=image\|voice\|file\|video\|all&before=<id>&limit=1…100 (30)` | `{ items: [Message] (newest first), counts: { image, voice, file, video }, hasMore }` — since 1.3.0: `video` = file messages whose file is `video/*`, `file` = the other files (no videos), `counts.video` (and `counts.file` without videos); `all` unchanged (pictures, voice, files and videos) |

**`around=<messageId>`** (since 1.1.0) — jump to a search result or a quoted
message: up to `floor(limit / 2)` messages older than `around`, then the message
`around` itself (when the caller sees it — a message hidden for the caller or
deleted for good leaves just its neighbours) and the newer ones, `limit` in all
at most, ascending by id (the newer half is not filled up when there are fewer
older ones). The answer carries `hasMoreBefore` (older messages exist: continue
with `before=<first id>`) and `hasMoreAfter` (newer ones exist: continue with
`after=<last id>`); `hasMore` = either of them. An id of another chat only marks
a position — nothing of that chat is returned. Example: `messages?around=4711&limit=30`
→ 15 older, 4711 and 14 newer.

### Sending

* **Idempotent**: `(conversation, sender, clientId)` is unique. A retry with
  the same `clientId` returns the stored message with `duplicate: true` and
  sends nothing again (outbox, notification replies).
* `text`: `text` 1…4000 characters (`\r\n` → `\n`, control characters
  removed, at most 3 empty lines in a row, trimmed).
* `image`: `mediaId` (image/*), optional `thumbMediaId` (image/*, ≤ 64 KB),
  optional caption `text`, `meta.w`/`meta.h`. Scale before the upload (long
  side 2048, WebP/JPEG); the server converts nothing.
* `voice`: `mediaId` (audio/*: `audio/ogg`, `audio/mp4`, `audio/aac`,
  `audio/mpeg`, `audio/webm`), `meta.durationMs` (≤ `maxVoiceS` + 1 s),
  `meta.waveform` (≤ 64 values 0…255).
* `file`: `mediaId` (any allowed type), `meta.fileName` (≤ 200), optional
  caption `text`; since 1.3.0 optional `thumbMediaId` and, for a video file,
  `video` — see "Videos and file previews".
* `location`: `location { lat, lon, label?, accuracy? }` (one-off position).
* `replyTo`: a message of the same chat the caller sees, not deleted.
* Files: upload first (`PUT /api/v1/client/plugins/gatecontrol-messenger/media`
  with the raw file, `Content-Type` one of `limits.types`, `Content-Length`
  ≤ `limits.maxBytes` → `{ mediaId, mime, bytes }`; errors `413 too_large`,
  `415 unsupported_type`, `507 quota_exceeded`, `411 length_required`), then
  send the message with the `mediaId` — the plugin binds it (`gc.media.claim`)
  when the message is stored; only the uploader may attach it, once. Unsent
  uploads are removed by GateControl after 24 h.
* Download in the apps: `GET /api/v1/client/plugins/gatecontrol-messenger/media/<mediaId>`
  (`Range` supported) — 404 unless the caller is an active member of the chat
  the file belongs to (message, preview or group picture), sees that message
  (joined before it, not hidden for them, not deleted for everyone). An unsent
  upload: its uploader only.
* Sending moves the sender's own read mark to the new message (replying reads).
* Disappearing chats: messages sent while `disappearingS > 0` carry
  `expiresAt`; the server deletes them (and their files) for good after it.

### Videos and file previews (since 1.3.0)

A video stays a **file message** (`kind: "file"`, file `video/*`) — apps that
know nothing of 1.3.0 keep showing it as a file. Check `features.video_meta` /
`features.file_thumbs` of `GET me` (`true`) before sending — a messenger
before 1.3.0 has neither flag, drops `video` and does not list videos apart:

* `thumbMediaId` (`file_thumbs`, any file): a preview picture the sender
  uploaded like the file — `image/webp`, `image/jpeg` or `image/png`, ≤ 64 KB
  (`limits.thumbMaxBytes`), ≤ 640 px a side (`limits.thumbMaxSide`; the
  server cannot read the bytes of an upload, so the side is the sender's
  job — the push picture is checked by GateControl again). A video: a frame
  at about 1 s; a PDF: the first page. Same rules as a picture's preview:
  the sender's own unused upload, not the file itself (`media_invalid`,
  `media_in_use`, `invalid`).
* `video` (`video_meta`, only when the file is `video/*`, else `invalid`):
  `{ durationMs (0…86400000), width (1…16384), height (1…16384) }` —
  integers, the size as shown (rotation applied); a value may be left out or
  null when unknown, other keys are ignored, `{}` counts as none.
* Messages return both as `thumbMediaId` and `video` (null when not sent;
  `media.thumbId` / `media.thumbUrl` as for pictures). The preview is loaded
  like the file (`GET …/media/<thumbMediaId>`) with the same access rule:
  active members who see the message.
* `GET conversations/:id/media?kind=video` lists the videos (with or
  without `video` meta — the file's type decides), `kind=file` the other
  files; `counts.video`.
* Push: a video with a preview carries the preview as the push picture,
  exactly like a picture message (see "Push").
* The preview goes with its message: deleted for everyone, disappearing,
  retention, a deleted managed group — the file and its preview are removed
  from GateControl's store together.

### Read receipts

* Per member `lastReadId` / `lastDeliveredId`. Delivered = the member's apps
  fetched the chat list or messages up to that id.
* Whoever switches read receipts off sends none and sees none (both ways, like
  WhatsApp): for them `readUpTo` is null and `receipts` empty; the others get
  `lastReadId: null` in the `read` event for them.
* `readUpTo` = the lowest `lastReadId` of the other members (with an account)
  who share receipts (null when none); `deliveredUpTo` = the lowest
  `lastDeliveredId` of the other members (with an account).
* `status` of an own message: `read` when `id ≤ readUpTo`, else `delivered`
  when `id ≤ deliveredUpTo`, else `sent`.

### Live events

Realtime events (`gc.events`) arrive in the apps on the push stream
(`GET /api/v1/client/push`) as `event: plugin` with
`{ "plugin": "gatecontrol-messenger", "type", "data" }` (in the portal through
`GC.on('event')`). Only to active members of the conversation; ephemeral, no
replay — after a reconnect call `GET conversations?since=` and
`GET conversations/:id/messages?after=<last id>` (and `changedSince=` for
cached chats).

| type | data | client action |
|---|---|---|
| `message.new` | `{ conversationId, messageId, senderId (null = system), clientId, kind, createdAt }` | fetch `messages?after=` (match `clientId` to replace a pending outbox entry) |
| `message.update` | `{ conversationId, messageId, editedAt }` — since 1.11.0 also for a new state of the virus scan: `{ …, editedAt (the time of the change; the message's own `editedAt` stays), scan }` | fetch `messages?changedSince=` |
| `message.delete` | `{ conversationId, messageIds: [..], reason: "deleted" \| "hidden" \| "expired" \| "retention" }` | `deleted`: show tombstone; the others: remove (`hidden` goes to the caller's own devices only) |
| `reaction` | `{ conversationId, messageId, userId, emoji \| null, reactions: [ { emoji, count, userIds } ] }` | replace the message's reactions |
| `read` | `{ conversationId, userId, lastReadId (number \| null when not shared), lastDeliveredId, readUpTo, deliveredUpTo }` — to the reader's own devices additionally `{ …, self: true, unread }` | update receipts / ticks; `self`: update unread, remove that chat's notifications. `readUpTo` / `deliveredUpTo` (since 1.1.0): the values `GET conversations/:id` would give **this recipient** right now (see "Read receipts") — set the chat's `readUpTo` / `deliveredUpTo` (and the ticks of own messages) from the event, no GET needed. Sent for read marks and for delivered marks (the same event; a moved delivered mark changes `lastDeliveredId` / `deliveredUpTo`). |
| `typing` | `{ conversationId, userId, until (ISO) \| null }` | show "schreibt …" until `until` (≈ 6 s; null = stop) |
| `conversation.update` | `{ conversationId, reason }` — `reason`: `created`, `settings`, `members`, `title`, `avatar`, `disappearing`, `released` (since 1.1.0: no longer managed by a plugin) (comma-separated when several) | `GET conversations/:id` (treat an unknown reason the same) |
| `conversation.remove` | `{ conversationId }` | drop the chat (removed, left, no longer in a managed group, or — since 1.1.0 — a managed group deleted by its plugin) |

### Virus scan (since 1.11.0)

GateControl checks every file of a chat right after its upload (the GateControl version after 1.222.0 — Einstellungen ›
Sicherheit › Virenscan, source "Messenger"; pictures, voice messages, files, their previews, stories and group pictures;
contract: GateControl's `docs/feature-malware-scan-contract.md`). The Messenger reads the result where the host gives one
(`scan` of `gc.media.info`) and changes nothing with an older GateControl; the minimum stays 1.193.0.

* **Upload:** GateControl may refuse the upload itself — `422 { code: 'infected', finding }` (the administrator's action
  "Sofort löschen": the file is gone) or `503 scan_unavailable` (try later). The apps show „Nicht gesendet –
  Schadsoftware gefunden“ for the first.
* **Sending** (`POST conversations/:id/messages`, stories, the group picture): a file in quarantine is refused with **`422
  infected { finding }`** („Nicht gesendet – der Virenscan hat in der Datei Schadsoftware gefunden.“), a file blocked as
  not checkable with `423 scan_blocked`. A file still being checked (a big video) **is sent**: its message carries
  `media.scan.state: 'pending'` with `blocked: true` until the check ends.
* **The message:** `media.scan { state, blocked, finding }` once a result is known (`state` `pending` | `clean` |
  `infected` | `unscannable` | `unchecked`; `finding` the find or the reason). **`blocked` decides:** a held-back file
  has `url`, `thumbUrl`, `thumbId` and `thumbMediaId` `null`, no push picture, GateControl's media route answers `423`
  (`scan_pending` with `Retry-After`, `quarantined`, `scan_blocked`), "In Drive speichern" answers `423` with the same
  code. The clients show „Wird auf Viren geprüft …“ (`pending`) or „Datei gesperrt – Schadsoftware gefunden (<finding>)“ /
  „Datei gesperrt – konnte nicht geprüft werden“ instead of the picture, the player or the file — for the recipients
  and the sender alike. `infected` with `blocked: false` (the administrator only marks): usable, with a warning.
* **Later results** (the check of a big file ends, the nightly re-check with new signatures, an administrator releases
  or deletes the file — hook `mediaScanned`): the message's `updated_at` moves and the members get `message.update {
  conversationId, messageId, editedAt, scan }` — fetch `messages?changedSince=` as for an edit.
* **Hand-overs** (`send_file` of GateDrop) keep the state; GateControl never hands over a held-back file.

### Push

One chat notification (`kind: "message"`, topic
`plugin:gatecontrol-messenger:message`) per new message (text, image, voice,
file, location, plugin notice) to every member except the sender who has an
account, has not muted the chat (`notify: "none"` or `mutedUntil` in the
future) and does not have it open (`active` within 30 s). Member changes and
other system messages are not pushed. The payload as the device contract
(GateControl docs/feature-notification-center.md "Chat-Benachrichtigungen"):

```json
{
  "kind": "message", "topic": "plugin:gatecontrol-messenger:message",
  "title": "Anna",                         // sender name; preview off: "Neue Nachricht von Anna" / "New message from Anna"
  "body": "Bist du schon unterwegs?",      // preview off: ""; image "Foto: <caption>", voice "Sprachnachricht (0:14)",
                                           // file "Datei: <name>", location "Standort: <label>" (in the recipient's language)
  "collapse_key": "plugin:gatecontrol-messenger:chat:12",
  "data": {
    "route": "plg-gatecontrol-messenger",
    "messageId": 4711, "conversationId": 12,
    "conversation": { "id": "12", "title": "Familie" | null (direct), "isGroup": true },
    "sender": { "id": 7 | "gatecontrol", "name": "Anna" | "GateControl", "avatarUrl": "/avatars/…" | null },
    "actions": [
      { "id": "reply", "type": "reply", "label": "Antworten", "path": "conversations/12/messages" },
      { "id": "mark_read", "type": "mark_read", "label": "Gelesen", "path": "conversations/12/read", "body": { "upTo": 4711 } }
    ]
  }
}
```

* `reply` (missing for a read-only notice channel): the app posts
  `{ clientId: "<UUID>", kind: "text", text, source: "notification" }` to
  `/api/v1/client/plugins/gatecontrol-messenger/api/conversations/12/messages`
  (answer as "Sending"; a retry with the same `clientId` is stored once) and
  then does what `mark_read` does.
* `mark_read`: the app posts `{ "upTo": 4711 }` to
  `/api/v1/client/plugins/gatecontrol-messenger/api/conversations/12/read`
  and acks the notification(s) of that chat as `read`.
* Preview and language are per recipient: the preference `preview` (`PUT
  prefs`) and the language of the person's last request to this API.
* **Picture** (since 1.1.0, on GateControl ≥ 1.178.0): a picture message
  carries its preview as the push picture — GateControl puts it into the
  payload as `imageUrl` (`/notify-media/<id>.<ext>`, fetched without login,
  lives as long as the push; Android: `MessagingStyle.Message.setData`).
  Only for recipients with `preview` on; the preview file (`thumbMediaId`),
  else the photo itself, when it is PNG/JPEG/WebP, ≤ 300 KB and 32…2560 px a
  side — otherwise the push goes out without a picture. On GateControl
  1.177.x there is none. Apps that ignore `imageUrl` are not affected.
  Since 1.3.0 a video file with a preview (`thumbMediaId`) carries that
  preview the same way (only the preview — never the video, never the
  preview of another kind of file); the body stays "Datei: <name>".
* Budgets are GateControl's (1200/h per plugin, 120/h per recipient); a
  recipient over it gets no push (logged as a limit).

### Since 1.4.0 — status, stories, privacy, chat tools, polls, events, live arrival, home actions

Everything below is new in **1.4.0** (GateControl ≥ 1.180.0). A client shows a
feature only when `GET me` → `features.<key>` is `true` (the key is absent
otherwise — never `false`):

| key | what |
|---|---|
| `status` | status line (`PUT/DELETE status`, `GET status/feed`) |
| `stories` | stories (`status/stories…`); absent when the administrator switched them off |
| `story_duration` | since 1.4.1: `POST status/stories` takes `durationH` (one of `limits.storyDurationsH`); present together with `stories` |
| `polls` | message kind `poll` |
| `events` | message kind `event`, `nextEvent` on conversations |
| `arrival` | message kind `arrival` (live arrival) |
| `actions` | home actions (`GET actions`, message kind `action`, buttons of `card` messages); absent without `gc.actions` on the host or when the administrator switched them off — `homeActions.reason` says which (since 1.5.0) |
| `action_requests` | since 1.5.0: `GET actions/requestable`, request `approvers`, `expiresAt`; present together with `actions` |
| `grant_off` | since 1.5.0: grant `offAtEnd`, system message `grant_off`; present together with `actions` |
| `notices` | since 1.6.0: conversations carry `listPinned` and `notice`, cards of kind `notice` ("Notifications in chats") |
| `notice_routes` | since 1.6.0: `GET/PUT portal/notify-routes` (GateControl has `gc.notify.routes`) |
| `msg_tools` | blocks, archive, pins, lists, export, remind me, suggest |
| `privacy2` | `prefs.privacy` / `prefs.notify` / `prefs.chats`, last seen / online |

`GET me` also has `integrations: { familie: { lists, calendar, places } }`
(booleans: the Familie plugin offers `list_add`, `calendar_add`, `places`
right now — `gc.services.available`) and these `limits`: `statusTextMax: 60,
storyTextMax: 700, storyTtlS: 86400, storyDurationsH: [1, 3, 6, 12, 24] (since 1.4.1), storiesMax: 30, pollOptionsMax: 12,
pollQuestionMax: 200, pollOptionMax: 80, eventTitleMax: 120,
eventChecklistMax: 20, pinsMax: 3, listsMax: 20, remindersMax: 100,
arrivalEveryS: 20, arrivalMaxS: 10800, arrivalRadiusM: 150`; since 1.5.0
`requestTtlMin` and `grantMaxDays` (the administrator's settings).

Since 1.5.0 `GET me` also has `homeActions: { available, reason: null | "off"
(the administrator's switch) | "host" (no gc.actions), approversDefault:
"parents" | "rights", childrenMayRequest, familyRoles (Familie offers
family_roles), canRequest (false for Familie's children while
childrenMayRequest is off), doorbell: { lastCardAt } | null (the last doorbell
card of gatecontrol-door in a chat of the caller) }` — show "Aus deinem
Zuhause" with a hint instead of hiding it when `available` is false.

Unknown message kinds (a newer server): show a neutral bubble "Diese
Nachricht braucht eine neuere App-Version". New error codes:

| HTTP | code | when |
|---|---|---|
| 403 | `blocked` | a direct message while either of the two blocked the other |
| 403 | `not_allowed` | not the creator / not an approver / not allowed to run that action / options not allowed / nobody may be added (`groupAdd`) |
| 403 | `feature_off` | stories or home actions switched off (or no `gc.actions`) |
| 409 | `closed` | poll closed, event cancelled, arrival no longer live, action no longer open |
| 409 | `no_approver` | an action request nobody in the chat may run |
| 409 | `unavailable` | the Familie plugin does not offer that service (or refused it) |
| 429 | `rate_limited` | poll nudge more than once an hour |
| 403 | `no_seat` / `not_licensed` | since 1.10.0, Drive: no Drive seat / Drive not licensed ("Save to Drive") |
| 409 | `quota` / `upload_invalid` / `exists` | since 1.10.0, Drive: storage full / file not taken / name taken |
| 409 | `drive_unavailable` | since 1.10.0: the Drive plugin does not take files right now |

#### Preferences (`GET me` → `prefs`, `PUT prefs`)

`PUT prefs` takes partial objects; unknown keys or values → `invalid`.

```json
{
  "readReceipts": true, "typing": true, "preview": true,
  "privacy": { "lastSeen": "all|family|nobody", "avatar": "all|family|nobody", "statusDefault": "all|family|custom",
               "placeInStatus": "nobody|family|all", "groupAdd": "all|family|nobody", "defaultDisappearingS": 0|86400|604800|2592000 },
  "notify":  { "groupsMentionsOnly": false, "reactions": true, "statusDigest": false, "eventReminderMin": 0|15|60|120|1440 },
  "chats":   { "keepArchived": true }
}
```

Defaults as shown (`placeInStatus` default `family`, `eventReminderMin` 60).
**family** = the members of the Familie plugin's group "Familie" (the managed
group `gatecontrol-familie` / `family`); without it, `family` means the same
as `all`.

* `lastSeen`: who sees `online` / `lastSeenAt`. Symmetric like read receipts:
  whoever hides theirs from someone sees nothing of that person.
* `avatar`: who gets the person's `avatarUrl` (others get `null` everywhere:
  people, members, peer, status feed). Since 1.22.0 on a GateControl that keeps
  „Wer sieht dein Bild?“ in the user profile, see below.
* `statusDefault`: the audience when `PUT status` / `POST status/stories`
  carry no `visibility`.
* `groupAdd`: who may add the person to groups. Others are left out and listed
  in `skipped` of `POST conversations` / `PATCH conversations/:id`
  (`not_allowed` when nobody is left). Groups of other plugins are not affected.
* `defaultDisappearingS`: new chats the person opens start with it (when the
  administrator allows disappearing chats).
* `groupsMentionsOnly`: in groups only pushes for messages that name the
  person (`@Name` or `@Firstname`) or answer one of their messages (plugin
  notices still push).
* `reactions`: a push when someone reacts to the person's message.
* `statusDigest`: one push a day in the evening (18:00 server time) when
  people the person may see posted stories (topic `status`, not a chat push).
* `eventReminderMin`: the reminder of an event the person creates when the
  event names none.
* `keepArchived`: `false` → an archived chat comes back with a new message.

**Last seen / online**: members (`members[]`, `peer`) and `GET people` carry
`online` (boolean) and `lastSeenAt` (ISO or `null`) — `online` = a request of
the person's apps / portal within 150 s (the server notes the time at most once
a minute; the `active` ping every 20 s keeps it fresh); hidden → `online:
false, lastSeenAt: null`. `GET people` also carries `blocked` (the caller
blocked that person).

#### Status and stories

| Method & path | Body / query | Answer |
|---|---|---|
| `GET status` | | `{ status }` (own, or `null`) |
| `PUT status` | `{ preset: "none"\|"homeoffice"\|"away"\|"dnd"\|"auto_place", text? (≤ 60), until? (ISO, future, ≤ 1 year), visibility? ("all"\|"family"\|"custom"), userIds? (custom, ≥ 1), eta? (away), destLabel? (≤ 80, away) }` | `{ status }` — `preset: "none"` needs a `text` |
| `DELETE status` | | `{ status: null }` |
| `GET status/feed` | | `{ items: [Item], me: Item, serverTime }` |
| `POST status/stories` | `{ kind: "text"\|"image"\|"video", text? (≤ 700; required for text), bg? ("#RRGGBB"), font? ("sans"\|"serif"\|"mono"), mediaId? (image: image/*, video: video/*), thumbMediaId? (WebP/JPEG/PNG ≤ 64 KB), video? ({ durationMs, width, height }), visibility?, userIds?, eventMessageId? (an event message the caller sees), place? (≤ 80), durationH? (1\|3\|6\|12\|24, since 1.4.1; default 24) }` | `{ story }` — `too_many` over 30 active stories, `feature_off` when switched off |
| `DELETE status/stories/:id` | | `{ deleted: true }` (own) |
| `POST status/stories/:id/seen` | | `{ seen: true }` |
| `GET status/stories/:id/viewers` | | `{ viewers: [ { user, seenAt, reaction } ] }` (own stories only) |
| `POST status/stories/:id/react` | `{ emoji }` | `{ message }` — sent to the owner as a direct message (`text` = the emoji) with `replyStory` |

**Status** (`status`): `{ preset, text, place, until, eta, destLabel,
updatedAt }` + for the owner `{ ownText, visibility, userIds }`. `text` is
what to show: for `auto_place` the place (when the viewer may see it, see
`placeInStatus`), else the person's text (or `null` → show the preset's
name). `dnd`: while it lasts the person gets **no chat pushes** (messages
still arrive; own "remind me" reminders still come). `auto_place`: the place
comes from the Familie plugin (service `set_place_status`, see "Services");
a live arrival that arrives sets it to the destination's label. An expired
status disappears (background run, `status.update`).

**Feed item**: `{ user: { id, name, avatarUrl, initials, colorHex }, status |
null, stories: [Story], unseen }`, sorted unseen first, then by the newest
story, people with only a status last. `me` is the caller's own item (stories
with `viewerCount`, `reactionCount`, `visibility`).

**Story**: `{ id, kind, text, bg, font, mediaId, thumbMediaId, video, url,
thumbUrl, createdAt, expiresAt, seen, place, eventMessageId }` — `url` /
`thumbUrl` are signed URLs for the portal frame (null in the apps; the apps
load `GET /api/v1/client/plugins/gatecontrol-messenger/media/<mediaId>` —
allowed while the story lasts for its audience and the owner). Stories last
24 h; then they and their files are deleted (`story.remove`).

**Audience** (`visibility`): `all`, `family`, `custom` (`userIds`). Blocked
people (either way) see neither status nor stories.

**Replies**: a normal direct message to the owner with `replyStory: { storyId }`
in the send body (the story must still exist and be visible to the sender;
only in the direct chat with its owner). The message then carries
`replyStory: { storyId, ownerId, preview: { kind, text (≤ 100), thumbMediaId } }`.

#### Blocks, archive, pins, lists, export, remind me, suggest

| Method & path | Body / query | Answer |
|---|---|---|
| `GET blocks` | | `{ blocks: [ { userId, name, avatarUrl, initials, colorHex, at, gone } ] }` |
| `POST blocks` | `{ userId }` | `{ blocks }` |
| `DELETE blocks/:userId` | | `{ blocks }` |
| `POST conversations/:id/archive` | `{ archived: bool }` | `{ conversation }` (per member) |
| `POST conversations/:id/pins` | `{ messageId }` | `{ conversation }` — max 3 per chat (`too_many`), any member; groups of a plugin: admins only (`managed`), notice channels never (`readonly`) |
| `DELETE conversations/:id/pins/:messageId` | | `{ conversation }` |
| `GET lists` | | `{ lists: [ { id, name, conversationIds } ] }` |
| `PUT lists` | `[ { id ([A-Za-z0-9_-]{1,40}), name (1…40), conversationIds } ]` (≤ 20; or `{ lists: [...] }`) | `{ lists }` — ids of chats the caller is not in are dropped; stored encrypted |
| `GET conversations/:id/export` | `?format=txt&before=<id>` | `{ format: "txt", mime: "text/plain", fileName, text, count, truncated, before }` |
| `POST messages/:id/remind` | `{ at }` (future, ≤ 1 year) | `{ reminder: { id, messageId, conversationId, at, createdAt } }` (≤ 100 open) |
| `GET reminders` | | `{ reminders: [ { id, messageId, conversationId, at, createdAt, preview } ] }` (open ones, soonest first) |
| `DELETE reminders/:id` | | `{ deleted: true }` |
| `GET messages/:id/suggest` | | `{ items: [string], dates: [ { startsAt, label, title, allDay } ] }` |
| `POST messages/:id/to-list` | `{ items: [string] (1…50, ≤ 120), list? ("shopping" default, or a Familie list id) }` | `{ listId, listName, added, skipped }` — `unavailable` without Familie |
| `POST messages/:id/to-calendar` | `{ title (≤ 80), startsAt, endsAt?, allDay?, place? }` | `{ eventId }` — `unavailable` without Familie |
| `GET familie/places` | | `{ places: [ { id, name, lat, lon, radiusM } ] }` (for the event place and the arrival destination) — `unavailable` without Familie |

* **Conversation** gains `archived` (bool, the caller's), `pinned` ([message
  ids] the caller sees), `nextEvent` (`{ messageId, title, startsAt, yesCount }`
  or null — the soonest event not cancelled and not over, shown above the
  chat), `can.pin`, `peer.blocked` (the caller blocked the peer; then
  `can.send` is false) and `online` / `lastSeenAt` on `peer` and `members[]`.
* **Blocks**: A blocked B → no direct messages either way (`blocked`), neither
  sees the other's status, stories, last seen or online; the blocked person
  gets no `avatarUrl` of the blocker. Groups are not affected.
* **Export**: the newest messages up to ~800 KB, oldest first, one line each:
  `dd.mm.yy, HH:MM - Name: text` (server time zone); pictures, voice, files,
  locations, polls, events … as `<Foto>`, `<Datei: name.pdf>`, `<Standort:
  label lat,lon>`, `<Umfrage: question>`; member changes are left out.
  `truncated: true` → ask again with `before=<before>` and put that part in
  front. The apps add media files themselves if they want to.
* **Remind me**: at `at` a chat push to the caller only — title "Erinnerung",
  body "Erinnerung: <preview>" (`data.kind: "reminder"`, `messageId`,
  `conversationId`, `reminderId`); sent even when the chat is muted or the
  status is dnd. Deleting the message (for everyone, disappearing, retention)
  removes its reminders.
* **Suggest**: a German rule-based parser on the server (no external
  service). `items`: bullet lines, `Einkaufsliste: …`, comma / "und" lists
  next to kaufen, besorgen, mitbringen ("bring … mit"), mitnehmen, holen,
  brauchen. `dates`: heute, morgen, übermorgen, weekdays ("am Samstag",
  "nächsten Montag"), `18.10.`, `18.10.2026`, `18. Oktober`, times ("um 15
  Uhr", "15:30", "9.15 Uhr", "halb 4") — relative to when the message was sent,
  server time zone; `allDay` without a time; `label` e.g. "Sa., 24.10. 15:00";
  `title` the sentence without the date words.

#### Save to Drive (since 1.10.0)

"In Drive speichern" for the file of a message: the Drive plugin
(`gatecontrol-drive` ≥ 1.4.0, service `save_file`; this plugin lists
`gatecontrol-drive:save_file` in `permissions.services`). `GET me` →
`integrations.drive` (boolean): Drive takes files right now
(`gc.services.available`) — show the action only then.

| Method & path | Body | Answer |
|---|---|---|
| `POST messages/:id/to-drive` | `{}` or `{ folderId }` (a Drive folder id the person picked with Drive's own API) | `{ saved: { nodeId, name, where } }` |

* Which messages: pictures, voice messages and files (`kind` image / voice /
  file with `media`) the caller may download — the rule of `GET …/media/<id>`:
  an active member who sees the message (joined before it, not hidden for
  them, not deleted for everyone); otherwise `404 not_found` like every
  message route. The id is the **message** id (`message.id`), not the
  `mediaId`; one file per message.
* Where: without `folderId` **Meine Dateien › Messenger › <name>** (the folder
  is made when missing), with `folderId` into that folder. `name`: the
  message's `meta.fileName`, else e.g. "Foto 2026-10-17 12-00.jpg" /
  "Sprachnachricht … .ogg" (sent at, server time zone; "Photo", "Voice
  message", "File" in English). A name already taken gets " (2)".
* The file is handed over (`gc.media.handOver`, a copy — the chat keeps its
  own) and saved for the caller; Drive checks the seat, licence, write access
  and quota. `saved.where` is Drive's text in the caller's language, e.g.
  "Meine Dateien › Messenger › Foto.jpg" → toast "Gespeichert in <where>".
* Errors: Drive's codes as they are — `403 no_seat` (no Drive seat), `403
  not_licensed`, `403 forbidden` (no write access to the folder), `404
  not_found` (also: unknown folder), `400 invalid` (bad `folderId` or name),
  `409 quota` (Drive's storage full), `409 upload_invalid` (Drive does not
  take the file), `409 exists`; `409 drive_unavailable` (Drive not installed,
  not running or refusing, GateControl without the hand-over), `429
  rate_limited` (20 saves per hour and person, or GateControl's limit of 60
  service calls per hour for the messenger).

#### Polls (`kind: "poll"`)

Send: `{ clientId, kind: "poll", poll: { question (1…200), options: [string]
(2…12, each ≤ 80, not twice), multi?, anonymous?, allowAdd?, closesAt? (ISO,
future) } }` (no `text`, no `meta`). Message `poll`:

```json
{ "question": "Pizza oder Pasta?", "options": [ { "id": "o1", "text": "Pizza", "count": 2, "voters": [3, 4], "addedBy": null } ],
  "multi": false, "anonymous": false, "allowAdd": true, "closesAt": null, "closed": false, "closedAt": null,
  "voterCount": 2, "memberCount": 4, "creatorId": 2, "myVotes": ["o1"] }
```

`voters` is missing when `anonymous`. Routes (members; answer `{ message }`):
`POST messages/:id/vote { optionIds: [] }` (replaces the caller's votes;
empty = withdraw; one id unless `multi`), `POST messages/:id/options { text }`
(`allowAdd`; `addedBy` = the caller), `POST messages/:id/close` (the creator or
a group admin), `POST messages/:id/nudge` (the creator, at most once an hour:
a push "Bitte abstimmen: <question>" to the members who have not voted →
`{ message, nudged }`). Closed (by hand or at `closesAt` by the background
run) → system message `poll_closed { by (null = at closesAt), messageId,
question, winner (text or null on a tie / no votes), winners: [text], votes }`.
Event `poll.update`.

#### Events (`kind: "event"`)

Send: `{ clientId, kind: "event", event: { title (1…120), startsAt, endsAt?,
allDay?, place?: { label, familiePlaceId?, lat?, lon? }, description? (≤ 1000),
checklist?: [string] (≤ 20, each ≤ 80), rsvp? (default true), guests? (default
false), reminderMin? (0|15|60|120|1440; default the creator's
`notify.eventReminderMin`), familyCalendar?, departureHint? } }`. Message `event`:

```json
{ "title": "Grillen", "startsAt": "…", "endsAt": null, "allDay": false, "place": { "label": "Garten" }, "description": null,
  "checklist": [ { "id": "c1", "text": "Kohle", "doneBy": 3, "doneAt": "…" } ],
  "rsvpEnabled": true, "guests": true,
  "rsvp": { "yes": [ { "userId": 3, "guests": 1 } ], "maybe": [], "no": [], "mine": "yes", "myGuests": 0 },
  "reminderMin": 60, "familyCalendar": false, "departureHint": true, "cancelled": false, "creatorId": 2 }
```

(**Deviation from the draft**: the send field `rsvp` (bool) comes back as
`rsvpEnabled`; `rsvp` in the message is the answers object.)

Routes (answer `{ message }`): `POST messages/:id/rsvp { answer:
"yes"|"maybe"|"no"|null, guests? (0…20, only with yes and guests on) }`,
`POST messages/:id/checklist/:itemId { done }`, `PATCH messages/:id/event { any
send field, cancelled?: true }` (the creator or a group admin; a checklist item
with the same text keeps its id and tick; a moved start sends reminders
again; `cancelled` → system message `event_cancelled { by, messageId, title }`).
Event `event.update` (+ `conversation.update` effects through `nextEvent`).
Pushes: `reminderMin` before the start "Erinnerung: Termin" / "<title> – <time>"
to yes + maybe (everyone when RSVP is off), `data.kind: "event_reminder"`;
`departureHint`: 45 min before "Abfahrt?" / "<title> beginnt in N Min. –
Ankunft teilen" with `data.kind: "event_departure"`, `data.deepLink:
"arrival"` (open the chat and offer to share the arrival). `familyCalendar`:
after each change Familie's `calendar_upsert { sourceRef:
"messenger:<messageId>", title (≤ 80), startsAt, endsAt?, allDay, place
(label), userIds (the members) }`, cancelled / deleted → `calendar_remove`
(all-day dates as `YYYY-MM-DD`).

#### Live arrival (`kind: "arrival"`)

Send: `{ clientId, kind: "arrival", arrival: { dest: { label (≤ 120), lat,
lon, radiusM? (30…5000, default 150), familiePlaceId? }, onArrive?: {
actionId, plugin? } } }` — an older live arrival of the same person in that
chat stops. Message `arrival`:

```json
{ "dest": { "label": "Zuhause", "lat": 50.0, "lon": 7.0, "radiusM": 150 }, "onArrive": null,
  "state": "live|arrived|stopped", "etaAt": "…", "distanceM": 5560, "progress": 0.5,
  "lastAt": "…", "startedAt": "…", "endedAt": null, "position": { "lat": 50.05, "lon": 7.0, "accuracy": 12 } }
```

The sender's app posts `POST messages/:id/arrival { lat, lon, accuracy?,
speedMps? }` about every 20 s (closer than 15 s → `{ accepted: false }`, not
used) → `{ message, accepted, arrived }`. The server computes `distanceM`
(great circle), `progress` (1 − distance / distance at the first post),
`etaAt` (from the smoothed speed: the app's `speedMps` or the progress since
the last post; 40 km/h without either). Within `radiusM` → `arrived`: system
message `arrived { userId, messageId, label }`, a push "Anna ist angekommen"
to the others, `onArrive` run as the sender (an automation run; system message
`action_run`), a status `auto_place` shows the label. `POST messages/:id/arrival/stop`
→ `stopped`; after 3 h it stops by itself. `position` only while `live` (members
only — every viewer is one); the stored position is encrypted and deleted when
the arrival is no longer live. Only the sender may post (`not_sender`). Event
`arrival.update { conversationId, messageId, state, updatedAt }`.

#### Home actions and plugin cards

Built on GateControl's `gc.actions` (1.180.0): the quick actions the other
plugins offer to a person, run **as that person with their rights**
(GateControl's activity log names the user "via plugin gatecontrol-messenger").

* `GET actions` → `{ actions: [ { id, plugin, label, icon (SVG path, 24×24) |
  null, kind ("button"|"toggle"), needsConfirm, state, subtitle, pluginName } ] }`
  — what the caller may run with a tap (attach sheet). Which of them a person
  shows in the attach sheet is a client setting ("Haus-Aktionen").
* `GET actions/requestable[?approvers=parents|rights|<id,id,…>&conversationId=<id>]`
  (since 1.5.0, feature `action_requests`) → `{ actions: [ { id, plugin, label,
  icon, kind, needsConfirm, state, subtitle, pluginName, approverIds: [ids],
  self } ], approvers: "parents"|"rights"|"list"|null, approversDefault,
  canRequest, requestTtlMin }` — what the caller may **ask for**: the actions
  the possible approvers may run (also ones the caller cannot run, e.g. a
  child asking for the front door; `self`: the caller may run it too). Without
  `approvers` the administrator's default; `conversationId`: only approvers
  among that chat's members (at most 30 people are asked). `canRequest: false`
  (Familie's children while `childrenMayRequest` is off) → `actions: []`.
* Send `{ clientId, kind: "action", action: { mode: "run"|"request"|"grant",
  actionId, plugin?, label? (≤ 80), approvers? (request, since 1.5.0:
  "parents" | "rights" | [ids]), approverIds? (request, older form of a list),
  grant?: { toUserId, until (≤ grantMaxDays, default 7 days), offAtEnd?
  (since 1.5.0) } (grant) } }`:
  * `run`: a button; the sender must be able to run it.
  * `request`: approvers = the members of the chat in the group who may run
    it — `parents` (the Familie plugin's service `family_roles`; without
    Familie, or when it refuses, `rights`), `rights` (every other member), a
    list of ids; without `approvers`/`approverIds` the administrator's default
    (`requestApproversDefault`). None → `no_approver`; Familie's children
    while `childrenMayRequest` is off → `not_allowed`. The push goes to the
    approvers only ("Bittet um: <label>"). Open for `requestTtlMin` (default
    15 min, kept per request).
  * `grant`: the sender lets one member run it until `until`, **as the
    sender** (an automation run). Actions with `needsConfirm` (sensitive, e.g.
    a door) cannot be granted (`not_allowed`). `offAtEnd: true` (a `toggle`
    only, ignored for buttons): when the grant ends the action runs with state
    `off` as the granter, then the system message `grant_off { messageId,
    label, ok, byUserId, toUserId }` ("„Flurlicht“ wurde zum Ende der Freigabe
    ausgeschaltet").
* Message `action`: `{ mode, actionId, plugin, label, icon, needsConfirm,
  approverIds (request), expiresAt (request, since 1.5.0), approvers (request,
  since 1.5.0: "parents"|"rights"|"list"|null), grant: { toUserId, until,
  offAtEnd } (grant), state: "open"|"done"|"denied"|"expired", result: { ok,
  message } | null, by, at, can: { run, approve, deny } }` (`can` for the
  caller). Open requests expire at `expiresAt` (24 h for requests sent before
  1.5.0), grants at `until`. Approving needs the right to run it at that
  moment (`not_allowed` otherwise).
* `POST messages/:id/action/run` (run: anyone who may run it, as themselves —
  an **interactive** run, the target sees a person's tap; grant: the grantee,
  as the granter), `POST …/action/approve` (an approver: runs it as the
  approver, interactive → `done`), `POST …/action/deny` (→ `denied`) →
  `{ message, result: { ok, message, state, error } | null }`. A failed run
  answers 200 with `result.ok: false` and the target's `message` (show it);
  only a successful run posts the system message `action_run { userId,
  messageId, label, mode, asUserId (grant: the granter) }`; a denial
  `action_denied { by, messageId, label, requesterId }`. Approve / deny push
  the requester ("Erledigt: <label>" / "Abgelehnt: <label>"). Confirm
  `needsConfirm` actions in the client before calling run / approve. Event
  `action.update { conversationId, messageId, updatedAt }`.
* **Plugin cards** (`kind: "card"`, from another plugin's `send_message` with
  `card`, `senderId: null`, `via` = the plugin): message `card: { kind:
  "doorbell"|"notice", title, text, image: { mime, bytes } | null, link: {
  label, route, kind } | null, actions: [ { plugin, actionId, label, icon,
  needsConfirm, canRun } ], lastRun: { by, at, ok } | null }`. The picture:
  `GET messages/:id/card/image` → `{ mime, bytes, data (base64) }` (members who
  see the message). A button: `POST messages/:id/action/run { actionId, plugin? }`
  — runs as the person pressing (interactive). `link` (e.g. the door's
  doorbell card: `{ label: "Live-Bild", route: "plg-gatecontrol-door", kind:
  "live_view" }`, set by the server) is a deep link to that app route.
  Push: title "GateControl", body "<title>: <text>", a doorbell card with
  priority high and its picture.
* **Notification cards** (since 1.6.0, `card.kind: "notice"`, `via:
  "gatecontrol-messenger"`): a notification of GateControl's notification
  center the person routed into a chat — see "Notifications in chats".

#### Notifications in chats (since 1.6.0)

GateControl ≥ 1.191.0 lets each person choose per push topic where a
notification appears: **GateControl** (the inbox, the pinned row — default),
the **family chat** (Familie's group, for everyone in it; a household setting
only administrators and Familie's parents may set) or an **own chat** per
source (e.g. "Schule", only for the person). Locked topics (`security`,
`admin_notice`) always stay in the inbox. The settings are GateControl's
(`GET/PUT /api/v1/client/push/routes`, web `/api/v1/me/notify/routes`); this
plugin is the **sink** (`permissions.notifySink: true`) that delivers them.
`GET me` → `features.notices`.

* Hook `deliverNotice(payload)` — GateControl hands over a notification after
  it decided the recipients (subscriptions, mute, quiet hours): `{ id, topic,
  source: "core" | "plugin:<id>", sourceLabel, topicLabel, title, body,
  priority, createdAt, data, imageUrl?, card?: { text ≤ 4000, link?: { label
  ≤ 40, route }, actions? }, family: [userIds], own: [userIds], lang }` →
  `{ covered: [userIds] }`. Whoever is not covered (an error, more than 10 s,
  no family group, an unknown account) gets it in GateControl's inbox instead.
  * `family` → **one** card in Familie's group (`managedBy:
    "gatecontrol-familie"`, key `family`); covered = the ids of `family` who
    are members. No group → none covered.
  * `own` → per person a read-only **notice channel per source** (a group with
    only that person, `readonly`, `managedBy: "gatecontrol-messenger"`, title
    = `sourceLabel`, created on first use and renamed with the source;
    conversation field `notice: { source, label }`), one card there.
  * The same notification id lands at most once per chat (a repeated call
    answers the people it reached the first time; kept 7 days).
* The card (message `kind: "card"`, `senderId: null`): `card: { kind:
  "notice", title, text (card.text, else the body — ≤ 4000, the whole text),
  image: null, imageUrl: "/notify-media/…" | null (the push picture, a
  capability path of the server, valid as long as the push), link: { label,
  route, kind: null } | null (card.link, else the first `open_app_route`
  button), actions: [ { plugin, actionId, label, icon, needsConfirm, canRun } ]
  (the `quick_action` buttons of card.actions / data.actions, ≤ 4, run as the
  presser like every plugin card; other button types are left out), lastRun,
  notice: { source, sourceLabel, topic, topicLabel, priority, data } }`. Head
  of the card: "<sourceLabel> · <topicLabel>" (e.g. "Schule · Nachrichten der
  Schule"); `notice.data` is what a push of that topic carries (route, the
  plugin's own keys, e.g. `schule.messageId` — without the buttons, ≤ 2 KB),
  so a link can open the same screen as the push. Counts as unread.
* Pushed like a chat message: a muted chat stays silent, dnd and an open chat
  as always; title = the source ("Schule"), body "<title>: <text>", priority
  high for `high` / `critical`. In the family group only the people of
  `family` get the push (the others see the card in the chat).
* Hook `mayRouteToFamily({ user })` → boolean: administrators, and Familie's
  parents (service `family_roles`, cached 10 min; Familie missing → false).
  GateControl asks it before a person may set the family chat as a target
  (administrators are allowed without asking).
* Hook `ensureNoticeChat({ user: { id, name, role }, source, sourceLabel,
  lang })` (since 1.7.0, GateControl ≥ 1.192.0) — someone chose **own chat**
  for a topic: the person's notice channel of that source exists from now on
  (the existing one, else created empty — `conversation.update` with `reason:
  "created"` tells the open apps at once) → `{ conversationId, created }` or
  null. GateControl's `PUT …/push/routes` with `dest: "own"` answers it as
  `chat: { source, label, conversationId, created }` (else `chat: null`), so an
  app can say "Chat „Schule“ angelegt" / "… wird verwendet" and refresh its
  list. With GateControl 1.191.0 the channel still comes with the first
  notification.
* Errors go to the Protokoll as `notice_failed` (no content).
* `GET portal/notify-routes` / `PUT portal/notify-routes { topic, dest:
  "inbox"|"own"|"family" }` (feature `notice_routes`: GateControl offers
  `gc.notify.routes`) → `{ sink, canFamily, groups: [ { source, label, topics:
  [ { id, label, dest, locked, familySetBy } ] } ] }` — GateControl's answer
  for the caller (`gc.notify.routes.get / .set` with the caller's id, labels
  in the request's language; the same as GateControl's own
  `/api/v1/me/notify/routes`, which the apps call directly). Refusals: 400
  `invalid` (topic / dest), 404 `not_found` (a topic the person cannot get),
  403 `family_not_allowed` (the family chat — set or lifted — without
  `canFamily`), 409 `locked`, 409 `no_sink`, 409 `routes_off` (GateControl
  without `gc.notify.routes`, or the messenger is not the sink).

#### Live events and pushes since 1.4.0

| type | data | client action |
|---|---|---|
| `poll.update` / `event.update` / `action.update` | `{ conversationId, messageId, updatedAt }` | fetch `messages?changedSince=` |
| `arrival.update` | `{ conversationId, messageId, state, updatedAt }` | the same |
| `status.update` | `{ userId }` | `GET status/feed` (also after a block) |
| `story.new` / `story.remove` | `{ userId, storyId }` | `GET status/feed` |
| `lists.update` / `reminders.update` | `{}` (to one's own devices) | `GET lists` / `GET reminders` |
| `conversation.update` | new reasons `archive`, `pins`, `blocks` | `GET conversations/:id` |

Chat pushes of the new kinds (topic `message`): poll "📊 Umfrage:
<question>", event "📅 Termin: <title>", arrival "📍 Live-Ankunft: <label>",
action "Haus-Aktion: <label>" / "Darf jetzt: <label>" / "Bittet um: <label>"
(approvers only), card see above. Extra pushes carry `data.kind`:
`poll_nudge`, `event_reminder`, `event_departure` (+ `deepLink: "arrival"`),
`arrived`, `reminder` (+ `reminderId`), `action_approved`, `action_denied`,
`reaction` (body "👍 auf: <preview>"), each with `messageId` and
`conversationId` and a `collapse_key` of its own. Preview off → a neutral
body without content. Nobody with an active `dnd` status gets chat pushes
(except own reminders). The daily story digest uses the topic `status`
("Neue Status" / "Anna, Marc haben etwas geteilt", `data.deepLink: "status"`).

#### Encryption and clean-up

Encrypted like message texts: status texts, destination and place, story
texts, poll questions and options, event details, arrival destination and
position, action labels and results, list names, card pictures. Expired
statuses and stories (with their files), polls past `closesAt`, arrivals
after 3 h, open requests after 24 h, ended grants and sent reminders (after 7
days) are handled by the background run (every 60 s); messages that go
(deleted for everyone, disappearing, retention, a deleted plugin group) take
their polls, votes, events, RSVPs, arrivals, actions, card pictures,
reminders, pins and Familie calendar entries along.

## Bridges to other messengers (since 1.12.0; 1.13.0: second stage)

Writing from GateControl to people in **WhatsApp** (also accounts of the WhatsApp
Business app — the same way in, "linked devices"); Signal and Telegram later.
GateControl runs the bridges next to the server and talks to them (`gc.bridges`,
`permissions.bridges` — a **preview** in GateControl, feature-detected: an older
server ignores the key and nothing is offered). This plugin names a network and
a person; it never sees an address, a token or a session key, and keeps no
phone number (migration 006: who confirmed the notes, the parents' grants, which
account is linked with which bridge login id and state).

**These stages** switch the bridges and link accounts. Nothing reads or writes
an outside chat yet — `GET me` keeps `features.bridges: false` until it does.
Since 1.13.0 the portal has the page "Verknüpfte Dienste" (chat settings;
`ui/bridges.js`), offered while `GET me` says `features.linked_services: true`
(a bridge is offered and switched on); the apps have no screen for it yet.

Rules:

* Every person links **their own** account. GateControl refuses a call for
  somebody else (not the plugin in the background, not an administrator).
* Before the first link per network the person confirms the notes (not an
  official client, the service may block accounts, the phone must be online at
  least every 14 days, the end-to-end encryption ends at the bridge).
* **Children** (Familie's `family_roles`) are locked until a parent allows it,
  per child and network. Since 1.13.0 the switches are shown by the Familie
  plugin (≥ 1.23.0, services `bridge_children` / `bridge_child_set`), and
  taking a permission back also **ends the child's link** on that network
  (`gc.bridges.unlinkFor`, a GateControl whose `gc.bridges.version` is ≥ 2 — it
  requires the parent to be acting right now and logs the call; on an older one
  the link stays and the answer says `unlinked: { <network>: false }`). The
  child can always unlink itself. Without Familie nobody is a child.
* Administrators switch the bridges and see states and counts — nothing else.

| Method & path | Body | Answer |
|---|---|---|
| `GET bridges` | | `{ bridges: { available, location: "server", networks: [{ id: "whatsapp", state: "running" \| "starting" \| "failed" \| "unreachable", allowed, lock: null \| "child", consent: ISO \| null, outdated, version, wantVersion (1.13.0: the bridge runs another program version than GateControl pins), logins: [{ id, name, state: "connected" \| "connecting" \| "logged_out" \| "error" \| "unknown", since }] }] } }` — `available: false` (and no networks) while the bridges are off or not offered. `name` is the caller's own account at the service (WhatsApp: their number); with `state: "unreachable"` the last known logins without a name |
| `POST bridges/:network/consent` | `{ accept: true }` | `{ consent: ISO }` |
| `POST bridges/:network/login` | `{ flow: "phone" \| "qr" }` | `{ login: { processId, step } }` |
| `POST bridges/:network/login/:processId/:stepId` | `{ input: { <field id>: text } }` for a `user_input` step, `{}` for `display_and_wait` | `{ login: { processId, step } }`, or `{ login: { processId, waiting: true } }` — the person has not confirmed on the phone yet: call again (the call takes up to 15 s) |
| `DELETE bridges/:network/login/:processId` | | `{ cancelled: true }` |
| `DELETE bridges/:network/logins/:id` | | `{ unlinked: true }` |
| `GET bridges/children` | | parents only: `{ children: [{ userId, networks: { whatsapp: boolean }, linked: { whatsapp: boolean }, newChat: { whatsapp: boolean } }] }` — `linked` (1.13.0): the child has an account linked, never which; `newChat` (1.16.0): new chats by number allowed |
| `PUT bridges/children/:userId` | `{ networks?: { whatsapp: boolean }, newChat?: { whatsapp: boolean } }` | parents only: `{ child, unlinked }` — `unlinked` (1.13.0): per network taken back `true` (the child's link was ended) or `false` (it could not be ended); absent when nothing was linked or allowed |
| `GET admin/bridges` · `PUT admin/bridges` | `{ enabled?, networks?: { whatsapp?: boolean } }` or (1.16.0, alone) `{ newChatPerHour: 1…60 }` | administrators in the admin UI: `{ bridges }` — GateControl's `gc.bridges.status()` plus `linked` per network |

`step`: `{ id, type: "user_input", fields: [{ id, type: "phone_number", optional }] }`,
`{ id, type: "display_and_wait", display: { type: "code" | "qr", data } }` (draw
the pairing code or the QR code from `data`; since 1.13.0 a `qr` display also
carries `matrix: { size, rows: ["0101…"] }`, the code's modules without a quiet
zone) or `{ id, type: "complete", loginId }`.
WhatsApp: `phone` → number → 8-character code to enter under *Linked devices ›
Link with phone number instead*; `qr` → a QR code that must be shown on a second
screen. The texts for the steps are the client's own.

Testing: `tools/testing/mock-bridges.js` stands in for GateControl and for the
bridge (`createHost(dir, { bridges: … })`, `host.bridges.confirm(processId)` …);
`test/bridges.test.js`.

## Chats over a bridge (since 1.14.0)

GateControl with `gc.bridges` version ≥ 3 (a preview) delivers what a linked
account receives at the outside messenger; `server/bridgechats.js` files it
into chats (migration 007) and sends the person's answers out. Without such a
server nothing of this exists.

* A bridged chat is a conversation with **one** member — the linked person —
  and `bridge` set. Nobody else has a member row, so no other member of the
  household and no administrator can read it, gets an event or a push.
* It is listed once it has a message (no history at linking).
* **Clients must say that they know such chats:** every call carries
  `?bridged=1` (or `"bridged": true` in the body — the buttons of a push).
  Without it bridged chats are missing from `GET conversations` and every
  route on one answers `404 not_found` — an app that does not know them would
  show a chat with a deleted account.
* `GET me` `features.bridge_chats: true` only for people who have such a chat
  (an older app shows its "newer version" hint to exactly these people).

`conversation.bridge`: `null`, or `{ network: "whatsapp", label, state: "ok" |
"unreachable" | "logged_out" | "unlinked" | "locked" | "off", closed, supports:
["text", "reply", "reaction", "edit", "delete", "read", "typing"] }` (since 1.15.0 also
files and `mediaTypes` — see below); `peer`
null, `title` the contact's or group's name, `can.send` only with `state: "ok"`
and not `closed`.

`message.bridge`: `null`, or `{ sender: { contactId, name } | null, remote,
state: "pending" | "sent" | "delivered" | "read" | "failed" | null, reason,
placeholder: { kind, name } | null }`. A contact's message has `senderId:
null` and `via: "bridge:<network>"`; `remote` marks what the person wrote in
the messenger's own app; `placeholder` stands for a file or a kind that does
not cross yet (`image`, `video`, `audio`, `voice`, `file`, `sticker`,
`location`, `unsupported`). `status` of an own message: `sending`, `sent`,
`delivered`, `read`, `failed`. `reactions[].contactIds` lists contacts.

| Route | In a bridged chat |
|---|---|
| `POST conversations/:id/messages` | `kind: "text"` only (with `replyTo`); anything else `409 bridge_text_only`, nothing stored. The message goes to the bridge after the commit; the answer carries what became of it |
| `POST messages/:id/resend` | an own message that failed, again → `{ message }` |
| `PATCH messages/:id`, `DELETE messages/:id?for=all`, `PUT messages/:id/reaction` | go to the other messenger first; refused there, nothing changes here |
| `POST conversations/:id/read`, `…/typing` | also told to the other side, for people who share read receipts / typing |
| `PATCH conversations/:id` | `mutedUntil`, `notify` only |

Codes: `bridge_text_only` 409, `bridge_unlinked` 409 (`reason`), `bridge_off`
409, `bridge_unreachable` 503, `bridge_failed` 502 (`reason`), `bridge_locked`
403. There is no queue: with the bridge away nothing is taken.

Events: `message.new` with `bridge`, `message.update` with `status` or
`reactions: true`, `typing` `{ conversationId, userId: null, contacts: [{
contactId, name }], until }`, `read` with `userId: null`,
`conversation.update` reasons `bridge` and `title`. Since 1.19.0 `title` of a bridged chat is never a phone number: a direct chat is named by the person's own address book (Mail, matched by the number at GateControl), else by the bridge's name, else „WhatsApp-Kontakt“ (a group without a name „WhatsApp-Gruppe“); a contact without a name has `name: null`. Push: like a normal chat's,
to the one person; `data.bridge`, `data.sender.id` `"ext-<contactId>"`; the
actions carry `bridged: true` in their body.

In: `gc.bridges.events.pull` → filed in one transaction per batch →
`events.ack`; woken by the hook `bridgeEvents`, and pulled again in every
background run. The bridge's id of a message is unique per chat (`ext_event`),
so an event that arrives twice changes nothing; what arrives before its
message waits in `bridge_pending` (a day). Events for a child without the
parents' permission are dropped. Tests: `test/bridgechats.test.js` against the
mock host's `gc.bridges` version 3 (`tools/testing/mock-bridges.js`).

## Files, pictures and a new chat by number over a bridge (since 1.15.0)

GateControl with `gc.bridges` version ≥ 4 carries files (`server/bridgemedia.js`, migration 008). With version 3
nothing of this section exists: `supports` stays as above and files stay placeholders.

* `GET me` `features.bridge_media: true` — only for the same people as `bridge_chats` (an older app shows its update
  hint to exactly them), and only when GateControl has the API. `features.bridge_new_chat: true` — 1.15.0 the same;
  **since 1.16.0** as soon as the person has a service linked (also without a chat — the first chat can be one they
  start), and only when GateControl can look numbers up.
* `conversation.bridge.supports` adds `"image"`, `"video"`, `"voice"`, `"file"`; `conversation.bridge.mediaTypes`
  `{ image: ["image/jpeg", "image/png", "image/webp"], video: ["video/mp4"], voice: ["audio/ogg", "audio/mp4",
  "audio/aac", "audio/mpeg"], file: null }` — what the bridge takes (WhatsApp: no `audio/webm`; `null` = any type).
* `conversation.avatarMediaId` / `avatarUrl` (portal) — the contact's picture in a direct chat, the group's picture,
  once fetched (load it like a group picture: `GET …/media/<id>`); `message.bridge.sender.avatarMediaId` /
  `avatarUrl` — a contact's picture, fetched once a message of theirs was shown (so it may come with a later
  refresh). A contact's picture belongs to no chat: only the person whose contact it is may load it.

**In.** A contact's picture, video, voice message, file or sticker first is a placeholder with `state: "loading"`
(`message.bridge.placeholder: { kind, name, state: "loading" | "failed" | null, reason, geo? }`), then — after
GateControl's virus scan, `media.scan` as everywhere — a normal message: `kind` `image` (also a sticker), `voice`, or
`file` (a video with `video { durationMs, width, height }`, any other file a download), `text` the caption,
`bridge.placeholder: null`; the live event `message.update` carries `media: true`. `state: "failed"` keeps the
placeholder with `reason`: `too_large` (more than `limits.maxBytes`), `type`, `infected`, `quota`, `gone` (the bridge
lost it), `unavailable` (no answer for days — since 1.19.0 also: refused a few times in a way that is not final). Since
1.19.0 a failed placeholder carries `retry: true` when asking again may help (`unavailable` with its reference kept):
`POST messages/:id/fetch?bridged=1` then fetches it again („Erneut versuchen“; `retry` is missing for other states).
`state: null`: nothing to fetch (a location — then `geo { lat, lon }` —,
an encrypted file, a GateControl without version 4). Older apps see the placeholder as in 1.14.0 and the file once it
is there.

**Out.** `POST conversations/:id/messages` with `kind: "image" | "voice" | "file"` and `mediaId` (and `text` as the
caption, `replyTo`, `meta`, `video`) as in a normal chat — `supports` names it. Refused before anything is stored:
`423 scan_pending` (the virus scan is not finished — send again in a moment), `409 bridge_media_type` (`reason`
`image` | `voice` | `video`: a type the bridge does not take), `422 infected` / `423 scan_blocked` as everywhere.
Location, polls, events, live arrival, home actions, cards, `replyStory` stay `409 bridge_text_only`; a caption is
not edited at the other side (`PATCH` → `409 bridge_text_only`). "Erneut senden" sends the same file again.

**A new chat by number** (`bridge_new_chat`; since 1.16.0 the dialog „Neuer WhatsApp-Chat“ in the portal,
`ui/newchat.js`, and what the apps need for theirs):

| Route | Answer |
|---|---|
| `GET bridges` (1.16.0) | each network adds `newChat: { available, reason, limit: { perHour, left, retryAfterS } }` — `reason`: `null`, `"off"` (GateControl cannot look numbers up), `"unlinked"`, `"child_locked"` (a child, the service locked by the parents, the link still there), `"child_new_chat_off"` (a child without the parents' second switch), `"logged_out"`, `"unreachable"` |
| `POST bridges/:network/resolve { number }` | `{ found, name, avatarUrl, existing }` — is this number at the service (WhatsApp: "on WhatsApp"), under which name. 1.16.0: `existing: { conversationId }` when the person started a chat with this number here before (then without asking the service and without counting), else `null`; `avatarUrl` (portal; the chat's picture when it exists) or `null`. `{ found: false, name: null, avatarUrl: null, existing: null }` when not |
| `POST bridges/:network/chats { number }` | `{ conversation, created }` — the direct chat with this number, made or found (`created: false`); open it with `?bridged=1` as usual. It is listed once something was said in it |

**Show the line** „WhatsApp-Chat mit Nummer“ in „Neuer Chat“ (under „Neue Gruppe“) per network when
`features.bridge_new_chat` and `newChat.reason` is none of `off`, `unlinked`, `child_new_chat_off`. Any other
`available: false` is a state of the dialog: `child_locked` „Von deinen Eltern gesperrt“, `logged_out` „abgemeldet“ →
„Neu verknüpfen“, `unreachable` „Brücke nicht erreichbar“, `limit.left: 0` „Zu viele Prüfungen“ (next check
`retryAfterS` from now). Ask the service only on the button („Prüfen“), never while typing.

`number` with `+` and the country code (spaces, dashes, dots, brackets, a leading `00` are fine; a national `0`
after `+49` is not) — else `400 invalid_number`. The clients normalise first with +49 as the preset (drop a leading
0, spaces and dashes, take a `+` as it is) and show „Wird geprüft als +49 …“; the plugin checks again. Refusals:
`409 bridge_unlinked` (`reason: "unlinked"`), `409 bridge_logged_out` (1.16.0; before `bridge_unlinked` with `reason:
"logged_out"`), `403 bridge_locked` (a child, the service locked), `403 child_new_chat_off` (1.16.0: a child without
the second switch — answers in existing chats are not affected), `503 bridge_unreachable` (also after 15 s without an
answer), `409 bridge_off`, `403 feature_off` (GateControl without the lookup), `429 rate_limited` with `retryAfterS`
and (1.16.0) `perHour`. `chats`: `404 not_found` with `reason: "not_on_network"`.

**The limit** (1.16.0): `newChatPerHour` checks per person and hour (preset 10; the administrator sets 1–60 in the
card „Brücken“: `PUT admin/bridges { newChatPerHour }`, `GET admin/bridges` → `newChat: { available, perHour, min,
max }`); GateControl's own limit of 20 an hour stays. Not counted: invalid numbers, a chat that exists, a bridge that
does not answer, GateControl's own refusals, and „Chat starten“ for a number found in the last 15 minutes (kept in
memory as a keyed hash, never the number). Before 1.16.0: 10 numbers in 10 minutes, every call counted.

**The number** is never logged — neither by the plugin nor by GateControl — and the apps must not log it either.
Kept only once the person starts the chat, and only as a keyed hash (HMAC with a key derived from the plugin's own
key, migration 009 `conversations.bridge_num`) to find that chat again; deleted when the person (or a parent) unlinks
the service. Of the bridge's answer only the name goes on.

**Children** (1.16.0): the parents' second switch per child and network, „Neue Chats per Nummer“, default off and only
next to the permission itself (taking the permission back clears it). Shown by Familie ≥ 1.25.0 in its card „Andere
Messenger“: `bridge_children` answers `newChat: true` (this GateControl can look numbers up) and each child's
`newChat: { whatsapp }`; `bridge_child_set` takes `newChat: { whatsapp }` next to or instead of `networks` (`invalid`
without the permission). The same in the app API: `GET bridges/children` / `PUT bridges/children/:userId { newChat }`.
An older Familie never sends it: children stay without new chats by number.

Tests: `test/bridgemedia.test.js`, `test/newchat.test.js` (1.16.0) against the mock host's `gc.bridges` version 4.

**Older history, the phone, where the files lie** (`bridge_history`, since 1.17.0, GateControl with `gc.bridges`
version 5; `server/bridgehistory.js`):

| Route | Answer |
|---|---|
| `GET bridges` | adds `history: { available, days, default, options, pending } \| null` — `days` `0` (off), `30` (default), `-1` (everything the bridge brings); `available: false` while the administrator switched it off, `null` on a GateControl without history. Each network adds `phone: { offline, days, leftDays }` (the bridge's warning: the phone was not seen for `days` ≥ 12 days; WhatsApp ends the link after about 14) and `clientOutdated` (WhatsApp refuses the bridge's version — show „Brücke veraltet“ like `outdated`) |
| `PUT bridges/history { days }` | `{ history }` — `days` one of `0`, `30`, `-1`, else `400 invalid`; `403 feature_off` without history. It counts at a link; fewer days drop what still waits |
| `POST messages/:id/fetch?bridged=1` | `{ message }` — a file of the history (placeholder `state: "on_request"`), or since 1.19.0 one that failed with `retry: true`, is fetched now: the placeholder becomes `loading`, later the file arrives as usual (`message.update { media: true }`). Only the person of the chat; `400 invalid` when there is nothing to ask for |

**Filed at night:** the plugin files the history GateControl hands over in its night window (card „Brücken“,
`historyFrom` / `historyTo`, default 01:00–05:00 in the time zone of GateControl's update window), 100 events a minute,
one transaction each. Such messages come **without push and without `message.new`**, already read; each chat that got
some sends one live event `conversation.update { reason: "history" }` — reload the chat's messages then (they sit at
their own time, `createdAt`, before the newer ones; `messages?changedSince=` finds them by their `updatedAt`). History
GateControl hands over before a new message of the same chat comes in the normal stream, the same way.

**The phone warning** reaches the person once per time as a push of the topic `bridge` („Verknüpfte Dienste“, `data:
{ deepLink: "bridges", bridge: "whatsapp" }`); show `phone.offline` in „Verknüpfte Dienste“ under the service:
„Handy seit {days} Tagen nicht gesehen …“.

**Files** of bridged chats (and the pictures of their chats and contacts) lie in the sealed media area `bruecken`
(`plugin.json` `media.areas`): the administrator chooses its storage target under Einstellungen › Plugins › Messenger ›
Speicherorte. Nothing changes for the apps.

Admin (card „Brücken“): `GET admin/bridges` adds `history: { available, enabled, default, options, pending, from, to,
timeZone, conversations, messages }`, `backup: { time, timeZone, lastAt, bytes, requested, error, restore }`, `cleanup:
{ deleted, waiting, lastAt, error }`, `media: { target, bytes, count, state, moving, encrypted }` and per network
`phoneOffline` (how many people) and `clientOutdated`. `PUT admin/bridges` takes `{ history }`, `{ historyFrom,
historyTo }` (`HH:MM`), `{ backupNow: true }`, `{ backupTime }`.

Tests: `test/bridgehistory.test.js` against the mock host's `gc.bridges` version 5.

**„Neuer Chat“ with contacts** (`bridge_contacts`, since 1.18.0, GateControl with `gc.bridges` version 6;
`server/contactchat.js`, migration 011; Mail ≥ 1.16.0 for the address book):

| Route | Answer |
|---|---|
| `GET contacts/new-chat?q=&network=whatsapp` | `{ network, query, gatecontrol, whatsapp, addressBook, addressBookReason?, number, numberEntry, limit }` — the three sections of „Neuer Chat“ › Person (below) |
| `POST bridges/:network/chats { ref }` | `{ conversation, created }` — a WhatsApp contact of the list: the chat at once, nothing checked, nothing counted. `409 contact_expired`: the reference ran out (30 minutes, or GateControl restarted) — load the list again |
| `POST bridges/:network/chats { contactId, phoneKind }` | `{ conversation, created }` — a number of the address book (`contactId` of `addressBook.items`, `phoneKind` its `key`): exactly this number is asked at the service, counted in the brake. `404 not_found` with `reason: "not_on_network"` (and `remembered: true` when the answer came from what was remembered — nobody asked, nothing counted), `reason: "contact_gone"` (no such contact or number any more — reload), `409 mail_missing`, `429 rate_limited` (`retryAfterS`, `perHour`), the refusals of `{ number }` |

The sections (`null` = leave it out):

* `gatecontrol: [{ userId, name, avatarUrl, initials, colorHex, conversationId }]` — the accounts as `GET people`;
  `conversationId` of a direct chat with a message („Chat öffnen“), else start it with `POST conversations`.
* `whatsapp: { state, items, total } | null` — `null` when nothing is linked, the bridge or this GateControl cannot,
  a child is locked or has no second switch. `state` `"ok"`, `"unreachable"` („WhatsApp-Kontakte gerade nicht
  verfügbar“), `"logged_out"` („WhatsApp ist abgemeldet“ → „Neu verknüpfen“). `items: [{ ref, name, avatarMediaId,
  avatarUrl, conversationId, alsoInAddressBook, addressBookId }]`, sorted by name — **never a number**. `ref` starts the
  chat; `avatarMediaId` (apps) / `avatarUrl` (portal) only when GateControl already fetched that contact's picture;
  `alsoInAddressBook`: the same number is in the person's address book (merged on the server, `name` is then the
  address book's) — show „auch in deinem Adressbuch“.
* `addressBook: { state, items, total } | null` — the person's own contacts with a number (Mail's service
  `contacts_phones`), without those merged into WhatsApp; `null` without Mail, contacts switched off, no place in Mail,
  no contact with a number, or without the WhatsApp section (`addressBookReason`: `no_mail`, `feature_off`, `no_seat`,
  … when Mail refused). `state` follows WhatsApp: not `"ok"` → show, but not tappable („Antippen geht wieder, sobald …“).
  `items: [{ contactId, name, conversationId, phones: [{ key, kind: mobile | work | home | other, number, e164,
  landline, notOnNetwork }] }]` — the numbers are the person's own, so they go to the apps; mobile numbers first,
  landlines last (grey, still choosable). `notOnNetwork`: remembered „nicht bei WhatsApp“ (30 days).
  `conversationId`: a chat started here with one of its numbers („Chat öffnen“, no question to WhatsApp).
* `number: { e164, show, conversationId } | null` — the search looks like a phone number: the last line „<show> bei
  WhatsApp prüfen“ → the number dialog of 1.16.0 with it (checked only when tapped).
* `numberEntry` — show „Nicht dabei? Nummer eingeben“ (the number dialog). `limit` as `GET bridges` `newChat.limit`.

The search `q` (≤ 100 characters) goes through all sections (GateControl by name, WhatsApp by the bridge's search,
the address book by name, company and digits). Nothing goes to WhatsApp while listing or searching: the WhatsApp list
is the bridge's own contact store, merging compares numbers with it on the server (`gc.bridges.matchNumbers`).
**The brake** is the one of 1.16.0 (`newChatPerHour`, preset 10): a tapped address book number counts like a typed
one; WhatsApp contacts, „Chat öffnen“, merged contacts and remembered answers do not. **„nicht bei WhatsApp“** is
kept 30 days as the address book contact's id, the kind of number and the date — never the number (table
`bridge_not_on`); unlinking the service deletes it. The protocol notes „WhatsApp-Nummer geprüft · Quelle Adressbuch ·
gefunden / nicht gefunden“ (`bridge_number_checked`, level `info`) without number and name.

Tests: `test/contactchat.test.js` against the mock host's `gc.bridges` version 6.

## Channels, read-only groups, format and link previews over a bridge (since 1.20.0)

Needs GateControl with `gc.bridges` version 7 (`features.bridge_channels`, for the same people as `bridge_chats`;
`server/bridgechannels.js`, migration 012). Tests: `test/bridgechannels.test.js` against the mock host's version 7.

**Channels** (a WhatsApp channel the person follows) are bridged conversations with `bridge.channel: true`
(`kind: "group"`). A client that knows them sends `?channels=1` (next to `?bridged=1`) on its calls:

| Route | Answer |
|---|---|
| `GET conversations?bridged=1&channels=1` | as before, **without** channels — so they are not in „Ungelesen“ or the badge — plus `channels: { count, unread }` (channels with a post; `unread` = new posts) for the TV symbol and its grey dot |
| `GET channels?bridged=1&channels=1[&since=]` | `{ channels: [conversation], removed, unread, serverTime }` — the page „Kanäle“, newest post first |

Without `?channels=1` channels stay in `GET conversations` as before (read-only chats). Everything else (messages,
read, PATCH `notify`, reactions) works on a channel like on any bridged chat.

Conversation fields: `bridge.channel`, `bridge.readOnly` (a channel, or a group where only admins write),
`bridge.reactions` (channels only: `"own"` — the person's own reaction; `"off"` — the bridge refused one, reacting in
channels of this network is off until the bridge runs another version), `can.sendReason` (`"channel"` |
`"admins_only"` | `null`), `can.react`. A channel is created muted (`me.notify: "none"`, `muted: true`): the bell is
`PATCH conversations/:id { notify: "all" | "none" }`. Its push: title „<Kanal> · Kanal über WhatsApp“, `data.channel:
true`, only the action `mark_read`. Sending into a channel or an admins-only group: `409 bridge_read_only` with `reason`
`channel` | `admins_only`; reacting in a channel while off: `409 bridge_read_only` `reason: "reactions_off"`.

Message fields (bridged chats; `null` elsewhere):

* `marks: [{ type: "bold" | "italic" | "strike" | "code" | "link", start, end, url? }] | null` — offsets in UTF-16 code
  units of `text` (JavaScript string indices; Kotlin `String` indices are the same), `end` exclusive, may nest; `url`
  only http(s). Render as text with spans, never as HTML. Plain addresses in the text carry no mark: clients make
  http(s) and `www.` addresses clickable themselves, in every chat.
* `preview: { url, title, description, site, image: { mediaId, url, mime, w, h, state: "loading" | "failed" | null } |
  null } | null` — a link preview on top of the bubble (tap → open `url`). `image.mediaId` loads like any file of the
  plugin (`url` only for the portal).
* `bridge.channel: true` — a post written by the channel (`bridge.sender` is `null`; show no sender name).

`message.update { media: true }` follows when a preview's picture arrived. `conversation.update { reason: "bridge" }`
when a chat turned out to be a channel, an admins-only group opened or closed, or reacting in channels went off.

## WhatsApp status in the status row (since 1.25.0)

Needs GateControl with `gc.bridges` version 12 (`chat.status`; `features.bridge_status` once the person linked WhatsApp;
`server/bridgestatus.js`, migration 015). Tests: `test/bridgestatus.test.js` against the mock host's version 12. With an
older GateControl the room "WhatsApp Status Broadcast" stays a chat as before.

The bridge keeps the contacts' status updates in a room of their own. Its conversation (`bridge_status = 1`) is **never a
chat**: not in `GET conversations` (nor in `?channels=1`, search, unread, filters), every route answers `not_found`,
muted, no push, no `message.new`, never a read receipt from `POST conversations/:id/read`. Each status runs out 24 h
after it was posted (`expires_at`; the file goes with it), a deletion of the contact removes it at once.

| Route | Answer |
|---|---|
| `GET status/feed` | as before, plus `bridged: [{ network, contact: { id, name, avatarMediaId, avatarUrl }, chatId, canReply, stories: [{ id, kind, text, mediaId, thumbMediaId, video, url, thumbUrl, createdAt, expiresAt, seen }], unseen }]` — one entry per contact, unseen first, then the newest. `kind`: `text` (no colour or font: WhatsApp does not pass them on — the apps use their own colour), `image`, `video` (caption in `text`), `unsupported` ("open it in WhatsApp"). A status whose file is still on its way is left out until it is there. `chatId`: the WhatsApp direct chat with the contact, when known (since 1.25.2 also by the bridge's contacts). `contact.name` (since 1.25.2): the person's address book, else the direct chat's name, else the bridge's contacts, else the contact's public name — never a number or only punctuation („.“), else „WhatsApp-Kontakt“; `contact.avatar*`: the direct chat's picture, else the contact's. Older clients read `items` only (their entries need an account) |
| `POST status/bridged/:id/seen` | `{ seen: true, reported }` — watched here (the ring turns grey). WhatsApp is told (`reported: true`) only with `prefs.privacy.bridgedStatusSeen` on (default off) and `readReceipts` on, and only up to the newest status before which every status in the room was watched too — the bridge marks everything up to the message it is told, for every sender |
| `POST status/bridged/:id/reply` | `{ text, clientId? }` or `{ emoji, clientId? }` → `{ message, conversationId, emoji? }` — a normal message into the WhatsApp direct chat with the contact (found by the contact, else by the bridge's contacts — opened when needed); an emoji as the text "❤️ auf deinen Status" (the bridge refuses reactions on a status). `not_found` with reason `no_chat` when there is no way to the contact; the bridge's refusals as for `POST conversations/:id/messages` |

`PUT prefs { privacy: { bridgedStatusSeen: boolean } }` — "WhatsApp mitteilen, wenn ich einen Status ansehe". Live event
`story.bridged { network, storyId, action: 'new' | 'seen' | 'remove' | 'contact' }` → load the feed again (since 1.25.2 `contact`: a sender's picture arrived; clients load the feed on any action).

## Old media from the phone (since 1.26.0)

Needs GateControl with `gc.bridges` version 13 (`message.oldMedia`, `edit.media`, `status().mediaRequests`). Tests:
`test/oldmedia.test.js` against the mock host's version 13. With an older GateControl an old WhatsApp file stays the
placeholder "not shown here yet" (GateControl 1.294.x sends the bridge's notice as a notice).

A WhatsApp file of the history whose copy at WhatsApp ran out (only the phone still has it) is a placeholder of its kind
with **`bridge.placeholder.old`**: `off` (nobody asks the phone — open it in WhatsApp), `daily` (the bridge asks the phone
once a day), `now` (asked at once), `failed` (the phone could not send it). For apps that do not know `old` the
placeholder also carries a state they already show: `off` → `state: "failed"`, `reason: "gone"`; `daily` / `now` →
`state: "loading"`; `failed` → `state: "failed"`, `reason: "unavailable"` — `retry` is always `false` (there is nothing
to ask for again here). The caption is the message's `text`. When the phone sent the file, the placeholder becomes a
normal picture / voice message / file like any other file of a bridge (`message.update { media: true }`, virus scan).

The portal's line: „Ältere Sprachnachricht – öffne sie in WhatsApp“ / „… – wird später vom Handy geladen“ / „… –
wird geladen“ / „… – kam vom Handy nicht; öffne sie in WhatsApp“ (texts `bc.old.<kind>`, `bc.old_it.<kind>`,
`bc.old_<state>`).

**Admin** (card „Brücken“): `GET admin/bridges` → `mediaRequests: { mode: "off" | "daily" | "now", options, dailyAt,
timeZone }` (GateControl's); `PUT admin/bridges { mediaRequests }` (`feature_off` before version 13). The switch „Alte
Medien vom Handy nachladen“ with „Einmal am Tag (empfohlen)“ / „Sofort“. Once a day means about 8 hours after the
bridges' nightly backup (`dailyAt`) — the pinned bridge knows no time zone of a login, so it cannot be set to a time of
night (GateControl's docs/feature-messenger-bridges.md, "Old media from the phone").

## Versandweg, location over a bridge, place messages (since 1.27.0)

`features.placeMessages: true` (GET me). `server/persons.js` (`replyPref`), `server/bridgechats.js` (location),
`server/placemsgs.js`, migration 016. Tests: `test/versandweg.test.js` against the mock host's `gc.bridges` version 14.
A location over a bridge needs GateControl with `gc.bridges` version 14; with an older one it stays refused as before
(`bridge_text_only`), everything else works with any GateControl that runs 1.26.0.

**„Nachrichten senden über“ (replyPref).** Every `person` (list entry, `GET persons/:id`, answers of changes) carries
`replyPref`: `"auto"` (default) | `"gatecontrol"` | a network (`"whatsapp"`, `"signal"`, `"telegram"`) and `reply`
`{ way, label, conversationId, fallback? }`.

| Route | Answer |
|---|---|
| `PUT persons/:id { replyPref }` (also `PATCH`; `null` = `"auto"`) | `{ conversation, person }` — only one's own person (`404` otherwise); `400 bad_request` when the person has no such way, `400 invalid` when it is no word; `conversation.update { reason: "person", personId }` to the own devices |

`person.reply`: `replyPref` ≠ `auto` and that way can send → that way; it cannot send (bridge away, logged out) → the
chat inside GateControl with `fallback: true` (only when the person has one; else as `auto`); `auto` (or a way the
person no longer has) → as before (the way of the newest incoming message, a tie and none: GateControl). `POST
persons/:id/messages` without `replyTo` goes over `person.reply`; with `replyTo` still over the way of that message.

**Location over a bridge.** With `gc.bridges` version 14 a bridged conversation's `bridge.supports` contains
`"location"` when its network's bridge sends one (`status().networks[].location` — WhatsApp and Telegram; never
Signal). Then `POST conversations/:id/messages { clientId, kind: "location", location: { lat, lon, label?, accuracy? },
replyTo? }` (or `POST persons/:id/messages`) goes out as a real location (`gc.bridges.send(…, { txnId, location: { lat,
lon, label }, replyTo })`, m.location); no `text`, no file. Without it: `409 bridge_text_only` (`reason: "kind"`).
An incoming location (GateControl's media `{ kind: "location", geo }`) is a normal message of **kind `location`**:
`location: { lat, lon, label }` (label = the caption without the bridge's „Location:“; a bare geo URI or link is no name →
`null`), `text: null`, `bridge: { sender, …, placeholder: null }`; the push says „Standort: <label>“. A location without
valid geo stays the placeholder of before. Live locations are not followed (only the first point).

**Place messages** („Beim Ankommen senden“). A rule of one person, watched by one phone (`deviceId`); the server never
learns where the person is — the place is stored sealed for the phone, and only the finished text goes out.

| Route | Answer |
|---|---|
| `GET place-messages` | `{ placeMessages: [placeMessage] (newest first), limits: { activeMax: 10, textMax: 1000, nameMax: 80, radiusMinM: 100, radiusMaxM: 2000, radiusDefaultM: 150, everyS: 3600, lateS: 1800 }, serverTime }` |
| `POST place-messages` | body below → `{ placeMessage }`; `409 limit` with 10 active (enabled, not done) |
| `PUT place-messages/:id` (also `PATCH`) | any field of the body → `{ placeMessage }`; `enabled: true` starts it afresh (`doneAt: null`, `limit` counts) |
| `DELETE place-messages/:id` | `{ deleted: true, id }` |
| `POST place-messages/:id/fire { at, deviceId }` | `{ placeMessage, message, duplicate, way, conversationId }` — the text goes out now like a message from the composer, marked `meta.placeMessage { name, trigger }` (never coordinates) |

Body: `{ deviceId: "[A-Za-z0-9._:-]{1,128}", trigger: "enter" | "exit", place: { familieId?, name (1–80), lat, lon,
radiusM? (100–2000, default 150) }, text (1–1000), conversationId, way?: "auto" (default) | "gatecontrol" | network,
repeat?: "once" (default) | "always", window?: { days: [1–7 (Mo = 1)], from: "HH:MM", to: "HH:MM" } | null, ask?:
true (default), enabled?: true (default) }`. `conversationId`: a chat the person may write into (`403 readonly` for a
channel, a read-only group, a notice channel; `404` for a chat that is not theirs) or any way of a person (stored as the
person's lead) — then `way` is `auto` or one of the person's ways, for a chat that is no person `auto` or its own way
(`400 bad_request` otherwise). `familieId`: the id from `GET familie/places` (a number or a short word), kept for the
picker only. The phone checks `window` and `ask`; the server does not know the phone's time zone.

`placeMessage`: `{ id, deviceId, trigger, place: { familieId, name, lat, lon, radiusM }, text, conversationId, way,
repeat, window, ask, enabled, lastFiredAt, doneAt, createdAt, updatedAt, target: { title, personId, reply } }`
(`target.reply` = the person's current `reply` while `way` is `auto`).

`fire`: `at` (ISO) is when the phone reached / left the place. Where it goes: a person with `way: "auto"` → `person.reply`;
a fixed way → that way while it can send, else the chat inside GateControl; a chat → that chat. Refusals: `403
not_allowed` (another `deviceId` than the stored one — change it with PUT when the phone changes), `409 closed`
(switched off, or `once` and done), `409 expired` (`at` more than 30 minutes ago), `409 too_soon` (less than an hour
after the last firing), `400 invalid` (`at` missing or more than 5 minutes ahead), and those of sending a message
(`readonly`, `blocked`, `bridge_*` …). The same `at` again → `duplicate: true`, the same message, nothing changes
(`clientId` `place-<id>-<at ms>`). Afterwards `lastFiredAt = at`; `once` → `doneAt`, `enabled: false`.

A message sent this way has `placeMessage: { name, trigger }` in the **sender's** view only (`null` for everybody else;
over a bridge only the text crosses). „Zurücknehmen“ is `DELETE messages/:id?for=all` as for any own message.

Live event `place_messages.changed { id, reason: "created" | "updated" | "deleted" | "fired" }` to the person's own
devices (GateControl takes lower-case event types only). A place message whose chat went is deleted by the clean-up.

## Persons — one chat per human over several ways (since 1.21.0)

`features.chat_people` (for the same people as `bridge_chats`; `server/persons.js`, migration 013). A client that knows
persons sends `?people=1` next to `?bridged=1` (in a body `people: true`). Suggestions need GateControl with `gc.bridges`
version 8 (`matchAccounts`), the question at the link version 9 (`recognition`); merging by hand works from version 3.
Only in the view of the person who merged: nothing of it reaches the other side; the messages stay in their
conversation, so „Trennen“ loses nothing. Groups and channels are never merged. Tests: `test/persons.test.js`.

| Route | Answer |
|---|---|
| `GET conversations?…&people=1` | one entry per person: the view of its lead conversation (the chat inside GateControl, else the oldest way) with the person's `title`, picture (`avatarUrl` / `avatarMediaId` of the way the name comes from, else of another), `unread` of all ways, the newest `lastMessage` of any way, `archived` (every way) and `person`; `folded: [id]` — the ways that left the list |
| `GET conversations/:id` (any way) | + `person` — the app opens the person (`person.conversationId`) |
| `GET persons/:id` | `{ conversation (the entry), person }` |
| `GET persons/:id/messages?before=\|after=\|around=\|changedSince=&limit=&way=` | `{ messages (ascending by time), hasMore[, hasMoreBefore, hasMoreAfter], ways: [{ conversationId, way, lastReadId, readUpTo, deliveredUpTo }], serverTime }` — all ways mixed by time; cursors are message ids of any way; `way=gatecontrol \| whatsapp` filters |
| `POST persons/:id/messages` | body as for a conversation → `{ message, duplicate, way, conversationId }` — the way of the newest incoming message (a tie and none: GateControl; a bridged way that cannot send gives way to GateControl); with `replyTo` the way of that message |
| `POST persons/:id/read { upTo? }` | `{ unread, ways: [{ conversationId, way, lastReadId, unread }] }` — every way up to the time of `upTo` (without: all) |
| `GET persons/:id/search?q=&way=` | `{ results (newest first), scanned, truncated }` over the ways |
| `PATCH persons/:id { name?: "account" \| <conversationId>, notify?, mutedUntil?, replyPref? }` | `{ conversation, person }` — the name, mute and notifications for every way; since 1.27.0 `replyPref` („Nachrichten senden über“) |
| `POST persons/:id/archive { archived }` | `{ conversation, person }` |
| `POST persons { conversationIds: [id…], userId?, name? }` | `{ conversation, person }` — merges (chats that belong to a person bring it along; the chat with the account is made when there is none, without a message). `409 cannot_merge` with `reason` `group` \| `channel` \| `not_direct` \| `two_accounts` \| `one_way` |
| `DELETE persons/:id/ways/:conversationId` / `DELETE persons/:id` | `{ person \| null, conversations }` — „Trennen“ (a person with one way left is dissolved); that account and way are not suggested again |
| `GET persons/suggestions` | `{ suggestions: [{ id, conversationId, userId, network, label, strength, via, contact: { name, avatarUrl, avatarMediaId }, account: { name, avatarUrl, initials, colorHex }, text, reason, lastMessageAt }] }` — strong first; `gc.bridges.matchAccounts` at most every 10 minutes per person and network |
| `POST persons/suggestions/:id { action: "later" \| "never" }` | `{ suggestion: { id, state, until } }` — „Nicht jetzt“ (7 days), „Nicht mehr vorschlagen“ |
| `GET persons/candidates?conversationId=` | `{ accounts: [{ userId, name, avatarUrl, initials, colorHex, personId }], chats: [{ conversationId, title, network, label, avatarUrl, avatarMediaId, personId }] }` — „Mit Person zusammenführen …“ |
| `GET bridges` → `recognition` | `{ available, network, asked, allowed } \| null` — „Dürfen andere auf diesem Server dich an deinem WhatsApp erkennen?“ (the profile's consent), asked once after WhatsApp was linked |
| `PUT bridges/recognition { allowed }` | `{ recognition }` (`403 feature_off` without `gc.bridges` version 9) |

1.23.0 — Signal (GateControl with `gc.bridges` version 10; see `apps-contract-7a` in the release notes):

| Call | Answer |
|---|---|
| `GET bridges` → `networks[]` | + `flows` (`["qr"]` for Signal — the only way in; missing on an older server: both), `history { maxDays, phoneConfirms }` (Signal: `30`, `true` — once at the link, the phone asks), `recognition { available, asked, allowed } \| null` (the consent of this network), `handoff` |
| `GET bridges` → `handoff` | `{ network, target, expiresAt } \| null` — an open „am PC fortsetzen“ of this person |
| `PUT bridges/recognition { allowed, network? }` | `{ recognition, recognitions: { whatsapp, signal } }` — `network` missing: `whatsapp`; another network needs `gc.bridges` version 10 (`403 feature_off`) |
| `POST bridges/:network/handoff { target: "portal" \| "windows" }` | `{ handoff: { network, target, expiresAt, portalPath } }` — the phone cannot scan its own screen: the step on a second screen (10 minutes); a live event `bridge.handoff { network, target, expiresAt }` to the person; only for a network that links by QR code, after the notes (`409 consent_required`) |
| `DELETE bridges/:network/handoff` | `{ handoff: null }` (also over at a completed link) |
| `PUT admin/bridges { animatedStickers }` | the admin view with `stickers { animated }` — one switch for every bridge that converts animated stickers (off: a still picture); `403 feature_off` before version 10 |

A Signal chat: `conversation.disappearingS` is the chat's timer at Signal (any length; `can.setDisappearing` false —
nothing runs out here, the bridge deletes), its change a system message `{ event: "disappearing", by: null, seconds,
network }`; a view-once picture `bridge.placeholder.kind: "view_once"` (no file).

1.24.0 — Telegram (GateControl with `gc.bridges` version 11; see `apps-contract-7b` in the release notes):

| Call | Answer |
|---|---|
| `GET bridges` → `networks[]` | + `needs` (`"app"`: Telegram is not set up — an administrator enters the application id; `"script"` / `"compose"`: the server is too old; missing: nothing); Telegram's `flows` `["qr", "phone"]` |
| `POST bridges/telegram/login { flow: "phone" }` | a `user_input` step with a field `phone_number`; then `2fa_code`; then (two-step verification) `password` — each sent as `{ input: { <field id>: value } }` to `…/login/:process/:step`; a wrong code or password: the same kind of step again with `retry: true`. Nothing of it is kept |
| `PUT admin/bridges { telegramApp: { apiId, apiHash } \| null }` | the admin view with `telegramApp { set, setAt, setBy }` — alone in its request (`400 invalid` with other keys), `403 feature_off` before version 11; the values only pass through |
| `GET admin/bridges` | + `telegramApp { set, setAt, setBy }` |
| service `bridge_children` / `bridge_child_set` | + `channels: ["telegram"]`, per child `channels { telegram }` — „Telegram-Kanäle“ (default off, only next to the permission) |

A Telegram chat: `bridge.bot: true` (a bot), `bridge.members` (a group's member count; 200 and more: created muted); a
Telegram channel is a channel (`bridge.channel`); a message's `bridge.buttons: true` — „Diese Nachricht hat Knöpfe. Öffne
sie in Telegram.“ (not sent by the pinned bridge yet); a file too large for GateControl: `bridge.placeholder { kind:
"file", state: "failed", reason: "too_large" }`. A child without „Telegram-Kanäle“ gets no Telegram channel.

`person`: `{ id, name, nameFrom: "account" | <conversationId>, userId, conversationId (the lead), names (every name — the
search finds each), ways: [{ way, label, conversationId, title, avatarUrl, avatarMediaId, unread, muted, archived,
lastMessageAt, bridge, can: { send, sendReason, react } }], reply: { way, label, conversationId }, createdAt }`. With
`?people=1` every message carries `way` (`gatecontrol` or the network). Mute, notifications and archive of one way are
copied to the others (also after `PATCH conversations/:id` / `POST …/archive` of a way). Pushes of a way: „<Name> · über
WhatsApp“ / „<Name> · über GateControl“ (without previews: as before), `data.person: { id, conversationId }`. Live: the
events of the ways as before; `conversation.update { reason: "person", personId }` when a person was merged, renamed or
split — load the list again. The Mail address book as a hint („Adressbuch verbindet beide“) is not built: it needs the
e-mail address of the account, which plugins do not get.

## Services (for other plugins)

`gc.services.call({ plugin: 'gatecontrol-messenger', service, userId?, payload })`
(caller lists `"gatecontrol-messenger:<service>"` in `permissions.services`):

* `sync_group` `{ key: "family", title, userIds }` → `{ ok, conversationId,
  created, added, removed, ignored }` — creates/updates the caller's managed
  group `key` (`[a-z0-9_-]{1,32}`): title and exactly these members (enabled
  accounts; unknown ids are ignored and listed). Members cannot change the
  members, title or picture in the messenger, nor leave; they can mute it and
  set disappearing messages.
* `send_message` `{ conversation, text (1…4000), title? }` → `{ ok,
  conversationId, messageId }` — a system message from "GateControl"
  (`senderId: null`, `via` = caller, `system.event: "notice"`), pushed like a
  message. `conversation`: `"family"` (the caller's managed group `family`),
  `"group:<id>"` (a group the caller manages, or one the calling `userId` is a
  member of), `"user:<id>"` (the caller's notice channel for that person —
  created on first use, only that person, read-only, named `title` or
  "GateControl"), since 1.5.0 `"direct:<id>"` (the direct chat between the
  calling `userId` and that person, found or created; needs `userId`, never
  the user themselves, `forbidden` when either blocked the other — e.g.
  Familie's shopping request from the person who asks; shown "via" the plugin).
  * **Several targets** (since 1.1.0): `conversation` may be an array of 1…20
    such strings (duplicates dropped), e.g. `["user:3", "user:7", "family"]` —
    one call (one of the host's 60 per hour), one message per target, each
    target on its own (a refused target does not stop the others) → `{ ok: true,
    sent, failed, results: [ { conversation, ok: true, conversationId,
    messageId } | { conversation, ok: false, code } ] }` in the given order.
    An empty array, more than 20 or a non-string entry → `{ ok: false, code:
    "invalid" }` for the whole call. The single form is unchanged. A messenger
    1.0.x answers an array with `{ ok: false, code: "invalid" }` — callers fall
    back to one call per target.
* `release_group` `{ key, delete?: false, adminIds?: [ids] }` (since 1.1.0) →
  `{ ok, conversationId, released, deleted, admins }` — hands the caller's
  managed group `key` back:
  * `delete: false` (default): it becomes a normal group (`managedBy` null) —
    members may leave, change title and picture; `adminIds` (those who are
    members) become admins, without any the member who joined first; the
    history stays, a system message `released` and `conversation.update`
    (`reason: "released"`) tell the members. `admins` lists the new admins.
  * `delete: true`: the group is deleted for everyone — its messages, files and
    picture are removed for good, the members get `conversation.remove` (and
    the chat under `removed` in `GET conversations?since=`).
  * Either way the key is free again: a later `sync_group` with it creates a
    new group. No such group of the caller → `not_found`.
* `send_message` with `card` (since 1.4.0): `{ conversation, card: { kind:
  "doorbell"|"notice", title (1…80), text? (≤ 500), imageBase64? (JPEG or
  WebP, ≤ 300 KB — GateControl 1.180.0 takes service payloads up to 512 KB),
  actions?: [ "<id>" (a quick action of the caller, e.g. the door's
  `"<lockId>:open"`) | "<plugin>/<id>" ] (≤ 4, ids `[A-Za-z0-9:._-]{1,64}`),
  link?: { label (≤ 24), route (an app route: plg-<id>, vpn, services,
  gateways, inbox) } } }` (`text` of the call may be left out) → a message
  `kind: "card"` (see "Home actions and plugin cards"). A bad picture or
  anything else out of range → `{ ok: false, code: "invalid" }` (the door then
  sends again without the picture). A doorbell card of `gatecontrol-door`
  without `link` gets `{ label: "Live-Bild", route: "plg-gatecontrol-door",
  kind: "live_view" }`. `conversation: "family"` (since 1.4.0): a caller
  without its own managed group `family` reaches the group "Familie" of
  `gatecontrol-familie` (e.g. the door's doorbell card).
* `set_place_status` `{ userId, place: string (≤ 80) | null }` (since 1.4.0,
  only from `gatecontrol-familie`, the user in the payload) → `{ ok, applied }`
  — Familie's presence ("Zuhause", "Schule", …). Shown only while that
  person's status preset is `auto_place` (`applied: false` otherwise); who
  sees the place decides the person's `privacy.placeInStatus`.
* `send_file` `{ conversation: "direct:<id>" | "family" | "group:<id>", user, mediaIds: [≤ 20], names?: [..], text? }`
  (since 1.8.0, for GateDrop; GateControl ≥ 1.193.0) → `{ ok, conversationId, messageIds }` — the files were handed
  over to the messenger first (`gc.media.handOver(id, { toPlugin: 'gatecontrol-messenger', user })`, up to
  `media.handOverMaxBytes` = 2 GB; the messenger's own uploads stay at 25 MB). They become messages **of `user`**
  (the calling `userId` must be the same person): one per file — `image` (JPEG, PNG, WebP, GIF), `voice` (audio/*),
  `file` (everything else, a video/* file shown as a video) with `meta.fileName` from `names`; `text` (≤ 20 000) is
  the first file's caption when ≤ 4000, else (or without files) text messages before the files (split at 4000, ≤ 5).
  Pushed like any message of that person. `user` must be a member: `direct:<id>` found or created (a block either way
  → `forbidden`), `family` the caller's managed group `family` else Familie's, `group:<id>` a group the person is in;
  read-only → `readonly`. Each file must be handed over for `user`, unused and ≤ 2 GB → else `media_invalid`,
  `media_in_use`, `file_too_large`.
* Refusals answer `{ ok: false, code: "invalid" | "not_found" | "forbidden" }`. `send_file` also `readonly`, `media_invalid`, `media_in_use`, `file_too_large`.

Messenger calls these Familie services (since 1.4.0, `permissions.services`,
each feature-detected with `gc.services.available`; refusals `{ ok: false,
code }` become `unavailable` for the client): `list_add { userId, list, items }`,
`calendar_add { userId, title, startsAt, endsAt?, allDay?, place? }`,
`calendar_upsert { sourceRef: "messenger:<messageId>", title, startsAt,
endsAt?, allDay?, place?, userIds? }`, `calendar_remove { sourceRef }`,
`places { userId }` (a bare array), since 1.5.0 `family_roles {}` →
`{ parents: [ids], children: [ids] }` (cached 10 minutes; missing → requests
use `rights`, nobody counts as a child). Dates are ISO with a time, or
`YYYY-MM-DD` for all-day; `place` is the label.

## Portal tab

List | chat | info side by side (info as an overlay below 1100 px, one pane at a
time below 760 px). Uploads with `GC.upload` (pictures scaled in the browser to
2048 px WebP plus a 320 px preview), files shown through signed URLs (valid
6 h), voice messages recorded with `MediaRecorder` (Opus in Ogg/WebM, or MP4)
when the browser allows the microphone, live updates with `GC.on('event')`
plus a refresh every 30 s. Limits of the sandboxed frame: no downloads (files
other than pictures, audio and video open in the apps).

Videos and file previews (1.3.0): sending an MP4 reads its duration and size
from the file and draws a frame at about 1 s (WebP ≤ 64 KB, ≤ 640 px), sent
as `video` and `thumbMediaId` when `GET me` has `features.video_meta` /
`features.file_thumbs`. The frame's CSP allows media only from
`/plugin-media/` (no `blob:`/`data:`), so a `<video>` element cannot open
the picked file: `ui/video.js` reads the MP4's `moov` box and decodes the
frame with WebCodecs (`VideoDecoder`: H.264 in Chrome, Edge and Safari;
HEVC where the system decodes it; VP9 and AV1). No WebCodecs (Firefox
before 130, plain HTTP) or an unknown codec: the duration and size alone;
nothing readable: the plain file, as before. PDFs get a first-page preview
only when the frame already has a PDF renderer (`window.pdfjsLib`) —
GateControl gives frames none, so today none. Videos with a preview show as
a tile with play button and duration (a click plays them in place), files
with a preview show it on the file card, and the chat info's "Recently
shared" has the tabs Photos / Videos when the chat has videos.

Locations (1.2.0, `ui.maps`): the attach button offers "File or photo" and
"Location". The location dialog shows a map with GateControl's Leaflet
(`/plugins/_shared/leaflet/`) and tiles through GateControl's tile relay
(`window.GC.tiles` — the frame has an opaque origin, OpenStreetMap refuses its
referrer-less requests). Tap or drag the point, or type latitude/longitude;
an optional label. "My location" asks the browser (`navigator.geolocation`)
only where the frame may ask (`document.featurePolicy.allowsFeature
('geolocation')`; GateControl ≥ 1.179.0 gives frames of `ui.geolocation`
plugins `allow="geolocation *"`), a refusal leaves the map. Sent as the
existing `location` message. No address search (the plugin has no internet
access for a geocoder). Received locations show a small static map (a few
relay tiles around the point with a pin, no Leaflet per message); a click
opens the map in a dialog with the accuracy circle and a link to
openstreetmap.org (new tab).

Pinned "GateControl" entry (1.2.0, `ui.inbox`, GateControl ≥ 1.179.0): on
top of the chat list, like in the apps — the viewer's own GateControl inbox
with the unread count and the newest title, from `window.GC.inbox.on()`
(the portal's own bell state; count, title, time and priority only). A click
calls `GC.inbox.open()`, which shows the portal's inbox (`#mitteilungen`).
Feature-detected: without `GC.inbox` (GateControl 1.177/1.178) or with
`available: false` (notification center off) there is no entry.

Since 1.6.0: the status strip ("Mein Status") comes first, above
"Angeheftet"; under "Angeheftet" the "GateControl" entry, then the chats the
server pins (`listPinned`: Familie's group) — they are not repeated under
"Chats". Notice channels carry the mark "Mitteilungen" in the list and "Mitteilungen
von <Quelle>" in the head; notification cards show "<source> · <topic>", the
title and the whole text with their buttons (the card's link and `imageUrl` are
for the apps — the frame cannot navigate the portal or load `/notify-media/`).
The page "Wo Mitteilungen erscheinen" (feature `notice_routes`) opens from the
settings dialog (the first row) and from the info of a notice channel: per
source the topics with their place as a chip — a choice dialog GateControl /
Familien-Chat ("Für alle in Familie sichtbar", only with `canFamily`) / Eigener
Chat „<Quelle>“; locked topics with a lock and "immer GateControl"; a household
family route names who set it (only people with `canFamily` change it); without
an active sink a hint and nothing to change. It goes through
`portal/notify-routes` (below), because a frame reaches only its own plugin.

Since 1.4.0 (`ui/rich.js`): the status strip under "Angeheftet" (own status
first with a "+", a glowing ring for people with unseen stories; a click opens
the stories one after the other with arrows, seen marks, reactions and a reply
field — own stories with the viewers), setting the own status (preset, text,
duration, audience) and posting text or photo stories; polls (vote, add
options, close, nudge), events (RSVP, checklist, edit, cancel; the next event
above the chat), live arrivals read-only (the apps share the way), home action
messages and plugin cards with their buttons (a confirmation first for
`needsConfirm`); the attach menu offers poll, event and home action; the
message menu pin / unpin, "Erinnern" and "Zur Liste / In Kalender" (with
Familie) and, since 1.10.0, "In Drive speichern" for pictures, voice messages and files
(with Drive, into Meine Dateien › Messenger; a toast names the place); the chat info archive, export (shown as text to copy — frames have
no downloads) and block; chips for chat lists and the archive above the chat
list; the settings dialog for privacy, notifications, chats and blocks. Each
part only when `GET me` lists its feature.

## Profile picture visibility from the profile (since 1.22.0)

On a GateControl with `gc.users.setAvatarVisibility` the person chooses in her
user profile who sees her picture, for all of GateControl: `all`, `contacts`,
`family`, `self`. The apps change it there (`PATCH /api/v1/client/me/profile`
`{ visibility: { avatar } }`), not here.

* `GET me` → `avatarInProfile: true`. `prefs.privacy.avatarProfile` is the
  level of the profile; `prefs.privacy.avatar` mirrors it for older apps
  (`contacts` → `family`, `self` → `nobody`). The privacy row "Profilbild"
  opens the profile.
* `PUT/PATCH prefs { privacy: { avatar } }` (older apps) is forwarded to the
  profile (`nobody` → `self`).
* `avatarUrl` is `null` for a reader who may not see the picture: `contacts`
  = the family (GateControl's groups of the kind family) and everybody who
  shares a direct chat or a group with the person; `family`; `self` nobody.
  The person always sees her own; a block hides it both ways. Pushes carry the
  sender's picture only for recipients who may see it.
* On the first start the person's old `privacy.avatar` (`family`, `nobody`)
  is handed to the profile once, only while nothing is chosen there.

Without `avatarInProfile` everything works as before (privacy.avatar here).

## Development

`npm test` (mock host `tools/testing/mock-host.js`), `npm run validate`.
