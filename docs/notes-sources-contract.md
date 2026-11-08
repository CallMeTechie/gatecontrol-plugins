# Notizen & Aufgaben ↔ sources — the contract (v1)

Owner: `gatecontrol-notizen` (the hub, plugin id **`gatecontrol-notizen`**, name „Notizen & Aufgaben“).
Sources in step 1: `gatecontrol-familie`, `gatecontrol-mail`, `gatecontrol-drive`, `gatecontrol-schule`,
`gatecontrol-alltag`. Later sources (Fahrzeuge, NAS, Proxmox) use the same contract.

The hub shows everything a person has „zu tun“ in the other plugins next to its own tasks and notes. **The original stays
in its plugin**: the hub keeps a cached copy, ticking it off here ticks it off there (`todo_complete`), tapping it opens it
there (`open`). The hub never edits a source item in any other way.

Everything below goes over GateControl's plugin services (`gc.services.call`, server `docs/plugins.md` „Services between
plugins“). GateControl ≥ 1.216.0 for all parties (`maxPerHour`).

## 1. Why push first (the rate limit)

`gc.services.call` allows **60 calls per hour per calling plugin** unless the *provider* gives a service its own budget
(`services.provides.<name>.maxPerHour`, 60 … 3600, counted per calling plugin and service). Polling five sources for every
person would blow that. So:

1. **Sources push** their changes to the hub (`gatecontrol-notizen:todo_changed`, `maxPerHour: 3600` declared by the hub),
   batched and debounced (§ 4).
2. **The hub keeps a cached copy** (`src_items`) and answers all screens from it — no service call when a person opens
   „Mein Tag“.
3. **The hub reconciles** now and then by pulling (`<source>:todo_items`, `maxPerHour: 600` declared by the source): once per
   person and source after install / when a source shows up or changes version, then about every 12 hours, and when a
   person taps „Jetzt abgleichen“ in „Quellen“ (at most once per 10 minutes and source). The hub spreads these so that it
   stays below 300 calls per hour and source.
4. **Completing** is a direct call (`<source>:todo_complete`, `maxPerHour: 600` declared by the source) — only when a person
   taps the check box.

No host change is needed for this.

## 2. The item

```jsonc
{
  "id": "msg:4711",                 // the source's own stable id, [A-Za-z0-9:._-]{1,120}, unique within the source
  "kind": "task",                   // task | event | deadline | homework | exam | list | note
  "title": "Angebot von ACME beantworten",           // 1…200 characters, plain text
  "subtitle": "Zu tun aus „Ihr Angebot 2026-114“",   // optional, ≤ 200, plain text (the grey line under the title)
  "due": "2026-11-09T09:00:00+01:00", // optional: ISO date "YYYY-MM-DD" (with allDay true) or an ISO date-time WITH offset
  "allDay": false,                  // true: `due` is a date only
  "lead": null,                     // optional "evening": show the item in „Mein Tag“ of the day BEFORE `due`, at the
                                    // person's chosen time (hub setting „Erinnern um“, default 18:00) — Alltag's waste
                                    // collection („Gelbe Tonne rausstellen“, due = the collection day)
  "area": "private",                // private | work — Mail: a work account's items are "work"
  "users": [12, 15],                // who sees it in their hub: 1…50 user ids (required in a push; in a pull answer
                                    // optional — then the asking person only)
  "assignee": 15,                   // optional user id it is assigned to (Familie: the child), else null
  "assigneeName": "Noah",           // optional, ≤ 60 (for a person who is not a GateControl user)
  "important": false,               // flagged / starred / „wichtig“
  "done": false,                    // done in the source (the hub shows it under „Erledigt heute“ for the day)
  "canComplete": true,              // may the hub offer the check box? false: show only (e.g. a parent evening)
  "progress": { "done": 4, "total": 18 },  // optional (packing list 4/18, sub tasks)
  "group": { "id": "account:3", "label": "Arbeit (Microsoft 365)" },
                                    // optional: a source-defined group the person can map to an area or hide in the
                                    // hub's „Quellen“ (Mail: the account; Schule: the child; Familie: the list) —
                                    // id [A-Za-z0-9:._-]{1,80}, label ≤ 80
  "meta": {                         // optional, ≤ 1 KB JSON, only strings ≤ 120 / numbers / booleans, flat:
    "type": "shopping",             //   source-specific sub type, [a-z_]{1,32} — see § 6 for the ones the hub filters on
    "amount": "84,20 €",            //   shown as a chip
    "child": "Ben",                 //   shown as a chip
    "stars": 2,                     //   Familie stars, shown as a chip
    "flagged": true                 //   Mail: a flagged mail (hub filter „Markierte Mails als Aufgabe“)
  },
  "open": { "plugin": "gatecontrol-mail", "route": "message/4711" },
                                    // where tapping leads: plugin = the source's id (always), route
                                    // [A-Za-z0-9/._:=-]{0,200} — see § 5
  "updatedAt": 1762600000000        // ms, when the source last changed the item (the hub keeps the newer one)
}
```

