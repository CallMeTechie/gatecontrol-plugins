# Tür & Kamera / Door & Camera (`gatecontrol-door`)

*English: see [below](#english). App API for the GateControl apps: [App API](#app-api).*

Nuki-Schlösser und -Opener (lokale Nuki Bridge oder Nuki Web) und Ring-Klingeln/-Kameras in
GateControl: Tür in App, Widget und Portal auf- und zusperren, Klingel-Push mit Bild und
„Tür öffnen“, Verlauf mit Bildern, automatisches Aufsperren bei Ankunft (nur mit Zustimmung)
und Sicherheits-Hinweise. Rechte pro Person und Schloss. Dazu der **Ring-Modus** (Inaktiv /
Zuhause / Abwesend) pro Ring-Standort – in App, Widget, Portal und in Regeln der Familie.

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
   **Admins bekommen auf Schlösser nichts automatisch.** Pro Ring-Standort zusätzlich das Recht
   **„Ring-Modus schalten“** – Admins haben es immer, andere Personen nur mit Haken. Kiosk-Geräte
   und Portal-Besucher, die nur per Geräte-Vertrauen erkannt sind, sehen nur – sie können nie
   etwas auslösen.
6. **Einstellungen:** Zeitzone (für Zeitfenster und Nachtkontrolle), Sprache der Mitteilungen,
   Aufbewahrung der Bilder (1–30 Tage, Standard 7), Abstand der Bewegungs-Pushs, Ring-Abfrage
   an/aus, Nuki-Web-Protokoll übernehmen, **Klingel in den Familien-Chat** (1.3.0, Standard an):
   mit dem Messenger-Plugin (ab 1.4.0, GateControl ≥ 1.177.0) kommt jedes Klingeln als Karte mit Bild
   und „Tür öffnen“ in den Chat „Familie“; den Knopf prüft der Server wie jede andere Aktion. Gibt es
   keine Gruppe „Familie“ (1.4.0), geht die Karte an die Personen, die den Klingel-Push bekommen –
   jeweils in ihren eigenen Kanal „Tür & Kamera“. Die **Klingel-Diagnose** darunter zeigt die zuletzt
   erkannte Klingel (Zeit, Kamera, nach wie vielen Sekunden und über welchen Weg erkannt, was daraus
   wurde), das letzte Chat-Ergebnis mit verständlichem Grund und ob Ring die Sofort-Abfrage
   (`dings/active`) gerade einschränkt.

### Automatisch aufsperren bei Ankunft

Familie › Anwesenheit & Smart Home › neue Regel **„Person kommt heim“** (Person wählen) › Aktion
**„Haustür aufsperren“** (Tür & Kamera). Die Familie führt die Schnellaktion `<lockId>:unlock`
als die Person aus, die die Aktionen der Regel festgelegt hat (auf der Admin-Seite der
Administrator) – **deren** Rechte und Zustimmung gelten hier.

Das Plugin sperrt nur auf, wenn **alles** stimmt: nur „aufsperren“ (öffnen/Falle nie
automatisch), Zustimmung „Automatisch aufsperren“ und mindestens „zu-/aufsperren“, Zeitfenster,
höchstens einmal in 10 Minuten pro Person und Schloss, Schloss erreichbar und zugesperrt (frisch
abgefragt; ein „in Bewegung“, das seit 3 Minuten nicht endet – bei Nuki Web auch eines, dessen
Cloud-Stand älter als 60 s ist –, gilt als **Zustand unklar** und wird abgelehnt), Tür geschlossen (bei Türsensor). Sonst: abgelehnt, Eintrag im Verlauf und Mitteilung
„Automatisches Aufsperren abgelehnt: …“ (Thema „Automatisches Aufsperren“). Danach: „Haustür
automatisch aufgesperrt“ mit „Wieder zusperren“. **Sicherheitsnetz:** meldet der Türsensor in
3 Minuten kein „offen“, sperrt das Plugin wieder zu („wieder zugesperrt“); ohne Türsensor fragt
eine Mitteilung mit „Zusperren“.

**Risiken:** „zuhause“ heißt bei der Familie: das Handy ist im WLAN des Heimnetzes. Das kann auch
vor der Haustür, in der Einfahrt oder beim Nachbarn der Fall sein, und wer das Handy hat, kommt
hinein. Nur für Personen einschalten, die das wollen, möglichst mit Türsensor und Zeitfenster.
Tipp: Regel **„Alle sind unterwegs“** › Aktion „Haustür zusperren“.

### Zustand „in Bewegung“ (sperrt auf / sperrt zu / öffnet) und Diagnose

Die Bridge liefert in `/list` ihren **zwischengespeicherten** Zustand, Nuki Web in `/smartlock`
den der Cloud. Beide können nach einer Bedienung (z. B. über die Nuki-App, das Keypad oder den
Knopf am Schloss) auf einem Zwischenzustand hängen bleiben – „Öffnet …“ (`unlatching`), „Sperrt
auf …“, „Sperrt zu …“, beim Opener „Summer …“ oder „Startet …“. Deshalb:

* **Bridge:** steht ein Schloss in `/list` seit ≥ 30 s auf einem Zwischenzustand, fragt das
  Plugin das Schloss selbst (`/lockState`, per Bluetooth über die Bridge) – höchstens einmal pro
  Minute und Schloss – und übernimmt dessen Antwort. Klappt das nicht, gilt für diese Abfrage
  weiter `/list`.
* **Nuki Web:** nach ≥ 60 s wird das einzelne Schloss neu gelesen (`GET /smartlock/{id}`),
  höchstens alle 2 Minuten. Nuki Web liefert die **Kopie der Cloud**; sie bekommt nur Neues, solange
  das Schloss (bzw. seine Bridge) mit dem Internet verbunden ist. Wann die Cloud ihre Kopie zuletzt
  geändert hat, steht in `updateDate` des Schlosses. Ist ein Zwischenzustand dort **älter als
  60 s**, kann er nicht echt sein (ein Schloss bewegt sich nur Sekunden): er gilt sofort als
  „Zustand unklar“ (ohne 3 Minuten zu warten), und das Schloss wird sofort neu gelesen.
* **Anzeige:** ist der Zustand nach **3 Minuten** immer noch ein Zwischenzustand (Nuki Web: oder
  sein Cloud-Stand älter als 60 s), zeigen App, Portal und die Seite „Geräte“ den letzten festen
  Zustand mit dem Hinweis „Zustand unklar – zuletzt: Zugesperrt“ (API: `stale: true`). Wurde noch
  nie ein fester Zustand gesehen (z. B. hing die Cloud schon vor dem Update), heißt es nur
  „Zustand unklar“ (API: `lock: "unknown"`, `stale: true`) – nie „Öffnet …“. Für
  Sicherheitsentscheidungen zählt das nie: automatisches Aufsperren wird dann abgelehnt („Zustand
  des Schlosses unklar“).
* **Diagnose:** die Seite „Geräte“ zeigt pro Schloss die Quelle (Bridge/Nuki Web), den rohen
  Nuki-Code (z. B. 7 = öffnet, 3 = aufgesperrt, 1 = zugesperrt), woher er stammt (`/list`,
  `/lockState`, `/smartlock`, `/smartlock/{id}`), was die Übersicht meldet, wenn es abweicht,
  und wann zuletzt gelesen wurde. Darunter die **rohen Felder**: bei Nuki Web `mode`, `state`,
  `lastAction`, `trigger`, `doorState`, `serverState` (0 = ok, 4 = offline) und der Cloud-Stand
  aus `updateDate` („Cloud-Stand: vor 3 Std.“); bei der Bridge aus `lastKnownState` bzw.
  `/lockState` `mode`, `state`, `stateName`, `doorsensorState`, `doorsensorStateName` und
  `timestamp` (falls vorhanden). Bitte diese Zeilen mitschicken, wenn ein Zustand nicht stimmt.
* **Hinweis:** gilt ein Zustand aus Nuki Web als unklar, steht beim Schloss: „Nuki Web liefert
  einen veralteten Zustand. Für zuverlässige Anzeige die Nuki Bridge verwenden oder in der
  Nuki-App prüfen, ob das Schloss mit dem Internet verbunden ist.“

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
zu `api.nuki.io`, `oauth.ring.com`, `api.ring.com`, `app-snaps.ring.com`,
`prd-api-us.prd.rings.solutions` (Ring-Modus) und zur zugewiesenen Bridge.

### Ring-Modus (Inaktiv / Zuhause / Abwesend)

Wie in der Ring-App unter *Modi*: je nach Modus nehmen bestimmte Kameras auf und melden sich –
**welche, legst du in der Ring-App fest**; das Plugin zeigt und schaltet nur den Modus. Dafür
müssen die Modi für den Standort in der Ring-App eingeschaltet sein.

* **Wo:** Seite „Geräte“ › *Ring-Modus* (pro Standort der aktuelle Modus und drei Knöpfe),
  Portal-Tab „Tür“, Start-Kachel „Ring-Modus · <Standort>“ und die **Schnellaktionen** der
  Apps: pro Standort (Gerät = der Standort, ohne Rückfrage) **ein Schalter Zuhause ⇄ Abwesend**
  (an = Abwesend, aus = Zuhause; Titel = der aktuelle Modus, bei Inaktiv „Ring-Modus“ ohne
  Zustand; Antippen: Abwesend → Zuhause, Zuhause → Abwesend, Inaktiv → Zuhause) und der Knopf
  **Inaktiv** (seit 1.2.0; vorher drei Knöpfe). Der Schalter trägt das **Widget** „Ring-Modus“
  mit dem aktuellen Modus und einer Auswahl der drei Modi (mit Symbolen wie in der Ring-App;
  GateControl vor 1.174.0 zeigt nur die Namen).
* **Regeln:** Familie › Anwesenheit & Smart Home › z. B. Regel **„Alle sind unterwegs“** ›
  Schalter des Standorts › **„Abwesend“** und **„Erste Person kommt heim“** › **„Zuhause“**
  (oder der Knopf **„Inaktiv“**). Der Schalter kennt Zielzustände (`targets`): eine Regel setzt
  immer genau diesen Modus, auch wenn er schon gilt – sie schaltet nie um. Die Regel läuft als die Person, die ihre Aktionen festgelegt
  hat – diese Person braucht „Ring-Modus schalten“ (Admins immer).
* **Prüfung bei jedem Wechsel:** Recht, kein Kiosk-/Geräte-Vertrauen-Zugriff, Zeitfenster der
  Person, höchstens 10 Wechsel pro Minute pro Person und pro Standort. Jeder Versuch steht im
  **Verlauf** (Art „Ring-Modus“: wer, welcher Modus, über App / Mitteilung / Automatik (Regel,
  mit dem aufrufenden Plugin) / Portal / Admin-Seite, Ergebnis).
* **Aktualität:** gelesen mit dem Geräteabgleich (alle 10 Minuten, nach der Anmeldung,
  „Geräte aktualisieren“) und danach **jede Minute** pro Standort; nach einem Wechsel gilt sofort
  die Antwort von Ring. Fehler beim Lesen bremsen nur diese Abfrage (1 … 15 min, bei 429 nach
  `Retry-After`) – Klingel und Bilder laufen weiter.
* **Ring Alarm:** Standorte mit einer Ring-Alarmanlage (Basisstation) werden **nie** gelesen
  oder geschaltet – dort gehört der Modus zur Alarmanlage. Die Seite „Geräte“ zeigt sie mit dem
  Hinweis „Ring-Alarmanlage vorhanden – ihren Modus schaltet nur die Ring-App“. Ebenso ohne
  Knöpfe: Standorte ohne Kameras, mit ausgeschalteten Modi oder wenn Ring dem Konto den Wechsel
  nicht erlaubt (`readOnly`, z. B. geteilter Zugang ohne Freigabe).
* **Meldungen:** „Ring: Zuhause“; abgelehnt/fehlgeschlagen mit Grund, z. B. „Ring lehnt den
  Moduswechsel ab (HTTP 403).“, „Ring hat den Modus nicht umgestellt (HTTP 503).“, „Ring ist
  nicht erreichbar – der Modus wurde nicht umgestellt.“, „Ring hat den Modus nicht übernommen
  und meldet weiter „Zuhause“.“, „Ring ist nicht verbunden.“, „Außerhalb deines Zeitfensters.“

### Klingel-Verzögerung (Ring)

Ohne Push-Empfang (ein Plugin kann keine dauerhafte Verbindung zu Google/Firebase halten) fragt
das Plugin Ring ab: alle 5 Sekunden die aktiven Ereignisse, alle 30 Sekunden die Ereignisliste
als Nachlauf. **Erwartete Verzögerung: etwa 5–15 Sekunden**, dazu bis ~8 s für das Bild (ohne
Bild, wenn Ring keins rechtzeitig liefert oder es größer als 300 KB ist). Bei Fehlern bremst das
Plugin (5 s … 5 min, bei 429 nach `Retry-After`).

Ring schränkt die Sofort-Abfrage (`dings/active`) für viele Konten ein – sie liefert dann nichts oder
einen Fehler. Seit 1.4.0 stört das die Abfrage nicht mehr: bei einem Fehler (oder 429) pausiert das
Plugin nur diese eine Abfrage für 10 Minuten (bei 429 so lange, wie Ring verlangt) und liest die
Ereignisliste währenddessen alle 15 Sekunden. Dann kommt ein Klingeln **etwa 15–60 Sekunden** später
an (Ring führt es oft erst mit Verzögerung in der Liste). Klingeln bis 10 Minuten nach dem Läuten
landen im Verlauf und im Chat, der Push geht nur bis 5 Minuten danach raus; ältere zeigt nur die
Klingel-Diagnose. Gong und Fernseher bekommen das Klingeln direkt von Ring und sind deshalb schneller.

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
  stored, never the password. Link each camera to a lock — or (1.5.0), for a camera without one (at
the letterbox, in the garden), tick on the page "Berechtigungen" who sees it: those people see it, get
its rings and motion and find them in the history. The page "Einstellungen" warns when "Ring abfragen"
is off or a camera is seen by nobody (its rings reach nobody).
* **Permissions:** per person and lock none / view / lock+unlock / also open; optional weekly
  time window; opt-in "allow automatic unlock on arrival"; doorbell/motion push per camera.
  Administrators get nothing automatically; kiosk devices and device-trust portal viewers are
  read-only. Every action is checked again on the server (right, window, 10 per minute) and
  written to the history, refused ones included.
* **Automatic unlock:** Family › Presence & smart home › rule "Person comes home" › action
  "Unlock front door". Accepted only for `unlock` (never open), with the opt-in and at least
  `lock`, inside the window, at most once per 10 min per person and lock, lock reachable and
  locked (a "moving" state that has not ended for 3 min is refused as `state_unclear`), door
  closed (with a sensor). Not opened within 3 min → locked again (with a sensor) or
  a push asks. Risk: "home" = the phone is on the home Wi-Fi, which may be the case in front of
  the house.
* **Stuck "moving" states:** the bridge's `/list` (its cache) and Nuki Web's `/smartlock` can stay
  on unlocking / locking / unlatching (opener: opening / boot_run). Bridge: after ≥ 30 s the lock
  itself is asked (`/lockState`, at most once per minute per lock); Nuki Web: after ≥ 60 s the
  lock is read again (`GET /smartlock/{id}`, at most every 2 min). Still moving after 3 min — Nuki
  Web: or the cloud's copy (`updateDate`) of a moving state older than 60 s, then at once → the
  last stable state is shown with `stale: true` ("State unclear – last: Locked"; no stable state
  ever seen: `lock: "unknown"`, "State unclear"); automatic unlock refuses then. The page
  **Devices** shows per lock the source, the raw Nuki state code, where it came from, when it was
  last read, the raw fields (Nuki Web: `mode`, `state`, `lastAction`, `trigger`, `doorState`,
  `serverState`, the cloud's age from `updateDate`; bridge: `mode`, `state`, `stateName`,
  `doorsensorState`, `doorsensorStateName`, `timestamp`) and, for a stale Nuki Web state, a hint
  to use the bridge or check the lock's internet connection in the Nuki app.
* **Privacy:** history (90 days), pictures (1–30 days) and rights stay on your server; tokens are
  encrypted, never logged and never sent to a page or app.
* **Ring mode:** per Ring location Disarmed / Home / Away as in the Ring app (which cameras
  record and notify in each mode is set up there). Page **Devices**, the portal tab, a Start tile
  and per location (device `ring:<locationId>`, no confirm) the toggle `mode:<locationId>`
  Home ⇄ Away (on = Away; `targets`, so a Family rule "Everyone is out" › "Away" sets exactly
  that mode; carries the widget "Ring mode" with a choice control `mode`) and the button
  `mode_disarmed:<locationId>` ("Disarmed"). Right "Switch Ring mode"
  per person and location; administrators always. Checked like door actions (right, read-only
  viewers, time window, 10 per minute per person and location) and written to the history.
  Read every minute; locations with a **Ring Alarm** base station are never read or switched.
* **Ring delay:** polled (no push receiving possible for a plugin): about 5–15 s plus up to ~8 s
  for the picture. Ring restricts `dings/active` for many accounts (empty or an error): since 1.4.0 an
  error or a 429 there only pauses that request (10 minutes, longer when Retry-After says so) and the
  location events are read every 15 s instead — about 15–60 s then. Rings are taken up to 10 minutes
  after they rang (history, chat card), pushed only up to 5 minutes; motion keeps 2 minutes.
* **Doorbell in the family chat (1.3.0):** with the Messenger plugin (1.4.0 or later, GateControl ≥
  1.177.0, `permissions.services` `gatecontrol-messenger:send_message`) every ring posts a card into
  the chat "Family": `send_message { conversation: 'family', card: { kind: 'doorbell', title:
  'Klingel · <lock>', text: '<camera> · HH:MM', imageBase64?, actions: ['<lockId>:open'] } }` —
  the picture when there is one (sent again without it when the host refuses the size: 16 KB of JSON
  per service call), the lock's "open" quick action when it offers one. A tap on the card is
  GateControl's interactive run (`user.interactive: true`, `automation: false`, `via:
  'gatecontrol-messenger'`): a person's action with that person's rights, never the automation
  rules; history `via: 'chat'` with `caller: 'gatecontrol-messenger'`. Switch "Doorbell in the family
  chat" on the page **Settings** (default on); without the messenger nothing changes.
  1.4.0: the host takes up to 512 KB per call from GateControl 1.180.0 on (16 KB before). When the
  messenger answers `not_found` (no group "Family"), the card goes to the people who get the ring's
  push, each into their own read-only channel "Door & Camera" (`conversation: ['user:<id>', …]`, ≤ 20,
  `title`). The page shows the **doorbell diagnosis**: the last ring noticed (when, camera, delay,
  source `active` | `events`, outcome) and the last chat result with a reason.

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
  "cameras": [ CameraView, … ],           // enabled cameras linked to one of those locks, and (1.5.0) cameras without a lock the person was given
  "ring": { "connected": true, "broken": false },   // broken → show "Ring-Verbindung gestört"
  // 1.4.0: the last ring and its chat card — null for people who see no camera
  "doorbell": { "lastRingAt": "2026-10-14T08:00:00Z" | null, "source": "active" | "events" | null,
                "chat": { "at": "…", "ok": true, "error": null | "not_found" | "unavailable" | "rate_limit" | "timeout" | "invalid" | "failed",
                          "fallback": false } | null },   // fallback: sent to the people's own channels (no group "Familie")
  "ringModes": [ RingModeView, … ],       // Ring locations this person may switch (see below; [] for most people)
  "serverTime": "2026-10-14T08:00:00Z"
}
```

**RingModeView** (1.1.0)

```jsonc
{ "id": "a1b2c3d4-…", "name": "Langenlonsheim",
  "mode": "home",                         // "disarmed" (Inaktiv) | "home" (Zuhause) | "away" (Abwesend)
  "modes": ["disarmed", "home", "away"],  // the buttons, in this order
  "blocked": null,                        // null | "read_only" | "outside_window" (show the buttons disabled)
  "modeAt": "2026-10-14T07:00:00Z",       // when Ring last changed the mode (may be null)
  "checkedAt": "2026-10-14T08:00:00Z" }   // last read / switch
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
    "stale": false,                       // true: Nuki has reported a moving state for ≥ 3 min (Nuki Web: or from cloud data older than 60 s) — "lock" is then the last stable state ("unknown" if none was seen); show "Zustand unklar – zuletzt: …" ("Zustand unklar" for "unknown")
    "door": "closed",                     // null = no door sensor | "open" | "closed" | "unknown" | "deactivated" | "calibrating" | "uncalibrated" | "removed"
    "batteryCritical": false, "batteryPercent": 80, "batteryCharging": false,   // batteryPercent may be null
    "reachable": true, "updatedAt": "2026-10-14T08:00:00Z"                     // updatedAt may be null
  }
}
```

Lock states — smart lock: `locked`, `unlocked`, `unlatched`, `locking`, `unlocking`,
`unlatching`, `jammed`, `uncalibrated`, `unknown`; opener: `online`, `rto_active`, `open`,
`opening`, `untrained`, `boot_run`, `unknown`. `reachable: false` → show "nicht erreichbar".
Transitional ("moving") states: `unlocking`, `locking`, `unlatching`, `opening`, `boot_run`. One
that has not ended after 3 minutes (Nuki Web: or whose cloud data — `updateDate` — is older than
60 s) is not shown any more: `lock` is the last stable state seen before it, or `unknown` when
none was ever seen, and `stale` is `true` (an app that does not know `stale` simply shows that
state). Show `stale: true` with `lock: "unknown"` as "Zustand unklar" / "State unclear".

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

### `POST modes/<locationId>/<mode>` (1.1.0)

`<mode>` = `disarmed` | `home` | `away`. Switches the Ring mode of that location (checked again:
the right "Ring-Modus schalten" — administrators always —, read-only viewers, time window,
≤ 10 per minute per person and location; every attempt is in the history).

```jsonc
{ "ok": true, "message": "Ring: Zuhause", "ringMode": RingModeView }
```

A location this person may not switch (or an unknown mode) → `404 not_found`.

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
the rings/motion of cameras linked to locks they can view and (1.5.0) of cameras without a lock they
were given (administrators: everything).

```jsonc
{ "ok": true, "nextCursor": 118,          // null = no more; pass as ?cursor=
  "items": [ {
    "id": 120, "at": "2026-10-14T08:00:00Z",
    "kind": "action",                     // "action" | "ding" | "motion" | "alert" | "nuki" | "mode" (Ring mode switch)
    "lockId": 1, "lockName": "Haustür", "cameraId": null, "cameraName": null,
    "locationId": null, "locationName": null,   // kind "mode": the Ring location
    "userId": 3, "userName": "Marc",
    "via": "app",                         // "app" | "portal" | "notification" | "automation" | "chat" (1.3.0) | "system" | "nuki" | "keypad" | "ring" | "admin"
    "caller": null,                       // automation: the calling plugin id, e.g. "gatecontrol-familie"
    "action": "unlock",                   // action: lock|unlock|open; alert: open_long|jammed|unreachable|night; nuki: lock|unlock|open|null; mode: disarmed|home|away
    "result": "ok",                       // "ok" | "refused" | "failed"
    "reason": null, "reasonText": null,   // e.g. "outside_window" / "außerhalb des Zeitfensters"
    "hasImage": false                     // ding/motion with a stored picture → GET events/<id>
  } ] }
```

Reason codes: `no_right`, `unsupported`, `read_only`, `outside_window`, `rate_limited`,
`auto_open`, `auto_no_right`, `auto_off`, `auto_too_soon`, `unreachable`, `not_locked`,
`door_open`, `failed`, `lock_unreachable`, `lock_failed`, `nuki_auth`, `no_target`,
`not_configured`, `auto_relock`; Ring mode: `mode_alarm`, `mode_disabled`, `mode_read_only`,
`ring_not_connected`, `ring_login_failed`, `ring_rate_limited`, `ring_mode_refused`,
`ring_mode_failed`, `ring_mode_unreachable`, `ring_mode_mismatch`.

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
| 409 | `mode_alarm`, `mode_disabled`, `mode_read_only` | Ring mode: a Ring Alarm location / modes off in the Ring app / Ring does not let this account switch |
| 429 | `rate_limited`, `too_soon`, `ring_rate_limited` | with `retryAfter` (s) |
| 502 | `lock_unreachable`, `lock_failed`, `nuki_error`, `ring_error` | |
| 502 | `ring_mode_refused`, `ring_mode_failed` | Ring answered the mode switch with an error, `httpStatus` = its HTTP status |
| 502 | `ring_mode_unreachable`, `ring_mode_mismatch` | no answer / Ring kept the old mode (`mode`) |

### Quick actions

`GET /api/v1/client/actions` lists, per lock and right: `<lockId>:lock` ("Haustür zusperren",
no confirm), `<lockId>:unlock` ("… aufsperren", `confirm: true`), `<lockId>:open` ("… öffnen";
opener "… Summer", `confirm: true`); subtitle = the state ("Zugesperrt"), icons lock / open lock /
door. Runs: `POST /api/v1/client/actions/gatecontrol-door/<lockId>:<action>` with body
`{ "source": "app" | "notification" }`. Another plugin (`gc.actions.run`, `automation: true`)
gets only `lock`/`unlock`, and `unlock` only under the rules of "Automatisch aufsperren".

Ring mode, per location the person may switch (administrators: every location that supports
it), both with `device: { id: "ring:<locationId>", title: "<location name>", subtitle:
"Ring-Modus" }` and no confirm (1.2.0; 1.1.0 had three buttons — `mode_home:` / `mode_away:` are
gone, pins of them disappear):

* `mode:<locationId>` — **toggle** Zuhause ⇄ Abwesend: `state` `"on"` = away, `"off"` = home,
  `null` = disarmed or unknown; `title` the current mode ("Zuhause" / "Abwesend", "Ring-Modus"
  when disarmed/unknown), `subtitle` the location name; `look: { on: { icon: <running person
  shield>, tone: "good" }, off: { icon: <person shield>, tone: "neutral" } }`, `verbs: { on:
  "Abwesend", off: "Zuhause" }` (en Away / Home), `targets: true`. A run with a target state sets
  exactly that mode (`on` → away, `off` → home, also when it already holds); a plain run: away →
  home, home → away, disarmed/unknown → home. The answer has the new `state` and `widget`.
* `mode_disarmed:<locationId>` — **button** "Inaktiv", subtitle "Aktuell: Zuhause".

The toggle carries the widget:

```jsonc
{ "label": "Ring-Modus", "value": "Zuhause", "state": "good",   // "off" for Inaktiv
  "power": false,
  "controls": [{ "id": "mode", "kind": "choice", "label": "Modus", "value": "home",
                 "options": [{ "id": "disarmed", "label": "Inaktiv", "icon": "<path>" },
                             { "id": "home", "label": "Zuhause", "icon": "<path>" },
                             { "id": "away", "label": "Abwesend", "icon": "<path>" }] }] }
```

A control run on the toggle (`control: "mode"`, `value: "away"`) sets that mode (also
`disarmed`) and answers with the new state and widget. Answers: `{ ok: true, message: "Ring: Zuhause" }`, refused/failed `{ ok: false,
message: "<reason>" }` (see "Ring-Modus" above). Option icons need GateControl ≥ 1.174.0 (older
hosts drop them, the apps show the labels); widget and device need ≥ 1.171.0 / 1.172.0, `look`
1.172.0, `verbs` / `targets` 1.173.0 (older hosts drop them; a target-state run then becomes a
plain run — the Familie rules with target states need 1.173.0 anyway).

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
`GET cameras/<id>/snapshot`; `POST modes/<locationId>/<disarmed|home|away>`; `GET rights`,
`PUT rights/<userId>`; `GET history`, `GET events/<id>`;
`GET|PUT settings` (1.3.0: `familyChat` in `config`; both answer `chat: { api, available, last: { at, ok,
error, image, fallback: { to, sent, failed } | null } | null, detect }` — `available` `null` on GateControl < 1.178.0;
1.4.0 `detect: { lastDing: { at, seenAt, delayS, source: 'active' | 'events', camera, outcome: 'handled' | 'too_old' |
'no_camera' | 'failed', pushed } | null, active: { state: 'ok' | 'off', code, since, offUntil } | null }`). Secrets are write-only (`hasToken: true/false`). `GET status` carries
`ringModes: [{ id, name, mode, supported, why, cameras, alarm, readOnly, error, present, modeAt,
checkedAt }]` (`why`: `null` or `alarm` | `no_cameras` | `unknown` | `error` | `disabled` |
`read_only`); `GET rights` carries `locations: [{ id, name, supported }]` (no Ring Alarm
locations) and `modeRights: { <userId>: [<locationId>, …] }`; `PUT rights/<userId>` takes
`modes: { <locationId>: true | false }`. Each lock of `GET status` /
`locks` carries `diag: { source, nukiState, via, listNukiState, updatedAt, checkedAt, movingSince,
stableState, stale, staleWhy, raw, cloudAt, cloudAgeSec, cloudHint }` — the raw Nuki state code and
where it came from (`list` = bridge `/list`, `lockState`, `smartlock` = web overview, `smartlock_id`
= web single read, `assumed` = after an own action until the next poll); `staleWhy`: `null`,
`moving` (≥ 3 min) or `cloud` (Nuki Web data older than 60 s); `raw`: the raw fields Nuki reported
(Nuki Web: `mode`, `state`, `lastAction`, `trigger`, `doorState`, `serverState`, `updateDate`;
bridge: `mode`, `state`, `stateName`, `doorsensorState`, `doorsensorStateName`, `timestamp` —
only numbers, booleans and short strings, never tokens; kept in `lock_state.nuki_raw`, migration
`003_state_raw.sql`); `cloudAt` / `cloudAgeSec`: Nuki Web's `updateDate` and its age;
`cloudHint`: a Nuki Web state is stale (the page shows the hint).

## Ring – what is used (unofficial, `server/ring.js`)

| | |
|---|---|
| Login | `POST https://oauth.ring.com/oauth/token` JSON `{ client_id: "ring_official_android", scope: "client", grant_type: "password", username, password }`, headers `2fa-support: true`, `2fa-code`, `hardware_id`, `User-Agent: android:com.ringapp`; `412` → code needed (`tsv_state`, `phone`); `400 "Verification Code…"` → wrong code |
| Refresh | same endpoint, `grant_type: "refresh_token"`; the answer's `refresh_token` replaces the stored one at once |
| Session | `POST https://api.ring.com/clients_api/session` `{ device: { hardware_id, metadata: { api_version: 11, device_model: "GateControl" }, os: "android" } }` every 12 h |
| Devices | `GET https://api.ring.com/clients_api/ring_devices` (`doorbots`, `authorized_doorbots`, `stickup_cams`) |
| Events | `GET …/clients_api/dings/active` every 5 s (optional since 1.4.0: an error or 429 pauses it for ≥ 10 min); `GET …/clients_api/locations/<id>/events?limit=20` every 30 s (15 s while `dings/active` is paused) |
| Pictures | `GET https://app-snaps.ring.com/snapshots/next/<id>?after-ms=…&max-wait-ms=…&extras=force`; `GET …/clients_api/snapshots/image/<id>` |
| Locations | `GET https://api.ring.com/devices/v1/locations` → `user_locations: [{ location_id, name }]`; Ring Alarm = `base_stations` of `ring_devices` with that `location_id` (ring-client-api `lib/api.js`) |
| Mode | `GET` / `POST https://prd-api-us.prd.rings.solutions/api/v1/mode/location/<location_id>` (POST body `{ mode: "disarmed" \| "home" \| "away" }`) → `{ mode, readOnly, lastUpdateTimeMS, … }`; switchable = cameras there, no Ring Alarm, `mode` not `disabled`/`unset`, not `readOnly` (ring-client-api 14.3.0 `lib/location.js` `getLocationMode` / `setLocationMode` / `supportsLocationModeSwitching`) |
