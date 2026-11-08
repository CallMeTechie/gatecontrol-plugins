# gatecontrol-notizen — Notizen & Aufgaben

The hub of a person's tasks and notes: own tasks and notebooks plus everything "to do" from the other plugins (Familie,
Mail, Drive, Schule, Alltag) in one place — „Mein Tag“, Wichtig, Geplant, Mir zugewiesen, lists and list groups,
notebooks with tags, check lists, tables and pictures, full-text search, Tresor notebooks (end-to-end encrypted), a
quick entry in plain language and the move from Microsoft To Do and Synology DS Note. The areas **Privat** and
**Arbeit** are kept apart (like Drive's photos). The original of an item of another plugin stays there: ticking it off
here ticks it off there, tapping it opens it there.

*Deutsch:* Eigene Aufgaben und Notizen plus alles „Zu tun“ aus den anderen Plugins an einer Stelle. Details im
HANDBUCH.md und CHANGELOG.

Needs GateControl ≥ 1.216.0 (`services.provides.<name>.maxPerHour`, `GC.keys`, `GC.mediaBytes`, `gc.events`, media
previews). Opening an item of another plugin from the portal uses `GC.openPortal` (GateControl ≥ 1.254.0, feature-
detected — without it the portal says „In <Plugin> öffnen“). The move from Microsoft To Do needs GateControl Mail ≥
1.12.0 (`gatecontrol-mail:ms_tasks_token`). The sources need their own releases that speak
[`docs/notes-sources-contract.md`](../../docs/notes-sources-contract.md) (of this repository).

Licence: `"license": { "required": true }` like GateControl Drucken & Scannen (price and tiers live in the licence
server, not here).

## Areas and rights

| Thing | Who | Notes |
|---|---|---|
| List | its owner and its members (shared lists) | every member reads and writes its tasks; only the owner renames, colours, shares or deletes it; a member leaves it |
| List group | one person | each member files a shared list into a group of their own |
| Notebook | its owner and its members | like lists; a Tresor notebook as below |
| Notebook kept for a plugin | the members the plugin names (`notes_bind`) | Familie's Pinnwand and Packlisten — nobody deletes or shares it here |
| Item of another plugin | the people its source lists in `users` | never more than they see in the source |

Every list and notebook has an area (`private` | `work`); every screen asks for one area. Each person gets a default
list „Aufgaben“ and a default notebook „Notizen“ per area on first use. Sharing (setting *sharing*): `all` (everyone with
an account), `groups` (people one shares a GateControl group with), `off`.

Portal viewers recognised only by device trust (`loggedIn: false`) may read, not change (`403 { reason: 'login' }`);
kiosk devices get nothing.

## API

The same routes for the portal (`/api/v1/portal/plugins/gatecontrol-notizen/api/…`) and the apps
(`/api/v1/client/plugins/gatecontrol-notizen/api/…`). Answers `{ ok: true, … }`; refusals `{ ok: false, code, … }` with
`400 invalid { field }`, `403 forbidden`, `404 not_found`, `409 conflict | not_member | encrypted | stale_key |
consent_required`, `413 too_large`, `429 busy`, `503 unavailable { reason }`, `507 quota`.

```
GET    me                       → { user, lang, today, time, timezone, features, prefs, sharing, vaults, imports, attachMB, readOnly }
GET    nav?area=                → { area, smart: { myday, important, planned, assigned }, sources: [{ plugin, label, hint, open }],
                                    lists: [List], groups: [{ id, name, area }], notes: { total, notebooks: [Notebook], tags: [{ tag, count }] } }
GET    views/<name>?area=       → { view, title, sections: [{ id, title, count, items: [Task | Item], collapsed? }] }
                                    name: myday (events, overdue, today, upcoming = next 14 days, done = done today) | important |
                                    planned (overdue, today, tomorrow, week, later) | assigned | list:<id> (open, done) | source:<plugin> (by group)
POST   parse { text, area? }    → { parsed } — the quick entry as the server reads it (ui/quickparse.js)
GET    people                   → { people: [{ id, name, avatarUrl, colorHex, initials, me }] } — whom one may share with
GET    search?q=&area=          → { tasks: [Task], notes: [NoteSummary + hit], items: [Item] }  (q 2…200 characters)
GET    prefs · PUT prefs { … }  → { prefs }  (see "A person's choices")
GET    sources                  → { sources: [{ plugin, label, hint, enabled, available, open, lastSync, error, groups: [{ id, label, count }] }] }
POST   sources/<plugin>/sync    → { scheduled, reason? } — a reconciliation soon (at most every 10 minutes)

GET    lists?area=              → { lists: [List], groups }
POST   lists { name, area, color?, groupId? }                → { list }
PATCH  lists/<id> { name?, color?, area?, groupId?, position? } → { list }
DELETE lists/<id>               → { ok, left? } — the owner deletes (tasks into the trash), a member leaves
PUT    lists/<id>/members { members: [userId…] }           → { list } — the owner; new members get the push topic `shared`
POST   groups { name, area } · PATCH groups/<id> { name?, position? } · DELETE groups/<id>

POST   tasks { title | text, listId?, area?, note?, important?, due?: { date, time? } | null, remindAt?: ISO | { date, time } | null,
               repeat?: Rule | null, assigneeId?, myDay?, parentId? (a sub task), createList? (text names a new list) }
                                → { task, parsed? }
GET    tasks/<id>               → { task: Task + { note, subtasks: [{ id, title, done }], list, attachmentList, sourceItem? } }
PATCH  tasks/<id> { title?, note?, important?, due?, remindAt?, repeat?, assigneeId?, listId?, position?, myDay? } → { task }
POST   tasks/<id>/complete { done } → { task, next? } — a repeating task gets its next one (`next`)
DELETE tasks/<id>               → { ok } (the trash: purged after 30 days)

GET    items/<id>               → { item, taskId } — an item of another plugin
POST   items/<id>/complete { done } → { item } — ticked off in its plugin (todo_complete); 403 read_only, 503 unavailable
POST   items/<id>/carry         → { task } — the item gets a hub task of its own (sub tasks, note, reminder; completing it
                                  ticks the item off; the source ticking it off ticks the task) — once per person

GET    notebooks?area=          → { notebooks: [Notebook], tags, total }
POST   notebooks { name, area, color? } · PATCH notebooks/<id> { name?, color?, area?, position?, nameCipher? (Tresor) }
DELETE notebooks/<id> · PUT notebooks/<id>/members { members }
GET    notes?area=&notebook=&tag=&pinned=1&before=<updatedAt>:<id>&limit=  → { notes: [NoteSummary], next }  (newest first)
POST   notes { notebookId?, area?, title?, body?, pinned?, color?, due?, expiresAt? }       → { note }
       (Tresor: { notebookId, titleCipher, cipher, keyVersion })
GET    notes/<id>               → { note: NoteSummary + { body | cipher, notebook, attachments: [Attachment], tasks: [{ id, title, due, done }] } }
PATCH  notes/<id> { title?, body?, pinned?, color?, due?, expiresAt?, notebookId?, rev? } → { note } — `rev` given and stale → 409
POST   notes/<id>/check { line, done } → { note } — a check box of the text (a line that became a task ticks it too)
POST   notes/<id>/task { line, listId?, due?, myDay? } → { task, note } — the line becomes a task, the line gets „[Aufgabe](task:<id>)“
DELETE notes/<id>

POST   attachments { kind: 'note' | 'task', refId, mediaId, name | nameCipher } → { attachment } — the upload first
       (GC.upload / PUT …/media); setting attach_mb per file, quota_mb per person
GET    attachments/<id>         → { attachment } (a fresh signed `url`, 1 h) · DELETE attachments/<id>
PUT    attachments/<id>/text { text } → { ok } — recognised text of a picture (on-device OCR) for the search

POST   vaults { id, area, nameCipher, recoveryPub, recoveryAuth, recoveryWrap, device: { publicKey, name?, platform? }, wrap } → { vault, notebook }
GET    vaults · GET vaults/<id> · GET vaults/<id>/keys?deviceId= · GET|PUT vaults/<id>/recovery · GET|POST vaults/<id>/devices
POST   vaults/<id>/devices/<deviceId>/approve { wraps | wrap, via?: 'recovery', recoveryAuth? } · DELETE vaults/<id>/devices/<deviceId>
POST   vaults/<id>/rotate { keyVersion, wraps: [{ deviceId, wrap }], recoveryWrap | recovery: { pub, auth, wraps } }
       — exactly Drive's vault routes and rules (gatecontrol-drive README "Vault folders"), with the notebook's vault id

GET    import/mstodo/accounts   → { available, reason?, accounts: [{ id, email, label, kind, tasks }] }
POST   import/mstodo/consent { accountId, deviceId? } → { deviceId, userCode, verificationUri, expiresIn, interval } | { status }
GET    import/mstodo/preview?accountId= → { lists: [{ id, name, open, done, attachments, area, wellknown, shared, include }], totals }
POST   import/mstodo/start { accountId, lists: [{ id, name?, area, include }], doneDays: 0|30|90|365|-1, twoWay } → { job }
GET    import/jobs/<id>         → { job: { id, kind, state: running|done|failed|canceled, stats, error } }
GET    import/mstodo/links · DELETE import/mstodo/links/<id>  (ends the transition period; the list stays)
POST   import/dsnote/start { file, notebooks, notes, bytes } → { job }
POST   import/dsnote/<job>/notebook { ref, name, area? } → { notebookId }
POST   import/dsnote/<job>/notes { notebookId, notes: [{ ref, title, body, tags?, created?, updated?, attachments?: [{ n, mediaId, name }] }] } (≤ 20)
                                → { imported, skipped, ids }  — a Tresor: { ref, titleCipher, cipher, keyVersion, …, attachments: [{ n, mediaId, nameCipher }] }
POST   import/dsnote/<job>/finish { skipped?, protectedSkipped? } → { job }
```

```
Task  = { uid: 't:<id>', type: 'task', id, listId, parentId, title, hasNote, important, done, doneAt, due: { date, time } | null, overdue,
          remindAt (ISO with offset), repeat: Rule | null, repeatText, assignee: { id, name } | null, myDay, progress: { done, total } | null,
          attachments, source: { plugin, id } | null, noteId, position, canComplete: true, updatedAt }
Item  = { uid: 's:<id>', type: 'source', id, kind, title, subtitle, source: { plugin, label, open: { plugin, route } }, due, show (the date and time
          it shows on — the evening before for lead 'evening'), allDay, lead, overdue, area, important, done, doneAt, canComplete,
          assignee: { id, name } | null, progress, group: { id, label } | null, meta, updatedAt }
List  = { id, name, area, color, icon, isDefault, owner: { id, name }, role, groupId, position, shared, members: [{ id, name }], open, ext }
Notebook = { id, name (null in a Tresor), area, color, isDefault, role, owner, members, shared, vault: { id, nameCipher, keyVersion, needsRotation } | null,
          bound: { plugin, key, kind, label } | null, count, position }
NoteSummary = { id, notebookId, title (null in a Tresor), snippet, titleCipher, keyVersion, encrypted, pinned, color, due, expiresAt,
          check: { done, total } | null, images, files, tags, ext, createdAt, updatedAt, updatedBy, rev }
Attachment = { id, kind, refId, name | null, nameCipher, mime, bytes, encrypted, hasText, url, createdAt }
Rule  = ui/repeat.js
```

Live updates: `gc.events` type `changed` `{ what: ['tasks' | 'notes' | 'items' | 'lists' | 'notebooks'] }` (merged per
second) and `vault` `{ vault, event: 'request' | 'approved', device }` — clients fetch again. Pushes: topics
`reminders`, `shared`, `vault`, `data.notizen = { task | list | notebook | vault }`.

Opening: an item's `source.open` → apps `gatecontrol://plugin/<plugin>/<route>`, portal `GC.openPortal({ plugin,
query: { open: route } })`; a note of Familie's notebooks is `{ plugin: 'gatecontrol-notizen', route: 'note/<id>' }`.

## A person's choices (`prefs`)

```
{ area: 'private'|'work', evening: 'HH:MM' (18:00),
  sources: { <plugin>: { on, kids: 'all'|'mine'|'none' (Familie), shoppingInMyDay (Familie), flagged (Mail), evening (Alltag) } },
  groups: { '<plugin>|<group id>': 'private'|'work'|'hide' },   // Mail accounts, Schule children …
  times: { morning, noon, afternoon, evening, night } }       // the quick entry's words „früh“, „abends“ …
