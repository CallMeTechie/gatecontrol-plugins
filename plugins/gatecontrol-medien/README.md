# gatecontrol-medien — Medien

Jellyfin und die NAS-Freigaben (SMB, WebDAV) zentral im GateControl-Server: Handy, Fernseher und PC bekommen die
Quellen und ihren Zugang automatisch über die App-API des Plugins (`permissions.app`), ohne Eingabe am Gerät. Videos laufen
nie über den Server – er liefert nur Liste, Adressen und Zugänge (wenige KB) und spricht selbst nur mit Jellyfin (kleine
JSON-Antworten über das Zugriffsziel `jellyfin`). Handbuch: [HANDBUCH.md](HANDBUCH.md) / [HANDBOOK.md](HANDBOOK.md).

Eigene Lizenz (`license.required`), **nie** im GateControl-Plan oder einer Server-Lifetime-Lizenz enthalten: eine
Berechtigung mit `source` `plan` oder `lifetime` (`gc.license.info()`) zählt im Plugin nicht (`server/license.js`, App-Tab
aus, App-API `403 license_required`). Shop-Eintrag mit `included_in_lifetime: false` (Teilstufe L, nicht in diesem PR).

```
server/index.js     Hooks: start, request, render, appVisible, devicesChanged, groupsChanged, settingsChanged, tick
server/admin.js     Admin-API admin/* (Reiter Quellen, Personen, Geräte, Übersicht)
server/app.js       App-API v1/* (Apps mit Geräte-Token)
server/cast.js      „Auf TV/PC abspielen“: Cast-Nachrichten zwischen den eigenen Geräten
server/jellyfin.js  kleiner Jellyfin-Admin-Client (10.9–10.11), Tests gegen aufgezeichnete Antworten
server/sources.js   Quellen, Geheimnisse (gc.settings.setSecret), Netz-Regel (away)
server/rights.js    Recht „Medien“ je Person/Gruppe, Sicht je Quelle, Kinder ohne NAS-Freigaben
server/mapping.js   Person ↔ Jellyfin-Benutzer (per Name, von Hand, „In Jellyfin anlegen“)
server/devices.js   Anmeldungen, ausgelieferte Passwörter, Widerruf, Abgleich alle 5 Minuten
server/license.js   nur die eigene Lizenz zählt
ui/                 Seiten overview (Seitenleiste Apps › Medien), sources, people, devices (ui.settingsPages)
test/               node:test gegen tools/testing/mock-host.js; test/fixtures = Antworten echter Jellyfin-Server
test/spike/         das Skript des Spikes M0 (gegen ein echtes Jellyfin)
```

Mindestversion **GateControl 1.301.0** (Signal-Topic, `ui.settingsPages`, `reason: plugin_unavailable`). Mit
**GateControl ≥ 1.322.0** nutzt das Plugin den Hook `devicesChanged` (entferntes/gesperrtes Gerät verliert Jellyfin
sofort); ohne ihn reicht der Abgleich alle 5 Minuten (bleibt auch mit Hook das Sicherheitsnetz, der Host holt verpasste
Meldungen nicht nach). `clientType: 'android-tv'` (GateControl ≥ 1.320.0) erkennt Fernseher als Cast-Ziel.

## Spike M0: Jellyfin-Anmeldung ohne Eingabe (Ablauf A)

**Ergebnis: Ablauf A geht.** Getestet am 25.11.2026 gegen die offiziellen Linux-Releases **Jellyfin 10.9.11, 10.10.7 und
10.11.11** (frisch eingerichtet, ein Admin, ein normaler Benutzer, danach nur noch der API-Schlüssel). Das Skript liegt in
`test/spike/jellyfin-spike.mjs`, die bereinigten Antworten in `test/fixtures/jellyfin-<version>.json` (die Tests des
Clients laufen dagegen). Das Synology-Paket nutzt denselben Server; die Version zeigt die Prüfung im Dialog.

