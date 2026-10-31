# gatecontrol-mail — Mail

Every mail account of a person in one place: GMX, WEB.DE, T-Online, Gmail (app password), Outlook.com and Microsoft 365
(Microsoft sign-in) or any IMAP account. The server keeps a copy (headers, flags, bodies within a quota), so the apps
and the portal show one posteingang of all accounts ("Alle Posteingänge") with **Relevant** and **Sonstige**, push for new
mail, pictures only on request (tracking pixels removed), attachments into Drive (with a suggestion, or on their own) and
from Drive, and AI ("Kurz gesagt", "Zu tun", reply suggestions) through GateControl's AI provider. Since 1.2.0 also
**calendars and contacts**: own GateControl calendars, the calendars of the accounts (Microsoft 365 / outlook.com via
Graph, GMX / WEB.DE / an own server via CalDAV both ways, Gmail read only via its secret iCal address), Familie, Alltag
and the contacts' birthdays shown alongside, invitations (a card in the mail, answers, own invitations), reminders as
push; an own address book with the accounts' contacts (Graph, CardDAV; Gmail: vCard import), groups, duplicates,
„Als Kontakt speichern“, the sender view and suggestions while writing.

*Deutsch:* Alle E-Mail-Konten an einem Ort – ein Posteingang mit Relevant und Sonstige, Push, Schutz vor Zählpixeln,
Anhänge in Drive und KI; dazu Kalender und Kontakte. Details im CHANGELOG.