```

## The other plugins (sources)

[`docs/notes-sources-contract.md`](../../docs/notes-sources-contract.md) is the contract. In short: a source pushes its
changes (`gatecontrol-notizen:todo_changed`, `maxPerHour: 3600`), the hub keeps a copy (`src_items`, who sees what in
`src_item_users`) and answers every screen from it, reconciles about every 12 hours per person and source and on
„Jetzt abgleichen“ (`<source>:todo_items`, paged, ≤ 300 calls an hour per source against the source's 600) and ticks
off with `<source>:todo_complete`. GateControl's 60 service calls an hour are never touched: every service in both
directions declares its own `maxPerHour`. No host change was needed for this.

Reconciliations only for people who opened the hub within 30 days. A source the administrator switches off (settings
*source_*) or that goes away (`gc.services.available` false) is hidden at once and its copy purged after 7 days.

### Services this plugin provides

| Service | Who calls | What |
|---|---|---|
| `todo_changed` | Familie, Mail, Drive, Schule, Alltag | `{ v: 1, upsert: [Item] ≤ 200, remove: [id] ≤ 500 }` → `{ ok, accepted, removed, rejected }` |
| `notes_bind` | Familie | `{ key, title, kind: 'notes'|'checklists', members, area? }` → `{ ok, notebookId }` |
| `notes_list` | Familie (with the person) | `{ key, cursor?, since? }` → `{ ok, notes, cursor, removed? }` (≤ 16 KB) |
| `note_save` · `note_check` · `note_delete` | Familie | see the contract § 3 |
| `notes_import` | Familie | the one-time move of the Pinnwand and the packing lists (idempotent per `ref`) |

A bound notebook's check list item id is `<line>.<first 6 hex of SHA-256 of its text>` (found again by its text when
lines move). Changes made in the hub reach Familie through `gatecontrol-familie:notes_changed` (at most once a minute
and notebook, 30 s after the last change); changes Familie makes itself are not echoed.

## The quick entry (ui/quickparse.js)

Deterministic, no AI, the same code in the server and the portal, ported 1:1 by the apps:
`parse(text, { today, now?, lists, people, times }) → { title, date, time, remind, important, list, listName,
assignee, assigneeName, repeat, marks }`. Understood words: README of the module (head comment) and the handbook;
**test/vectors/quickparse.json** (51 cases, `today` 2026-11-08, a Sunday) is what every port must give. Rules worth
knowing: a weekday means the next such day after today; a time alone means today, or tomorrow when it is over; a
reminder is set when date and time are given; `@name` matches the first word of a person's name, `#list` a list
without case, spaces and dashes (or the only one starting with it — else `listName` for „Neue Liste …“).