| Aufruf (mit API-Schlüssel) | 10.9.11 | 10.10.7 | 10.11.11 | Beleg im Code (Tag v10.10.7) |
|---|---|---|---|---|
| `POST /QuickConnect/Authorize?code=…&userId=<anderer Benutzer>` | 200 `true` | 200 `true` | 200 `true` | `QuickConnectController.AuthorizeQuickConnect` → `RequestHelpers.GetUserId`: anderer Benutzer nur mit Rolle Administrator; `CustomAuthenticationHandler`: `IsApiKey` → Rolle Administrator |
| derselbe Code noch einmal | 500 | 500 | 500 | `QuickConnectManager.AuthorizeRequest`: „Request is already authorized“ |
| unbekannter/abgelaufener Code | 404 | 404 | 404 | `ResourceNotFoundException` (Anfragen gelten 10 Minuten, `Timeout = 10`) |
| Quick Connect aus (`/QuickConnect/Initiate`) | 401 | 401 | 401 | „Quick connect is disabled“ |
| Gerät danach in `/Devices/Info?id=gc-…` mit `LastUserId` des Benutzers | ja | ja | ja | `AuthenticateDirect` legt den Zugang für DeviceId/DeviceName der Anfrage an |
| `DELETE /Devices?id=gc-…` | 204 | 204 | 204 | `DevicesController.DeleteDevice` (`RequiresElevation`), beendet Sitzungen, löscht Tokens |
| Token des Geräts danach (`/Users/Me`) | 401 | 401 | 401 | – |
| unbekanntes Gerät löschen | 404 | 404 | 404 | `NotFound()` |
| `POST /Users/New { Name, Password }` | 200, kein Admin | 200 | 200 | `UserController.CreateUserByName` (`RequiresElevation`); doppelter Name 400 |
| Quick Connect per Konfiguration (`GET`/`POST /System/Configuration`, `QuickConnectAvailable`) | 204, wirkt sofort | 204 | 204 | Standard ist **an** |
| `/Devices` mit dem Token eines Geräts | 403 | 403 | 403 | ein Gerät kann keine Admin-Aufrufe |

Wichtig für die Apps: Jellyfin liest die Werte im `Authorization`-Kopf **URL-codiert**. Ein Gerätename wie
`GateControl · Pixel von Mila` roh im Kopf → `400` bei `/QuickConnect/Initiate`; mit `encodeURIComponent` → 200, in
Jellyfins Geräteliste steht der Name richtig. Der Rückfall B (verwaltetes Passwort) wird **nicht** gebraucht.

Grenze von A: Welche DeviceId zu einem Code gehört, zeigt Jellyfin erst nach der Bestätigung. Das Plugin prüft danach, dass
Jellyfin genau die vom Plugin vergebene DeviceId für den verknüpften Benutzer angelegt hat, und antwortet sonst
`device_mismatch` (Protokoll-Eintrag). Ein fremder Code bringt dem Einreicher nur einen Zugang zu seinem **eigenen**
verknüpften Benutzer.

## App-API v1

Basis: `/api/v1/client/plugins/gatecontrol-medien/api/` mit dem Geräte-Token (Scope `client`, Gerätebindung wie jede
Client-Route), `Cache-Control: no-store`, 240 Anfragen pro Minute und Token (GateControl). Die Version steht im Pfad
(`v1/`) und in jeder Antwort (`v: 1`). Neue Felder kommen ohne neue Version dazu – Apps übergehen unbekannte Felder.
Eine nicht passende Änderung bekommt `v2/`; `v1/` bleibt dann mindestens zwei Plugin-Versionen erhalten.
Das Plugin bekommt das fragende Gerät von GateControl (`permissions.devices`, `req.user.device.id` = Token-ID);
eine Ziel-Person nimmt **kein** Aufruf als Parameter an.

Fehler: `{ ok: false, v: 1, code, error }` (+ ggf. `field`, `reason`).

