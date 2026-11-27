# Changelog

## 1.6.0

Mindestversion **GateControl 1.328.0**. **Neues Recht `transcode` („Videos umwandeln“)** – der Administrator bestätigt es
mit dem Update (heikles Recht: Dateien in den Medienordnern werden ersetzt). Ohne Bestätigung bleibt es bei der Liste.

- **Videos umwandeln (Schritt 2, Entwurf vom 26.11., Fragen 92–102):** Die Liste wandelt über den Dienst „umwandeln“ des
  Gateways (ab 1.50.0, Host-API `gc.transcode`) um – H.264 8 Bit per Intel-Grafik, Ton/Untertitel/Kapitel kopiert, gleicher
  Name und Ort. „Umwandeln“ merkt für die Nacht vor, „Alle über Nacht“ alle offenen Zeilen der Stufe „Umwandeln“, Auswahl
  per Kästchen, „Jetzt umwandeln“ sofort. Nur `.mkv` in den Medienordnern des Gateways und nur Pfade, die Jellyfin
  gemeldet hat; MP4/AVI „kommt später“.
- **Nachtfenster 01:00–06:00** (Ortszeit des Servers, einstellbar): je Gateway genau ein Auftrag, der nächste nach dessen
  Ende, ein neuer nur, wenn er voraussichtlich ins Fenster passt (Dauer ÷ gemessenes Tempo + 10 %, ohne Messung 3,0 × mit
  Grafik bzw. 0,3 × ohne). Reihenfolge: „Jetzt“, Serien, die gerade jemand schaut (Folgenreihenfolge), „beim Abspielen
  gestockt“, Vormerkzeit.
- **Pause beim Schauen:** Meldet Jellyfin (`/Sessions`) eine Wiedergabe, ruft Medien `pause { ttlSec: 180 }` und erneuert
  es jede Minute; danach `resume`. Einzelner Auftrag: „Pause“/„Fortsetzen“, „Abbrechen“.
- **Berichte und Prüfung:** Hook `transcodeChanged` und `report()` jede Minute; erledigte Aufträge werden gespeichert und
  quittiert (`ack`). Nach dem Tausch `POST /Library/Media/Updated` (Rückfall `/Items/{id}/Refresh`), danach prüft Medien,
  dass Jellyfin 8 Bit und dieselbe Laufzeit sieht (`checking` → `done`). Ansicht „geprüft“: Original/Neu, Probelauf,
  Jellyfin, Ort im Papierkorb.
- **Fehler:** `no_space` → nächste Nacht mit neuer `id`, kein Fehlversuch; `no_device`/`device_denied`/`no_encoder` →
  dieses Gateway angehalten, bis es wieder bereit meldet; Pfadfehler → übersprungen; `source_changed` → neu bewerten;
  sonst Fehlversuch, nach zwei übersprungen (mit den letzten ffmpeg-Zeilen). Verlorene Aufträge kommen mit neuer `id`
  wieder in die Warteschlange.
- **Papierkorb** (Kachel): Originale mit Titel, Größe und Löschdatum, „Wiederherstellen“ (Jellyfin liest neu ein, Datei
  `restored`, nicht wieder automatisch), „Jetzt löschen“, „Papierkorb leeren“, Hinweis auf Btrfs-Schnappschüsse.
- **Einstellungen** (Zahnrad): Zeitfenster, Anhalten beim Schauen, Papierkorb-Tage (Standard 14) und Qualität (Standard
  23) – die beiden letzten über `gc.transcode.settings` an die Gateway-Funktion.
- **Mitteilung am Morgen** (Thema `convert`): „3 Videos umgewandelt · 1 Fehler“ an die Administratoren, nur wenn etwas
  geschah, einmal am Tag.
- **Hinweise ohne Umwandeln:** älterer Server, kein Gateway, Gateway zu alt, Funktion aus, Dienst fehlt/steht, Gruppe der
  Grafik fehlt (mit GID), keine Grafik – jeweils mit dem Weg unter Gateways › Funktionen.
- **App-API:** `v1/convert/status` mit `state queued | running | done`, `position`, `startsAt`, `percent`, `requested` (und
  `states` je ID); neu `POST v1/convert/request { itemId }` („Umwandeln anfragen“ – nur auf die Liste, Filter „Angefragt“).
