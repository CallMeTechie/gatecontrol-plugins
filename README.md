# gatecontrol-plugins

First-party plugins for [GateControl](https://github.com/CallMeTechie/gatecontrol)
— sources, tests and the build / sign / release pipeline. The plugin format,
`plugin.json` schema and host API are documented in GateControl's
[`docs/plugins.md`](https://github.com/CallMeTechie/gatecontrol/blob/master/docs/plugins.md).

*Deutsch: siehe [unten](#deutsch).*

## Layout

```
plugins/<id>/               one folder per plugin (folder name = plugin.json id)
  plugin.json               manifest
  server/                   entry (plugin.json "entry", e.g. server/index.js)
  ui/                       templates/assets the plugin renders itself
  migrations/NNN_name.sql   SQL migrations of the plugin's own database
  CHANGELOG.md              one "## <version>" section per release
  test/*.test.js            node:test tests against the mock host (not packed)
tools/                      validate, test, pack, verify, release metadata, catalog
tools/testing/mock-host.js  mock of the host API (gc.*) for plugin tests
plugins.config.json         repo-level flags per plugin (release: false = never released)
catalog-meta.json           store metadata per plugin for catalog.json (category, icon, summary, …)
gatecontrol.ref             GateControl commit whose packer/validator is used (40-char SHA)
.github/                    CI (ci.yml), release (release.yml), catalogue (catalog.yml)
```

`plugins/gatecontrol-hello` is an **example** (port of GateControl's test
fixture). It is built and tested in CI but never released
(`plugins.config.json`: `"release": false`).

| Plugin | | GateControl |
|---|---|---|
| `gatecontrol-smarthome` | Smart Home (Phoscon/deCONZ) — formerly built into GateControl; imports the built-in data; notifies: alarm, window open, battery low, gateway unreachable; app quick actions: own lights, plugs, groups (toggles) and scenes | ≥ 1.154.0 (1.0.0: ≥ 1.149.0) |
| `gatecontrol-raumklima` | Raumklima (Midea air conditioners, cloud and LAN; Dreo heaters and air conditioners live over the Dreo cloud's WebSocket); accounts on the plugin's settings page — until 1.6.0 `gatecontrol-midea` (2.0.0 replaces it: data, settings and licence move over), formerly built into GateControl as Klimaanlage; imports the built-in data; notifies: device unreachable, clean filter, malfunction; app quick actions: power toggle per own unit | ≥ 1.185.0 (`gatecontrol-midea` 1.6.0: ≥ 1.154.0, Dreo ≥ 1.184.0) |
| `gatecontrol-skoda` | Fahrzeuge (Škoda / MySkoda) — formerly built into GateControl; imports the built-in data; notifies: charging complete, battery low, not locked, climate done; app quick actions per vehicle (device): climate with the vehicle's widget, charging, window heating, the lock as one toggle (S-PIN, unlocking asks first); since 1.5.0 the logbook (trips from mileage and parking position, purpose per push button or widget, export as PDF/CSV) | ≥ 1.186.0 (1.4.1: ≥ 1.154.0; 1.0.0: ≥ 1.151.0) |
| `gatecontrol-alltag` | Alltag / Everyday — waste collection dates (online waste calendars AbfallNavi, abfall.io, AWIDO; ICS upload; own rules) and iCal calendars (Google, iCloud, Outlook, or a home-network server such as Nextcloud); portal sections in "Zuhause", Start tiles, search; app API `app/events` for the family app (1.2.0); notifies: waste collection (per plan 0–3 days before at a set time, optionally on the day), calendar events; services `calendar_query` / `calendar_list` for Familie's calendar conditions (1.3.0, GateControl ≥ 1.177.0) | ≥ 1.164.0 (1.1.0: ≥ 1.154.0) |
| `gatecontrol-synology` | NAS (Synology) — status and control of Synology NAS through the DSM Web API (several NAS, home target over HTTP; DSM 2-step verification via device token): model, DSM version, CPU/RAM, temperature, volumes, storage pools, drives (S.M.A.R.T.), DSM update, Hyper Backup, UPS; reboot, shutdown, back up now; administrators only; app quick actions per NAS (device): refresh with the NAS widget (storage used, CPU/RAM/temperature, health badge), back up now per Hyper Backup task, restart, shut down (asking first), Start tile per NAS (1.1.0); notifies: NAS unreachable, storage degraded/almost full, drive health/temperature, backup failed, DSM update, reboot/shutdown ; 1.2.0: folders for GateDrop ("Ablage für GateDrop" on the settings tab) and the services `list_drop_folders` / `save_file` (a file handed over by GateDrop, uploaded with File Station through `gc.net.uploadTarget`) | ≥ 1.193.0 (1.1.0: ≥ 1.154.0) |
| `gatecontrol-proxmox` | Proxmox VE — status of hosts and clusters (nodes, VMs/containers, storage, backups, HA) and control of VMs/CTs (start, shutdown, stop, reboot) for administrators; admin page only; app widgets, quick actions (refresh per host, start/shutdown/reboot of watched guests) and a Start tile for administrators; notifies: host/node unreachable, watched guest stopped, storage almost full, backup failed, high node load | ≥ 1.154.0 |
| `gatecontrol-familie` | Familie / Family — the family in the GateControl app (own tab, `permissions.app` + `ui.app`) and the portal (own tab): shared shopping lists (offline-first ops API), tasks (fixed / in turns / first) with reminders and stars for children, dates and birthdays, locating children on request (auto or confirmed, the child sees every request, ends at 18; coordinates 7 days), "I've arrived" and SOS (critical push), place reminders (geofencing on the phone, consent), pick-ups & rides (weekly series, "I'll do it" / "can't" / "who can …?", reminders; 1.1.0), an emergency card (health data on the own server only, never in pushes or logs; 1.1.0), a wall tablet view in the portal (role `wall`; 1.1.0) with kiosk login (1.1.1, `permissions.kiosk`: wall members are kiosk users, paired in GateControl under the user › "Kiosk-Gerät koppeln", 90 days rolling, portal only; device trust alone reads only — setup in the plugin's CHANGELOG and on its page "Funktionen"); 1.2.0: pocket money per child (bookkeeping only, integer cents: weekly/monthly payout booked once per period, stars converted on the child's request with a parent's approval), wishlists (reservations never visible to the owner), a household book for parents (categories, settling up between 2+ parents, "done" as a record), pinboard & packing lists (templates), a meal plan (ingredients onto a shopping list without duplicates, today's meal on the wall), presence from the home Wi-Fi with consent and rules ("everyone out" with grace time, "first home", "child home alone", a person; time window, after sunset) that run other plugins' quick actions (`permissions.actions`, `gc.actions`) or notify; admin pages members, features, presence & smart home, log with OpenStreetMap (`ui.maps`); 1.3.0: the profile picture and favourite colour of each GateControl account (changed by each person in the GateControl app under Settings → Profile, or by the administrator in the user profile) on every member — `avatarUrl`, `color`, `colorHex`, `initials` and `presence` (`home`/`away`/`unknown`/`null`) in the member objects — and one avatar with a presence ring (home: favourite colour, away: red) on the admin pages, the portal tab and the wall; 1.4.0: fixed target states for switches in rules; 1.5.0: places as rule triggers ("arrives at / leaves a place", a person or anyone; geofencing on the phone with its own consent `places`, the server only learns enter/exit — never a position; late reports > 10 min fire nothing): rule places (≤ 20, OpenStreetMap editor with radius 50–5000 m and "use home"), the phone's watch list `GET presence/watch` with a version, `POST presence/places/<id>/event`, places CRUD `presence/places` (app API in the plugin's CHANGELOG); 1.6.0: with the Messenger plugin (`permissions.services`, GateControl ≥ 1.177.0) the group "Familie" with all family members kept in step (`sync_group` after every member change, at start and every 6 h; switch on the page "Funktionen", default on) and the rule action "Messenger-Nachricht senden" (`send_message`, into the group or to single people, placeholders `{name}`/`{place}`) — hidden and skipped without the messenger; 1.7.0: the switch off hands the group back (`release_group`, Messenger ≥ 1.1.0: a normal group, parents are admins; retried every 6 h with an older messenger), several people in one `send_message` call (falls back to one call per person on Messenger 1.0.x), `gc.services.available` instead of the empty probe on GateControl ≥ 1.178.0; 1.8.0: services for the Messenger (`services.provides`, caller `gatecontrol-messenger` only): `list_add` (items onto a shopping list, duplicates skipped), `calendar_add` ("Termin anlegen"), `calendar_upsert` / `calendar_remove` (chat events kept in step by `sourceRef`, read-only, marked "aus dem Familien-Chat"), `places` (home and rule places) — dates get a place label and an end time — and the place name (never a position, only with presence consent) in the messenger status through `set_place_status` on every presence or place change (retried every 5 min); 1.9.0: rules and reminders (module `rules`, own admin page and portal section, API `rules`): the trigger "schedule" (weekdays, time), conditions on another plugin's device value (GateControl ≥ 1.181.0 `gc.actions.get` / `withWidget`) and on dates (Familie, Alltag's `calendar_query`), notifications with facts and buttons ("in 1 hour", "done", another plugin's quick action — push actions `callback`, hook `notifyAction`, GateControl ≥ 1.181.0), house rules (parents) and own reminders (parents; children with the setting `children_own_rules`), the dry run; a shopping list asked of a person (card in the direct / family chat with the quick actions `shop-take` / `shop-decline`, else a push), "I'm going shopping" as a card in the family chat, tasks from a chat (`tasks/quick`, card with `task-done`), the service `family_roles`; 1.10.0: one rule editor — the page of 1.9.0 is gone, every rule and reminder (schedule, device value, event, buttons, dry run, list filter) is on "Anwesenheit & Smart Home" and in the portal section with the dialog of the presence rules; 1.15.0: the family as a GateControl group (`permissions.groups: "manage"`, `gc.groups.ensure` with key `family`, kind `family`: parents as parent, children as child, never a wall tablet — at start, after every member change, when it differs, every 6 h; feature-detected, the service `family_roles` stays for older callers); 1.15.3: `calendar_add` also for Drive (deadlines of documents, only for the person of the call, a family member); notifies: shopping, tasks, dates, locate, arrival, sos (critical), places, rides, allowance, presence, reminders | ≥ 1.173.0 (device values and buttons: ≥ 1.181.0; Messenger features: ≥ 1.177.0; GateControl group: ≥ 1.200.0; 1.3.x: ≥ 1.168.0; 1.2.x: ≥ 1.166.0; 1.1.x: ≥ 1.165.0 / 1.164.0) |
| `gatecontrol-door` | Tür & Kamera / Door & Camera — Nuki smart locks and openers (local Nuki Bridge over the home target `nuki-bridge` with hashed token auth, or Nuki Web) and Ring doorbells/cameras (**unofficial Ring API, no warranty** — polled every 5 s, no push receiving): lock/unlock/open in the app tab (`ui.app`), widget/quick actions (`<lockId>:lock\|unlock\|open`) and the portal tab; rights per person and lock (view / lock / open, weekly time window, opt-in auto-unlock), every action checked on the server and in the history; doorbell push with picture and "Tür öffnen" (`quick_action`, device auth), motion push (opt-in), Ring location mode Inaktiv/Zuhause/Abwesend (toggle `mode:<locationId>` Zuhause ⇄ Abwesend with target states + button `mode_disarmed:<locationId>`, widget choice, right per person and location, admins always, Ring Alarm locations never switched), automatic unlock on arrival via the Familie rule "Person kommt heim" (strict conditions, re-lock after 3 min), safety notices (open too long, jammed, unreachable, battery, night check); history with pictures; app API in the plugin README; 1.3.0: a ring as a card in the Messenger's family chat (`send_message` with `card`, `permissions.services`, GateControl ≥ 1.177.0; snapshot and the "open" quick action; switch "Klingel in den Familien-Chat" on the page "Einstellungen", default on); notifies: doorbell, motion, door, auto | ≥ 1.169.0 (family chat: ≥ 1.177.0) |
| `gatecontrol-messenger` | Messenger — chats between the GateControl accounts (paid): direct and group chats with text, pictures (with preview), voice messages, files and one-off location, replies, reactions, edit / delete within a window, read receipts and "typing …" (each switchable per person, both ways), disappearing chats and retention; files through `gc.media` (members only via the `mediaAccess` hook, signed URLs in the portal), live updates through `gc.events`, chat pushes with reply / mark-read (`notifyTopics[].chat`, muted chats and open chats get none, preview per person); texts encrypted at rest (AES-256-GCM, key in a secret setting); app tab "Chats" (`ui.app`, the apps draw it from the App-API in the plugin README), portal tab "Chats" (list, chat, info; uploads with `GC.upload`, voice recording with MediaRecorder), admin pages without any content (overview, log); services `sync_group` and `send_message` for Familie (`services.provides`); 1.1.0: service `release_group` (a managed group becomes a normal group, or is deleted), `send_message` to up to 20 targets in one call (per-target results), `messages?around=<id>`, `serverTime` in every messages answer, `readUpTo`/`deliveredUpTo` per recipient in the `read` event, the photo preview as the push picture (GateControl ≥ 1.178.0); 1.4.0: status and 24-h stories, privacy settings and last seen, blocks, archive, pins, chat lists, export, "remind me", suggestions (Familie list / calendar), polls, events (RSVP, checklist, reminders, Familie calendar), live arrival, home actions (`gc.actions`, interactive) and plugin cards (`send_message` with `card`), service `set_place_status`; 1.6.0: the chat sink of GateControl's notification center (`permissions.notifySink`, hooks `deliverNotice` / `mayRouteToFamily`): notifications people route into the family chat or an own read-only chat per source arrive there as cards (whole text, link, quick-action buttons), Familie's group `listPinned`, notice channels with `notice`, the portal page "Wo Mitteilungen erscheinen" (`portal/notify-routes` over `gc.notify.routes`); 1.8.0: service `send_file` for GateDrop (handed-over files up to 2 GB, `media.handOverMaxBytes`, as messages of the sending person); 1.9.0: group chats for GateControl groups (`permissions.groups: "read"`, GateControl ≥ 1.200.0, feature-detected): the administrator picks groups on "Übersicht" (`GC.pickPrincipals`), each gets a managed chat with the effective members (subgroups included), the path as title and the leads as chat admins, kept in step by `groupsChanged`; deselected, archived or deleted → a normal chat (`groupDeleting`, `groupUsage`); the family group stays Familie's; notifies: message (chat topic), status (daily digest) | ≥ 1.193.0 (group chats: ≥ 1.200.0; 1.6.x–1.7.x: ≥ 1.191.0; 1.4.x–1.5.x: ≥ 1.180.0; 1.3.x: ≥ 1.177.0) |
| `gatecontrol-gatedrop` | GateDrop — sharing like Quick Share (paid): files (≤ 20 per send, ≤ 2 GB each), a text or a link to people (a Messenger message of the sender via `send_file`, else a push), to one's own devices (directly on the same Wi-Fi — tickets, keys and candidates brokered by the plugin, silent data pushes — otherwise through the server), into NAS folders (Synology `save_file`) or as a public link with expiry and PIN (`gc.publicLinks`, off until an administrator allows it); links and NAS for administrators and Familie's parents (`family_roles`); 7 days retention, 10 GB quota; portal tab and admin overview; app API in the plugin README; 1.1.0: own devices that are offline get the send once they are back (delivery `waiting`, `GET pending` for the apps); notifies: received, link | ≥ 1.193.0 |
| `gatecontrol-vault` | Vault — an end-to-end encrypted password manager (paid): the apps encrypt and decrypt (libsodium: Argon2id master key, a user key wrapped by it and by a recovery key, X25519 keys, XChaCha20-Poly1305 entries bound to vault, id and revision), the server keeps only what it cannot read; a personal vault and shared vaults with roles (read / write / manage, keys sealed per member, a key change in steps after someone leaves), sync of an offline copy by a change counter over the public address (no VPN), compare-and-swap with both versions kept on a conflict, trash (30 days), 10 versions per entry, emergency access for trusted people with a waiting time (push to the grantor, background release); no administrator reset; admin overview without content; app API and crypto format in the plugin README; notifies: share, emergency | ≥ 1.193.0 |
| `gatecontrol-drive` | Drive — the files of the family and the team on one's own storage (paid: Familie, Business or Kombi, people counted by the licence's tier and seats): areas "Meine Dateien", family, the children's folders (parents may look in, the child is told) and team folders with read / write / manage for people and groups; each area on this server, a NAS (readable as plain files, changes there come back through the journal) or S3; versions, a trash, links for people without an account (view, download, upload; PIN, expiry); portal tab "Drive" (tiles or list, preview, drag and drop of whole folders, live reload); admin pages overview (licence, storage, backup hint), people, team folders; services `list_areas` / `save_file` for other plugins; notifies: link uploads, backup hint, child view; 1.1.0: previews of files in every list for the apps and the portal (GateControl's previews; HEIC and videos from the uploading device); 1.2.0: delete on all devices — the server keeps the order until every device of the person removed its local copy (`permissions.devices` for the asking device) | ≥ 1.208.0 (1.0.0: ≥ 1.207.0) |
| `gatecontrol-mail` | Mail — every e-mail account of a person in one place (GMX, WEB.DE, T-Online, Gmail with an app password, Outlook.com and Microsoft 365 with the Microsoft sign-in, any IMAP account; paid): synced by the server (IMAP and SMTP through GateControl's `gc.mail` with IDLE, Microsoft through Graph with delta queries), "Alle Posteingänge" with Relevant / Sonstige (rules, learned senders, AI for unclear mail), folders, conversations, search beyond the retention, pictures only on request through `gc.http.fetchImage` (tracking pixels removed), writing with attachments from the device, a mail or Drive (copy or link), 10 s undo and planned sending; Drive ≥ 1.15.0 (suggestion, "Immer für diesen Absender", automatic filing, "Zum Ablegen"), AI (in short, to-dos into Familie's calendar, reply suggestions), a quota per person; app tab `mail` (`ui.app`, API in the plugin README), portal tab, admin page "Einstellungen"; notifies: mail, mail_failed | ≥ 1.216.0 |

### Notifications

Plugins that notify declare their topics in `plugin.json` (`notifyTopics`,
needs `permissions.notify`) and send through GateControl's notification
center with `gc.notify({ topic, title, body, priority, users, collapseKey, data })`
(GateControl ≥ 1.154.0, docs/plugins.md "Notifications"). The shared helper
`server/notify.js` (sending with fallbacks for older hosts, an own hourly
budget below the host's 30/h with a reserve for high priority, dedupe,
persisted last-seen state) is the **same file in every plugin** — packages
cannot share code; `tools/test/notify.test.js` fails when the copies differ.
Each plugin's `server/alerts.js` holds the transitions as a pure
`evaluate(previousState, observations, config, now)`: nothing is announced
on a first sighting, a restart neither repeats nor loses anything. The mock
host records both forms in `host.notifications` (`notifyApi: 'legacy'`
emulates a GateControl < 1.154.0).

### Quick actions

Plugins with a portal may offer quick actions to the GateControl apps
(home-screen shortcuts, Quick Settings tiles, widget) through two optional
hooks: `quickActions({ user, lang })` → at most 16
`{ id, title, subtitle, icon, kind: 'button'|'toggle', state, confirm }`
(1.5 s budget, cached state only) and `runQuickAction({ user, lang, id })` →
`{ ok, message, state }` (10 s). `user` is the signed-in portal viewer
(`app: true`); a plugin offers exactly what that person may control in the
portal and checks it again when an action runs. A GateControl without the
hooks never calls them, so the `gatecontrol` requirement stays. Smart Home,
Klimaanlage and Fahrzeuge offer them. The mock host checks the answers like
the host (stricter: what the host would drop or cut throws) —
`host.quickActions(user)`, `host.runQuickAction(user, id)`. Since GateControl
1.169.0 `runQuickAction` also gets `via` (`'app'` | `'notification'` | the
calling plugin's id) and `automation` (true only for another plugin's
`gc.actions.run`); a push may carry `{ type: 'quick_action', label, plugin, id,
confirm?, auth?: 'device' }` actions for the plugin's own quick actions and an
`image: { data, mime }` (≤ 300 KB) — `server/notify.js` passes `image` on and
sends a message again without it when the host refuses the picture.
Since GateControl 1.171.0 an action may carry a `widget` (value, status,
controls), since 1.172.0 a `device` `{ id, title, subtitle?, icon? }` that
groups the actions of one thing in the apps, a toggle `look` (icon and tone per
state) and `confirmWhen`, a widget `label`, `readings` and `power`, and a Start
tile `items` for the apps (`host.clientTiles(user)` in the mock host). Older
hosts drop the fields.
Since GateControl 1.173.0 a toggle may declare `verbs` `{ on, off }` (what
setting each state is called as a command, „Verriegeln“ / „Entriegeln“) and
`targets: true` (the hook honours an explicit `target`): a run with a target
state (`host.runQuickAction(user, id, lang, { state: 'on' })`, or another
plugin's `gc.actions.run({ …, state })`) then hands the hook `target: 'on'|'off'`
— set that state, never flip. Without `targets` the host decides from the
listed state (already there → no hook call, `unchanged: true`; unknown → 409
`state_unknown`). Fahrzeuge, Klimaanlage and Smart Home honour targets; older
hosts never send one, so their `gatecontrol` requirement stays.

## Tooling

The packer is **not** copied into this repository. CI checks out
`CallMeTechie/gatecontrol` at the commit in `gatecontrol.ref` and uses its
`scripts/plugin-pack.js`, `manifest.js` (plugin.json rules), `package.js` and
`signature.js`. Pin a newer GateControl with `tools/bump-gatecontrol.sh <sha>`
and commit the change.

```sh
npm ci                        # dev deps (ipaddr.js, needed by GateControl's validator)
npm run gatecontrol           # checks out the pinned GateControl into ./.gatecontrol
                              # (or set GATECONTROL_DIR, or keep a clone in ../gatecontrol)
npm run validate              # all plugin.json files + repo rules
npm test                      # all plugin tests (or: npm test -- <id>)
npm run pack <id>             # UNSIGNED dev build → dist/<id>-<version>.gcplugin
npm run pack <id> -- --no-license
                              # UNSIGNED dev build with license.required = false
                              # → dist/<id>-<version>-dev.gcplugin (see below)
```

An unsigned package counts as third party, and a third-party plugin that
needs a licence must name its own licence server — so the plain dev build of
a licensed first-party plugin (e.g. `gatecontrol-smarthome`) cannot be
installed. `--no-license` builds one that can (test servers only, never
released or signed). The mock host (`tools/testing/mock-host.js`) also offers
`gc.settings.setSecret`, `host.legacyImport(snapshot)`,
`host.portalVisible(user)` and `host.appVisible(user)`; it follows
`permissions.notify.perHour` and keeps priority `critical` on topics with
`allowCritical` (GateControl ≥ 1.164.0). With `permissions.kiosk` it offers
`gc.kiosk.allow(userId, allowed)` / `gc.kiosk.list()` (GateControl ≥ 1.165.0;
never an administrator or a disabled user — `{ disabled: true }` in `users`),
`host.kiosk` holds the plugin's kiosk users and `opts.kiosk` pre-fills them.
`gc.users` answers like GateControl ≥ 1.168.0: every user carries `avatarUrl`
(`/avatars/<id>.<ext>` or `null`), `color` (a favourite colour key, default
`palette[id % 10]`), `colorHex` and `initials`; set them per user in `users`
(`{ color: 'pink', avatarUrl: '/avatars/…webp' }`) and change them while a
test runs with `host.setUserFace(id, { color, avatarUrl })`.
Like GateControl ≥ 1.169.0 the mock host checks a push picture (`image: { data,
mime }`: ≤ 300 KB, the bytes match the mime, each side 32…2560 px, no animation;
a `data:` prefix is accepted) and records `image: { mime, size, width, height }`,
`imageUrl` (`/notify-media/<id>.<ext>`) and `imageTtl` (ttl, ≤ 7 days); accepts
`quick_action` push actions (own plugin id, label 1–24, `confirm`, `auth: 'device'`);
allows `background.intervalSeconds` from 5; and
`host.runQuickAction(user, id, lang, { via: 'notification' })` or
`{ automation: true, via: '<other plugin id>' }` passes `via` / `automation` to the
hook.
The messenger foundations of GateControl ≥ 1.177.0 are mirrored too (details
in the header of `tools/testing/mock-host.js`): plugin.json `media` with
`host.upload(user, buffer, mime)` (the host's upload answers and quota,
`opts.mediaQuota`), `gc.media.info/claim/delete/usage/url`,
`host.mediaGet(user, mediaId, { range })` through the hook `mediaAccess`,
`host.mediaFromUrl(url)` for `gc.media.url` URLs and `host.mediaCleanup(now)`;
`permissions.events` with `gc.events.emit` (recorded in `host.events`);
chat topics (`notifyTopics[].chat`: `users`, `conversation`, `sender`,
`reply`/`mark_read` actions, own budget; recorded with `kind: 'message'`); and
services between plugins (`services.provides`, `permissions.services`,
`gc.services.call` against `opts.services`, `host.callService(name, …)` for the
plugin's own hook `service`). `opts.gatecontrol: '1.178.0'` adds what
GateControl 1.178.0 brings (opt-in, the default stays 1.177.0):
`gc.services.available(plugin, service)` and push pictures from the plugin's
own media (`image: { mediaId }`). `opts.gatecontrol: '1.180.0'` adds GateControl 1.180.0:
`permissions.actions { interactive: true }`, `gc.actions.run({ actionId:
'<plugin>/<id>', interactive, via })` with `{ ok, result, code }` answers and
60 runs per minute, `actionId` / `label` / `needsConfirm` on listed actions,
service payloads up to 512 KB; `opts.actionsApi: false` emulates a host
without `gc.actions`.
`opts.gatecontrol: '1.193.0'` adds GateDrop's foundations: `media` up to 2 GB with
type families (`image/*` …), `resumable` and `handOverMaxBytes`, `permissions.devices`
(`gc.devices.list` from `opts.devices`, `gc.notify` `devices` / `silent` data pushes),
`gc.media.handOver` between linked mock hosts (`opts.services: [{ plugin, host }]` — the
other plugin's real services and media store), `gc.net.uploadTarget` (a target's
`upload` handler, `host.uploads`) and `permissions.publicLinks` (`gc.publicLinks.*`,
`opts.publicLinks` / `host.setPublicLinks`, `host.publicLinkUnlock` /
`host.publicLinkDownload` with the hook `publicLinkEvent`).
`opts.gatecontrol: '1.200.0'` adds the person groups (`permissions.groups` `"read"` /
`"manage"`): `gc.groups.list/get/members/isMember/leadersOf/ensure/remove` with the host's
checks and codes over `opts.groups` (seed: `[{ id, name, kind, parentId, source, key, archived,
members: [{ userId, role }] }]`), `host.groupStore` / `host.groupChanges`, `host.editGroups.*`
(an administrator's changes: create, setMember, removeMember, rename, move, archive, unarchive,
remove — the latter asks the hook `groupDeleting`), `host.groupsChanged(changes?)` (the queued
changes by default), `host.groupUsage(groupId, successorUserId)` and `host.groupDeleting(…)`.

Dev builds are always unsigned (`tools/pack.js` drops `GC_PLUGIN_SIGNING_KEY`
unless `--sign` is passed). Install them on a test server with
*Unsignierte Plugins erlauben*. **Signing happens only in the release
workflow** — the private key never leaves the `plugin-release` environment.

## Adding a plugin

1. Create `plugins/<id>/` (`id`: `[a-z0-9]+(-[a-z0-9]+)*`, 2–64 chars; for
   first-party plugins it is the licence server's entitlement slug).
2. Add `plugin.json`, the entry under `server/`, `migrations/`, `ui/`,
   `CHANGELOG.md` with a `## <version>` section, and `test/*.test.js` using
   `tools/testing/mock-host.js` (see the example plugin).
3. `npm run validate && npm test && npm run pack <id>`; open a PR.

## Versioning

Semantic versioning per plugin, independent of other plugins. `plugin.json`
`version` is the single source; every released version needs a CHANGELOG
section. `gatecontrol` declares the compatible server range. Pre-releases
(`1.2.0-rc.1`) are published as GitHub pre-releases and never become a
catalogue `latest` while a stable version exists.

## Release

1. On `main`: bump `version` in `plugins/<id>/plugin.json`, add the
   `## <version>` section to its `CHANGELOG.md`, merge.
2. Tag that commit and push the tag:
   `git tag gatecontrol-smarthome-v1.2.0 && git push origin gatecontrol-smarthome-v1.2.0`
   — or run **Actions → Tag release** on `main` with that tag: `tag.yml` runs
   the same tag check, creates the tag on the current `main` commit and
   dispatches `release.yml` on it (a tag created by the workflow token would
   not fire the push trigger on its own).
3. `release.yml` (environment `plugin-release`, waits for a reviewer if one is
   configured) checks that the tag is on `main`, tag = `plugin.json` version,
   CHANGELOG entry exists, the plugin is releasable; validates, tests, builds,
   **signs**, verifies the signature against `signing-key.pub` and creates
   the GitHub Release `<id>-v<version>` with
   `<id>-<version>.gcplugin`, `<id>-<version>.gcplugin.sha256` and
   `<id>-<version>.index.json`. It fails, and publishes nothing, when a key
   is missing or the signature does not match.
4. `catalog.yml` then rebuilds the catalogue (below).

### Catalogue

`catalog.json` is an asset of the rolling release **`catalog`**:
`https://github.com/CallMeTechie/gatecontrol-plugins/releases/download/catalog/catalog.json`.
It is rebuilt from the `*.index.json` assets of all published releases (the
releases are the source of truth; deleting a release and re-running the
*Catalog* workflow removes it). No branch, no commits, no merge conflicts.

```jsonc
{ "schema": 1, "generated_at": "…", "repository": "CallMeTechie/gatecontrol-plugins",
  "plugins": { "<id>": { "id", "name", "description", "publisher",
                         "latest": { /* index entry */ }, "versions": [ /* newest first */ ],
                         // optional, from catalog-meta.json:
                         "category", "icon", "summary", "audience", "keywords", "related", "highlight",
                         "adds", "permissions", "shows", "needs", "languages" } } }
// index entry (+ "notes"):
{ "schema": 1, "id", "name", "description", "publisher", "version", "prerelease",
  "gatecontrol": ">=1.146.0", "license_required", "file", "size", "sha256", "url",
  "signature": { "alg": "Ed25519", "key_id", "public_key" }, "tag", "release_url", "published_at",
  "notes": "…" }
```

**Store metadata** for GateControl's plugin store lives in `catalog-meta.json`
(repository root, one optional entry per released plugin id): `category`
(`family` / `home` / `mobility` / `infrastructure` / `other`), `icon`
(`family`, `chat`, `calendar`, `door`, `bulb`, `snowflake`, `car`, `server`,
`nas`, `puzzle`), `summary` `{ de, en }` (one sentence, ≤ 160 characters),
`audience` (`all` / `admins`), `keywords` (≤ 12 lowercase search words in
German and English, ≤ 32 characters each), `related` (≤ 4 other plugin ids,
"passt gut dazu") and an optional `highlight`
`{ version, title: { de, en } ≤ 80, text: { de, en } ≤ 280, tags? }` whose version
has a CHANGELOG section (`tags`: ≤ 4 chips beside it, `{ icon, text: { de, en } ≤ 40 }`).

The store's detail page reads these optional fields:

| Field | Shape | Shown as |
|---|---|---|
| `adds` | ≤ 8 × `{ icon, title ≤ 80, text ≤ 120 }` | „Was <Plugin> hinzufügt“ – pages, app tab, portal area, tiles, widgets, quick actions, notifications, background jobs |
| `permissions` | ≤ 10 × `{ icon, title ≤ 80, text ≤ 200, tag? ≤ 24 }` | „Das darf das Plugin“ for end users; `tag` only on sensitive rows (*Netzwerk*, *Steuern*, *Standort*, *Benutzer*) |
| `shows` | ≤ 3 × `{ kind: tile \| list \| widget, caption ≤ 60, value? ≤ 12 }` | captions of the wireframes „So sieht es bei dir aus“ – only what the plugin really has |
| `needs` | `{ de, en }` ≤ 80 | what it needs besides GateControl (an account, a token, a device) |
| `languages` | subset of `["de", "en"]` | languages of the plugin |

Titles, texts, tags and captions are `{ de, en }`. `icon` (in `adds`,
`permissions` and highlight `tags`) is one of `page`, `app`, `portal`,
`widget`, `tile`, `action`, `bell`, `clock`, `data`, `network`, `chat`, `key`,
`location`, `users`, `door`, `calendar`, `camera`, `car`, `bulb`, `server`,
`shield`, `link`. Write them from the plugin's `plugin.json`, README and
CHANGELOG – never promise what the plugin does not do.

`tools/catalog.js` copies the fields that are set into
the plugin's object; `node tools/validate.js` (CI) checks the file strictly
(`tools/catalog-meta.js`). Every version entry also gets **`notes`**: the
`## <version>` section of the plugin's `CHANGELOG.md` (at most 6000
characters, cut at a line end with `…`; no section → no `notes`). Both are
read from the commit the catalog workflow checks out (the release tag, or
`main` when run by hand), so a change shows up with the next catalogue rebuild.

### One-time setup (repository owner)

| Kind | Name | Value |
|---|---|---|
| Environment | `plugin-release` | *deployment branches and tags* → selected, tag rule `*-v*` (a required reviewer is optional) |
| Environment secret | `GC_PLUGIN_SIGNING_KEY` | private seed from `node scripts/plugin-keygen.js` (GateControl repo; run it on your own machine) |
| File in this repo | `signing-key.pub` | the matching public key (base64, 32 bytes); also in GateControl's `BUILTIN_PUBLIC_KEYS` |
| Tag ruleset (recommended) | `*-v*` | restrict creation/update/deletion to maintainers |

No other secrets are used. `pull_request` runs (`ci.yml`) never see the
signing key; nothing uses `pull_request_target`.

---

## Deutsch

Erstanbieter-Plugins für GateControl mit Build-, Signatur- und Release-Pipeline.

* **Aufbau:** ein Ordner pro Plugin unter `plugins/<id>/` (plugin.json, `server/`,
  `ui/`, `migrations/`, `CHANGELOG.md`, `test/`); gemeinsame Werkzeuge in `tools/`.
  `gatecontrol-hello` ist nur ein Beispiel und wird nie veröffentlicht.
* **Plugins:** Smart Home, Klimaanlage, Fahrzeuge (früher eingebaut), **Alltag**
  (Müllabfuhr aus Online-Abfallkalendern, ICS-Datei oder eigenen Regeln; iCal-Kalender;
  Erinnerungen und Portal „Zuhause“; ab 1.3.0 Kalender-Dienste für die Termin-Bedingungen der Familie), NAS, Proxmox VE und **Familie** (Einkaufslisten,
  Aufgaben und Sterne, Termine, Kinder orten, „Bin angekommen“ & SOS, Orts-Erinnerungen,
  Abholen & Fahrten, Notfall-Karte, ab 1.2.0 Taschengeld (nur Buchhaltung), Wunschlisten,
  Haushaltsbuch, Pinnwand & Packlisten, Essensplan sowie Anwesenheit mit Smart-Home-Regeln
  (nur mit Zustimmung; Schnellaktionen anderer Plugins über `permissions.actions`, ab
  GateControl 1.166.0) – in der App und im Portal – und ein Wand-Tablet im Portal, ab
  1.1.1 mit Kiosk-Anmeldung: in GateControl beim Benutzer „Kiosk-Gerät koppeln“;
  Einrichtung des Tablets im CHANGELOG des Plugins und auf seiner Seite „Funktionen“;
  ab 1.3.0 mit GateControl ≥ 1.168.0 Profilbild und Lieblingsfarbe jeder Person – die ändert
  jede Person in der GateControl-App (Einstellungen → Profil) oder der Admin im
  Benutzerprofil – mit der Anwesenheit als Ring ums Bild: Lieblingsfarbe = zu Hause,
  rot = unterwegs; ab 1.6.0 mit dem Messenger-Plugin und GateControl ≥ 1.177.0 die Gruppe
  „Familie“ mit allen Familienmitgliedern, automatisch abgeglichen und auf der Seite „Funktionen“
  abschaltbar, und die Regel-Aktion „Messenger-Nachricht senden“; ab 1.7.0 gibt der Schalter „aus“
  die Gruppe im Messenger (ab 1.1.0) als normale Gruppe frei; ab 1.8.0 Einkaufsliste, Termine und Orte
  für den Messenger 1.4.0 und der Ortsname im Messenger-Status; ab 1.9.0 Regeln und Erinnerungen mit
  Zeitplan, Gerätewerten (GateControl ≥ 1.181.0) und Terminen als Bedingung, Knöpfen in der Mitteilung,
  Hausregeln und eigenen Erinnerungen, Einkaufen zuweisen und Aufgaben aus dem Chat mit Karten im Messenger)
  und **Tür & Kamera** (Nuki-Schlösser und -Opener über die lokale Bridge oder
  Nuki Web, Ring-Klingeln und -Kameras über die **inoffizielle Ring-Schnittstelle, ohne Gewähr**;
  Rechte pro Person und Schloss mit Zeitfenster, Klingel-Push mit Bild und „Tür öffnen“,
  automatisches Aufsperren bei Ankunft nur mit Zustimmung über die Familie-Regel „Person kommt
  heim“, Verlauf mit Bildern; ab 1.1.0 der Ring-Modus Inaktiv / Zuhause / Abwesend pro Standort
  für Schnellaktionen, Widget und Regeln; ab 1.3.0 die Klingel als Karte im Familien-Chat des
  Messengers; ab GateControl 1.169.0) –
  Tabelle oben.
* **Werkzeuge:** Der Packer stammt aus GateControl (Commit in `gatecontrol.ref`,
  ändern mit `tools/bump-gatecontrol.sh <sha>`). Lokal: `npm ci`,
  `npm run gatecontrol`, `npm run validate`, `npm test`, `npm run pack <id>`
  (immer **unsigniert**; `-- --no-license` für einen installierbaren
  Testbau eines lizenzpflichtigen Erstanbieter-Plugins).
* **Neues Plugin:** Ordner anlegen, plugin.json + Code + CHANGELOG + Tests mit
  `tools/testing/mock-host.js`, prüfen, PR öffnen.
* **Benachrichtigungen:** Themen in `plugin.json` (`notifyTopics`, braucht
  `permissions.notify`), Versand mit `gc.notify({ topic, … })` (GateControl
  ab 1.154.0). `server/notify.js` ist in jedem Plugin dieselbe Datei
  (`tools/test/notify.test.js` prüft das); die Übergänge stehen je Plugin in
  `server/alerts.js` – beim ersten Sehen wird nichts gemeldet, ein Neustart
  wiederholt nichts.
* **Schnellaktionen:** optionale Hooks `quickActions` / `runQuickAction` für
  Verknüpfungen, Schnelleinstellungen und Widget der Apps (höchstens 16, nur was
  die Person im Portal steuern darf) – Smart Home, Klimaanlage, Fahrzeuge.
* **Versionierung:** SemVer pro Plugin; jede Version braucht einen
  `## <version>`-Abschnitt im CHANGELOG.
* **Release:** Version und CHANGELOG auf `main` bringen, dann Tag
  `<id>-v<version>` pushen. Die Release-Pipeline prüft, testet, baut,
  **signiert (nur in CI, Umgebung `plugin-release`)**, prüft die Signatur und
  veröffentlicht Paket, `.sha256` und Katalogeintrag; danach wird
  `catalog.json` im Release `catalog` neu erzeugt („Nach Updates suchen“
  liest diese Datei).
* **Einrichtung:** siehe Tabelle *One-time setup* oben.