Needs **GateControl ≥ 1.219.0** (since 1.2.0): `gc.mail.dav.request` (`permissions.mail.dav` — CalDAV/CardDAV to the
servers people enter, through the host's network checks), the calendar parts of a mail and `icalEvent` when sending
(iMIP), `autoconfig` with `caldav` / `carddav`, up to 1000 pushes an hour (`permissions.notify.perHour: 600` — the
reminders of all people go through this plugin). Before: **GateControl ≥ 1.216.0**: `gc.mail` (IMAP sessions with IDLE, SMTP, MIME, the HTML sanitizer, autoconfig —
`permissions.mail`, at most 100 IMAP sessions at once), `gc.http.fetchImage` (`permissions.network.images`),
`maxPerHour` of Drive's services (Drive ≥ 1.15.0). Microsoft accounts go through Microsoft Graph
(`graph.microsoft.com`, `login.microsoftonline.com`, the upload sessions of large attachments on `outlook.office.com` /
`outlook.office365.com` — `gc.http.fetch`). Optional: Drive ≥ 1.15.0 (`gatecontrol-drive`), Familie ≥ 1.15.4
(`gatecontrol-familie`, `calendar_add`), GateControl's AI service (`gc.ai`). No npm dependencies.

**GateControl ≥ 1.217.0** (found by feature detection, `"gatecontrol"` stays `>=1.216.0`): Microsoft accounts send files
from the device, from other mails and from Drive (`gc.http.fetch` with `bodyMedia` — the host streams the plugin's media
file to Graph; test `typeof gc.http.MEDIA_BASE64 === 'string'`), and a new account's or a new password's SMTP login is
checked before saving (`gc.mail.smtp.verify`). On 1.216.0 both stay as in 1.0.0.

## How it works

* **Sync** (`server/engine.js`, `imap.js`, `graph.js`): one IMAP session per account with IDLE on the posteingang — new
  mail is synced at once (its body too, then the push); the posteingang is checked again every 5 minutes, the other
  folders every 15 minutes and whenever their list is opened. Microsoft: a Graph delta query per folder (posteingang
  every minute, the rest every 15 minutes), the token renewed with the refresh token. The first sync takes the last
  `retentionMonths` (newest first, in parts: the newest 50 of the posteingang at once, then Graph delta page by page /
  IMAP 300 at a time); older mail comes from the server when a list is scrolled past it or by the search. Bodies of the
  rest come in the background (10 per account and run), within the quota.
  Since 1.1.2 every sync goes in short steps, and what a person waits for never waits behind them: Microsoft bodies,
  attachments, flags and moves go beside the sync (one token renewal for all), IMAP bodies and attachments on a short
  session of their own while a sync step runs (≤ 2 per account, 8 in all), flags and moves first after the running step.
* **Storage**: headers, snippet, flags, body (sanitized HTML + text) in the plugin's database; attachments as the
  plugin's media only when needed (administrator: `on_demand`, or `always` up to 10 MB), least used first out when the
  person is over `quotaGB` (bodies of the oldest mail next — the headers stay; `limits.usedBytes`). Mail older than the
  retention nobody opened for a week goes. Credentials are secrets of the plugin (`gc.settings.setSecret`), never in
  the database, an answer or the log.
* **Relevant / Sonstige** (`server/classify.js`): what the person taught for the sender, then rules (List-Id,
  Precedence bulk/list, Auto-Submitted, no-reply senders → Sonstige; people the person wrote to, answers to the person's
  mail → Relevant; List-Unsubscribe and Microsoft's "Other" are hints), unclear mail is Relevant at first and sorted by
  the AI in the background (administrator `ai.sort`, the account's `ai`, 5 per run).
* **Pictures**: GateControl's sanitizer turns external pictures into `gc-img:<n>`; the API shows them as
  `img/<token>` and loads them through `gc.http.fetchImage` only after "Bilder laden" (once) or "Immer von diesem
  Absender".
* **Sending**: an outbox — sent 10 s after "Senden" (undo until then) or at the planned time (background run every
  15 s, a timer for the next two minutes). IMAP accounts through `gc.mail.smtp.send` with a copy into "Gesendet" (not
  Gmail: it keeps one itself); Microsoft through Graph (`sendMail`, answers and forwards as Graph's own reply; with
  files a Graph draft: each file < 3 MB as `fileAttachment` with `contentBytes`, larger ones through an upload session
  in pieces of 2.8 MB, then `send` — a draft that does not go out is removed again). A busy or
  unreachable server: 3 tries a minute apart, then `failed` and the push `mail_failed`.

* **Calendars** (since 1.2.0; `server/pim.js` with `pimgraph.js`, `pimdav.js`): a line of its own per account beside
  the mail line, and mail goes first — in every background run after the posteingänge at most one calendar or contact
  step per account, within the rest of the run's budget, calendars before contacts. Graph: `/me/calendars` every 6 h and
  when the calendars are opened (at most every 5 min); the default calendar by `/me/calendarView/delta` in the window
  −13 … +24 months (UTC, 100 a page, a page per step; every 5 min, 1 min while the person has the calendar open), the
  others by `calendarView` in the same window (15 / 5 min, compared by `changeKey`). Background steps only while the
  person's own Graph work uses fewer than 2 of the 4 requests per mailbox; a 429 / 503 pauses mail and calendar of the
  account. CalDAV: discovery (`current-user-principal` → `calendar-home-set` → the VEVENT collections, `OPTIONS` for
  `calendar-auto-schedule`), then per collection `PROPFIND` Depth 0 (`getctag`, `sync-token`), `sync-collection` (an
  invalid token: a full comparison), else the ETags by `calendar-query` in the window; changed objects by `multiget` in
  blocks of 50 (15 / 2 min). iCal subscriptions every 30 min with `If-None-Match` / `If-Modified-Since`, after a failure
  15 min … 6 h. Contacts: Graph delta per folder (photos ≤ 256 KB when the `changeKey` moved), CardDAV like calendars
  (60 / 5 min). More than 50 % and more than 200 objects of a collection gone at once: nothing is deleted, the collection
  shows `unreachable` / `mass_delete` until a second sync confirms it.
* **Calendar objects** (`server/ics.js`, ical.js 2.2.1 vendored): own events are stored as iCalendar with a VTIMEZONE of
  timezones-ical-library 2.3.2 (vendored), CalDAV objects as the provider has them; a change touches only its
  properties (unknown ones stay — two-way sync). Occurrences of the window are stored for ranges and reminders
  (RRULE / RDATE / EXDATE / RECURRENCE-ID; wall clocks converted with Intl, TZIDs resolved like Alltag incl. Windows
  names); a range outside the window is expanded when asked. A 412 of the provider is merged field by field against the
  state before the own change: the change goes once more when the provider touched other fields, else 409 `conflict`.
  Contacts (`server/vcard.js`) the same way as vCard 3.0 / 4.0 (the server's version), the photo apart.
* **Invitations** (`server/invites.js`): the calendar parts of a received mail (IMAP) or Microsoft's event messages; one
  row per person + UID + occurrence, a newer SEQUENCE / DTSTAMP outdates the older one; only invitations naming an
  address of the person. Answers: Graph's event API, a CalDAV server with auto-schedule by PUT, else iMIP through the
  account's SMTP (`icalEvent`) or Graph `sendMail` with the `.ics`. Own events with attendees (GateControl calendars,
  CalDAV without auto-schedule): `SEQUENCE` + 1 and a REQUEST when time, place, rule or title change, CANCEL to removed
  attendees and on delete. GateControl people with a Mail place get invitations of GateControl calendars internally
  (no mail, push `calendar_invite`) and answer the same way (`calendar.internalInvites`).
* **Reminders** (`server/reminders.js`): every run (15 s) the occurrences due (start − minutes within the last 10 min;
  all-day ones against midnight in the person's zone) of calendars with `notify`, for people with reminders on, not
  cancelled or declined — each exactly once (`reminders_sent`), several of a person in one minute as one push.

## API (apps and portal)

`/api/v1/client/plugins/gatecontrol-mail/api/<path>` (device token) and `/api/v1/portal/plugins/gatecontrol-mail/api/<path>`
(a signed-in portal viewer). Only people the administrator allows (`403 not_allowed`; the app tab is hidden for them —
`appVisible`) and who have a place in the licence (since 1.1.0, like Drive — see "Licence and people": `GET me` answers
with `seat: null`, everything else `403 no_seat`; without a valid licence `403 not_licensed`). IDs are positive integers, times ms since the epoch. Errors: `{ error: { code, message, … } }` with
400 `invalid { field }`, 403 `forbidden | not_allowed | no_seat | not_licensed | limit { max } | login_required |
images_blocked`, 404 `not_found`, 409 `auth_failed { hint, server? } | imap_disabled { hint } | unreachable { server? } |
tls { server? } | exists | ai_off | ai_unavailable | seat_limit | seat_kind
| familie_unavailable | drive_unavailable | no_folder | not_waiting | microsoft_off | attachments_unsupported |
images_off | links_disabled | busy { retryAfter?, reason? }`, 413 `too_large { max }`, 429 `rate_limited`. Since 1.2.0:
403 `feature_off { feature: 'calendar' | 'contacts' }` (switched off by the administrator), 400 `invalid_ics | invalid_vcard`,
409 `read_only | conflict { current } | consent_required { accountId, missing } | dav_unavailable { reason: 'not_found' |
'no_calendar' | 'redirect' | 'host_old' } | not_supported { what } | send_failed { reason } | invitation_outdated`. `busy`: the provider
throttles, or (`reason: 'loading'`) an attachment is still on its way — ask again after `retryAfter` s (since 1.1.2 409,
before 503).

### Account, state

| | |
|---|---|
| `GET me` | `{ features, limits: { accountsMax, quotaBytes, usedBytes, retentionMonths }, microsoft: { clientId \| null, authority, scopes, adminConsentUrl }, accounts: [Account], unread: { all, byAccount }, settings: { threads, swipeLeft, swipeRight }, seat: 'family' \| 'business' \| null, licence: { valid, tier } }` — features `mail`, `ai`, `microsoft`, `drive`, `familyCalendar`, `images`, since 1.2.0 `calendar`, `contacts` (the administrator), `dav` (the host has `gc.mail.dav`), `familyOverlay`, `alltagOverlay`; `seat` / `licence` since 1.1.0 (answered also without a place). `microsoft.scopes`: mail + `Calendars.ReadWrite` / `Contacts.ReadWrite` while on; `usedBytes` counts events and contacts too |
| `PUT settings` | `{ threads?, swipeLeft?, swipeRight? }` (`archive \| delete \| read \| none`) → `{ settings }` |
| `GET providers` | `[{ id, label, auth: 'password' \| 'app_password' \| 'microsoft' \| 'imap', hint: { de, en } \| null, help }]` |
| `POST accounts/discover` | `{ email }` → `{ provider, auth, imap, smtp, hint }` (known domains, else `gc.mail.autoconfig`) |
| `POST accounts` | `{ provider, email, password, username?, name?, color?, kind?, imap?, smtp? }` → `{ account }` — the IMAP login is tried first, on GateControl ≥ 1.217.0 the SMTP login too (`gc.mail.smtp.verify`; its refusal names `server: 'smtp'`) |
| `POST accounts/microsoft` | `{ code, codeVerifier, redirectUri, name?, color?, kind? }` → `{ account }` — the server redeems the code (public client, PKCE, no secret). `redirectUri`: `msauth://com.gatecontrol.client/<…>` or `http://localhost[:port][/path]` |
| `POST accounts/microsoft/device` | `{ kind?, accountId? }` → `{ deviceId, userCode, verificationUri, expiresIn, interval }` — since 1.3.0 `accountId`: an own Microsoft account signs in anew (the portal's „Neu anmelden“), not counted against the limit of accounts |
| `GET accounts/microsoft/device/<deviceId>` | `{ status: 'pending' \| 'done' \| 'expired' \| 'denied', account? }` — asks Microsoft at most every `interval` s |
| `PATCH accounts/<id>` | `{ name?, color?, kind?, push?, ai?, attachments?, signature?, password? }` → `{ account }` (a new password is tried first: IMAP, and SMTP on ≥ 1.217.0). Since 1.2.0 also `{ calendarSync?, contactsSync?, caldavUrl?, carddavUrl?, davUsername?, davPassword?, icsUrl? }` (`https:`, `webcal:` → `https:`; `icsUrl` for Gmail / IMAP accounts, a secret; `davPassword` only when it differs from the mail password) — tried at once: 409 `auth_failed \| unreachable \| dav_unavailable { reason }`; sync off removes that side here |
| `POST accounts/<id>/microsoft` | `{ code, codeVerifier, redirectUri }` → `{ account }` (signed in anew; another address → `invalid`) |
| `DELETE accounts/<id>` | `{ ok }` — the server's copy goes, the mail at the provider stays |
| `GET accounts/<id>/avatar` | `{ mediaId, mime, size, url }` — the account's picture (`url`: signed for the portal's frame, 24 h); none: 404 `not_found` |

`Account` = `{ id, provider: 'gmx'|'webde'|'tonline'|'gmail'|'outlook'|'m365'|'imap', email, name, color ('#RRGGBB'), kind:
'personal'|'business', state: 'ok'|'syncing'|'auth_failed'|'unreachable', error: { code, at } | null, push:
'off'|'relevant'|'all', ai, attachments: 'off'|'suggest'|'auto', signature, avatar: { mediaId, mime } | null }`. A Microsoft sign-in of an address the
person has already signs that account in anew (also at the account limit).

`avatar` (since 1.1.2): the account's picture at the provider — Microsoft only (Graph `/me/photos/96x96`, else
`/me/photo`; many Microsoft 365 accounts have none → `null`), IMAP accounts always `null`. Fetched with the sign-in, then
at most once a day (an unchanged picture is not loaded again, a failure again within the hour); a new or removed picture
sends the live event `mail` `{ kind: 'changed', accountId, folderId: null }`. The apps load it as the plugin's media
(`/api/v1/client/plugins/gatecontrol-mail/media/<mediaId>`, only the account's person); without a picture they show the
provider's mark (`provider`) with `email` below the name.

Since 1.2.0 `Account` also has `calendar` and `contacts` = `{ sync, state: 'ok'|'syncing'|'auth_failed'|'unreachable'|
'consent_required'|'none'|'off', readOnly, server }` (`none`: no calendar / address book for this account, `off`: the
person or the administrator switched it off; `server`: the host only, never a secret address) and `missingScopes`
(Microsoft: `['Calendars.ReadWrite', 'Contacts.ReadWrite']` not granted yet, else `[]`). A Microsoft sign-in keeps the
scopes Microsoft granted (`accounts.ms_scopes`) and tokens are only renewed with those — a missing scope never stops the
mail; „Neu anmelden“ (`POST accounts/<id>/microsoft`) adds them.

### Folders, lists, search, reading

| | |
|---|---|
| `GET folders` | `{ accounts: [{ accountId, folders: [{ id, name, path, role, parentId, unread, total }] }] }` |
| `GET messages` | `?box=all\|<accountId>&folder=&tab=relevant\|other\|all&unread=1&flagged=1&attachments=1&before=<cursor>&limit=50` → `{ items: [Summary], next, counts: { relevant, other } }` — `counts`: unread per tab of the posteingänge. With `settings.threads` one row per conversation (its newest mail; `threadCount`), not with `unread` / `flagged`. A single folder whose copy ends before the server's mail gives a `next` at the end; that page loads older mail from the server |
| `GET search` | `?q=&box=&from=&after=&before=&attachments=1&unread=1&cursor=` → `{ items, next, remote }` — the copy first; the first page with few hits also asks the servers (`remote: true`) |
| `GET threads/<threadId>` | `{ items: [Message] }` oldest first — up to 10 missing bodies are loaded at once; what is not there after ~12 s comes with `bodyMissing` (live event with `threadId` when through) |
| `GET messages/<id>` | `Message` = Summary + `{ cc, bcc, replyTo, html \| null, text, imagesBlocked, trackers, attachments: [Attachment], listUnsubscribe, bodyMissing }` — the body from the server when it is not here. Since 1.1.2 at most ~12 s: then `bodyMissing: true` with the snippet as `text`, the load goes on (asking again joins it) and the live event `mail` with this `messageId` tells when it is there |
| `POST messages/<id>/images` | `{ allow: 'once' \| 'sender' }` → `Message` |
| `GET img/<token>` | `{ mime, size, data }` — the picture as base64 (≤ 700 KB, else 413) |
| `GET cid/<messageId>/<attachmentId>` | `{ mediaId, mime, size, url }` — an embedded picture (the apps load `media/<mediaId>`, the portal `url`); like attachments |
| `GET messages/<id>/attachments/<aid>` | `{ mediaId, name, mime, size, url }` — not there after ~12 s: 409 `busy { reason: 'loading', retryAfter }`, the download goes on (asking again joins it), the live event `mail` with `messageId` and `attachmentId` tells when it is there |
| `POST messages/flags` | `{ ids, unread?, flagged? }` → `{ ok, items }` |
| `POST messages/move` | `{ ids, folderId }` (one account) |
| `POST messages/archive` / `delete` / `junk` | `{ ids }` — delete: into the trash, in the trash for good; Gmail archives into "All Mail" |
| `POST messages/tab` | `{ ids, tab }` — learned for the senders (their other mail in the posteingänge follows) |

`Summary` = `{ id, accountId, folderId, threadId, threadCount, from: { name, email }, to (≤ 3), subject, snippet (≤ 160),
date, unread, flagged, answered, hasAttachments, tab, savedToDrive, ai: { summary } | null }`. `Attachment` = `{ id, name,
mime, size, inline, cid, savedTo: { nodeId, where } | null, suggestion }`.

**HTML**: sanitized by GateControl (no script, no event handlers, no `url()` in CSS); external pictures are
`img/<token>` (relative to the plugin API), embedded ones stay `cid:<id>` (→ `GET cid/…` by the attachment with that
`cid`). Show it without JavaScript; open links outside.

### Writing

| | |
|---|---|
| `POST drafts` | `{ accountId, to, cc, bcc, subject, html, replyTo?: messageId, mode?: 'reply'\|'replyAll'\|'forward', attachments: [Att] }` → `{ draft }` |
| `PUT drafts/<id>` | the same body (only what changes; `attachments` is the whole list — `{ id }` keeps one) → `{ draft }` |
| `GET drafts/<id>` / `DELETE drafts/<id>` | `{ draft }` / `{ ok }` |
| `POST drafts/<id>/send` | `{ sendAt? }` → `{ outboxId, undoUntil, sendAt }` |
| `POST outbox/<id>/cancel` | `{ draftId }` (waiting or failed) |
| `GET outbox` | `{ items: [{ id, draftId, accountId, subject, sendAt, state: 'waiting'\|'sending'\|'failed', error? }] }` |
| `GET contacts?q=` | `{ items: [{ name, email, source: 'person'\|'recent' }] }` (≤ 10) |

`Att` = `{ mediaId, name? }` (uploaded by the device, `PUT …/media`; the person's own, unused) | `{ messageId,
attachmentId }` | `{ driveNodeId, as: 'copy'|'link', expiresDays?, password? }` | `{ id }` (an attachment of this draft).
`draft` = `{ id, accountId, to, cc, bcc, subject, html, attachments: [{ id, name, size, mime, as, url? }], warnings: [{ kind:
'password'|'too_large'|'no_subject', text }] }`. With `mode` the server fills in what is missing: recipients (reply:
Reply-To or the sender; reply all: also To and Cc, never the person's own addresses), `Re:` / `Fwd:` and the quote; a
forward without `attachments` takes the mail's attachments (a client that sends them as `{ messageId, attachmentId }`
gets exactly those). The account's **signature is the clients'**: they put it on top (`Account.signature`); the server
never adds it. An answer always goes out of the account the mail came to.
Too large for the provider (GMX / WEB.DE 20 MB, others 25 MB): files from Drive become links (14 days, warning
`too_large`), files from the device or a mail → 413 `too_large`. A refused attachment is not added (the draft keeps
its attachments).
**Microsoft accounts** send through Graph. On GateControl ≥ 1.217.0 every file goes along like on IMAP accounts
(the host streams the plugin's media file to Graph — the plugin never holds the bytes; the size limit 25 MB, Drive copies
become links only above it). A forward of the same Microsoft mail is Graph's own forward: it carries the original's
attachments itself, the ones the person took out of the draft are deleted from it. On 1.216.0 (no `bodyMedia`): files
from Drive go as links (warning), files from the device or another account's mail → warning, and `send` answers 409
`attachments_unsupported`.

### AI

| | |
|---|---|
| `GET ai/<messageId>` | `AiResult` \| `{ status: 'none' }` |
| `POST ai/<messageId>` | `{ again? }` → `AiResult` — a result that is there is answered as it is (no new request; the apps ask on opening a mail), `again: true` asks anew; runs for the same mail at once share one request; at most 60 runs a person and hour (429) — 409 `ai_off` (administrator, account, business accounts blocked) / `ai_unavailable`, 429 `rate_limited` |
| `POST ai/<messageId>/todo/<index>` | `{ action: 'family_calendar' }` → `{ where }` (Familie's `calendar_add` for the person; 409 `familie_unavailable`) |

`AiResult` = `{ status: 'done', summary | null (mail < 600 characters), todos: [{ kind:
'question'|'deadline'|'event'|'amount'|'task', text, date?, time?, amount?, currency? }], replies: [{ label, text }] }`. The
text of the mail goes to the AI; its pictures only for a mail without text and only while GateControl lets pictures
go to the AI.

### Drive

| | |
|---|---|
| `POST messages/<id>/attachments/<aid>/drive/suggest` | `{ suggestion, duplicate }` (Drive's `suggest_folder`) |
| `POST messages/<id>/attachments/<aid>/drive/save` | `{ folderId?, name?, remember? }` → `{ savedTo: { nodeId, where } }` — without `folderId` the suggestion; the file shows "Aus Mail von …" with a jump back; `remember`: "Immer für diesen Absender" |
| `POST messages/<id>/drive/save-all` | `{ saved: [{ attachmentId, savedTo }], failed: [{ attachmentId, code }] }` |
| `GET filing` | `{ items: [{ id, messageId, attachmentId, name, from, date, suggestion }] }` ("Zum Ablegen") |
| `POST filing/<id>/confirm` / `dismiss` | `{ folderId?, name? }` → `{ savedTo }` / `{ ok }` |
| `GET drive/areas`, `GET drive/browse?area=&folder=&dirs=1` | the pickers of the portal (Drive's `list_areas` / `browse`); the apps use Drive's own API |

`Suggestion` = `{ folderId, areaId, path, where, name, confidence, reason: 'rule'|'learned'|'ai'|'kind' }`. Accounts with
`attachments: 'auto'` (and the administrator's `ai.autoFile`) file new attachments on their own when the reason is
`rule` / `learned` or the confidence ≥ 0.9, else they wait in "Zum Ablegen"; never duplicates, inline pictures < 30 KB
or invitations (`.ics`). With `suggest` the suggestion is ready when the mail is opened. Every attachment is handed over
to Drive (`gc.media.handOver`) before Drive sees it.

### Calendars (since 1.2.0)

| | |
|---|---|
| `GET calendars` | `{ calendars: [Calendar], overlays: [Overlay], prefs: CalPrefs, consent: [{ accountId, missing }] }` — the first call makes „Privat“ (default) and „Firma“ (not with `calendar.business: 'exchange'` and a Microsoft 365 account) and „Meine Kontakte“ |
| `POST calendars` | `{ name, color? }` → `{ calendar }` (GateControl calendar, ≤ 20, else 403 `limit`) |
| `PATCH calendars/<id>` | `{ name?, color?, visible?, notify? }` → `{ calendar }` (an account's calendar: name / colour only in GateControl) |
| `DELETE calendars/<id>` | `{ ok }` — GateControl calendars but the last one, subscriptions; their events go |
| `PATCH overlays/<id>` | `{ visible?, color? }` → `{ overlay }` |
| `POST calendars/subscribe` | `{ url, name?, color?, accountId? }` → `{ calendar }` — an iCal subscription (read only) |
| `PUT calendar/settings` | `{ defaultCalendarId?, view?, weekStart?, workWeek?, timeZone?, reminders?, defaultReminder?, allDayReminder? }` → `{ prefs }` |
| `GET events?from=&to=&calendars=` | `{ items: [Occurrence], overlays: [OverlayItem], pending: [calendarId] }` — ≤ 62 days (else 400 `invalid { field: 'to' }`), without `calendars` the visible ones |
| `GET events/<id>?occurrence=` | `Event` — since 1.3.0 with `series: { start, end, allDay, startDate?, endDate? } \| null`: the start and end of the series itself (its master; also when asked for one occurrence), `null` for a single event |
| `POST events` | `{ calendarId, title, allDay, start?, end?, startDate?, endDate?, timeZone?, location?, description?, online?: { create: 'teams' } \| { url }, reminders?, recurrence?: { freq, interval, byDay, byMonthDay, bySetPos, until, count } \| { rrule }, attendees?, busy?, private?, sendInvites?, fromAccountId? }` → `{ event, sent: { mail, internal } }` |
| `PATCH events/<id>` | the same fields + `{ scope: 'occurrence' \| 'series', occurrence?, etag?, sendInvites? }` → `{ event, sent }` (an old `etag` → 409 `conflict { current }`). Since 1.3.0 the times of `scope: 'series'` (without a new `recurrence`) are the series' new start and end, measured from `Event.series`: the shift (wall clock days and minutes in the series' zone) moves the rule's weekdays and days of the month, `UNTIL`, deleted occurrences and the exceptions (one at its original time moves along, one moved by hand keeps its time); earlier occurrences stay. The times of one of its occurrences sent back unchanged change nothing; a shift of a whole period of the rule or more, or one that would lose or add occurrences, → 400 `invalid { field: 'start', reason: 'series_shift' }` (nothing changed). Graph: the rule is moved, Exchange keeps the series |
| `DELETE events/<id>?scope=&occurrence=&notify=1&comment=` | `{ ok, sent }` |
| `POST events/<id>/respond` | `{ response: 'accepted' \| 'tentative' \| 'declined', comment?, occurrence?, proposeStart?, proposeEnd?, send? }` → `{ event }` |
| `GET invitations?state=open` | `{ items: [Invitation] }` |
| `GET invitations/<id>` | `Invitation` |
| `POST invitations/<id>/respond` | `{ response, comment?, calendarId?, proposeStart?, proposeEnd? }` → `{ invitation, event }` (sent first; failing → 409 `send_failed`, nothing stored) |
| `POST invitations/<id>/apply` | `{ invitation, event }` — COUNTER: the proposal taken over (a REQUEST to all), CANCEL: out of the calendar |
| `POST invitations/<id>/dismiss` | `{ decline? }` → `{ ok }` (a COUNTER declined: DECLINECOUNTER) |
| `POST ai/<id>/todo/<i>` | `{ action: 'calendar', calendarId? }` → `{ where, eventId }` (into the own calendar; `family_calendar` stays) |

The shapes (`Calendar`, `Overlay`, `CalPrefs`, `Occurrence`, `OverlayItem`, `Event`, `Recurrence`, `Invitation`) are those
of the contract of Phase 2: times in ms (UTC), zones as IANA names, all-day with `startDate` / `endDate` (`YYYY-MM-DD`,
`endDate` inclusive), an occurrence's key `occurrence` = the ms of its original start (all-day: its date), `key =
"<eventId>:<occurrence>"` (single events `"<eventId>"`). `Summary.invite` (`'request'|'cancel'|'reply'|'counter'|null`)
and `Message.invite` (`Invitation | null`) mark invitations in mail. Overlays: `familie` (Familie ≥ 1.16.0
`calendar_range`), `alltag:<subId>` (Alltag ≥ 1.4.0 `calendar_list` / `calendar_query`), `birthdays` (the person's
contacts) — read per person and month, kept 10 minutes. `CalPrefs.allDayReminder` (the reminder of new all-day events)
counts minutes before midnight of the event's day in the person's zone, like a VALARM `TRIGGER` on an all-day `DTSTART`:
the default 360 is 18:00 the day before (before 1.3.1: 1080, that is 06:00 the day before).

### Contacts (since 1.2.0)

| | |
|---|---|
| `GET addressbooks` | `{ items: [Addressbook], groups: [Group], prefs: CardPrefs }` |
| `PATCH addressbooks/<id>` | `{ visible?, name? }` → `{ addressbook }` |
| `PUT cards/settings` | `{ sort?, show?, defaultAddressbookId?, birthdays? }` → `{ prefs }` |
| `GET cards?q=&book=&group=&cursor=&limit=&since=` | `{ items: [CardSummary], next, version, deleted? }` — linked cards once (`linked`); `q` in names, company, addresses, numbers (digits); `since` (a `version`): changes and `deleted` ids |
| `GET cards/<id>` · `POST cards` · `PATCH cards/<id>` (`etag`; 409 `conflict { current }` / `read_only`) · `DELETE cards/<id>` | `Card` / `{ card }` / `{ ok }` |
| `GET/PUT/DELETE cards/<id>/photo` | `{ mime, size, data }` / `{ mime: 'image/jpeg' \| 'image/png', data }` (≤ 256 KB) → `{ card }` |
| `GET cards/lookup?email=` | `{ card, person: { userId, name } \| null, recent: { name, sent, received, lastAt } \| null }` |
| `GET cards/<id>/activity` | `{ mails: [Summary] (≤ 5), events: [Occurrence] (≤ 5) }` |
| `GET cards/draft?messageId=&email=` | `{ draft, existing }` — „Als Kontakt speichern“: name and address of the mail, phone, company and position from the signature (rules; with the AI when allowed); nothing is stored |
| `GET cards/duplicates` | `{ items: [{ key, reason: 'email' \| 'phone' \| 'name', cards }] }` |
| `POST cards/merge` | `{ ids (2…10), primaryId, pick? }` → `{ card }` — one address book: merged (the others deleted at the provider); several: linked |
| `POST cards/duplicates/ignore` | `{ ids }` → `{ ok }` |
| `POST cards/import` | `{ addressbookId?, vcf (≤ 5 MB) }` → `{ imported, updated, skipped }` (e.g. Google Kontakte › Exportieren › vCard) |
| `GET cards/export?book=&group=` | `{ name: 'kontakte.vcf', mime: 'text/vcard', data }` (vCard 4.0) |
| `POST groups` · `PATCH groups/<id>` · `DELETE groups/<id>` · `GET groups/<id>` · `POST groups/<id>/members` | GateControl's own distribution lists (≤ 200, ≤ 500 members), across sources: `{ add: [{ contactId } \| { email, name? }], remove: [memberId] }` |
| `GET contacts?q=` | as before `{ items: [{ name, email, source }] }` (≤ 10), since 1.2.0 own contacts first (`source: 'contact'`, `contactId`, `photo`), then groups (`source: 'group'`, `email: null`, `groupId`, `members` ≤ 50), GateControl people, recent addresses |

### Push and live events

* Topic `mail`: title = sender, text = subject, data `{ mail: { messageId, accountId } }` — per the account's `push`
  (`relevant`: mail of the tab Relevant); more new mail of a person in one run → one push "3 neue Mails" (data of the
  newest). Topic `mail_failed`: data `{ mail: { outboxId } }`.
* Live event `mail` `{ kind: 'changed', accountId, folderId }` — load the lists again. Since 1.1.2 also with `messageId`
  (the body the answer did not wait for is there — load the open mail again; with `attachmentId`: that attachment) or
  `threadId`; a long sync sends it while it goes on (at most every 5 s per folder).
* Since 1.2.0 topic `calendar_reminder`: title = the event, text „14:00–15:00 · Raum 1“ / „Morgen, ganztägig“, data
  `{ calendar: { eventId, occurrence } }` (`facts` with the place); several in one minute: „3 Termine um 9:00“. Topic
  `calendar_invite` (internal invitations): title = the organizer, text „Einladung: <Titel>, <Zeit>“, data
  `{ calendar: { invitationId } }`.
* Live event `calendar` `{ kind: 'changed', calendarId, accountId, from?, to? }` | `{ kind: 'calendars' }` |
  `{ kind: 'invitation', invitationId, messageId }` and `contacts` `{ kind: 'changed', addressbookId, contactIds? }` |
  `{ kind: 'addressbooks' }` | `{ kind: 'groups' }`; a mail with a new invitation card: `mail` with its `messageId`.

### Service for other plugins

`new_draft` `{ files: [{ mediaId, name? }], subject? }` → `{ ok, draftId }` — files the caller handed over first
(Drive: "Per Mail senden"); a draft of the person's first account.

## Licence and people

Like Drive (same codes and words): the signed plugin token carries `tier` (`family` | `business` | `combo`) and
`seats { included, family, business }` (`gc.license.info`). A person the administrator allows gets a **place** of their
kind the first time they use Mail, while the licence has room — the only kind of the licence, on `combo` `family` for a
member of a family group (GateControl groups), `business` otherwise. `family` counts against the family people,
`business` against the business people, `combo` shares the included ones (`seats.total`). Without a place `GET me`
answers `seat: null` and everything else `403 no_seat` (the portal shows the note "Mail ist für dich noch nicht
freigeschaltet"); without a valid licence `403 not_licensed`, and nothing is synced or sent. People with a place keep
working when the licence gets smaller (the settings page says "überschritten"). A licence without `tier` (lifetime, plan)
counts nobody. Seats of people no longer allowed or whose GateControl account is gone do not count.

## Portal

The tab „Mail“ of the portal (`ui/portal.js`, since 1.3.0 with `ui/calendar.js`, `ui/contacts.js` and the plain logic
`ui/pimlogic.js`): the menu with its foot (the settings on the left, Kontakte and Kalender on the right — only with
`features.contacts` / `features.calendar`; an account is added in the settings), the mail as before, the invitation card
of a mail; **Kalender** with the calendars grouped (GateControl, each account, shown alongside), Tag / Woche / Monat /
Liste, looking at, answering, editing (a PATCH sends only what changed; series: this one or all) and deleting events;
**Kontakte** with search, letters, groups, a contact, editing with the etag, duplicates, vCard import and export. A
Microsoft account with `missingScopes` gets the band „Kalender und Kontakte freigeben“ — „Neu anmelden“ by device code.

## Administration

Plugins › Mail › Einstellungen (the page `settings`, `ui.settingsPage`): who may use Mail (everybody, or people and
groups — `GC.pickPrincipals`), accounts per person (1…20), retention (1/3/6/12/24 months or all), attachments
(`on_demand` / `always`), quota per person (1…100 GB) with what is used in all and per person, AI (`bar`, `sort`,
`autoFile`, `blockBusiness`), Microsoft (`registration: 'default'|'custom'`, `customClientId`, the consent link
`https://login.microsoftonline.com/organizations/v2.0/adminconsent?client_id=<id>&scope=https://graph.microsoft.com/.default`).
The card **Personen und Lizenz** (since 1.1.0): tier, "x von y Personen", exceeded / full with the hint to add people in
the account on callmetechie.de, "Lizenz jetzt abrufen", every person with their place (Familie / Business / abgeschaltet
— switched off: no place, never given again on its own; their accounts rest).
Admin API `GET|PUT admin/settings` (with `seats`), `GET admin/overview` (with `seats`), `PUT admin/seats/<userId>`
`{ kind: 'family' | 'business' | null }` → `{ seat, seats }` (409 `seat_kind` | `seat_limit`), `POST admin/license/refresh`
→ `{ refreshed, seats }`. Administrators see numbers only — never anybody's mail.
Since 1.2.0 the settings `calendar: { enabled, accounts, business: 'gatecontrol' | 'exchange', defaultReminder (0 | 5 |
10 | 15 | 30 | 60 | 1440 | null), internalInvites, overlays: { familie, alltag, birthdays } }` and `contacts: { enabled,
accounts, ai }`; `usage.people[]` with `calendars`, `events`, `contacts`, `pimBytes`, `GET admin/overview` with `pim:
{ calendars, events, contacts, bytes }` — numbers only, never an event or a contact. `microsoft.registrationNeeds`: the
app registration needs `Calendars.ReadWrite` and `Contacts.ReadWrite` besides the mail. The page shows both (since
1.3.0): the cards „Kalender“ and „Kontakte“, the numbers per person in the storage table and in the overview, and the
rights of the Microsoft registration.

**Microsoft app registration**: `DEFAULT_MS_CLIENT_ID` (`server/config.js`) is `null` until the publisher's registration
exists — until then `features.microsoft` is off unless an administrator enters an own client id (Microsoft Entra:
public client; redirects `msauth://com.gatecontrol.client/<signature hash>` for Android, `http://localhost` for Windows,
"Allow public client flows" for the device code; delegated permissions `User.Read`, `Mail.ReadWrite`, `Mail.Send`,
`offline_access`; since 1.2.0 also `Calendars.ReadWrite` and `Contacts.ReadWrite` — companies that block user consent
open the admin consent link again).

## Development

`node tools/test.js gatecontrol-mail` — the mock host as GateControl 1.216.0 (and 1.217.0: `smtp.verify`, `bodyMedia`; 1.219.0: `gc.mail.dav`, iMIP) with a fake IMAP / SMTP world, a fake
Microsoft (token endpoint and Graph), fake Drive and Familie and the mock host's `gc.ai` (`test/helpers.js`); a fake
CalDAV/CardDAV server, Graph's calendars and contacts, Familie's and Alltag's calendars (`test/pim-helpers.js`). No network.

Vendored, unchanged (`server/vendor/`): ical.js 2.2.1 (`dist/ical.es5.cjs`, MPL-2.0, `LICENSE-ical.js.txt`) and
timezones-ical-library 2.3.2 (`dist/cjs/index.js`, Apache-2.0, `LICENSE-timezones-ical-library.txt`).