- Admin-API `convert/queue`, `convert/all`, `convert/file`, `convert/trash`, `convert/settings`; Migration 003
  (`conv_files`, `conv_jobs`). Mock-Host: `gc.transcode` (`tools/testing/mock-transcode.js`).

## 1.5.0

- **Neuer Reiter „Umwandeln“ (Schritt 1 von „Videos umwandeln“, Entwurf vom 26.11., Fragen 92–102):** die Liste der
  Filme und Folgen aus Jellyfin, die nicht auf allen drei Zielgeräten laufen (Android-Handy, Fire TV Cube 3. Gen.,
  Windows-App; feste Regeln, Frage 97 a). Drei Stufen: **Umwandeln** (kein Gerät bzw. eines kann es nicht und die NAS
  schafft das Umwandeln beim Abspielen nicht flüssig: H.264 10 Bit/High 10, 4:2:2/4:4:4/12 Bit, Dolby Vision 5),
  **Hinweis** (Jellyfin wandelt live um, die NAS schafft es: HEVC 10 Bit, AV1, MPEG-2/VC-1/MPEG-4 ASP/WMV, AVI/WMV/FLV,
  Bild-Untertitel PGS/VobSub) und **Info** (DTS/DTS-HD/TrueHD, AC3/E-AC3 als Standard-Tonspur, interlaced). DTS,
  TrueHD und PGS werden nur angezeigt (Frage 98 a). Je Zeile Grund, Geräte (✓ / ~ / ✕), Größe vorher und geschätzt
  nachher, geschätzte Dauer auf einer NAS mit Intel J3455 (Ziel H.264 8 Bit per Hardware); Filter, Suche, Sortierung,
  Details je Datei. Bei mehreren Versionen zählt die beste.
- **Noch kein Umwandeln:** Das braucht den Gateway-Dienst „umwandeln“ (Frage 92 a), der in einem späteren Schritt kommt.
  Die Seite sagt das und hat keinen Knopf, der es vortäuscht; `available: false` in Admin- und App-API.
- **Erkennung:** `GET /Items` seitenweise (200 je Seite, eine zu große Antwort – über 5 MB – wird kleiner neu geholt),
  Felder `MediaSources,Path`, nur vorhandene Dateien. Der erste Lauf startet beim ersten Öffnen der Seite oder mit
  „Neu prüfen“, danach alle 30 Minuten nur Änderungen (`MinDateLastSaved`), einmal am Tag alles (entfernt Gelöschtes).
  Solange die Liste Einträge hat, liest das Plugin jede Minute `GET /Sessions`: wandelt Jellyfin eine gelistete Datei
  langsamer als in Echtzeit um, bekommt sie „beim Abspielen gestockt“ (mit Jellyfins `TranscodeReasons`) und rückt nach
  oben.
- **API:** `GET admin/convert` (Liste, Zahlen, Schätzung, Stand je Quelle), `POST admin/convert/scan`; App-API
  `GET v1/convert/status?items=<id>,…` (höchstens 100 Jellyfin-IDs, nur aus Quellen, die die Person sieht) für den
  späteren Hinweis in den Apps (Frage 100). Neue Tabelle `conv_items` (Migration 002).

## 1.4.1

- **Lautstärke am PC:** `cast.cmd` kennt `cmd: "volume"` mit `volume` (Ganzzahl 0–100) und/oder `muted` (true/false),
  mindestens eins von beiden; sonst `invalid` mit `field: 'volume'` bzw. `'muted'`. Der Windows-Empfänger (GateControl
  Pro) setzt sie und meldet `volume`/`muted` in `cast.state` zurück (das Plugin reicht den Stand wie bisher durch).
  Bisher lehnte das Plugin den Befehl als unbekannt ab (`field: 'cmd'`).
- **Nur Pro-PCs als Ziel:** `GET v1/cast/targets` nennt nur noch Windows-Geräte, die GateControl als Pro-Client meldet
  (`clientType: 'pro'`). Der Community-Client spielt keine Medien ab – ein Cast dorthin endete nach 25 s mit „keine
  Antwort“. Ein Windows-Gerät, dessen Ausgabe GateControl (noch) nicht kennt, ist ebenfalls kein Ziel. GateControl-TV
  unverändert.

