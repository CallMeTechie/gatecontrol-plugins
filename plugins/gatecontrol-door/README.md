# Tür & Kamera / Door & Camera (`gatecontrol-door`)

*English: see [below](#english). App API for the GateControl apps: [App API](#app-api).*

Nuki-Schlösser und -Opener (lokale Nuki Bridge oder Nuki Web) und Ring-Klingeln/-Kameras in
GateControl: Tür in App, Widget und Portal auf- und zusperren, Klingel-Push mit Bild und
„Tür öffnen“, Verlauf mit Bildern, automatisches Aufsperren bei Ankunft (nur mit Zustimmung)
und Sicherheits-Hinweise. Rechte pro Person und Schloss.

Braucht **GateControl ≥ 1.169.0**. Kostenpflichtiges Zusatz-Plugin (eigenes Abo), **nicht** in
GateControl Lifetime enthalten.

> **Ring: inoffizielle Schnittstelle, ohne Gewähr.** Ring bietet keine offizielle Schnittstelle
> für Drittanbieter an. Das Plugin verwendet die Schnittstelle der Ring-App so, wie es die
> Open-Source-Projekte [ring-client-api](https://github.com/dgreif/ring) (Homebridge) und
> [python-ring-doorbell](https://github.com/python-ring-doorbell/python-ring-doorbell) (Home
> Assistant) tun. Ring unterstützt das nicht; es kann sich jederzeit ändern oder wegfallen. Nuki
> ist davon unabhängig und läuft weiter.

## Deutsch

### Einrichtung

1. **Nuki Bridge (empfohlen, lokal):** in der Nuki-App die HTTP-API der Bridge einschalten und den
   Token notieren. In GateControl unter Einstellungen › Plugins › Tür & Kamera › *Zugriffsziele*
   dem Ziel **„Nuki Bridge“** die Bridge zuweisen (Adresse im Heimnetz, Port 8080, oder eine
   Route). Mehrere Bridges = mehrere Zuweisungen. Dann auf der Seite **„Geräte“** die Bridge mit
   Zugriffsziel und Token anlegen, „Geräte suchen“ und die Schlösser hinzufügen.
   Das Plugin meldet sich bei der Bridge mit dem **gehashten Token** an (`ts`, `rnr`,
   `hash = sha256("ts,rnr,token")`) – der Token selbst steht nie in einer URL. Anfragen an eine
   Bridge laufen nacheinander (die Bridge kann nur eine gleichzeitig) und haben Timeouts.
2. **Nuki Web (Alternative, Cloud):** unter web.nuki.io einen API-Token erzeugen (Smart Locks
   ansehen/bedienen, Protokoll ansehen) und auf „Geräte“ speichern. Bedienungen am Schloss und
   am Keypad werden aus dem Protokoll in den Verlauf übernommen.
3. **Schloss:** Name („Haustür“), Quelle, welche Aktionen es geben soll (zusperren, aufsperren,
   öffnen = Falle ziehen; Opener: Summer), Türsensor vorhanden?, „offen zu lange“ nach Minuten
   (Standard 5), Nachtkontrolle (Standard 22:00, abschaltbar).
4. **Ring (inoffiziell, ohne Gewähr):** auf „Geräte“ mit E-Mail und Passwort anmelden, danach den
   Code aus SMS/E-Mail/Authenticator eingeben. Gespeichert wird nur ein Refresh-Token
   (verschlüsselt; es erneuert sich laufend, das Plugin speichert immer das neueste), **nie** das
   Passwort oder die E-Mail. Pro Installation entsteht einmal eine Geräte-ID; in der Ring-App
   erscheint das als angemeldetes Gerät „GateControl“. Jede Kamera mit einem Schloss
   verknüpfen – nur verknüpfte Kameras schicken Push und Bilder.
5. **Berechtigungen:** pro Person und Schloss *keine / ansehen / zu-/aufsperren / auch öffnen*,
   optional ein Wochen-Zeitfenster (gilt für alle Aktionen; über Mitternacht gehört es zum
   Starttag), „Automatisch aufsperren bei Ankunft erlauben“ und pro Kamera Klingel-/Bewegungs-Push.
   **Admins bekommen nichts automatisch.** Kiosk-Geräte und Portal-Besucher, die nur per
   Geräte-Vertrauen erkannt sind, sehen nur – sie können nie etwas auslösen.
6. **Einstellungen:** Zeitzone (für Zeitfenster und Nachtkontrolle), Sprache der Mitteilungen,
   Aufbewahrung der Bilder (1–30 Tage, Standard 7), Abstand der Bewegungs-Pushs, Ring-Abfrage
   an/aus, Nuki-Web-Protokoll übernehmen.

### Automatisch aufsperren bei Ankunft

Familie › Anwesenheit & Smart Home › neue Regel **„Person kommt heim“** (Person wählen) › Aktion
**„Haustür aufsperren“** (Tür & Kamera). Die Familie führt die Schnellaktion `<lockId>:unlock`
als die Person aus, die die Aktionen der Regel festgelegt hat (auf der Admin-Seite der
Administrator) – **deren** Rechte und Zustimmung gelten hier.

Das Plugin sperrt nur auf, wenn **alles** stimmt: nur „aufsperren“ (öffnen/Falle nie
automatisch), Zustimmung „Automatisch aufsperren“ und mindestens „zu-/aufsperren“, Zeitfenster,
höchstens einmal in 10 Minuten pro Person und Schloss, Schloss erreichbar und zugesperrt (frisch
abgefragt), Tür geschlossen (bei Türsensor). Sonst: abgelehnt, Eintrag im Verlauf und Mitteilung
„Automatisches Aufsperren abgelehnt: …“ (Thema „Automatisches Aufsperren“). Danach: „Haustür
automatisch aufgesperrt“ mit „Wieder zusperren“. **Sicherheitsnetz:** meldet der Türsensor in
3 Minuten kein „offen“, sperrt das Plugin wieder zu („wieder zugesperrt“); ohne Türsensor fragt
eine Mitteilung mit „Zusperren“.

**Risiken:** „zuhause“ heißt bei der Familie: das Handy ist im WLAN des Heimnetzes. Das kann auch
vor der Haustür, in der Einfahrt oder beim Nachbarn der Fall sein, und wer das Handy hat, kommt
hinein. Nur für Personen einschalten, die das wollen, möglichst mit Türsensor und Zeitfenster.
Tipp: Regel **„Alle sind unterwegs“** › Aktion „Haustür zusperren“.

### Mitteilungen

| Thema | Priorität | Wann | An wen |
|---|---|---|---|
| Klingel (`doorbell`) | hoch | es klingelt (mit Bild) | „ansehen“ auf dem verknüpften Schloss, Klingel-Push an; „auch öffnen“ zusätzlich mit „Tür öffnen“ |
| Bewegung (`motion`, Standard aus) | normal | Bewegung, ≤ 1 pro Kamera in 5 min | wer pro Kamera Bewegungs-Push eingeschaltet hat |
| Tür & Schloss (`door`) | normal (blockiert: hoch) | offen zu lange, blockiert, > 10 min nicht erreichbar, Batterie kritisch (1×/Tag), Nachtkontrolle; Ring gestört (Admins, 1×/Tag) | „zu-/aufsperren“ auf dem Schloss (+ Admins bei blockiert/nicht erreichbar/Batterie) |
| Automatisches Aufsperren (`auto`) | normal | aufgesperrt / abgelehnt / wieder zugesperrt / Rückfrage | die Person |

### Datenschutz

Alles bleibt auf dem eigenen Server: Verlauf (90 Tage), Bilder (1–30 Tage), Rechte. Bilder
gehen nur an Personen mit Recht auf das verknüpfte Schloss. Tokens werden mit dem
Server-Schlüssel verschlüsselt gespeichert, nie protokolliert und nie an eine Seite oder App
geschickt. Das Ring-Passwort wird nur für die Anmeldung an Ring gesendet. Verbindungen gehen nur
zu `api.nuki.io`, `oauth.ring.com`, `api.ring.com`, `app-snaps.ring.com` und zur
zugewiesenen Bridge.

### Klingel-Verzögerung (Ring)

Ohne Push-Empfang (ein Plugin kann keine dauerhafte Verbindung zu Google/Firebase halten) fragt
das Plugin Ring ab: alle 5 Sekunden die aktiven Ereignisse, alle 30 Sekunden die Ereignisliste
als Nachlauf. **Erwartete Verzögerung: etwa 5–15 Sekunden**, dazu bis ~8 s für das Bild (ohne
Bild, wenn Ring keins rechtzeitig liefert oder es größer als 300 KB ist). Bei Fehlern bremst das
Plugin (5 s … 5 min, bei 429 nach `Retry-After`).

## English

Nuki smart locks and openers (local Nuki Bridge or Nuki Web) and Ring doorbells/cameras in
GateControl. Needs **GateControl ≥ 1.169.0**; paid add-on, **not** included in GateControl
Lifetime. **Ring: unofficial interface, no warranty** (the one ring-client-api and
python-ring-doorbell use; Ring does not support it and may change it at any time; Nuki keeps
working regardless).

* **Setup:** assign the access target **"Nuki Bridge"** (Settings › Plugins › Door & Camera ›
  access targets), add the bridge with its HTTP API token on the page **Devices** (hashed token
  auth — the token never appears in a URL; one request per bridge at a time), or save a Nuki Web
  API token. Add locks (name, source, actions, door sensor, "open too long" minutes, night
  check). Sign in to Ring (email + password → 2FA code); only the rotating refresh token is
  stored, never the password. Link each camera to a lock.
* **Permissions:** per person and lock none / view / lock+unlock / also open; optional weekly
  time window; opt-in "allow automatic unlock on arrival"; doorbell/motion push per camera.
  Administrators get nothing automatically; kiosk devices and device-trust portal viewers are
  read-only. Every action is checked again on the server (right, window, 10 per minute) and
  written to the history, refused ones included.
* **Automatic unlock:** Family › Presence & smart home › rule "Person comes home" › action
  "Unlock front door". Accepted only for `unlock` (never open), with the opt-in and at least
  `lock`, inside the window, at most once per 10 min per person and lock, lock reachable and
  locked, door closed (with a sensor). Not opened within 3 min → locked again (with a sensor) or
  a push asks. Risk: "home" = the phone is on the home Wi-Fi, which may be the case in front of
  the house.
* **Privacy:** history (90 days), pictures (1–30 days) and rights stay on your server; tokens are
  encrypted, never logged and never sent to a page or app.
* **Ring delay:** polled (no push receiving possible for a plugin): about 5–15 s plus up to ~8 s
  for the picture.

## App API

For the native "Tür"/"Door" tab of the GateControl apps (`ui.app`), base
`/api/v1/client/plugins/gatecontrol-door/api/` (device token; the viewer is the token owner with
`app: true`). The portal tab uses the same paths under `/api/v1/portal/plugins/gatecontrol-door/api/`.
`?lang=de|en` (or the owner's language) sets the language of `message`, `error`, `reasonText`.
All times are ISO-8601 UTC to the second (`2026-10-14T08:00:00Z`). Reads (GET) are limited to
60 per minute and person (`429 rate_limited`).

Every answer is `{ "ok": true, … }` or `{ "ok": false, "code": "<code>", "error": "<text>" [, "retryAfter": <s>] [, "field": "<name>"] }`.

### `GET me`

```jsonc
{
  "ok": true,
  "me": { "userId": 3, "name": "Marc", "canAct": true, "autoUnlock": false,
          "window": null,                 // or { "days": [1,2,3,4,5], "from": "07:00", "to": "20:00" } (1 = Monday)
          "windowOpen": true },
  "locks": [ LockView, … ],               // only locks with a right for this person
  "cameras": [ CameraView, … ],           // enabled cameras linked to one of those locks
  "ring": { "connected": true, "broken": false },   // broken → show "Ring-Verbindung gestört"
  "serverTime": "2026-10-14T08:00:00Z"
}
```

**LockView**

```jsonc
{
  "id": 1, "name": "Haustür",
  "type": "smartlock",                    // "smartlock" | "opener"
  "right": "lock",                        // "view" | "lock" | "open"
  "actions": ["lock", "unlock"],          // buttons to show (right ∩ configured): "lock" | "unlock" | "open" (opener: "open" = "Summer")
  "blocked": null,                        // null = usable now | "read_only" | "outside_window" (show the buttons disabled)
  "confirm": ["unlock"],                  // actions to confirm first; the app also asks for device auth for "unlock"/"open"
  "doorSensor": true,
  "state": {
    "lock": "locked",                     // see "Lock states"
    "door": "closed",                     // null = no door sensor | "open" | "closed" | "unknown" | "deactivated" | "calibrating" | "uncalibrated" | "removed"
    "batteryCritical": false, "batteryPercent": 80, "batteryCharging": false,   // batteryPercent may be null
    "reachable": true, "updatedAt": "2026-10-14T08:00:00Z"                     // updatedAt may be null
  }
}
```

Lock states — smart lock: `locked`, `unlocked`, `unlatched`, `locking`, `unlocking`,
`unlatching`, `jammed`, `uncalibrated`, `unknown`; opener: `online`, `rto_active`, `open`,
`opening`, `untrained`, `boot_run`, `unknown`. `reachable: false` → show "nicht erreichbar".

**CameraView**

```jsonc
{ "id": 4, "name": "Klingel Haustür", "kind": "doorbell_v4", "doorbell": true, "lockId": 1,
  "online": true, "battery": 87,          // online/battery may be null
  "prefs": { "ding": true, "motion": false },   // this person's pushes for this camera
  "lastImageAt": "2026-10-14T07:59:40Z" } // newest stored picture or null
```

### `POST locks/<id>/<action>`

`<action>` = `lock` | `unlock` | `open`. No body needed. Checked again on the server (right,
time window, ≤ 10 actions per minute and person); every attempt is in the history.

```jsonc
{ "ok": true, "message": "Haustür aufgesperrt", "lock": LockView }
```

### `GET cameras/<id>/snapshot[?refresh=1]`

The newest stored picture (else Ring's latest). `refresh=1` asks the camera for a new one
(≤ 1 per camera per 15 s, ≤ 6 per person per minute → `429 too_soon` with `retryAfter`).

```jsonc
{ "ok": true, "snapshot": { "cameraId": 4, "mime": "image/jpeg", "size": 48213,
                            "at": "2026-10-14T08:00:05Z", "data": "<base64, ≤ 300 KB decoded>" } }
```

No picture → `404 no_image`; Ring not connected on refresh → `409 ring_not_connected`.

### `PUT cameras/<id>/prefs`

Body `{ "ding"?: boolean, "motion"?: boolean }` → `{ "ok": true, "prefs": { "ding": true, "motion": true } }`
(only for oneself; read-only viewers → `403 read_only`). Motion pushes also need the GateControl
topic "Bewegung an der Kamera" switched on (default off).

### `GET history[?cursor=<id>&limit=<1-100, default 30>&lockId=<id>&kind=<kind>]`

Newest first. A person sees their own actions, every event of locks where they have `open`, and
the rings/motion of cameras linked to locks they can view (administrators: everything).

```jsonc
{ "ok": true, "nextCursor": 118,          // null = no more; pass as ?cursor=
  "items": [ {
    "id": 120, "at": "2026-10-14T08:00:00Z",
    "kind": "action",                     // "action" | "ding" | "motion" | "alert" | "nuki"
    "lockId": 1, "lockName": "Haustür", "cameraId": null, "cameraName": null,
    "userId": 3, "userName": "Marc",
    "via": "app",                         // "app" | "portal" | "notification" | "automation" | "system" | "nuki" | "keypad" | "ring"
    "caller": null,                       // automation: the calling plugin id, e.g. "gatecontrol-familie"
    "action": "unlock",                   // action: lock|unlock|open; alert: open_long|jammed|unreachable|night; nuki: lock|unlock|open|null
    "result": "ok",                       // "ok" | "refused" | "failed"
    "reason": null, "reasonText": null,   // e.g. "outside_window" / "außerhalb des Zeitfensters"
    "hasImage": false                     // ding/motion with a stored picture → GET events/<id>
  } ] }
```

Reason codes: `no_right`, `unsupported`, `read_only`, `outside_window`, `rate_limited`,
`auto_open`, `auto_no_right`, `auto_off`, `auto_too_soon`, `unreachable`, `not_locked`,
`door_open`, `failed`, `lock_unreachable`, `lock_failed`, `nuki_auth`, `no_target`,
`not_configured`, `auto_relock`.

### `GET events/<id>`

One ring or motion event (the push "Ansehen" opens it with `data.door.eventId`):

```jsonc
{ "ok": true, "event": {
    …history item fields…, "kind": "ding",
    "image": { "mime": "image/jpeg", "size": 48213, "at": "2026-10-14T08:00:05Z", "data": "<base64>" },   // or null (expired / none)
    "lock": LockView                      // the linked lock for this person, or null → show "Tür öffnen" when lock.actions has "open"
} }
```

### Errors

| HTTP | code | |
|---|---|---|
| 400 | `invalid`, `ring_bad_code` | bad input |
| 403 | `read_only` | kiosk device / device-trust portal viewer |
| 403 | `no_right`, `outside_window`, `forbidden` | |
| 404 | `not_found`, `no_image` | unknown, or no right on that lock/camera |
| 409 | `unsupported`, `not_configured`, `no_target`, `nuki_auth`, `ring_not_connected`, `ring_login_failed`, `too_many` | |
| 429 | `rate_limited`, `too_soon`, `ring_rate_limited` | with `retryAfter` (s) |
| 502 | `lock_unreachable`, `lock_failed`, `nuki_error`, `ring_error` | |

### Quick actions

`GET /api/v1/client/actions` lists, per lock and right: `<lockId>:lock` ("Haustür zusperren",
no confirm), `<lockId>:unlock` ("… aufsperren", `confirm: true`), `<lockId>:open` ("… öffnen";
opener "… Summer", `confirm: true`); subtitle = the state ("Zugesperrt"), icons lock / open lock /
door. Runs: `POST /api/v1/client/actions/gatecontrol-door/<lockId>:<action>` with body
`{ "source": "app" | "notification" }`. Another plugin (`gc.actions.run`, `automation: true`)
gets only `lock`/`unlock`, and `unlock` only under the rules of "Automatisch aufsperren".

### Pushes (`data` for the app)

`data.route` = `plg-gatecontrol-door`; `data.door.type` says what it is; pictures arrive as
`imageUrl` (GateControl ≥ 1.169.0).

| Topic | `data.door` | `data.actions` |
|---|---|---|
| `doorbell` | `{ type: "ding", eventId, cameraId, lockId }` (+ picture) | `open` right: `{ type: "quick_action", label: "Tür öffnen" (opener "Summer"), plugin: "gatecontrol-door", id: "<lockId>:open", confirm: true, auth: "device" }`; all: `{ id: "open", type: "open_app_route", label: "Ansehen", target: "plg-gatecontrol-door" }` |
| `motion` | `{ type: "motion", eventId, cameraId, lockId }` (+ picture) | "Ansehen" |
| `auto` | `{ type: "auto_unlocked", lockId }` | `{ type: "quick_action", label: "Wieder zusperren", plugin, id: "<lockId>:lock" }`, "Ansehen" |
| `auto` | `{ type: "auto_refused", lockId, reason }` · `{ type: "auto_relocked" \| "auto_relock_failed", lockId }` | "Ansehen" |
| `auto` | `{ type: "auto_ask", lockId }` (no door sensor, 3 min) | `{ type: "quick_action", label: "Zusperren", plugin, id: "<lockId>:lock" }`, "Ansehen" |
| `door` | `{ type: "open_long" \| "jammed" \| "unreachable" \| "battery", lockId }` | "Ansehen" |
| `door` | `{ type: "night", lockId }` | `{ type: "quick_action", label: "Zusperren", plugin, id: "<lockId>:lock" }`, "Ansehen" |
| `door` | `{ type: "ring_broken" }` (administrators, ≤ 1 per day) | – |

`collapseKey`: `ring:<cameraId>` (doorbell/motion), `auto:<lockId>`, `door:<lockId>:<type>`, `ring:broken`.
Doorbell pushes have `ttl` 3600 s (the picture expires with it).

## Admin API (pages only)

`/api/v1/plugins/gatecontrol-door/api/admin/…` — administrators in GateControl's admin UI only
(portal/app callers get `403 forbidden`): `GET status`; `POST bridges`, `PATCH|DELETE bridges/<id>`,
`GET bridges/<id>/devices`; `PUT web`, `GET web/devices`; `GET|POST locks`, `PATCH|DELETE locks/<id>`,
`POST locks/<id>/refresh`; `POST ring/login|logout|sync`; `PATCH cameras/<id>`,
`GET cameras/<id>/snapshot`; `GET rights`, `PUT rights/<userId>`; `GET history`, `GET events/<id>`;
`GET|PUT settings`. Secrets are write-only (`hasToken: true/false`).

## Ring – what is used (unofficial, `server/ring.js`)

| | |
|---|---|
| Login | `POST https://oauth.ring.com/oauth/token` JSON `{ client_id: "ring_official_android", scope: "client", grant_type: "password", username, password }`, headers `2fa-support: true`, `2fa-code`, `hardware_id`, `User-Agent: android:com.ringapp`; `412` → code needed (`tsv_state`, `phone`); `400 "Verification Code…"` → wrong code |
| Refresh | same endpoint, `grant_type: "refresh_token"`; the answer's `refresh_token` replaces the stored one at once |
| Session | `POST https://api.ring.com/clients_api/session` `{ device: { hardware_id, metadata: { api_version: 11, device_model: "GateControl" }, os: "android" } }` every 12 h |
| Devices | `GET https://api.ring.com/clients_api/ring_devices` (`doorbots`, `authorized_doorbots`, `stickup_cams`) |
| Events | `GET …/clients_api/dings/active` every 5 s; `GET …/clients_api/locations/<id>/events?limit=20` every 30 s |
| Pictures | `GET https://app-snaps.ring.com/snapshots/next/<id>?after-ms=…&max-wait-ms=…&extras=force`; `GET …/clients_api/snapshots/image/<id>` |