| Code | HTTP | Was die App tut |
|---|---|---|
| `not_found` + `reason: plugin_unavailable` | 404 (vom Server, nicht vom Plugin) | Plugin nicht installiert, aus oder ohne Lizenz: Medien ausblenden, Hinweis „Medien ist im Server ausgeschaltet“. Zugänge/Passwörter/Downloads erst löschen, wenn das **24 h** so bleibt (Frage 37 a). |
| `license_required` (+ `reason: missing \| not_own`) | 403 | wie `plugin_unavailable` (Lizenz über Plan/GateControl Lifetime zählt nicht). |
| `no_access` | 403 | Person sieht die Quelle nicht (mehr): Quelle, Passwort, Jellyfin-Zugang und Downloads dieser Quelle löschen. |
| `no_device` | 400 | Anfrage ohne Gerätebindung (z. B. Browser) – nicht für Apps. |
| `no_mapping` | 409 | „Der Admin muss dich in GateControl › Medien mit Jellyfin verknüpfen.“ |
| `quick_connect_off` | 409 | Hinweis an Person; später erneut. |
| `admin_user` / `user_disabled` | 409 | Hinweis „Admin muss die Zuordnung ändern“. |
| `not_configured` | 409 | Quelle im Server unvollständig; später erneut. |
| `device_mismatch` | 409 | Der Code gehörte nicht zur DeviceId aus `v1/sources` → mit **genau** `device.id` neu starten. |
| `code_invalid` | 422 | Quick-Connect-Code abgelaufen/benutzt: neuen Code holen, **einmal** neu versuchen. |
| `rate_limited` | 429 | später erneut (Anmeldung: 10 pro Stunde und Gerät; Cast: 60/min, 600/h je Gerät). |
| `too_large` | 413 | Cast-Nachricht > 3000 Bytes. |
| `jellyfin_unreachable` / `jellyfin_error` / `key_invalid` | 502 | Server erreicht Jellyfin nicht: später erneut, vorhandener Zugang bleibt gültig. |
| `invalid` | 400 | Programmierfehler der App (`field` sagt welches Feld). |

### GET v1/sources[?since=<rev>]

Liste der Quellen, die diese Person **jetzt** sieht – ohne Passwörter. Wann: App-Start, Öffnen von Medien, nach dem
Ereignis `media.changed`, nach `media.revoke`, sonst höchstens alle 15 Minuten. `?since=<rev>` mit dem `rev` der letzten
Antwort: unverändert → `{ ok: true, v: 1, rev, unchanged: true, at }` (der Plugin-Host reicht keine Request-Header durch,
deshalb kein ETag/304).

```jsonc
{ "ok": true, "v": 1, "rev": "rVdEa3gRkVX1W", "at": "2026-11-25T19:02:11.000Z",
  "media": true,                       // die Person hat das Recht „Medien“ (false → sources: [])
  "maxOfflineDays": 90,                // nach so vielen Tagen ohne Kontakt zum Server NAS-Passwörter auf dem Gerät löschen
  "offlineHintDays": 30,               // ab dann Hinweis „lange keinen Kontakt zum Server“
  "network": {
    "rule": "home_direct_away_vpn",    // die Netz-Regel (siehe unten)
    "vpnRequiredAway": true,           // mindestens eine Quelle geht unterwegs nur über VPN
    "home": { "probes": [              // Heimnetz-Erkennung, nur über das lokale Netz (WLAN/LAN), nie durch den Tunnel
      { "kind": "jellyfin", "url": "http://192.168.1.20:8096/System/Info/Public", "serverId": "4f1c…a9", "sourceId": "jf-1", "unique": true },
      { "kind": "tls", "url": "https://192.168.1.20:5006/filme", "certSha256": "9c41…", "sourceId": "sh-1", "unique": true },
      { "kind": "tcp", "host": "192.168.1.30", "port": 445, "sourceId": "sh-2", "unique": false } ] }   // ab 1.0.1
  },
  "cast": { "enabled": true },         // „Auf TV/PC abspielen“ erlaubt
  "sources": [
    { "id": "jf-1", "kind": "jellyfin", "name": "DS918+",
      "serverId": "4f1c…a9", "version": "10.10.7",
      "address": "http://192.168.1.20:8096",          // = home.address (bleibt für ältere Leser)
      "home": { "address": "http://192.168.1.20:8096" },
      "away": { "mode": "vpn" },                       // oder { "mode": "direct", "address": "https://jellyfin.example.test" }
      "user": { "id": "a71e…", "name": "mila" },       // null → problem "no_mapping"
      "problem": null,                                 // null | "no_mapping" | "quick_connect_off"
      "device": { "id": "gc-7Hq2mXk4Rb9tLp0sVw3N", "name": "GateControl · Pixel von Mila" },   // null ohne Gerätebindung
      "paired": false,                                 // das Plugin kennt eine Anmeldung dieses Geräts für den aktuellen Benutzer
      "quickConnect": true, "downloads": true, "alwaysOriginal": false },
    { "id": "sh-1", "kind": "share", "name": "Filme", "folder": "filme",
      "smb": { "address": "smb://192.168.1.20/filme" },                                        // oder null
      "webdav": { "address": "https://192.168.1.20:5006/filme", "certSha256": "9c41…" },      // oder null; certSha256 optional (anheften)
      "user": "medien-lesen", "secretRev": 3,          // Passwort neu holen, wenn secretRev > eigener Stand
      "away": { "mode": "vpn" } } ] }
```