Rules:

* Only what the list needs — **no bodies, no mail text, no file contents**. The hub stores what it gets in its own
  database (at rest via GateControl, like Drive).
* `users` decides visibility. A source must only list people who may see the item in the source itself. The hub shows an
  item to exactly these people (and to nobody when the list is empty → treated as removed).
* `due` with a time must carry an offset (`+01:00`, `Z`). The hub converts to its time zone setting.
* Unknown fields are ignored; a bad field drops the item (not the batch) and is reported in `rejected`.
* A source item that is done may stay for 24 h with `done: true` and should then be removed (`remove`).

## 3. Services the hub provides (`gatecontrol-notizen`)

Callers list them in `permissions.services`, e.g. `"gatecontrol-notizen:todo_changed"`.

### `todo_changed` — push (maxPerHour 3600)

Call without `userId` (or with any — it is ignored; `users` of each item counts).

```jsonc
// payload (≤ 512 KB; at most 200 upserts and 500 removals per call)
{ "v": 1, "upsert": [Item, …], "remove": ["msg:4711", …] }
// answer
{ "ok": true, "accepted": 12, "removed": 1, "rejected": [{ "id": "msg:9", "code": "invalid", "field": "due" }] }
// refusal: { "ok": false, "code": "invalid" | "forbidden" | "unavailable" }
```

* The calling plugin is the item's source (`caller`); a source can never touch another source's items.
* Idempotent: the same item twice is one item; an older `updatedAt` than the cached one is ignored.
* Callers allowed: the five step-1 sources (the hub refuses others with `forbidden`, so a new source is a hub release).

### Notes for Familie (Pinnwand and Packlisten) — maxPerHour 3600 each

Familie's Pinnwand and packing lists **move into the hub**: they become notes and checklists in a notebook the hub keeps
for Familie and are **shown back in Familie** through these services. The data's owner is the hub; Familie keeps no copy
of its own after the import (a cache for its wall tablet is fine).

A *bound notebook* is identified by the calling plugin plus a `key` (`[a-z][a-z0-9_-]{0,31}`): Familie uses `pinnwand`
(notes, colours, pinned, expiry) and `packlisten` (checklists with an optional trip date).

| Service | `userId` | Payload | Answer |
|---|---|---|---|
| `notes_bind` | none | `{ key, title (≤ 60), kind: 'notes' \| 'checklists', members: [userId…] (1…50), area?: 'private' }` | `{ ok, notebookId }` — creates or updates the notebook; members (the family) may read and write it, nobody else. Call again when the family changes. |
| `notes_list` | a member | `{ key, cursor?, since? (ms) }` | `{ ok, notes: [Note…], cursor \| null, removed?: [id…] }` — ≤ 16 KB per page (about 30 notes), newest first; with `since`: only notes changed after it plus `removed` ids |
| `note_save` | a member | `{ key, id?, title?, text?, color?, pinned?, expiresAt?, due?, checklist?: [{ id?, text, done }] }` | `{ ok, note: Note }` — without `id` a new note; with `id` the given fields change (checklist: the whole list) |
| `note_check` | a member | `{ key, noteId, itemId, done }` | `{ ok, note: { id, progress } }` |
| `note_delete` | a member | `{ key, id }` | `{ ok }` |
| `notes_import` | none | `{ key, notes: [{ ref, title?, text?, color?, pinned?, expiresAt?, due?, authorId?, createdAt?, checklist?: [{ text, done }] }] }` (≤ 100 per call) | `{ ok, imported, skipped, ids: { <ref>: noteId } }` — the one-time move of the existing board notes and checklists; `ref` (e.g. `board:12`, `checklist:4`) makes it idempotent |

