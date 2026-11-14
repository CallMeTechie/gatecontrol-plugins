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
| List | its owner and its members (shared lists) | members with role `write` read and change its tasks, `read` members only read (and complete what is assigned to them); only the owner renames, colours, sets days, shares or deletes it; a member leaves it |
| List group | one person | each member files a shared list into a group of their own |
| Notebook | its owner and its members | like lists (roles `write` / `read`); a Tresor notebook as below |
| Notebook kept for a plugin | the members the plugin names (`notes_bind`) | Familie's Pinnwand and Packlisten — nobody deletes or shares it here |
| Item of another plugin | the people its source lists in `users` | never more than they see in the source |

Every list and notebook has an area (`private` | `work`); every screen asks for one area. Each person gets a default
list „Aufgaben“ and a default notebook „Notizen“ per area on first use. Sharing (setting *sharing*): `all` (everyone with
an account), `groups` (people one shares a GateControl group with), `off`.

Roles (1.2.0, feature `shareRoles`): `owner` | `write` | `read`. Everything a `read` member may not do is refused with
`403 forbidden { reason: 'read_only' }`: creating, changing (except their own `myDay`), deleting tasks, completing tasks not
assigned to them (or whose parent is not), attachments; in a notebook creating, changing, ticking, deleting notes. The
quick entry does not offer read lists. An owner-only change by a member: `403 forbidden { reason: 'owner' }`.

Portal viewers recognised only by device trust (`loggedIn: false`) may read, not change (`403 { reason: 'login' }`);
kiosk devices get nothing.

## API