Quellen-IDs (`jf-<n>`, `sh-<n>`) sind auf allen Geräten aller Personen gleich und ändern sich nie.

### GET v1/sources/{id}/secret

`{ ok, v: 1, user, password, rev }` einer Freigabe – nur für ein Gerät (Gerätebindung) einer aktiven Person mit Recht
„Medien“ und Recht auf diese Freigabe. Wird protokolliert (ohne Passwort). Holen, wenn `secretRev` neuer als der
eigene Stand ist. Verschlüsselt speichern (Android Keystore, Windows DPAPI).

### POST v1/jellyfin/pair `{ sourceId, code }` → `{ ok, v: 1, userId, userName, deviceId }`

Ablauf A (Spike M0: Jellyfin 10.9.11/10.10.7/10.11.11 nehmen es an):

1. `device.id`/`device.name` aus `v1/sources` nehmen.
2. Am Jellyfin: `POST {address}/QuickConnect/Initiate` mit
   `Authorization: MediaBrowser Client="GateControl", Device="<URL-codiert device.name>", DeviceId="<device.id>", Version="<App-Version>"`.
   **Werte URL-codiert** (`encodeURIComponent`) – mit „·“/Umlauten roh antwortet Jellyfin 400. Kein Code wird angezeigt.
   `401 Quick connect is disabled` → Hinweis `quick_connect_off`.
3. `POST v1/jellyfin/pair { sourceId, code: <Code aus Initiate> }`. Das Plugin prüft Gerät, Recht, Zuordnung (kein Jellyfin-Admin,
   nicht deaktiviert), bestätigt den Code mit dem API-Schlüssel für den verknüpften Benutzer und prüft danach, dass Jellyfin
   genau dieses `device.id` für diesen Benutzer angelegt hat (sonst `device_mismatch`).
4. Am Jellyfin: `GET /QuickConnect/Connect?secret=…` bis `Authenticated: true` (die Anfrage gilt nach der Bestätigung noch
   1 Minute), dann `POST /Users/AuthenticateWithQuickConnect { Secret }` → eigener `AccessToken` (nur auf dem Gerät, verschlüsselt).
5. `POST v1/jellyfin/paired { sourceId, jellyfinDeviceId: device.id }` → `{ ok, v: 1 }` (Geräte-Reiter zeigt „angemeldet“).

Einen Ablauf für Zugänge gibt es in Jellyfin nicht. Antwortet Jellyfin mit **401**, wiederholt die App 1–5 ohne Rückfrage.
`code_invalid` → einmal neu. Wechselt `user.id` in `v1/sources` (Zuordnung geändert), Schritte 1–5 neu (das Plugin hat das
alte Gerät in Jellyfin schon gelöscht).

