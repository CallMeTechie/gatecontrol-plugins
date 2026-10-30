# gatecontrol-mail — Mail

Every mail account of a person in one place: GMX, WEB.DE, T-Online, Gmail (app password), Outlook.com and Microsoft 365
(Microsoft sign-in) or any IMAP account. The server keeps a copy (headers, flags, bodies within a quota), so the apps
and the portal show one posteingang of all accounts ("Alle Posteingänge") with **Relevant** and **Sonstige**, push for new
mail, pictures only on request (tracking pixels removed), attachments into Drive (with a suggestion, or on their own) and
from Drive, and AI ("Kurz gesagt", "Zu tun", reply suggestions) through GateControl's AI provider.

*Deutsch:* Alle E-Mail-Konten an einem Ort – ein Posteingang mit Relevant und Sonstige, Push, Schutz vor Zählpixeln,
Anhänge in Drive und KI. Details im CHANGELOG.

Needs **GateControl ≥ 1.216.0**: `gc.mail` (IMAP sessions with IDLE, SMTP, MIME, the HTML sanitizer, autoconfig —
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

## API (apps and portal)

`/api/v1/client/plugins/gatecontrol-mail/api/<path>` (device token) and `/api/v1/portal/plugins/gatecontrol-mail/api/<path>`
(a signed-in portal viewer). Only people the administrator allows (`403 not_allowed`; the app tab is hidden for them —
`appVisible`) and who have a place in the licence (since 1.1.0, like Drive — see "Licence and people": `GET me` answers
with `seat: null`, everything else `403 no_seat`; without a valid licence `403 not_licensed`). IDs are positive integers, times ms since the epoch. Errors: `{ error: { code, message, … } }` with
400 `invalid { field }`, 403 `forbidden | not_allowed | no_seat | not_licensed | limit { max } | login_required |
images_blocked`, 404 `not_found`, 409 `auth_failed { hint, server? } | imap_disabled { hint } | unreachable { server? } |
tls { server? } | exists | ai_off | ai_unavailable | seat_limit | seat_kind
| familie_unavailable | drive_unavailable | no_folder | not_waiting | microsoft_off | attachments_unsupported |
images_off | links_disabled | busy { retryAfter?, reason? }`, 413 `too_large { max }`, 429 `rate_limited`. `busy`: the provider
throttles, or (`reason: 'loading'`) an attachment is still on its way — ask again after `retryAfter` s (since 1.1.2 409,
before 503).

### Account, state

| | |
|---|---|
| `GET me` | `{ features, limits: { accountsMax, quotaBytes, usedBytes, retentionMonths }, microsoft: { clientId \| null, authority, scopes }, accounts: [Account], unread: { all, byAccount }, settings: { threads, swipeLeft, swipeRight }, seat: 'family' \| 'business' \| null, licence: { valid, tier } }` — features `mail`, `ai`, `microsoft`, `drive`, `familyCalendar`, `images`; `seat` / `licence` since 1.1.0 (answered also without a place) |
| `PUT settings` | `{ threads?, swipeLeft?, swipeRight? }` (`archive \| delete \| read \| none`) → `{ settings }` |
| `GET providers` | `[{ id, label, auth: 'password' \| 'app_password' \| 'microsoft' \| 'imap', hint: { de, en } \| null, help }]` |
| `POST accounts/discover` | `{ email }` → `{ provider, auth, imap, smtp, hint }` (known domains, else `gc.mail.autoconfig`) |
| `POST accounts` | `{ provider, email, password, username?, name?, color?, kind?, imap?, smtp? }` → `{ account }` — the IMAP login is tried first, on GateControl ≥ 1.217.0 the SMTP login too (`gc.mail.smtp.verify`; its refusal names `server: 'smtp'`) |
| `POST accounts/microsoft` | `{ code, codeVerifier, redirectUri, name?, color?, kind? }` → `{ account }` — the server redeems the code (public client, PKCE, no secret). `redirectUri`: `msauth://com.gatecontrol.client/<…>` or `http://localhost[:port][/path]` |
| `POST accounts/microsoft/device` | `{ kind? }` → `{ deviceId, userCode, verificationUri, expiresIn, interval }` |
| `GET accounts/microsoft/device/<deviceId>` | `{ status: 'pending' \| 'done' \| 'expired' \| 'denied', account? }` — asks Microsoft at most every `interval` s |
| `PATCH accounts/<id>` | `{ name?, color?, kind?, push?, ai?, attachments?, signature?, password? }` → `{ account }` (a new password is tried first: IMAP, and SMTP on ≥ 1.217.0) |
| `POST accounts/<id>/microsoft` | `{ code, codeVerifier, redirectUri }` → `{ account }` (signed in anew; another address → `invalid`) |
| `DELETE accounts/<id>` | `{ ok }` — the server's copy goes, the mail at the provider stays |

`Account` = `{ id, provider: 'gmx'|'webde'|'tonline'|'gmail'|'outlook'|'m365'|'imap', email, name, color ('#RRGGBB'), kind:
'personal'|'business', state: 'ok'|'syncing'|'auth_failed'|'unreachable', error: { code, at } | null, push:
'off'|'relevant'|'all', ai, attachments: 'off'|'suggest'|'auto', signature }`. A Microsoft sign-in of an address the
person has already signs that account in anew (also at the account limit).

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

### Push and live events

* Topic `mail`: title = sender, text = subject, data `{ mail: { messageId, accountId } }` — per the account's `push`
  (`relevant`: mail of the tab Relevant); more new mail of a person in one run → one push "3 neue Mails" (data of the
  newest). Topic `mail_failed`: data `{ mail: { outboxId } }`.
* Live event `mail` `{ kind: 'changed', accountId, folderId }` — load the lists again. Since 1.1.2 also with `messageId`
  (the body the answer did not wait for is there — load the open mail again; with `attachmentId`: that attachment) or
  `threadId`; a long sync sends it while it goes on (at most every 5 s per folder).

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

**Microsoft app registration**: `DEFAULT_MS_CLIENT_ID` (`server/config.js`) is `null` until the publisher's registration
exists — until then `features.microsoft` is off unless an administrator enters an own client id (Microsoft Entra:
public client; redirects `msauth://com.gatecontrol.client/<signature hash>` for Android, `http://localhost` for Windows,
"Allow public client flows" for the device code; delegated permissions `User.Read`, `Mail.ReadWrite`, `Mail.Send`,
`offline_access`).

## Development

`node tools/test.js gatecontrol-mail` — the mock host as GateControl 1.216.0 (and 1.217.0: `smtp.verify`, `bodyMedia`) with a fake IMAP / SMTP world, a fake
Microsoft (token endpoint and Graph), fake Drive and Familie and the mock host's `gc.ai` (`test/helpers.js`). No network.
