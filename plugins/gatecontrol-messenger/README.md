# gatecontrol-messenger — Messenger

Chats between the GateControl accounts: direct and group chats with text,
pictures, videos, voice messages, files and location, replies with quote, reactions,
editing and deleting, read receipts, "typing …", disappearing chats and chat
pushes with a reply field. The apps (Android, Windows) draw their own tab
"Chats" from the API below; the portal has a tab "Chats" (sandboxed frame);
administrators get two pages (Übersicht, Protokoll) without any message
content. Paid plugin (`license.required`), needs **GateControl ≥ 1.180.0**
(plugin media, realtime events, chat notifications, services; since 1.4.0
interactive home actions `permissions.actions { interactive: true }` and
service payloads up to 512 KB). 1.4.0 adds status and stories, privacy
settings, last seen, blocks, archive, pins, chat lists, export, "remind me",
suggestions, polls, events, live arrival, home actions and plugin cards — see
"Since 1.4.0" in the App-API.

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
  Since 1.4.0 a card with counts only (active statuses / stories, open polls,
  upcoming events, live arrivals, home actions and plugin cards of the last 7
  days, blocks, pending reminders) and the switches "Storys erlauben" and
  "Haus-Aktionen in Chats" (both on by default).
* **Protokoll**: errors and limits only (push limit, live event limit, file
  clean-up, decryption, refused service calls, failed background steps, since
  1.4.0 failed home actions).

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
| `GET me` | | since 1.4.0 also `integrations`, more `prefs`, `features` and `limits` (see "Since 1.4.0"); `{ user: { id, name, avatarUrl, initials, colorHex }, prefs: { readReceipts, typing, preview }, license: { licensed, state, expiresAt }, features: { direct, groups, voice, files, location, reactions, edit, search, disappearing, bridges: false, e2e: false, video_meta: true, file_thumbs: true }, limits: { maxBytes, types[], quotaFull, editWindowS, maxVoiceS, textMax: 4000, thumbMaxBytes: 65536, thumbMaxSide: 640, imageMaxSide: 2048, groupMax: 256, titleMax: 80, pageMax: 100, typingS: 6, typingEveryS: 3, activeS: 30, disappearingS: [0, 86400, 604800, 2592000], retentionDays }, serverTime }` — `video_meta`, `file_thumbs`, `thumbMaxSide` since 1.3.0, see "Videos and file previews" |
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
| `actions` | home actions (`GET actions`, message kind `action`, buttons of `card` messages); absent without `gc.actions` on the host or when the administrator switched them off |
| `msg_tools` | blocks, archive, pins, lists, export, remind me, suggest |
| `privacy2` | `prefs.privacy` / `prefs.notify` / `prefs.chats`, last seen / online |

`GET me` also has `integrations: { familie: { lists, calendar, places } }`
(booleans: the Familie plugin offers `list_add`, `calendar_add`, `places`
right now — `gc.services.available`) and these `limits`: `statusTextMax: 60,
storyTextMax: 700, storyTtlS: 86400, storyDurationsH: [1, 3, 6, 12, 24] (since 1.4.1), storiesMax: 30, pollOptionsMax: 12,
pollQuestionMax: 200, pollOptionMax: 80, eventTitleMax: 120,
eventChecklistMax: 20, pinsMax: 3, listsMax: 20, remindersMax: 100,
arrivalEveryS: 20, arrivalMaxS: 10800, arrivalRadiusM: 150`.

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
  people, members, peer, status feed).
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
* Send `{ clientId, kind: "action", action: { mode: "run"|"request"|"grant",
  actionId, plugin?, label? (≤ 80), approverIds? (request), grant?: {
  toUserId, until (≤ 7 days) } (grant) } }`:
  * `run`: a button; the sender must be able to run it.
  * `request`: approvers = `approverIds` (or every other member) who may run
    it; none → `no_approver`. The push goes to the approvers only ("Bittet um:
    <label>").
  * `grant`: the sender lets one member run it until `until`, **as the
    sender** (an automation run). Actions with `needsConfirm` (sensitive, e.g.
    a door) cannot be granted (`not_allowed`).
* Message `action`: `{ mode, actionId, plugin, label, icon, needsConfirm,
  approverIds (request), grant: { toUserId, until } (grant), state:
  "open"|"done"|"denied"|"expired", result: { ok, message } | null, by, at,
  can: { run, approve, deny } }` (`can` for the caller). Open requests expire
  after 24 h, grants at `until`.
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
* `send_message` with `card` (since 1.4.0): `{ conversation, card: { kind:
  "doorbell"|"notice", title (1…80), text? (≤ 500), imageBase64? (JPEG or
  WebP, ≤ 300 KB — GateControl 1.180.0 takes service payloads up to 512 KB),
  actions?: [ "<id>" (a quick action of the caller) | "<plugin>/<id>" ] (≤ 4),
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
* Refusals answer `{ ok: false, code: "invalid" | "not_found" | "forbidden" }`.

Messenger calls these Familie services (since 1.4.0, `permissions.services`,
each feature-detected with `gc.services.available`; refusals `{ ok: false,
code }` become `unavailable` for the client): `list_add { userId, list, items }`,
`calendar_add { userId, title, startsAt, endsAt?, allDay?, place? }`,
`calendar_upsert { sourceRef: "messenger:<messageId>", title, startsAt,
endsAt?, allDay?, place?, userIds? }`, `calendar_remove { sourceRef }`,
`places { userId }` (a bare array). Dates are ISO with a time, or
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
Familie); the chat info archive, export (shown as text to copy — frames have
no downloads) and block; chips for chat lists and the archive above the chat
list; the settings dialog for privacy, notifications, chats and blocks. Each
part only when `GET me` lists its feature.

## Development

`npm test` (mock host `tools/testing/mock-host.js`), `npm run validate`.
