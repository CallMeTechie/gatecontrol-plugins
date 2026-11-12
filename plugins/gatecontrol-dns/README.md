# gatecontrol-dns — DNS-Schutz

Die Verwaltung des DNS-Schutzes von GateControl für die VPN-Geräte (`permissions.vpnDns`, `gc.vpnDns`; GateControl
≥ 1.267.0 – `gc.vpnDns.version` 4, docs/plugins.md „DNS protection“). GateControl filtert selbst (ein Filter-Dienst hinter dem DNS des VPN);
das Plugin legt fest, was für wen gesperrt wird, unterbricht den Schutz und liest Zähler.

```
server/index.js    Hooks: start (gc.vpnDns.on), request, render, portalVisible, groupsChanged, tick
server/admin.js    Einstellungsseite: admin/* (nur Administratoren in der Verwaltung)
server/api.js      Personen-API: Apps (Client-API) und Portal-Tab
server/rights.js   wer für wen wie lange unterbrechen darf (Familie = Personengruppe kind 'family', gc.groups)
server/config.js   eigene Einstellungen des Plugins (gc.settings: dns.config, dns.state)
server/notices.js  Mitteilungen: outage, pause_end, weekly
ui/                admin.html/js (eine Seite mit sechs Reitern + Dialoge), portal.html/js, common.js, style.css
```

Die Einstellungsseite ist **eine** Plugin-Seite (`ui.settingsPage: "protection"`) mit den Reitern Übersicht, Listen
& Ausnahmen, Profile, Geräte, Protokoll, Einstellungen – `ui.settingsPages` des Kerns lässt nur vier weitere Reiter
zu. Die erste Seite (`main`) zeigt dieselbe Oberfläche; einen Eintrag in der Seitenleiste gibt es nicht.

## Wer darf unterbrechen

| Wer | Für wen | Bedingung |
|---|---|---|
| jede angemeldete Person | eigene VPN-Geräte | Einstellung „Alle Benutzer“ (Voreinstellung); bei „Je Profil“ nur, wenn das wirksame Profil des Geräts es erlaubt; bei „Nur Admins“ nie |
| Elternteil (Rolle `parent` in einer Personengruppe `kind: 'family'`) | Mitglieder derselben Familie, nie Administratoren | nicht bei „Nur Admins“; die Profil-Sperre des Kindes gilt für Eltern nicht |
| Administrator | alle, auch „alle VPN-Geräte“ | immer |

Für Benutzer (auch Eltern): höchstens die „längste Dauer“ (5, 30, 60 oder 240 Minuten, Voreinstellung 60),
„Bis ich wieder einschalte“ nur mit dem Schalter „Auch Benutzern anbieten“. Administratoren: bis 7 Tage und ohne
Ende. **Wieder einschalten** darf jeder für die eigenen Geräte; eine Unterbrechung für alle Geräte beendet nur ein
Administrator. GateControl selbst hält zusätzlich zwei feste Regeln (für alle Geräte nur ein Administrator; für die
Geräte eines Administrators nur ein Administrator oder er selbst).

## App-API

Basis: `/api/v1/client/plugins/gatecontrol-dns/api/` (Geräte-Token der App; das Portal nutzt dieselben Pfade unter
`/api/v1/portal/plugins/gatecontrol-dns/api/`). Ob ein Server den DNS-Schutz hat, sagt `GET
/api/v1/client/permissions`: `vpnDns: { plugin: "gatecontrol-dns", state } | null` (`null` auch, solange der Schutz
ausgeschaltet ist). Antworten sind JSON mit `ok: true`, Fehler `{ ok: false, code, error }` (`error` ist ein Text in
der Sprache der Anfrage, `?lang=de|en`).

Ohne Ziel gilt eine Änderung für **das fragende Gerät** (der VPN-Peer des Tokens, `req.user.peerId`); hat das Token
keinen Peer (und im Portal), für **alle VPN-Geräte der Person**.

### `GET status`