## 1.4.0

- **Geräte-ID gleich mitliefern:** `GET v1/sources` hat das Feld `deviceId` (String, z. B. `"11"`; `null` ohne
  Gerätebindung) – die eigene GateControl-Geräte-ID des fragenden Geräts, dieselbe wie `devices[].id` in
  `v1/cast/targets` und `to`/`from` in Cast-Nachrichten. Auch `GET v1/cast/targets` nennt sie (`deviceId`). Bisher
  kannte ein Fernseher/PC seine ID erst aus der ersten stillen Mitteilung. Nur ein zusätzliches Feld.
- **NAS-Dialog prüft vor dem Speichern:** „Prüfen und speichern“ ruft `POST admin/probe { kind: 'share', … }` auf
  (WebDAV-Anmeldung und Ordner mit dem eingegebenen bzw. beim Bearbeiten dem gespeicherten Passwort) und zeigt das
  Ergebnis im Dialog. Schlägt sie fehl, bleibt der Dialog offen, „Trotzdem speichern“ übernimmt die Angaben. SMB prüfen
  die Geräte (Prüfergebnis `smb: 'devices'`).
- **Ungenutzte Zuweisungen entfernen, auch mitten in der Liste:** Der Dialog merkt sich die Zugriffsziel-Zuweisungen,
  die er selbst anhängt (`POST admin/targets/made`). Nutzt keine Quelle eine davon mehr, wird sie entfernt; die Quellen
  dahinter stellt das Plugin vorher in einer Transaktion um (`POST admin/targets/compact`), schlägt das Setzen der Liste
  fehl, stellt es sie zurück. Am Ende der Liste wie bisher jede ungenutzte Route/jeder ungenutzte Peer, nie eine Adresse
  des Administrators, nie eine benutzte Zuweisung.

## 1.3.0

- **Unterwegs über die Route:** `v1/sources` liefert unterwegs auch im Modus VPN eine durch den Tunnel erreichbare Adresse:
  `away: { mode: 'vpn', address }` (HTTPS, ohne abschließenden Schrägstrich). Bisher kam nur `{ mode: 'vpn' }`, die Geräte
  nahmen die Heimadresse durch den Tunnel – die erreicht das Heimnetz nie, der Server routet kein Heimnetz an das Gateway.
  Erreichbar sind die Routen (Domain → Server → Gateway → Ziel), auch nur intern freigegebene. `direct` bleibt die
  Ausnahme ohne VPN.
- **Quelle der Adresse:** die im Dialog gespeicherte HTTPS-Adresse für unterwegs; fehlt sie (Quellen vor 1.3.0), leitet
  Medien sie beim Ausliefern aus der Route ab, über die die Quelle läuft (Jellyfin `https://<Domain>`, WebDAV
  `https://<Domain>/<Pfad der WebDAV-Adresse>`) – ohne Neu-Speichern. Ohne Route (VPN-Peer, Adresse, reine SMB-Freigabe)
  bleibt es bei `{ mode: 'vpn' }`.
- **Dialog:** „HTTPS-Adresse für unterwegs“ gilt für beide Modi (immer sichtbar unter „Erweitert“), beim Bearbeiten
  einer Quelle ohne Adresse aus der Route vorbelegt. Reiter Quellen und Übersicht: „unterwegs über VPN: <Adresse>“ bzw.
  „unterwegs nicht erreichbar“.
- Texte berichtigt: Hinweis „durch den Tunnel nicht erreichbar“ im Reiter Geräte (fragt nach der Adresse für unterwegs
  statt nach einem Gateway, das das Heimnetz weiterleitet), Netz-Text, SMB-/WebDAV-Hinweise.
