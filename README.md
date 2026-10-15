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
gatecontrol.ref             GateControl commit whose packer/validator is used (40-char SHA)
.github/                    CI (ci.yml), release (release.yml), catalogue (catalog.yml)
```

`plugins/gatecontrol-hello` is an **example** (port of GateControl's test
fixture). It is built and tested in CI but never released
(`plugins.config.json`: `"release": false`).

| Plugin | | GateControl |
|---|---|---|
| `gatecontrol-smarthome` | Smart Home (Phoscon/deCONZ) — formerly built into GateControl; imports the built-in data; notifies: alarm, window open, battery low, gateway unreachable; app quick actions: own lights, plugs, groups (toggles) and scenes | ≥ 1.154.0 (1.0.0: ≥ 1.149.0) |
| `gatecontrol-midea` | Klimaanlage (Midea air conditioners, cloud and LAN) — formerly built into GateControl; imports the built-in data; notifies: device unreachable, clean filter, malfunction; app quick actions: power toggle per own unit | ≥ 1.154.0 (1.0.0: ≥ 1.150.0) |
| `gatecontrol-skoda` | Fahrzeuge (Škoda / MySkoda) — formerly built into GateControl; imports the built-in data; notifies: charging complete, battery low, not locked, climate done; app quick actions: climate, charging, window heating, lock/unlock (S-PIN, unlock asks first) | ≥ 1.154.0 (1.0.0: ≥ 1.151.0) |
| `gatecontrol-alltag` | Alltag / Everyday — waste collection dates (online waste calendars AbfallNavi, abfall.io, AWIDO; ICS upload; own rules) and iCal calendars (Google, iCloud, Outlook, or a home-network server such as Nextcloud); portal sections in "Zuhause", Start tiles, search; app API `app/events` for the family app (1.2.0); notifies: waste collection (per plan 0–3 days before at a set time, optionally on the day), calendar events | ≥ 1.164.0 (1.1.0: ≥ 1.154.0) |
| `gatecontrol-synology` | NAS (Synology) — status and control of Synology NAS through the DSM Web API (several NAS, home target over HTTP; DSM 2-step verification via device token): model, DSM version, CPU/RAM, temperature, volumes, storage pools, drives (S.M.A.R.T.), DSM update, Hyper Backup, UPS; reboot, shutdown, back up now; administrators only; notifies: NAS unreachable, storage degraded/almost full, drive health/temperature, backup failed, DSM update, reboot/shutdown | ≥ 1.154.0 |
| `gatecontrol-proxmox` | Proxmox VE — status of hosts and clusters (nodes, VMs/containers, storage, backups, HA) and control of VMs/CTs (start, shutdown, stop, reboot) for administrators; admin page only; notifies: host/node unreachable, watched guest stopped, storage almost full, backup failed, high node load | ≥ 1.154.0 |
| `gatecontrol-familie` | Familie / Family — the family in the GateControl app (own tab, `permissions.app` + `ui.app`) and the portal (own tab): shared shopping lists (offline-first ops API), tasks (fixed / in turns / first) with reminders and stars for children, dates and birthdays, locating children on request (auto or confirmed, the child sees every request, ends at 18; coordinates 7 days), "I've arrived" and SOS (critical push), place reminders (geofencing on the phone, consent), pick-ups & rides (weekly series, "I'll do it" / "can't" / "who can …?", reminders; 1.1.0), an emergency card (health data on the own server only, never in pushes or logs; 1.1.0), a wall tablet view in the portal (role `wall`; 1.1.0) with kiosk login (1.1.1, `permissions.kiosk`: wall members are kiosk users, paired in GateControl under the user › "Kiosk-Gerät koppeln", 90 days rolling, portal only; device trust alone reads only — setup in the plugin's CHANGELOG and on its page "Funktionen"); 1.2.0: pocket money per child (bookkeeping only, integer cents: weekly/monthly payout booked once per period, stars converted on the child's request with a parent's approval), wishlists (reservations never visible to the owner), a household book for parents (categories, settling up between 2+ parents, "done" as a record), pinboard & packing lists (templates), a meal plan (ingredients onto a shopping list without duplicates, today's meal on the wall), presence from the home Wi-Fi with consent and rules ("everyone out" with grace time, "first home", "child home alone", a person; time window, after sunset) that run other plugins' quick actions (`permissions.actions`, `gc.actions`) or notify; admin pages members, features, presence & smart home, log with OpenStreetMap (`ui.maps`); 1.3.0: the profile picture and favourite colour of each GateControl account (changed by each person in the GateControl app under Settings → Profile, or by the administrator in the user profile) on every member — `avatarUrl`, `color`, `colorHex`, `initials` and `presence` (`home`/`away`/`unknown`/`null`) in the member objects — and one avatar with a presence ring (home: favourite colour, away: red) on the admin pages, the portal tab and the wall; notifies: shopping, tasks, dates, locate, arrival, sos (critical), places, rides, allowance, presence | ≥ 1.168.0 (1.2.x: ≥ 1.166.0; 1.1.x: ≥ 1.165.0 / 1.164.0) |
| `gatecontrol-door` | Tür & Kamera / Door & Camera — Nuki smart locks and openers (local Nuki Bridge over the home target `nuki-bridge` with hashed token auth, or Nuki Web) and Ring doorbells/cameras (**unofficial Ring API, no warranty** — polled every 5 s, no push receiving): lock/unlock/open in the app tab (`ui.app`), widget/quick actions (`<lockId>:lock\|unlock\|open`) and the portal tab; rights per person and lock (view / lock / open, weekly time window, opt-in auto-unlock), every action checked on the server and in the history; doorbell push with picture and "Tür öffnen" (`quick_action`, device auth), motion push (opt-in), automatic unlock on arrival via the Familie rule "Person kommt heim" (strict conditions, re-lock after 3 min), safety notices (open too long, jammed, unreachable, battery, night check); history with pictures; app API in the plugin README; notifies: doorbell, motion, door, auto | ≥ 1.169.0 |

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
                         "latest": { /* index entry */ }, "versions": [ /* newest first */ ] } } }
// index entry:
{ "schema": 1, "id", "name", "description", "publisher", "version", "prerelease",
  "gatecontrol": ">=1.146.0", "license_required", "file", "size", "sha256", "url",
  "signature": { "alg": "Ed25519", "key_id", "public_key" }, "tag", "release_url", "published_at" }
```

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
  Erinnerungen und Portal „Zuhause“), NAS, Proxmox VE und **Familie** (Einkaufslisten,
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
  rot = unterwegs) und **Tür & Kamera** (Nuki-Schlösser und -Opener über die lokale Bridge oder
  Nuki Web, Ring-Klingeln und -Kameras über die **inoffizielle Ring-Schnittstelle, ohne Gewähr**;
  Rechte pro Person und Schloss mit Zeitfenster, Klingel-Push mit Bild und „Tür öffnen“,
  automatisches Aufsperren bei Ankunft nur mit Zustimmung über die Familie-Regel „Person kommt
  heim“, Verlauf mit Bildern; ab GateControl 1.169.0) –
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