## Repeat rules (ui/repeat.js)

`{ type: 'daily'|'weekly'|'monthly'|'yearly'|'after', interval, days?: [1…7], day?, month? }` — every n days, weeks on
weekdays (weeks counted Monday-based from the due date), months on a day (clamped to the month's end, the start day
kept: 31 → 28 → 31), years, or n days after completion. `next(rule, { due, done })` never lands on or before the day
it was completed. Completing a repeating task makes the next one (sub tasks unticked, the reminder moved by the same
days) and leaves the done one without a rule. Vectors: **test/vectors/repeat.json**.

## The text of a note (ui/notemd.js)

Markdown — CommonMark with GitHub's tables and task lists — so every client can render it with its own library
(Android: Markwon, Windows: markdown-it) and it stays readable as text: `#`–`###` headings, **bold**, *italic*,
~~strike~~, `code`, code blocks, quotes, lists, `- [ ]` / `- [x]` check boxes, tables, `---`, links (http, https, mailto
only), `![name](att:<attachment id>)` pictures and `[name](att:<id>)` files of the note, `[Aufgabe](task:<id>)` the task a
line became, `#tags` in the text (lower case; headings and code are not tags). Raw HTML is never rendered. The server
keeps the plain text (search, snippet), the counts of check boxes and the tags (`note_tags`, per notebook in
`notebook_tags`).