The same routes for the portal (`/api/v1/portal/plugins/gatecontrol-notizen/api/…`) and the apps
(`/api/v1/client/plugins/gatecontrol-notizen/api/…`). Answers `{ ok: true, … }`; refusals `{ ok: false, code, … }` with
`400 invalid { field }`, `403 forbidden { reason?: read_only | owner | default | bound, userId? }`, `404 not_found`, `409 conflict | not_member | encrypted | stale_key |
consent_required | unknown_client_id`, `410 gone`, `413 too_large`, `429 busy`, `503 unavailable { reason }`, `507 quota`.
`clientId`, `base`, `gone` and `unknown_client_id`: see [Offline on a device](#offline-on-a-device-110).

```
GET    me                       → { user, lang, today, time, timezone, features, prefs, sharing, vaults, imports, attachMB, readOnly, listIcons }
                                    features 1.2.0: listDays, shareRoles, groupEdit, deleteKeep, listIcons
                                    features 1.3.0: reminderActions, yesterdayOpen, taskCalendar; with
                                    calendar: { available, enabled, mine, name }, yesterday: { push, at } (see "1.3.0")
GET    nav?area=                → { area, smart: { myday, important, planned, assigned }, sources: [{ plugin, label, hint, open }],
                                    lists: [List], groups: [{ id, name, area, position, open }], notes: { total, notebooks: [Notebook], tags: [{ tag, count }] } }
GET    views/<name>?area=       → { view, title, sections: [{ id, title, count, items: [Task | Item], collapsed? }], listdays? }
                                    myday also has listdays (1.2.0): [{ list: List, title, open, assignedToMe, items: [Task] (first 3), more }]
                                    — the lists whose day is today, for every member (not mydayOff, prefs.myday.listdays); done empty when prefs.myday.showDone is false
                                    name: myday (events, overdue, today, upcoming = next 14 days, done = done today) | important |
                                    planned (overdue, today, tomorrow, week, later) | assigned | list:<id> (open, done) | source:<plugin> (by group)
POST   parse { text, area? }    → { parsed } — the quick entry as the server reads it (ui/quickparse.js)
GET    people                   → { people: [{ id, name, avatarUrl, colorHex, initials, me }] } — whom one may share with
GET    search?q=&area=          → { tasks: [Task], notes: [NoteSummary + hit], items: [Item] }  (q 2…200 characters)
GET    prefs · PUT prefs { … }  → { prefs }  (see "A person's choices")
GET    sources                  → { sources: [{ plugin, label, hint, enabled, available, open, lastSync, error, groups: [{ id, label, count }] }] }
POST   sources/<plugin>/sync    → { scheduled, reason? } — a reconciliation soon (at most every 10 minutes)

GET    lists?area=              → { lists: [List], groups }
POST   lists { name, area, color?, icon?, groupId?, clientId? }     → { list, clientId?, replayed? }
PATCH  lists/<id> { name?, color?, icon?, days?, remind?, area? (owner), groupId?, position?, mydayOff? (own), base? } → { list }
GET    lists/<id>/usage         → { open, done, members: [{ id, name, role }], isDefault, canDelete, target: { id, name } | null } (1.2.0)
DELETE lists/<id>?tasks=move|delete → { ok, deleted, moved, removed, target, restoreUntil } | { ok, left } | { ok, gone }
                                  — the owner deletes: move = open tasks into the default list „Aufgaben“ (done ones into the
                                  trash), delete (and no parameter, as in 1.1) = all into the trash; a member leaves; 403 default
POST   lists/<id>/restore       → { list } — „Rückgängig“: the owner, while in the trash (30 days): members, roles, tasks back (1.2.0)
PUT    lists/<id>/members { members: [userId | { id, role: 'read'|'write' }…] } → { list } — the owner; plain ids: new ones
                                  write, the others keep their role; new members get the push topic `shared`
POST   groups { name, area, lists?: [listId…], clientId? } → { group } · PATCH groups/<id> { name?, position? } → { ok, group }
DELETE groups/<id>              — „Gruppe auflösen“: the lists stay, without a group

POST   tasks { title | text, listId?, area?, note?, important?, due?: { date, time? } | null, remindAt?: ISO | { date, time } | null,
               repeat?: Rule | null, assigneeId?, myDay?, parentId? (a sub task), createList? (text names a new list),
               clientId?, listClientId?, parentClientId? }
                                → { task, parsed?, clientId?, replayed? }
GET    tasks/<id>               → { task: Task + { note, subtasks: [{ id, title, done }], list, attachmentList, sourceItem? } }
PATCH  tasks/<id> { title?, note?, important?, due?, remindAt?, repeat?, assigneeId?, listId?, position?, myDay?, base? } → { task }
                                  — 409 conflict { fields, task } when `base` is stale for a field
POST   tasks/<id>/complete { done } → { task, next? } — a repeating task gets its next one (`next`)
POST   tasks/<id>/snooze { until: '1h'|'evening'|'tomorrow'|ISO, tag? } → { snoozed, task }   (1.3.0, see "1.3.0")
POST   tasks/<id>/move { to: 'today'|'tomorrow'|'weekend'|'YYYY-MM-DD' } → { task }              (1.3.0)
GET    yesterday?area=          → { day, title, count, items: [Task], moveOptions: [{ to, date, label }] }   (1.3.0)
POST   yesterday { action: 'done'|'today'|'move', to?, ids?, area? } → { changed, failed: [{ id, code }], yesterday }
GET    reminders                → { now, nowMs, enabled, reminders: [{ tag, taskId, listId, area, title, body, at, atMs,
                                    important, snoozed, collapseKey, actions: [{ id, label }] }], yesterday: { push, at } }
DELETE tasks/<id>               → { ok, gone? } (the trash: purged after 30 days)

GET    items/<id>               → { item, taskId } — an item of another plugin
POST   items/<id>/complete { done } → { item } — ticked off in its plugin (todo_complete); 403 read_only, 503 unavailable
POST   items/<id>/carry         → { task } — the item gets a hub task of its own (sub tasks, note, reminder; completing it
                                  ticks the item off; the source ticking it off ticks the task) — once per person

GET    notebooks?area=          → { notebooks: [Notebook], tags, total }
POST   notebooks { name, area, color?, clientId? } · PATCH notebooks/<id> { name?, color?, area?, position?, nameCipher? (Tresor), base? }
GET    notebooks/<id>/usage     → { notes, withImages, withFiles, members, isDefault, canDelete, vault, target } (1.2.0)
DELETE notebooks/<id>?notes=move|delete → { ok, deleted, moved, removed, target, restoreUntil } | { ok, left } | { ok, gone }
                                  — move into the default notebook „Notizen“ (not a Tresor: 409 encrypted); no parameter = delete
POST   notebooks/<id>/restore   → { notebook } (1.2.0) · PUT notebooks/<id>/members { members: [userId | { id, role }…] }
GET    notes?area=&notebook=&tag=&pinned=1&before=<updatedAt>:<id>&limit=  → { notes: [NoteSummary], next }  (newest first)
POST   notes { notebookId?, area?, title?, body?, pinned?, color?, due?, expiresAt?, clientId?, notebookClientId? } → { note, clientId?, replayed? }
       (Tresor: { notebookId, titleCipher, cipher, keyVersion, clientId? })
GET    notes/<id>               → { note: NoteSummary + { body | cipher, notebook, attachments: [Attachment], tasks: [{ id, title, due, done }] } }
PATCH  notes/<id> { title?, body?, pinned?, color?, due?, expiresAt?, notebookId?, rev? } → { note } — `rev` given and stale → 409 conflict { rev }
                                  (unless the note is already exactly as sent: 200)
POST   notes/<id>/check { line, done } → { note } — a check box of the text (a line that became a task ticks it too)
POST   notes/<id>/task { line, listId?, due?, myDay? } → { task, note } — the line becomes a task, the line gets „[Aufgabe](task:<id>)“
DELETE notes/<id>               → { ok, gone? }

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
          attachments, source: { plugin, id } | null, noteId, position, canEdit, canComplete, updatedAt }
          (1.2.0: canEdit false in a list where the person only reads; canComplete then only for what is assigned to them)
Item  = { uid: 's:<id>', type: 'source', id, kind, title, subtitle, source: { plugin, label, open: { plugin, route } }, due, show (the date and time
          it shows on — the evening before for lead 'evening'), allDay, lead, overdue, area, important, done, doneAt, canComplete,
          assignee: { id, name } | null, progress, group: { id, label } | null, meta, updatedAt }
List  = { id, name, area, color, icon (list|cart|home|tool|gift|plane|heart|work, me.listIcons), isDefault, owner: { id, name },
          role (owner|write|read), canEdit, groupId, position, shared, members: [{ id, name, role, since }] (without the owner), open, ext,
          days: [1…7] (ISO weekdays in „Mein Tag“), remind: 'HH:MM' | null, mydayOff, dayToday }
Notebook = { id, name (null in a Tresor), area, color, isDefault, role, canEdit, owner, members: [{ id, name, role, since }], shared, vault: { id, nameCipher, keyVersion, needsRotation } | null,
          bound: { plugin, key, kind, label } | null, count, position }
NoteSummary = { id, notebookId, title (null in a Tresor), snippet, titleCipher, keyVersion, encrypted, pinned, color, due, expiresAt,
          check: { done, total } | null, images, files, tags, ext, createdAt, updatedAt, updatedBy, rev }
Attachment = { id, kind, refId, name | null, nameCipher, mime, bytes, encrypted, hasText, url, createdAt }
Rule  = ui/repeat.js
```

Live updates: `gc.events` type `changed` `{ what: ['tasks' | 'notes' | 'items' | 'lists' | 'notebooks'] }` (merged per
second) and `vault` `{ vault, event: 'request' | 'approved', device }` — clients fetch again. Pushes: see [Pushes](#pushes).

Opening: an item's `source.open` → apps `gatecontrol://plugin/<plugin>/<route>`, portal `GC.openPortal({ plugin,
query: { open: route } })`; a note of Familie's notebooks is `{ plugin: 'gatecontrol-notizen', route: 'note/<id>' }`.

## 1.4.0 — shopping lists, a list at a task

Features `shoppingLists`, `taskList`, `familyShopping` (check these words in `GET me`, never the version).
`ui/quickparse.js` and `test/vectors/quickparse.json` are **unchanged** — the suggestion below comes from the server.

**The model.** A shopping list is a list (owner, members with roles, icon, list days, trash) of the kind `shopping`. Its
items are no tasks but rows of their own (`shop_items`: text, quantity, ticked) with ids the device makes — the
offline protocol Familie had. It has two ids: `id` (text, made by the device; the same in Familie) and `listId` (the
list's number for `PATCH lists/<n>`, `PUT lists/<n>/members`, `DELETE lists/<n>`, `POST lists/<n>/restore` and for
attaching). Shopping lists are not part of `GET lists` / `nav.lists` (older apps would show empty task lists); a task
cannot be put into one (`400 invalid { field: 'listId', reason: 'shopping' }`).

```
GET  shopping[?since=<serverTime>]
  → { lists: [ShopList], items: [ShopItem], serverTime }
  ShopList { id, listId, name, icon, area, sort, updatedAt, deleted, role, canEdit, canManage, owner { id, name },
             shared, members [{ id, name, role }], family, open, total, assignee, dueAt, going [{ userId, at }],
             tasks [{ id, title }] (the person's open tasks carrying it, ≤ 5), days, remind, mydayOff, dayToday }
  ShopItem { id, listId (the list's text id), text, qty, checked, checkedBy, updatedAt, deleted }
  `lists` is always complete (every list the person sees now); with `since` also the lists deleted since
  ({ id, listId, name, deleted: true, … }) and only the items changed since, tombstones included (kept 30 days). A list
  the device knows that is missing: gone (left, no longer shared). A list it does not know: fetch once without `since`.

POST shopping/ops { ops: [...] }   ≤ 200, in order, idempotent, last write wins by arrival
  → { applied, rejected: [{ index, code: 'invalid' | 'not_found' | 'forbidden' | 'too_many' }], serverTime,
      completed: [{ taskId, title, listId }] }
  list_add { id, name ≤ 40, icon?, area?, family? }   list_rename { id, name, icon? }   list_delete { id }
  item_add { id, listId, text ≤ 120, qty? ≤ 40 }      item_edit { id, text?, qty? }     item_check { id, checked }
  item_delete { id }                                  clear_checked { listId }
  ids: 8–64 of [A-Za-z0-9_-], starting with a letter or digit. Items: canEdit (owner, write). Rename / delete:
  canManage (the owner; of a family list every parent). An id of a list the person does not see → forbidden.

PUT  shopping/lists/<id>/family { on }             share with the whole family (canManage; on: parents only)
POST shopping/lists/<id>/going                     „Ich gehe einkaufen“ and
POST shopping/lists/<id>/assign { userId | null, dueAt?, notify? }   „Kannst du einkaufen gehen?“ of a family list —
  handed to Familie (its cards, pushes, quick actions) → { list, notified, chat? }; 409 unavailable without Familie,
  400 invalid { field: 'family' } for a list that is no family list, Familie's own codes (429 too_soon { retryAfter })
```

`GET me` → `shopping: { family: { available, bound, parent } }`; `GET nav` → `shopping: [{ id, listId, name, icon, open,
total, family, shared, role }]`; the event `changed { what: ['shopping'] }` (the numbers of `attachedList` may have
changed too). `listdays[]` of „Mein Tag“ carries `shopping { id }` and `points [{ id, text, qty }]` for a shopping list.

**A list at a task.** `Task.attachedList { id (the list's number), uid (its text id), name, icon, open, total, done,
family } | null` (null also when the person is no member of that list). Written with `attachedListId: n | null` or
`attachedListUid: '<text id>'` in `POST tasks` / `PATCH tasks/<id>` (`base` knows `attachedListId`). 404 `not_found
{ field: 'attachedListId' }` for a list the person is no member of, 400 `invalid { …, reason: 'kind' }` for a task
list. Sub tasks carry none; a repeating task hands it to its next.

**The suggestion.** `POST parse { text, area? }` → `{ parsed, attach }`, `attach: { via: 'tag' | 'name' | 'word', word?,
list: AttachedList | null, lists: [AttachedList] } | null` — `tag`: `#name` names a shopping list (then
`parsed.listName` is no task list to be made); `name`: the name of a shopping list is a word of the line; `word`: one of
einkaufen, einkauf, einkäufe, besorgen, besorgung, besorgungen, shopping, groceries, grocery — it fits the lists whose
name starts with Einkauf / Lebensmittel / Shopping / Grocer… or that have the icon `cart`, else every shopping list.
`list` when exactly one fits. `POST tasks { text, attach: 'auto' }` attaches it then (→ `attach` in the answer);
without `attach: 'auto'` the server never attaches anything by itself.

**All ticked.** When an `item_check { checked: true }` ticks the last open item of a list (with at least one item),
every open task carrying the list is completed — whoever ticks, wherever (also through Familie). `completed` of the
answer names those the person may see; „Rückgängig“ is `POST tasks/<id>/complete { done: false }`. No push. The list
stays. Nothing happens the other way round, nor by deleting the last open item, `clear_checked`, or attaching a list
that is ticked off already.

**The reminder.** A task with a list: body `"Fällig heute 10:00 · Aufgaben\nEinkauf · 8 Punkte: Milch, Brot, Äpfel,
Butter …"`, `data.notizen.attachedList { id, uid, name, open, total }`, `data.actions`: `open_list` („Liste öffnen“,
type `open_app_route`, target `plg-gatecontrol-notizen`), `done`, `snooze_1h`. `GET reminders` rows carry
`attachedList` and the same three buttons.

**Familie** (≥ 1.21.0, after its move): the services `shopping_bind { members, parents } | { release: true }`,
`shopping_put { lists, items }` (rows of Familie's copy, written when they differ → `{ lists, items, rejected,
completed }`), `shopping_list { since?, cursor? }` (every family list, the items changed since); the hub calls
`gatecontrol-familie:shopping_changed` (a second after a change here, else by the background run) and
`gatecontrol-familie:shopping_action` (going / assign as the person).

## 1.3.0 — reminders with buttons, „Gestern offen geblieben“, the calendar

Features `reminderActions`, `yesterdayOpen`, `taskCalendar` (check these words in `GET me`, never the version).

**Task** — new fields wherever a Task is given:

```
reminder: null | { tag: 'task:<id>:<ms>', at: ISO, atMs, mine, snoozed }   the reminder still to come; mine: this person
                                                                          gets its push (assignee, else the creator; when
                                                                          that one left the list: the owner)
snoozed: bool            „Später“ moved it (a reminder or due date set anew clears it)
missedReminder: bool     it could not be sent any more (server off for over 24 h) — part of „Gestern offen geblieben“
calendar: null | { state: 'synced' | 'pending', eventId?, calendarId?, mine }   its event in Mail's calendar „Aufgaben“
```

**The reminder push** (`server/remind.js`): title the task, body „Fällig heute 09:00 · Liste“ (sent late: „War fällig um
09:00 · Liste“, `late: true`), `collapseKey` `task:<id>`, `data.notizen = { kind: 'reminder', taskId, listId, area, task,
tag, remindAtMs, dueAt, late, snoozed }`, `data.actions` three callbacks: `done` „Erledigt“, `snooze_1h` „In 1 Std.“,
`snooze_eve` „Heute Abend“ (the person's `prefs.times.evening`, 19:00) — or, from an hour before that, `snooze_tom`
„Morgen früh“ (`prefs.times.morning`, 09:00). GateControl (≥ 1.181.0) hands a press to the hook `notifyAction` once per
push and button; the plugin checks again what the person may do. `done` ticks the task off; `snooze_*` moves the
reminder only while the task still has the reminder of that push (`tag`).

`POST tasks/<id>/snooze { until, tag? }` — the same for a device's own alarm: `1h`, `evening` (400 `invalid { field:
'until' }` once it is over), `tomorrow`, or an ISO time with offset (in the future, ≤ 1 year). With `tag`: nothing
happens (`snoozed: false`) when the task no longer has that reminder. Who may complete the task may snooze it.

`GET reminders` — the person's own reminders of the next 30 days (≤ 200) with tag, text and buttons as the push will
have them, for an alarm the device sets itself as a backup; `enabled: false` when the person switched the reminders off
(`prefs.notify.reminders`). A device shows alarm and push as ONE notification (tag = `collapseKey`), keeps the tags it
has shown and the person decided, and drops a push or alarm with such a tag.

**„Gestern offen geblieben“** (`server/yesterday.js`) — own open tasks (no sub tasks) that were due yesterday and are
the person's, that the person put into „Mein Tag“ yesterday (unless due today or in „Mein Tag“ again), or whose reminder
got lost. `GET yesterday`, and `yesterday` of `GET views/myday` (its tasks are in `overdue` as well — a client that shows
the card leaves them out there). `POST tasks/<id>/move { to }`: the due date goes to that day (the time stays), the
reminder moves by as many days and does not ring again when that is over; a task without a due date (or with one still
to come) and `today`: into „Mein Tag“ of today; `weekend`: the coming Saturday (on a Saturday: the Sunday); a date
before today: 400. `POST yesterday` does one action for all (or `ids`) of the card.

The push in the morning: once a day at `prefs.yesterdayAt` (07:30), only with something open and unless
`prefs.notify.yesterday` is off; more than 6 hours late it is not sent that day. Title „Gestern offen geblieben: 2“ (one
task: „Gestern offen geblieben“), body up to 5 lines „Titel · Liste“ and „… und N weitere“, `collapseKey` `yesterday`,
`data.notizen = { kind: 'yesterday', day, count, taskIds (≤ 20), area: null }`. Buttons: one task — `done` and `today`
as callbacks, `move` as `open_app_route`; several — `done_ask` (`open_app_route`: the app asks once, then `POST
yesterday { action: 'done', ids }`), `today` (callback: all of them), `move`. The plugin has no app tab of its own in the
manifest, so GateControl sends those `open_app_route` buttons as `open_portal` to `/portal#plg-gatecontrol-notizen`: an
app with a screen of its own takes them itself, anything else lands in the portal where the card has the same buttons.

**The calendar** (`server/calsync.js`, services `calendar_tasks`, `calendar_add`, `calendar_update`, `calendar_delete` of
gatecontrol-mail ≥ 1.15.0): a task with date and time is a 30-minute event in the calendar „Aufgaben“ of the person whose
task it is, without a reminder. `tasks.cal_dirty` marks what has to be looked at; a write tries at once, the background
run does the rest (25 a minute). No Mail: the marks wait. Mail refuses for the person: parked, asked again once a day.
The administrator's setting `calendar_tasks` and `prefs.calendar.tasks` take the events out again. Done: „✓ Titel“,
time free; deleted (also with its list): gone. Always Mail's own GateControl calendar, never an account's (Microsoft
365, CalDAV) — see Mail's README. Moving the event in the calendar does not move the task (not part of 1.3.0).

## Offline on a device (1.1.0)

`GET me` lists the feature **`offlineEdits`**: an app may then queue creates, changes and deletes made without a
connection and send them later, in the order they were made. Without it (1.0.x) an app keeps to ticks only — 1.0 made a
second object for a create sent twice.

- **`clientId`** (8–64 of `A–Z a–z 0–9 _ -`, a UUID made on the device) on `POST tasks` (also sub tasks and the quick
  entry), `lists`, `groups`, `notebooks`, `notes` (also in a Tresor). The first create makes the object and keeps
  (person, clientId) → its id (`client_ids`, migration `002_client_ids.sql`, in the same transaction; kept 180 days).
  The same create again — the answer was lost, the outbox sent it twice, both at once — answers **200 with that
  object as it is now** and `replayed: true`; nothing is made twice. Every answer of a create with a clientId carries
  `clientId` beside the object's `id`: that is the device's map from its own id to the server's.
  Per person: another person's clientId never finds someone else's object (it makes their own). A clientId of another
  kind (a note's clientId on `POST tasks`) → `400 invalid { field: 'clientId' }`. The object was deleted meanwhile or the
  person left its list → **`410 gone { clientId, id }`** (the device drops its copy).
- **Parents made offline too:** `listClientId` / `parentClientId` on `POST tasks`, `notebookClientId` on `POST notes`
  name the list, task or notebook by the clientId it was created with (by this person). Not made yet — a sub task sent
  before its task — → **`409 unknown_client_id { field, clientId }`**, nothing made, the clientId still free: send the
  parent first (the Android app does) or again later. A device may as well replace the ids itself from the answers.
- **Changes:** `PATCH tasks/<id>`, `PATCH lists/<id>` (name, colour) and `PATCH notebooks/<id>` (name, colour) take
  **`base`**: `{ <field>: the value the device saw before it changed it }`. A field whose value now differs from `base`
  and from the new value — someone else changed it meanwhile — → **`409 conflict { fields: [...], task | list |
  notebook }`** with the object as it is now; nothing of the change is written. Fields left out of `base` are not checked;
  other fields changed elsewhere do not matter (field by field: a tick on one phone and a new title on another never
  clash, which a revision of the whole task would make them). Without `base` the change wins (the dialog's „Meine
  behalten“). Notes keep their whole-text **`rev`** (`409 conflict { rev }`); „Meine behalten“ sends without `rev`.
- **Sent twice:** a field set to the value it has already is not written — no new `updatedAt`, no event, and above all
  no second reminder (a `remindAt` sent again does not arm it again) and no second „zugewiesen“ push. `PATCH notes`
  that changes nothing answers 200 even with a stale `rev`. `POST tasks/<id>/complete { done }` sets a state (as in 1.0).
- **Deletes:** something in the trash already answers `{ ok: true, gone: true }` to whoever may see it (a member of its
  list or notebook; a list or notebook its owner deleted); what never was or is purged answers `404` as before. A device
  takes both as done.
- **Tresor notes offline (decision):** safe on the server's side — a device sends ciphertext only (`titleCipher`,
  `cipher`, `keyVersion`), with `clientId` and `rev` like any note; the same ciphertext sent twice is harmless; a stale
  `rev` → `409 conflict`, a key rotated meanwhile → `409 stale_key { keyVersion }` (the device decrypts its own
  version with the old key it still has and encrypts it again with the new one). Nothing about a Tresor's keys or
  members can be changed offline. The server never sees more than before.

## Pushes

Topics `reminders` (a task's reminder), `shared` (a list or notebook shared with the person, a task assigned to them),
`vault` (a new device asks for a Tresor) and `listday` (1.2.0: the morning of a list day). A person's
`prefs.notify.reminders | shared | listday = false` keeps that kind from them. Since 1.1.0 (feature `pushTargets`) `data.notizen` says what to open:

| `kind` | Topic | `data.notizen` | Opens |
|---|---|---|---|
| `reminder` | reminders | `{ kind, taskId, listId, area, task }` | the task |
| `assigned` | shared | `{ kind, taskId, listId, area, task }` | the task |
| `shared_list` | shared | `{ kind, listId, area, list }` | the list |
| `shared_notebook` | shared | `{ kind, notebookId, area, vaultId?, notebook }` | the notebook (a Tresor: unlock first) |
| `listday` | listday | `{ kind, listId, area, day, list }` | the list (1.2.0: once per list and day at `remind`, to the members with the card, only with open tasks) |
| `vault_request` | vault | `{ kind, vaultId, notebookId, deviceId, area, vault, notebook, event: 'request' }` | the Tresor's approvals |

1.3.0: `reminder` also carries `tag`, `remindAtMs`, `dueAt`, `late`, `snoozed` and the buttons `data.actions`; the new
kind `yesterday` (topic reminders) is `{ kind, day, count, taskIds, area: null }` — see ["1.3.0"](#130--reminders-with-buttons-gestern-offen-geblieben-the-calendar).

`area` is `private` | `work` (the area to switch to). The keys of 1.0 (`task`, `list`, `notebook`, `vault`, `event`)
stay for older apps. Ids are numbers except `vaultId` / `deviceId` (base64url). The item may be gone by the time the
push is tapped (`404` on `GET tasks/<id>`): the app says so and shows the list.

## A person's choices (`prefs`)

```
{ area: 'private'|'work', evening: 'HH:MM' (18:00),
  sources: { <plugin>: { on, kids: 'all'|'mine'|'none' (Familie), shoppingInMyDay (Familie), flagged (Mail), evening (Alltag) } },
  groups: { '<plugin>|<group id>': 'private'|'work'|'hide' },   // Mail accounts, Schule children …
  times: { morning, noon, afternoon, evening, night },        // the quick entry's words „früh“, „abends“ …
  myday: { listdays: true, showDone: true },                 // 1.2.0: the list day card; the done ones of today
  startArea: 'last'|'private'|'work',                         // 1.2.0: the area on opening
  notify: { reminders: true, shared: true, listday: true,   // 1.2.0: false = no push of that kind
            yesterday: true },                                // 1.3.0: the morning hint „Gestern offen geblieben“
  yesterdayAt: 'HH:MM' (07:30),                               // 1.3.0: when that hint comes
  calendar: { tasks: true } }                                 // 1.3.0: false = my tasks are not written into my calendar in Mail
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
| `shopping_bind` · `shopping_put` · `shopping_list` | Familie | 1.4.0: the family's shopping lists live here (see „1.4.0“) |

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

Reminders as pushes with buttons (topic `reminders`, to the assignee or else the creator, once; since 1.3.0 a reminder
the server missed is sent late for up to 24 hours and then kept for „Gestern offen geblieben“ instead of dropped), the
morning hint „Gestern offen geblieben“ (who has something open is asked every 15 minutes, never per minute), the tasks
whose event in Mail's calendar has to be looked at (a batch of 25), the morning pushes of list days (topic `listday`), notes whose `expiresAt` came, `notes_changed` to Familie, the sources (availability, due reconciliations
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
`test/fixtures/sample.nsx`), the portal in a small DOM (`test/fake-dom.js`). Offline creates, changes and deletes sent twice or out of order, and the pushes' targets: `test/offline.test.js`.