### POST v1/jellyfin/paired `{ sourceId, jellyfinDeviceId }` → `{ ok, v: 1 }`

### DELETE v1/jellyfin/device[?sourceId=jf-1] → `{ ok, v: 1, sources: [...] }`

App abgemeldet, „Medien zurücksetzen“, TV entkoppelt: das Plugin löscht dieses Gerät in Jellyfin (alle Zugänge). Ohne
`sourceId` alle Jellyfin-Quellen.

### POST v1/shares/{id}/checked `{ protocol: "smb", ok, problem? }` → `{ ok, v: 1 }`

Nach der ersten SMB-Anmeldung (nur wenn das Passwort vorher über `secret` geholt wurde). Quellen-Seite zeigt „SMB geprüft“.

### POST v1/sources/{id}/report `{ way: "home" | "away", ok, problem? }` → `{ ok, v: 1 }`

Der Weg zur Quelle (z. B. `problem: "tunnel_unreachable"`, „NAS durch den Tunnel nicht erreichbar“). Nur bei Änderung senden.

### Ereignisse und stille Mitteilungen

| Was | Weg | Inhalt | App tut |
|---|---|---|---|
| Liste geändert | Ereignis `event: plugin` auf dem Push-Stream, `{ plugin: "gatecontrol-medien", type: "media.changed", data: { rev } }` | – | `GET v1/sources?since=…` |
| Widerruf | stille Daten-Mitteilung (Signal-Topic `media_signal`, `kind: "data"`, `silent: true`), `data: { kind: "media.revoke", sourceIds: [..] \| null, reason }` | `null` = alle Quellen | Zugänge, Passwörter, Downloads dieser Quellen löschen, Jellyfin-Token verwerfen, dann `GET v1/sources` (darf neu anmelden, wenn noch berechtigt). `reason`: `admin`, `right`, `mapping`, `source`, `user`, `device_removed`. |
| Cast | Ereignis `type: "media.cast"` und/oder stille Mitteilung `data.kind: "media.cast"` | siehe Cast | siehe Cast |

### Netz-Regel (verbindlich)

- **Zu Hause** (Heimnetz erkannt): direkt im LAN an `home.address` bzw. `smb`/`webdav`, **nie** über Server oder Tunnel –
  auch bei eingeschaltetem VPN (Android: an das WLAN/LAN-Netz gebundener Socket, `Network.bindSocket`/`openConnection`;
  Windows: an die LAN-Schnittstelle gebunden). SMB bevorzugt.
- **Unterwegs**, `away.mode == "vpn"` (Standard): Medien **nur durch das VPN** (dieselben Heimadressen durch den eigenen
  WireGuard-Tunnel; Freigaben per WebDAV, sonst SMB durch den Tunnel). Ist das VPN aus, **startet die App es beim Abspielen
  selbst** (Android: VpnService der App; fehlt die Einwilligung, einmal fragen). Ohne VPN (abgelehnt, nicht möglich)
  wird **nicht** abgespielt: „Unterwegs nur über VPN – VPN einschalten“. Kein Rückfall auf andere Wege.
- **Unterwegs**, `away.mode == "direct"` (Admin-Ausnahme „Unterwegs ohne VPN erlauben“, je Quelle oder global): ohne VPN
  über `away.address` (immer `https://…`, z. B. eine GateControl-Route; bei Freigaben die WebDAV-Adresse für unterwegs mit
  demselben Pfad). Normale TLS-Prüfung (kein Anheften nötig). Läuft das VPN ohnehin, darf auch der VPN-Weg genommen werden.