```jsonc
// Note
{ "id": 812, "title": "WLAN Gäste", "text": "SSID und Hinweise für Besuch …",   // text: plain text ≤ 2000 (the note's
                                                                               //   Markdown without marks, cut)
  "color": "yellow",                 // none | yellow | green | blue | pink | grey | orange | purple
  "pinned": true, "expiresAt": null, // ms or null — the hub deletes the note then (Familie's „läuft ab“)
  "due": "2026-11-13",               // checklists: the trip date, or null
  "checklist": [{ "id": "3.9f2c1a", "text": "Zahnbürste", "done": true }],   // ≤ 200 items; id = "<line>.<6 hex of
                                                                               //   SHA-256(text)>", stable while the line stays
  "progress": { "done": 4, "total": 18 },
  "updatedAt": 1762600000000, "updatedBy": 12, "createdBy": 12,
  "open": { "plugin": "gatecontrol-notizen", "route": "note/812" } }
```

Codes: `invalid` (with `field`), `forbidden` (not a member / not the binding plugin), `not_found`, `too_many` (more than 500
notes in a bound notebook). The `text` of a note is plain text and the checklist is its own field: the hub stores both as
the note's Markdown (text, a blank line, then `- [ ]` / `- [x]` lines); what Familie writes through these services is not
echoed back to it with `notes_changed`.

When a bound notebook changes in the hub (someone edited a note in the hub, the portal or an app), the hub tells the
owner: it calls **`<owner>:notes_changed { v: 1, key, ids: [noteId…], removed: [noteId…], at }`** — at most once per 30 s
and key (changes in between are merged). Familie declares `notes_changed` with `maxPerHour: 600` and then fetches with
`notes_list { since }`. A missing `notes_changed` is fine: Familie may also refresh every 15 minutes.

## 4. Services each source provides

Each source declares in `plugin.json`:

```jsonc
"services": { "provides": {
  "todo_items":    { "label": { "de": "Zu erledigen für Notizen & Aufgaben", "en": "To-dos for Notes & Tasks" }, "maxPerHour": 600 },
  "todo_complete": { "label": { "de": "In Notizen & Aufgaben abgehakt", "en": "Ticked off in Notes & Tasks" }, "maxPerHour": 600 }
} },
"permissions": { "services": ["gatecontrol-notizen:todo_changed"] }   // Familie also the notes services of § 3
```

and answers only calls whose `caller` is `gatecontrol-notizen` (others: `{ ok: false, code: 'forbidden' }`).

### `todo_items` — pull (reconciliation)

```jsonc
// gc.services.call({ plugin: '<source>', service: 'todo_items', userId: 12, payload })
{ "v": 1, "cursor": null, "limit": 50 }          // cursor: the previous answer's; limit 1…100 (default 50)
// answer (≤ 16 KB — cut the page by size, not only by `limit`)
{ "ok": true, "items": [Item, …], "cursor": "opaque" | null, "now": 1762600000000 }
```

* The full current set for that person (open items, plus items done in the last 24 h), paged. `cursor: null` = the last
  page. After the last page the hub removes that person from cached items of this source that did not come.