```json
{
  "ok": true,
  "state": "active",
  "enabled": true,
  "device": { "peerId": 21, "name": "Leas Handy", "platform": "android", "state": "filtered", "ownDns": null },
  "profile": { "id": "p1a2b3c4d", "name": "Kinder", "safeSearch": true },
  "pause": null,
  "outage": null,
  "counters": { "scope": "device", "queries": 3310, "blocked": 893, "percent": 27 },
  "top": [{ "domain": "ads.tiktok.com", "count": 148 }],
  "may": { "pause": true, "resume": false, "extend": false, "reason": null, "durations": [5, 30, 60], "maxMinutes": 60, "forever": false },
  "today": [{ "from": "21:00", "to": "07:00", "block": "categories", "categories": ["social", "games", "video"] }],
  "devices": [{ "peerId": 21, "name": "Leas Handy", "platform": "android", "state": "filtered", "ownDns": null, "profile": { "id": "p1a2b3c4d", "name": "Kinder" }, "suspended": false, "pause": null, "today": { "queries": 3310, "blocked": 893, "percent": 27 } }],
  "manage": false,
  "log": { "enabled": true, "visible": true },
  "serverTime": "2026-11-12T13:48:00.000Z"
}
```

* `internet` (seit 1.1.0): `{ paused: true, until (ISO), remainingSeconds }` | `null` – „Internet pausieren“ aus dem
  Plugin Familie gilt für das Gerät (bzw. alle gefilterten Geräte der Person). `state` bleibt `active` (oder
  `paused`): es wird gefiltert, aber nur „Immer erlaubt“ antwortet. `may.pause` ist dann `false` mit
  `may.reason: "internet_paused"` – Unterbrechen hebt die Pause nicht auf.
* `state`: `active` (wird gefiltert) · `paused` (unterbrochen, siehe `pause`) · `fallback` (Filter ausgefallen,
  ungefiltert, siehe `outage.since`) · `unfiltered` (das Gerät hat einen eigenen DNS-Server, ist ausgenommen oder die
  Person hat kein VPN-Gerät) · `starting` · `off`.
* `device`: das fragende Gerät oder `null` (Token ohne Peer, Portal). `device.state`: `filtered` | `ownDns` |
  `excluded` | `disabled`.
* `pause`: `{ scope: "all" | "peer" | "user", until (ISO | null), openEnd, since, by: { userId, name } | null, byMe,
  remainingSeconds (null bei offenem Ende), minutes }` – `minutes` (seit 1.1.0): die gewählte Dauer in Minuten, mit
  „+30 Min.“ die ganze; `null` bei offenem Ende.
* `devices[]` (seit 1.1.0) zusätzlich `internetPaused` (ISO | null) und `timesSuspended` (ISO | null – „Zeit
  verlängern“ aus Familie: die Zeiten des Profils sind bis dahin ausgesetzt).
* `counters.scope`: `device` (dieses Gerät – nur bei eingeschaltetem Abfrageprotokoll), `person` (alle eigenen
  Geräte, ohne fragendes Gerät), sonst `server` (Zähler des ganzen Servers). `percent` mit einer Nachkommastelle.
* `top`: Top gesperrte Domains von heute für das Gerät bzw. die Person (höchstens 5) – `null`, wenn das Protokoll
  aus ist oder Benutzer es nicht sehen dürfen; dann weglassen.
* `may`: was diese Person jetzt darf. `pause` – die Dauer-Knöpfe zeigen; `durations` – die erlaubten Minuten
  (Teilmenge von 5, 30, 60, 240; andere Stufen ausgrauen), `forever` – „Bis ich wieder einschalte“ anbieten;
  `resume` – „Wieder einschalten“ zeigen; `extend` – „+30 Min.“ zeigen. `reason` (sonst `null`): `admins_only`,
  `profile` („Unterbrechen nicht erlaubt“), `not_filtered`, `no_device`, `fallback`, `off`, `paused_for_all`,
  `internet_paused` (seit 1.1.0).
* `today`: die Zeiten des Profils, die heute gelten („Zeiten heute“); `categories`: `social`, `games`, `video`.
* `manage`: Administrator oder Elternteil – `GET people` liefert etwas.

### `POST pause`