- **Heimnetz-Erkennung**: zu Hause, wenn über das **lokale** Netz (nicht den Tunnel; Socket an WLAN/Ethernet bzw. die
  LAN-Schnittstelle gebunden, auch bei laufendem VPN) eine der `network.home.probes` passt. Ab 1.0.1 hat **jede** sichtbare
  Quelle mindestens eine Probe (höchstens 20, eindeutige zuerst). Jede Probe hat `kind`, `sourceId` (die Quelle, zu der sie
  gehört) und `unique` (`true`: erkennt genau dieses Heimnetz; `false`: nur „Adresse antwortet“). Arten:
  - `jellyfin` (`url`, `serverId`, `unique: true`) → `GET url` antwortet in ≤ 1,5 s mit `Id == serverId` (Groß/klein egal).
    Das Plugin ermittelt die Server-ID beim Speichern und Prüfen und behält sie, auch wenn Jellyfin später nicht erreichbar
    ist; war Jellyfin beim Speichern aus, holt der Abgleich (alle 5 min) sie nach und sendet `media.changed`.
  - `tls` (`url`, `certSha256`, `unique: true`) → TLS-Handshake an `url` mit Zertifikat-SHA-256 == `certSha256` (WebDAV mit
    angeheftetem Zertifikat).
  - `tcp` (`host`, `port`, `unique: false`, **neu in 1.0.1**) → TCP-Verbindung zu `host:port` kommt in ≤ 1,5 s zustande
    (Handshake fertig, sofort wieder schließen, keine Daten, keine Anmeldung). Kommt, wenn es nichts Eindeutiges gibt:
    Jellyfin ohne bekannte Server-ID (Port der `home.address`, z. B. 8096), Freigabe ohne `certSha256` (SMB: Port 445 bzw.
    der Port der SMB-Adresse, WebDAV: Port der WebDAV-Adresse, 443 ohne Angabe). `host` ist die Heimadresse wie in
    `smb`/`webdav`/`home.address` (meist die LAN-IP).
  - Unbekannte `kind` übergehen (weitere Arten kommen ohne neue Version).
  Ein Treffer einer beliebigen Probe (auch `tcp`) = zu Hause: lieber direkt im LAN als durch den Tunnel. Nur eine private
  IP-Adresse im WLAN ohne Probe-Treffer reicht **nicht** (fremde 192.168.1.x-Netze). Passt nur eine `tcp`-Probe, darf die
  App das als „zu Hause (nicht eindeutig)“ zeigen. Neu prüfen bei Netzwechsel (WLAN/Mobilfunk/VPN) und wenn sich die Liste
  ändert. Ohne Probe-Treffer = unterwegs. Der Reiter Quellen kennzeichnet Quellen ohne eindeutige Probe
  („Heimnetz nicht eindeutig“).
- Ohne Server-Kontakt zählt die zuletzt gespeicherte Liste (Zwischenspeicher); nach `maxOfflineDays` NAS-Passwörter löschen.

### Cast: „Auf TV/PC abspielen“ (Frage 38 a)

Nachrichten nach dem Cast-Vertrag Version 1, **Abschnitte 2 und 3** (`cast.play`, `cast.cmd`, `cast.state`, Felder `v`,
`session`, `seq`, `at`, Fehlercodes, Regeln: Alter 120 s/60 s, Sitzungs-Controller, wachsende `seq`, Lebenszeichen) – nur der
**Umschlag** (Abschnitt 1, GateDrop) entfällt. Unterschied in `cast.play`: `source` ist `{ "id": "<Quellen-ID des Plugins>" }`
(weitere Felder wie `kind`/`serverId` dürfen dabei sein und werden durchgereicht); der Empfänger sucht die Quelle mit dieser
ID in seiner eigenen `v1/sources`-Liste (nicht mehr per ServerId/Adresse). `item.id` = Jellyfin-Item-ID bzw. `item.path` bei
Freigaben wie im Vertrag. Keine Geheimnisse (Felder mit Namen wie token/password/secret werden abgelehnt).

- `GET v1/cast/targets` → `{ ok, v: 1, devices: [{ id, name, kind: "tv" | "pc", clientType, online, lastSeen }] }` – eigene
  GateControl-TV- und Windows-Geräte (ohne das fragende), online zuerst.