* A person who cannot use the source (no seat, not allowed, no licence) gets `{ ok: true, items: [], cursor: null }`.
* Never more than the person may see; `user` (GateControl's) is the person — `payload` carries no user id.

### `todo_complete`

```jsonc
{ "v": 1, "id": "msg:4711", "done": true }       // with userId = the person who ticked it
// answer
{ "ok": true, "item": Item }                      // the item as it is now (optional; the hub then takes it)
{ "ok": false, "code": "not_found" | "forbidden" | "read_only" | "invalid" }
```

* Do in the source what ticking it off there does (Mail: „Zu tun“ erledigt / flag cleared; Familie: the task done for
  that person — stars as in Familie; Drive: the deadline done; Schule: homework done for the child; Alltag:
  „rausgestellt“). `done: false` undoes it where the source can (else `read_only`).
* The hub ticks optimistically and reverts on a refusal. Afterwards the source may also push the item (fine either way).

### Pushing (`todo_changed`)

* Keep a set of changed item ids (e.g. a table `todo_dirty(id, at)`); flush it from the background run (`tick`) **at
  most every 10 s**, and right away (with a 5 s debounce) after a person changed something in the source themselves.
  Typical rate per source well under 100 calls per hour.
* On `ERR_RATE_LIMIT`, `ERR_TIMEOUT`, `ERR_SERVICE_UNAVAILABLE`: keep the set, try again at the next run. Check
  `gc.services.available('gatecontrol-notizen', 'todo_changed')` first — the hub may not be installed (then do nothing
  and drop the set; the hub pulls everything when it comes).
* After a source's update that changes what it reports: push the changed items; the hub's reconciliation catches the rest.

## 5. Opening the original (`open`)

`open: { plugin, route }` — `plugin` is always the source itself, `route` the source's own path (no leading `/`).

* **Apps** (Android, Windows) open `gatecontrol://plugin/<plugin>/<route>` — the scheme Drive already uses for mails
  (`gatecontrol://plugin/gatecontrol-mail/message/<ref>`). Each app maps the routes of the plugins it has screens for;
  an unknown route opens the plugin's start screen.
* **Portal**: the hub's frame asks GateControl to open `/portal?open=<route>#plg-<plugin>` (`GC.openPortal`, GateControl
  ≥ 1.254.0 — older ones: the hub shows the item's details with the hint „In <Plugin> öffnen“). The source's portal frame
  reads `new URLSearchParams(location.search).get('open')` and shows that thing (a mail, a task, a homework). A plugin
  without its own portal tab (only sections in „Zuhause“) gets its section's tab; it may ignore `open`.
* Routes the step-1 sources should support (suggestion, the source decides): Mail `message/<id>`, Familie `task/<id>`,
  `shopping/<listId>`, `checklist/<id>`; Drive `node/<id>` (the deadline's file); Schule `homework/<id>`, `exam/<id>`,
  `event/<id>`; Alltag `waste/<date>`.

## 6. What each step-1 source reports (guidance)

| Source | `kind` | Notes |
|---|---|---|
| Familie | `task` (with `assignee`, `meta.stars`), `list` (`meta.type: 'shopping'`, `progress`) | Tasks of children: `users` = the child and the parents; the hub filters „Aufgaben der Kinder zeigen: Alle / Nur mir zugewiesene / Keine“ on `assignee`. Shopping lists: `meta.type: 'shopping'` (hub setting „Einkaufslisten in Mein Tag“). Packing lists and Pinnwand are **not** todo items — they live in the hub (§ 3). `group`: the task's list or „Familie“. |
| Mail | `task` („Zu tun“, `subtitle` „Zu tun aus „<subject>““), flagged mails (`meta.flagged: true`) | `area: 'work'` for an account of kind business; `group` = the account (`account:<id>`, label = its name or address) so the person can map it; `users` = the account's owner. |
| Drive | `deadline` (`meta.amount` when known, `due` the deadline date, `allDay: true`) | `users` = whoever reads the file's area and has a seat; `area: 'work'` for team folders. |
| Schule | `homework`, `exam`, `event` (parent evening, `canComplete: false`) | `users` = the child and its recipients (parents); `assignee` = the child; `group` = the child (`child:<id>`, label the name) — the hub's „Kinder“ filter. |
| Alltag | `event` with `lead: 'evening'`, `due` = the collection date (`allDay: true`), `title` „Gelbe Tonne rausstellen“, `subtitle` „Abholung morgen früh“ | `users` = the household (whoever gets the waste reminder); `canComplete: true` = „rausgestellt“ (hides it for everybody in the household). |

The hub's per-person source settings (board „Quellen“) work only on these fields — a source needs no settings of its own
for them.

## 7. Versions and testing

* Contract version `v: 1` in every payload; a hub that sees a higher `v` takes what it understands.
* Tests in each source: `todo_items` paging (≤ 16 KB per answer with 200 items of long titles), `users` visibility,
  `todo_complete` (done/undo/read_only/forbidden for another caller), the push batching (one call for many changes, kept
  on `ERR_RATE_LIMIT`). The mock host's `gc.services` has `maxPerHour` since GateControl 1.216.0.
* The hub's side: `plugins/gatecontrol-notizen/test/contract.test.js` (fake sources against the mock host).