Body: genau eines von `{ "minutes": 30 }`, `{ "forever": true }`, `{ "extend": 30 }` (ab dem Ende der laufenden
Unterbrechung, sonst ab jetzt); optional das Ziel `peerId` (ein Gerät), `userId` (alle Geräte einer Person) oder
`all: true` (alle VPN-Geräte, nur Administratoren). Antwort: `{ ok, pause, status }` – `status` wie `GET status`.

### `POST resume`

Body: optional `peerId` | `userId` | `all: true`. Antwort `{ ok, resumed, status }` (`resumed: false`, wenn nichts
unterbrochen war).

### `GET people`

Für Administratoren (alle Personen mit VPN-Gerät) und Eltern (sie selbst und ihre Familie); sonst 403 `forbidden`.

```json
{ "ok": true,
  "all": { "may": { "pause": true, "…": "…" }, "pause": null },
  "people": [{ "userId": 4, "name": "Lea", "role": "user", "self": false, "may": { "pause": true, "resume": false, "extend": false, "reason": null, "durations": [5, 30, 60], "maxMinutes": 60, "forever": false },
               "devices": [{ "peerId": 21, "name": "Leas Handy", "platform": "android", "state": "filtered", "profile": { "id": "p1a2b3c4d", "name": "Kinder" }, "suspended": false, "pause": null, "today": null, "may": { "…": "…" } }] }] }
```

`all` nur für Administratoren, sonst `null`. Seit 1.1.0 je Person zusätzlich `pause` (die Unterbrechung der Person,
sonst die gemeinsame aller ihrer gefilterten Geräte, sonst `null` – Form wie `status.pause`) und `internet` (wie
`status.internet`); je Gerät `internetPaused` / `timesSuspended`.

### `GET log?limit&before&peerId&blockedOnly=1&search`

Das eigene Abfrageprotokoll (immer nur die eigenen Geräte): `{ ok, entries: [{ id, at, peerId, device, domain, type,
result: "blocked" | "allowed" | "allowed_paused" | "safe_search", action, reason, list, scope, profile: { id, name } }],
next }` – `next` als `before` der nächsten Seite. `scope` (seit 1.1.0): bei eigenen Einträgen (`profile_deny`,
`profile_allow`) `"all"` (gilt für alle) oder `"profile"`, sonst `null`; neuer Grund `paused` (Internet pausiert). 409 `log_off`, 403 `not_allowed` (`reason: "log_admins_only"`).

### Fehlercodes

| HTTP | `code` | Wann |
|---|---|---|
| 400 | `invalid` | Body falsch (`detail` nennt das Feld) |
| 403 | `forbidden` | nicht angemeldet / fremdes Gerät im Protokoll / `people` ohne Recht |
| 403 | `not_allowed` | Unterbrechen hier nicht erlaubt – `reason`: `admins_only`, `profile`, `admin_target`, `not_yours`, `not_filtered`, `paused_for_all`, `log_admins_only`, `internet_paused` (seit 1.1.0) |
| 403 | `forever_not_allowed` | „Bis ich wieder einschalte“ ist für Benutzer nicht freigegeben |
| 403 | `too_long` | länger als die längste Dauer (`maxMinutes`) |
| 404 | `not_found` | Gerät oder Person unbekannt |
| 409 | `off` | der DNS-Schutz ist ausgeschaltet (oder startet noch) |
| 409 | `not_filtering` | der Filter ist ausgefallen (Rückfall) – es gibt nichts zu unterbrechen |
| 409 | `no_device` | die Person hat kein VPN-Gerät |
| 409 | `log_off` | das Abfrageprotokoll ist aus |
| 501 | `unsupported` | der Server hat `gc.vpnDns` nicht (GateControl < 1.264.0; das Plugin 1.1.0 braucht 1.267.0) |
| 503 | `unavailable` | der Filter-Dienst antwortet nicht |

## Tests

`npm test -- gatecontrol-dns` – gegen den Mock-Host (`tools/testing/mock-vpn-dns.js` bildet `gc.vpnDns` nach, mit
den festen Regeln und Prüfungen des Kerns): die Berechtigungsmatrix des Unterbrechens, die App- und Portal-API, die
Einstellungsseite, der Umzug von Pi-hole, die Mitteilungen, Texte und Seiten.
