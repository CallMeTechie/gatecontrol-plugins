# gatecontrol-messenger — Messenger

Chats between the GateControl accounts: direct and group chats with text,
pictures, videos, voice messages, files and location, replies with quote, reactions,
editing and deleting, read receipts, "typing …", disappearing chats and chat
pushes with a reply field. The apps (Android, Windows) draw their own tab
"Chats" from the API below; the portal has a tab "Chats" (sandboxed frame);
administrators get two pages (Übersicht, Protokoll) without any message
content. Paid plugin (`license.required`), needs **GateControl ≥ 1.177.0**
(plugin media, realtime events, chat notifications, services).

* Version 1 is internal only (GateControl ↔ GateControl); bridges (WhatsApp,
  Signal, Matrix, ntfy, Gotify) and end-to-end encryption come later.
* Every enabled GateControl account may chat. Accounts seen on a kiosk device
  (wall tablet) are not offered as people and kiosk devices get no tab.
* The pinned chat "GateControl" in the apps is the GateControl inbox (core
  notifications) — not part of this plugin.

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
* **Protokoll**: errors and limits only (push limit, live event limit, file
  clean-up, decryption, refused service calls, failed background steps).

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
  "managedBy": "gatecontrol-familie" | null,
  "readonly": false,                     // a plugin's notice channel: members cannot send
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
  "media": { "id", "mime", "bytes", "url", "thumbId", "thumbUrl" } | null, // url/thumbUrl: signed URLs for the portal frame only, null in the apps
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
| `GET me` | | `{ user: { id, name, avatarUrl, initials, colorHex }, prefs: { readReceipts, typing, preview }, license: { licensed, state, expiresAt }, features: { direct, groups, voice, files, location, reactions, edit, search, disappearing, bridges: false, e2e: false, video_meta: true, file_thumbs: true }, limits: { maxBytes, types[], quotaFull, editWindowS, maxVoiceS, textMax: 4000, thumbMaxBytes: 65536, thumbMaxSide: 640, imageMaxSide: 2048, groupMax: 256, titleMax: 80, pageMax: 100, typingS: 6, typingEveryS: 3, activeS: 30, disappearingS: [0, 86400, 604800, 2592000], retentionDays }, serverTime }` — `video_meta`, `file_thumbs`, `thumbMaxSide` since 1.3.0, see "Videos and file previews" |
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
| `message.update` | `{ conversationId, messageId, editedAt }` | fetch `messages?changedSince=` |
| `message.delete` | `{ conversationId, messageIds: [..], reason: "deleted" \| "hidden" \| "expired" \| "retention" }` | `deleted`: show tombstone; the others: remove (`hidden` goes to the caller's own devices only) |
| `reaction` | `{ conversationId, messageId, userId, emoji \| null, reactions: [ { emoji, count, userIds } ] }` | replace the message's reactions |
| `read` | `{ conversationId, userId, lastReadId (number \| null when not shared), lastDeliveredId, readUpTo, deliveredUpTo }` — to the reader's own devices additionally `{ …, self: true, unread }` | update receipts / ticks; `self`: update unread, remove that chat's notifications. `readUpTo` / `deliveredUpTo` (since 1.1.0): the values `GET conversations/:id` would give **this recipient** right now (see "Read receipts") — set the chat's `readUpTo` / `deliveredUpTo` (and the ticks of own messages) from the event, no GET needed. Sent for read marks and for delivered marks (the same event; a moved delivered mark changes `lastDeliveredId` / `deliveredUpTo`). |
| `typing` | `{ conversationId, userId, until (ISO) \| null }` | show "schreibt …" until `until` (≈ 6 s; null = stop) |
| `conversation.update` | `{ conversationId, reason }` — `reason`: `created`, `settings`, `members`, `title`, `avatar`, `disappearing`, `released` (since 1.1.0: no longer managed by a plugin) (comma-separated when several) | `GET conversations/:id` (treat an unknown reason the same) |
| `conversation.remove` | `{ conversationId }` | drop the chat (removed, left, no longer in a managed group, or — since 1.1.0 — a managed group deleted by its plugin) |

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
  "GateControl").
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
* Refusals answer `{ ok: false, code: "invalid" | "not_found" | "forbidden" }`.

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

## Development

`npm test` (mock host `tools/testing/mock-host.js`), `npm run validate`.