## Search

SQLite FTS5 (`unicode61 remove_diacritics 2`: „Zahnärztin“ is found with „zahnarzt“), every word a prefix, all words
needed. Tasks (title, note) and notes (title, text, tags, recognised text of pictures). Few matches are ranked (bm25);
many matches (a common word) give the newest 400 unranked — ranking tens of thousands of rows costs ~100 ms. Items of
other plugins are matched by title in memory. Tresor notes are never indexed.

**Recognised text of pictures (OCR):** GateControl has no OCR service for plugins in general (only `gc.print.ocr`
through a gateway with tesseract, made for scans into PDFs). Step 1: a device sends the text it recognised itself
(`PUT attachments/<id>/text` — Android ML Kit, Windows.Media.Ocr); the portal does not recognise text.

## Tresor-Notizbücher – Kryptografie

A Tresor notebook is end-to-end encrypted with **Drive's vault format** (gatecontrol-drive README "Tresor-Ordner –
Kryptografie", its `ui/vaultcrypto.js`) **byte for byte, with one change: every label starts with `gcnotes-v1`
instead of `gcdrive-v1`** (domain separation: a key or wrap of one plugin never opens anything of the other). A client
that has Drive's code takes the prefix as a parameter. Reference: `ui/vaultcrypto.js`; frozen vectors
`test/vault-vectors.json` (the same inputs as Drive's, plus a note); `test/vault.test.js` reads them with a second
implementation using only Node's `crypto`.

| Item | Definition |
|---|---|
| Device key | X25519 per device; portal: WebCrypto, not extractable, `GC.keys` name `notes-device-<userId>`; Android Keystore; Windows DPAPI |
| Device id | `base64url(SHA-256("gcnotes-v1:device:" ‖ publicKey)[0..16])` |
| Safety number | `SHA-256("gcnotes-v1:fingerprint:" ‖ publicKey)`, 4 × uint32 mod 100000, 5 digits each |
| Notebook key TK | 32 random bytes per Tresor and key version |
| `wrap` | `0x01 ‖ enc (32) ‖ ct (48)`: HPKE base, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM, `info = "gcnotes-v1:tk:<vaultId>:<keyVersion>"` |
| Name cipher | `0x01 ‖ keyVersion ‖ nonce (12) ‖ AES-256-GCM(HKDF(TK, "gcnotes-v1:name:<vaultId>"), pad(name))` — the notebook's name, a note's title, an attachment's name |
| Content | header `"GCDV" ‖ 0x01 ‖ keyVersion ‖ chunkSize ‖ salt (16)`, AES-256-GCM chunks with `HKDF(TK, salt, "gcnotes-v1:content:<vaultId>")` — a note's Markdown (UTF-8, base64url in `cipher`, ≤ 1 000 000 characters) and every attachment (uploaded as `application/octet-stream`) |
| Recovery key | 56 characters (Crockford base32 with a BLAKE2b check, the Vault plugin's format); X25519 from `HKDF(key, "gcnotes-v1:recovery")`, proof `HKDF(key, "gcnotes-v1:recovery-auth")` (the server keeps its SHA-256) |

The server keeps ciphertext, sizes, times, public keys and wraps only (`test/vault.test.js` searches every table for
a title, a text, a key and the recovery key). Who may use a Tresor: its members; a member taken out loses their
devices' wraps and the Tresor asks for a new key (`needsRotation`, the rotation wraps for exactly the approved devices).
What a Tresor notebook does not have: search, tags, check boxes ticked by the server, a line to a task, moving notes
out of it. The portal locks the keys after 15 minutes without use and when the page is left.

## Umzug aus Microsoft To Do

Through the Microsoft account the person signed in with in GateControl Mail. Mail ≥ 1.12.0 provides (caller
`gatecontrol-notizen` only, `maxPerHour: 600` each): `ms_accounts`, `ms_tasks_consent` (Microsoft's device code with
the scope `Tasks.ReadWrite` added — incremental consent; the account's mail keeps working meanwhile) and
`ms_tasks_token` (an access token for **only** `Tasks.ReadWrite`, from Mail's refresh token — Mail's mail token never
leaves Mail; cached here until shortly before it ends). The hub calls Microsoft Graph itself (`graph.microsoft.com`).

Lists → lists (named like work — Arbeit, Büro, Projekt, Firma, Work, Office … — to the area Arbeit, changeable per list
before the import; „Markierte E-Mails“ left out by default), tasks with sub tasks (`checklistItems`), note (HTML to
text, linked resources as lines), due date, reminder, importance, recurrence, completed ones of the chosen last days,
attachments (`gc.media.fetch` from `…/attachments/<id>/$value`, up to 20 a task). The job runs in the background, ≤ 40
Graph requests a minute.

**Transition period** (setting *mstodo_sync*, the person's switch at the import): every 5 minutes per list, changes made
here go to To Do (new, title, note, due date, reminder, importance, done, deleted) and To Do's changes come back (Graph
delta). Both changed the same task: the later change wins. Sub tasks are not kept in step after the import. Ending it
(`DELETE import/mstodo/links/<id>`) leaves the list here.

## Umzug aus DS Note

The device reads the **.nsx export** itself (`ui/nsx.js`: ZIP with ZIP64, `config.json`, a JSON entry per notebook and
note, `file_<md5>` per attachment; pictures in the text by their `ref`) — the export is never uploaded as a whole
(1.4 GB of pictures go one by one through `GC.upload`). HTML becomes Markdown (headings, bold, italic, lists, check
lists, tables, links, pictures); tags become `#tags`; times are kept. Each notebook once per `ref`, each note once per
`ref` (an import can be repeated).

**Protected notes (decision):** DS Note does not document how it encrypts them. The device tries the password the person
enters on the content in the CryptoJS / OpenSSL passphrase form (`U2FsdGVkX1…`: `Salted__` ‖ salt ‖ AES-256-CBC, key and
IV by EVP_BytesToKey with MD5) — what DSM's web pages use. If it opens, the notebook's protected notes go into a **new
Tresor notebook** made on the device (the recovery key is shown first) — encrypted there, the server never sees them.
If not (another format, a wrong password, no password), they are **skipped and counted**, with the hint to remove the
protection in DS Note and export again. Not tested against a real DS Note export yet.

**Straight from the NAS: not offered.** GateControl Synology signs in to DSM with the administrator's monitoring account
and uses only system APIs and File Station; DS Note's notes belong to each NAS user and its API (`SYNO.NoteStation.*`)
is undocumented. Fetching them would need the person's own DSM password in the hub and a new, undocumented API in the
Synology plugin — left out; the mockup's „Direkt von der NAS“ is a hint how to export instead.

## Background (every minute)

Reminders as pushes (topic `reminders`, to the assignee or else the creator, once; a reminder missed by more than 6 hours
is dropped), notes whose `expiresAt` came, `notes_changed` to Familie, the sources (availability, due reconciliations
within the budgets, done items without news after 36 h), the To Do import and the transition period; hourly the trash
(tasks and notes after 30 days, with their attachments) and old „Mein Tag“ marks.

## Speed

Every query of the screens and the background runs on an index (`migrations/001_init.sql`; `INDEXED BY` where SQLite
should not choose). `test/speed.test.js`: 50 000 tasks and 50 000 notes of one person, 600 items of a source — every
statement of nav, the four smart lists, a list, a source, notes (all, pinned, by tag, a notebook, a page), notebooks,
five searches, a new task and note, the background run and a push of 200 items stays under 200 ms (the slowest ~15 ms
in the mock host's SQLite).

## Development

`node tools/test.js gatecontrol-notizen` — the mock host as GateControl 1.216.0 with fake sources (`test/helpers.js`), a
fake Microsoft Graph and Mail (`test/mstodo.test.js`), the .nsx fixture (`node test/fixtures/build-nsx.js` writes
`test/fixtures/sample.nsx`), the portal in a small DOM (`test/fake-dom.js`).