- Handbuch: Voraussetzungen (eine Route statt eines VPN, das das Heimnetz in den Tunnel gibt), [Netz](HANDBUCH.md#netz),
  Fehlersuche, „Neu in 1.3.0“; README: App-API `away` und die Netz-Regel.

## 1.2.0

Mindestversion **GateControl 1.325.0** (die Zugriffsziele eines Plugins mit `assignTargets` stehen nur noch auf seiner
Seite, nicht mehr unter Einstellungen).

- **Quellen an einer Stelle (Entwurf vom 25.11.):** Der Jellyfin-Dialog hat nur noch drei Angaben: **„Wo läuft
  Jellyfin?“** (passende Routen als Auswahl, dazu „Andere Route oder Adresse …“ mit allen Routen, VPN-Peers und schon
  zugewiesenen Adressen), **API-Schlüssel** und den **Namen aus Jellyfin** (Servername beim Prüfen). Adresse zu Hause,
  Unterwegs, Herunterladen und der Name stehen vorbelegt unter **„Erweitert“**.
- **NAS-Dialog analog:** „Wo liegt die NAS?“, Freigabename, Benutzer, Passwort. SMB-Adresse aus dem Ziel der Route,
  WebDAV-Adresse bei HTTPS, HTTPS-Adresse für unterwegs aus der Domain; die Zugriffsziele `webdav` (und `smb` bei einem
  VPN-Peer) weist Medien selbst zu.
- Hinweis **„Mit „Prüfen und speichern“ erlaubst du dem Plugin, <Ziel> zu erreichen“**; der Knopf heißt „Prüfen und
  speichern“ (prüft vorher, der Name kommt aus der Prüfung).
- **Reiter Quellen:** je Quelle „über <Route> · zu Hause direkt … · unterwegs …“ und **„Server-Freigabe: aktiv (wird mit
  der Quelle verwaltet)“**, sonst „Server-Freigabe fehlt“. Nach Hinzufügen (auch abgebrochen), Bearbeiten und Entfernen
  entfernt Medien Freigaben am Ende der Liste, die keine Quelle mehr nutzt – auch `smb`; die Indizes anderer Quellen
  verschieben sich nie.
- Entfallen: die Auswahl zugewiesener Zugriffsziele ohne `GC.targets` (Mindestversion), Texte zu „Zugriffsziele“ unter
  Einstellungen.
- Handbuch: „Zugriffsziele“, „Jellyfin hinzufügen“, „NAS-Freigabe“, „Neu in 1.2.0“.

## 1.1.0

Mindestversion **GateControl 1.324.0** (neue Host-API `window.GC.targets`, Berechtigung
`permissions.network.assignTargets`).

- **Einrichtung an einer Stelle:** Der Dialog „Jellyfin-Server hinzufügen/bearbeiten“ hat statt der Auswahl eines
  zugewiesenen Zugriffsziels jetzt **„Erreichbar über“** mit den Routen und VPN-Peers von GateControl. Beim Speichern
  (und bei „Prüfen“) weist Medien das Zugriffsziel `jellyfin` selbst zu. Eine vorhandene gleiche Zuweisung wird
  wiederverwendet, eine neue angehängt, der Index anderer Quellen ändert sich nie. Ebenso **„WebDAV prüfen über“** bei
  NAS-Freigaben (Ziel `webdav`, optional). Zuweisungen am Ende der Liste, die keine Quelle mehr nutzt, entfernt Medien nach
  dem Bearbeiten oder Entfernen einer Quelle wieder.
- **Vorbelegung:** Heimnetz-Adresse aus dem Ziel der Route (z. B. `http://192.168.2.151:8096`, nicht bei Peer-Routen), HTTPS-Adresse
  für unterwegs aus der Domain der Route (`https://<Domain>`). Beides überschreibbar.
- „Zugriffsziele öffnen“ entfällt. Der Knopf öffnete die Einstellungen im Dialog und blockierte die Seite. Der Hinweistext
  ist ersetzt.
- **Rückwärts:** Bestehende Zuweisungen und `targetIndex` der Quellen bleiben gültig. Eine von Hand zugewiesene Adresse
  erscheint unter „Bereits zugewiesen“. Ohne `GC.targets` bleibt die bisherige Auswahl.
- Handbuch: „Zugriffsziele“, „Jellyfin hinzufügen“, „NAS-Freigabe“, „Neu in 1.1.0“.

## 1.0.1

Mindestversion unverändert **GateControl 1.301.0**.

- **Heimnetz-Erkennung für jede Quelle** (`network.home.probes` in `v1/sources`): bisher gab es Proben nur für Jellyfin mit
  bekannter Server-ID und WebDAV mit `certSha256` – ohne Probe hielt sich ein Gerät auch zu Hause für unterwegs und ging
  durch das VPN. Neu die Probe-Art `tcp` `{ host, port }` (TCP-Verbindung über die LAN-Schnittstelle) für Jellyfin ohne
  bekannte Server-ID und Freigaben ohne Zertifikat (SMB 445, WebDAV-Port). Jede Probe hat zusätzlich `sourceId` und
  `unique`; höchstens 20, eindeutige zuerst. `jellyfin`/`tls` unverändert, App-API bleibt v1.
- **Jellyfin-Server-ID** wird beim Speichern, Bearbeiten und Prüfen ermittelt und in der Quelle gespeichert (bleibt, wenn
  Jellyfin später nicht erreichbar ist; neue Adresse oder neues Zugriffsziel → neu ermitteln). Fehlt sie, holt der Abgleich
  alle 5 Minuten sie nach und schickt `media.changed`.
- **Admin**: Reiter Quellen mit Zeile „Heimnetz-Erkennung“, Zeichen und Hinweis **„Heimnetz nicht eindeutig“** für Quellen
  ohne eindeutige Probe; ebenso in der Übersicht. Admin-API: `home { level, why, probes }` je Quelle.
- README (App-API, Netz-Regel), Handbuch „Netz“ und „Neu in 1.0.1“.

## 1.0.0

Neues Plugin **Medien** (eigene Lizenz, nicht im GateControl-Plan oder einer Lifetime-Lizenz enthalten). Mindestversion
**GateControl 1.301.0**; mit GateControl ≥ 1.322.0 Widerruf sofort über den Hook `devicesChanged`.

- **Quellen zentral im Server** (Einstellungen › Plugins › Medien › Quellen): Jellyfin-Server (Zugriffsziel `jellyfin`,
  API-Schlüssel als Geheimnis, Prüfung von Erreichbarkeit, Version ≥ 10.9, Schlüssel, Quick Connect und Bibliotheken,
  „In Jellyfin einschalten“ für Quick Connect) und NAS-Freigaben als SMB/WebDAV-Paar oder einzeln (Lese-Benutzer, Passwort
  als Geheimnis, WebDAV nur HTTPS, Zertifikat zum Anheften, Prüfung per WebDAV über das Zugriffsziel `webdav`,
  „Passwort ersetzen“ verteilt das neue Passwort).
- **Personen** (Reiter Personen): Recht „Medien“ je Person und Gruppe, Zuordnung zu Jellyfin-Benutzern automatisch per
  Name, von Hand, „bewusst ohne“ oder „In Jellyfin anlegen“; Jellyfin-Administratoren werden nie angeboten. Sicht je
  Quelle, „Personen oder Gruppen wählen …“; Kinder der Familie sehen NAS-Freigaben nur mit der Einstellung.
- **Geräte ohne Eingabe**: Ablauf A – das Gerät startet Quick Connect mit der DeviceId des Plugins, das Plugin bestätigt den
  Code mit dem API-Schlüssel für den verknüpften Benutzer (Spike M0: Jellyfin 10.9.11, 10.10.7, 10.11.11). Reiter Geräte
  mit „Abmelden“; Widerruf löscht das Gerät in Jellyfin und schickt eine stille Mitteilung `media.revoke`.
- **Netz-Regel**: zu Hause direkt im Heimnetz, unterwegs nur über VPN; Ausnahme „Unterwegs ohne VPN erlauben“ je Quelle oder
  für alle mit einer HTTPS-Adresse für unterwegs (`away` in `v1/sources`), Heimnetz-Erkennung über `network.home.probes`.
- **App-API v1** (README): `sources`, `sources/{id}/secret`, `jellyfin/pair`, `jellyfin/paired`, `jellyfin/device`,
  `shares/{id}/checked`, `sources/{id}/report`, Cast (`cast/targets`, `cast/{session}/message`, `handoff`) für
  „Auf TV/PC abspielen“ nach dem Cast-Vertrag; Ereignisse `media.changed`, `media.cast`, Signal `media.revoke`.
- Abgleich alle 5 Minuten (entfernte Geräte, Rechte, Zuordnungen, Jellyfin-Versionen), Protokoll ohne Geheimnisse,
  Handbuch DE/EN.