- `POST v1/cast/{session}/message` `{ to: "<Geräte-ID>", body: <Cast-Nachricht> }` → `{ ok, v: 1, via: ["event", "push"], online }`.
  `body.session` muss `{session}` sein, ≤ 3000 Bytes JSON, 60/min und 600/h je sendendem Gerät. Beide Geräte gehören der fragenden
  Person, sie hat „Medien“ (und bei `cast.play` die Quelle). Antworten des TV (`cast.state`) gehen genauso an das Handy (`to` = Handy).
- `POST v1/handoff` `{ to, sourceId, item: { id, name, … }, positionMs?, audio?, subtitle?, session?, from? }` → wie oben + `session`:
  Abkürzung, das Plugin baut `cast.play` (seq 0).
- Zustellung an genau ein Gerät, `data = { kind: "media.cast", from, fromName, to, session, body }`:
  - ist das Ziel online (Push-Stream verbunden): Echtzeit-Ereignis `type: "media.cast"` an die offenen Apps der Person
    (jede App außer `to` ignoriert es);
  - `cast.play`, `cast.cmd stop` und alles an ein Gerät, das nicht online ist: zusätzlich/stattdessen stille Mitteilung
    (Signal-Topic `media_signal`, kommt auch nach dem Wiederverbinden an – alte Starts verwirft der Empfänger nach 3.3).
  - Empfänger entdoppelt nach `session` + `seq` (eine Nachricht kann auf beiden Wegen kommen) und nimmt nur `from` == Controller an.
- Grenzen: Ereignisse 600/min je Plugin (reicht), stille Mitteilungen **600/h je Plugin für alle Personen** – deshalb Befehle
  und Zustände bei Online-Ziel nur als Ereignis; Lebenszeichen weiter höchstens alle 5 Minuten (Vertrag 3.3).

## Admin-API (admin/*, nur Administratoren in der Verwaltung)

`GET overview` · `GET sources` · `POST sources` · `GET|PUT|DELETE sources/{id}` · `POST sources/{id}/check` ·
`PUT sources/{id}/key` · `PUT sources/{id}/password` · `POST sources/{id}/quickconnect { on }` · `PUT sources/{id}/access
{ mode: all | list, users, groups }` · `PUT sources/{id}/people/{userId} { allow: true | false | null }` ·
`PUT sources/{id}/mapping/{userId} { jfUserId | null } | { auto: true }` · `POST sources/{id}/mapping/{userId}/create { name }` ·
`POST sources/{id}/automap` · `GET people` · `PUT rights/{user|group}/{id} { media: true | false | null }` · `GET devices` ·
`POST devices/{deviceId}/revoke { sourceId? }` · `POST probe { targetIndex, key? }` · `GET targets` · `GET log`.
Schlüssel und Passwörter gehen nur hinein; Antworten sagen `hasKey` / `hasPassword`.
Jede Quelle in `GET sources` hat `home: { level: unique | weak | none, why: null | no_server_id | no_cert, probes }`
(die Heimnetz-Proben dieser Quelle, wie in `v1/sources`); `GET overview` nur `home.level`. Die Jellyfin-Server-ID steht in
`config.serverId` (beim Speichern, `PUT` und Prüfen ermittelt).

## Speicher

`migrations/001_init.sql`: `sources` (Konfiguration ohne Geheimnisse, letzte Prüfung), `source_access`, `rights`,
`mappings`, `pairings` (Gerät ↔ Jellyfin-DeviceId ↔ Benutzer, nie ein Token), `deliveries` (welches Gerät welchen
Passwort-Stand bekam), `reports`, `known_devices`, `hits` (Ratenbegrenzung), `log` (nie Passwörter, Schlüssel, Codes,
Tokens). Geheimnisse: `jf.<id>.key`, `share.<id>.pw` über `gc.settings.setSecret`. Die Jellyfin-DeviceId ist
`gc-` + 20 Zeichen HMAC eines zufälligen Plugin-Schlüssels (`gc.storage` `pepper`) über Quelle und Geräte-ID.
