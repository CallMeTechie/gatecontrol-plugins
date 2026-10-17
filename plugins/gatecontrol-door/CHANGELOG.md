# Tür & Kamera (gatecontrol-door)

Nuki-Schlösser und -Opener sowie Ring-Klingeln und -Kameras in GateControl – in der App
(eigener Tab „Tür“), im Widget/den Schnellaktionen und im Portal (eigener Tab „Tür“). Alles
bleibt auf dem eigenen Server. Einrichtung, Risiken, Datenschutz und die App-API: README.md.

**Ring: inoffizielle Schnittstelle, ohne Gewähr.** Ring bietet keine offizielle Schnittstelle
an; das Plugin nutzt die, die auch die Open-Source-Projekte ring-client-api (Homebridge) und
python-ring-doorbell (Home Assistant) verwenden. Sie kann sich jederzeit ändern oder wegfallen.

## 1.1.0
- **Neu: Ring-Modus (Inaktiv / Zuhause / Abwesend)** pro Ring-Standort – wie in der Ring-App
  unter *Modi*; welche Kameras im jeweiligen Modus aufnehmen und melden, bleibt in der Ring-App
  eingestellt. Für Standorte mit eingeschalteten Modi und ohne Ring-Alarmanlage.
- **Schnellaktionen und Regeln:** pro Standort drei Knöpfe „Inaktiv“, „Zuhause“, „Abwesend“
  (Gerät = der Standort, ohne Rückfrage, Symbole wie in der Ring-App). Knöpfe statt Umschalter:
  eine Regel der Familie (z. B. „Alle sind unterwegs“ › „Abwesend“) setzt immer genau diesen
  Modus. „Inaktiv“ trägt das Widget „Ring-Modus“ mit dem aktuellen Modus und einer Auswahl, die
  den Modus direkt umstellt (Symbole in der Auswahl ab GateControl 1.174.0, sonst die Namen).
  Antwort „Ring: Zuhause“ oder der Grund, z. B. „Ring lehnt den Moduswechsel ab (HTTP 403).“
- **Recht „Ring-Modus schalten“** pro Person und Standort (Seite „Berechtigungen“); Admins dürfen
  immer. Geprüft wie bei den Schlössern: kein Kiosk-/Geräte-Vertrauen-Zugriff, Zeitfenster,
  höchstens 10 Wechsel pro Minute pro Person und Standort.
- **Seite „Geräte“:** neuer Bereich „Ring-Modus“ mit dem aktuellen Modus pro Standort und drei
  Knöpfen; Standorte, die nicht schalten können, mit Grund (Ring-Alarmanlage, Modi aus, keine
  Kameras, Ring erlaubt es dem Konto nicht). **Portal-Tab „Tür“:** dasselbe für berechtigte
  Personen (der Tab erscheint auch ohne Schloss-Recht), dazu eine Start-Kachel
  „Ring-Modus · <Standort>“. App-API: `ringModes` in `GET me`, `POST modes/<id>/<mode>`.
- **Ring-Alarmanlage:** solche Standorte werden nie gelesen oder geschaltet – dort gehört der
  Modus zur Alarmanlage.
- Der Modus wird mit dem Geräteabgleich und danach jede Minute gelesen; nach einem Wechsel gilt
  sofort die Antwort von Ring. Lesefehler bremsen nur diese Abfrage (eigene Wartezeit), Klingel
  und Bilder laufen weiter.
- **Verlauf:** jeder Wechsel (auch abgelehnte und fehlgeschlagene) als Art „Ring-Modus“ mit
  Person, Modus, Standort und Weg (App, Mitteilung, Automatik mit aufrufendem Plugin, Portal,
  Admin-Seite).
- Ring-Schnittstelle (inoffiziell, wie ring-client-api 14.3.0): `GET https://api.ring.com/devices/v1/locations`,
  `GET`/`POST https://prd-api-us.prd.rings.solutions/api/v1/mode/location/<id>`; neuer Host
  `prd-api-us.prd.rings.solutions` in den Netzwerk-Rechten. Datenbank: Migration
  `004_ring_modes.sql` (`ring_locations`, `mode_rights`, `history.location_id`).
- Weiter ab GateControl 1.169.0: ältere Versionen lassen Widget (vor 1.171.0) und Gerät (vor
  1.172.0) weg, die drei Knöpfe bleiben.

## 1.0.3
- Geräte: die Schnellaktionen eines Schlosses bzw. Openers (zusperren, aufsperren, öffnen,
  Summer) gehören zu einem Gerät mit dessen Namen – die GateControl-Apps ab 1.38.0 zeigen
  sie als eine Zeile. Sonst unverändert; GateControl-Versionen vor 1.172.0 lassen das Feld weg.

## 1.0.2
- **Behoben: Nuki Web zeigt weiter „Öffnet …“, obwohl das Schloss längst aufgesperrt ist.** Die
  Cloud-Kopie kann auf einem Zwischenzustand hängen – auch `GET /smartlock/{id}` liefert dann
  weiter 7 (öffnet). Jetzt wird `updateDate` des Schlosses gelesen (wann die Cloud ihre Kopie
  zuletzt geändert hat): ein Zwischenzustand mit einem Cloud-Stand älter als 60 s gilt **sofort**
  als „Zustand unklar“ (nicht erst nach 3 Minuten) und wird sofort neu gelesen (weiter höchstens
  alle 2 Minuten). Ohne `updateDate` gilt wie bisher die 3-Minuten-Regel.
- **Kein fester Zustand bekannt** (z. B. hing die Cloud schon vor dem Update, Zeile aus 1.0.0):
  App-API `lock: "unknown"`, `stale: true`; Portal, Startkachel, Schnellaktionen und die Seite
  „Geräte“ zeigen nur „Zustand unklar“ (statt „Zustand unklar – zuletzt: Unbekannt“), nie
  „Öffnet …“. Geprüft: eine Zeile aus 1.0.0 (`moving_since` leer nach Migration 002) erreicht die
  3-Minuten-Regel über die Übersicht und über das Neulesen; die Uhr startet bei der ersten Abfrage
  nach dem Update und wird beim Neulesen nicht zurückgesetzt.
- **Diagnose** auf der Seite „Geräte“: die rohen Felder – Nuki Web `mode`, `state`, `lastAction`,
  `trigger`, `doorState`, `serverState` und „Cloud-Stand: vor … “ aus `updateDate`; Bridge
  `mode`, `state`, `stateName`, `doorsensorState`, `doorsensorStateName`, `timestamp` (aus
  `lastKnownState` bzw. `/lockState`). Auch bei „nicht erreichbar“ bleibt z. B. `serverState`
  sichtbar. Nur Zahlen und kurze Texte, nie Tokens.
- **Hinweis** auf der Seite „Geräte“, wenn der Zustand aus Nuki Web als unklar gilt: „Nuki Web
  liefert einen veralteten Zustand. Für zuverlässige Anzeige die Nuki Bridge verwenden oder in der
  Nuki-App prüfen, ob das Schloss mit dem Internet verbunden ist.“
- Datenbank: Migration `003_state_raw.sql` (`lock_state.cloud_at`, `lock_state.nuki_raw`).

## 1.0.1
- **Behoben: Schloss bleibt auf „Öffnet …“ (oder „Sperrt auf/zu …“) stehen.** Die Bridge liefert
  in `/list` ihren zwischengespeicherten Zustand, Nuki Web in `/smartlock` den der Cloud – beide
  können nach einer Bedienung über Nuki-App, Keypad oder Knopf auf einem Zwischenzustand hängen
  bleiben. Jetzt: Bridge – nach ≥ 30 s im Zwischenzustand wird das Schloss selbst gefragt
  (`/lockState`, höchstens 1× pro Minute und Schloss) und dessen Antwort gespeichert; schlägt das
  fehl, gilt für diese Abfrage weiter `/list`. Nuki Web – nach ≥ 60 s wird das Schloss einzeln neu
  gelesen (`GET /smartlock/{id}`, höchstens alle 2 Minuten).
- **Anzeige:** ein Zwischenzustand, der nach 3 Minuten nicht endet, wird nicht mehr gezeigt –
  stattdessen der letzte feste Zustand mit „Zustand unklar – zuletzt: …“ (Portal, Startkachel,
  Schnellaktionen; App-API: `state.stale: true`, die App zeigt den festen Zustand).
- **Sicherheit:** automatisches Aufsperren nutzt nur den echten, frisch abgefragten Zustand; ist
  er „unklar“, wird abgelehnt (Grund `state_unclear`, „Zustand des Schlosses unklar“).
- **Diagnose** auf der Seite „Geräte“: pro Schloss Quelle (Bridge/Nuki Web), roher Nuki-Code,
  Herkunft (`/list`, `/lockState`, `/smartlock`, `/smartlock/{id}`), abweichender Code der
  Übersicht, letzter Lesezeitpunkt, „in Bewegung seit“. Debug-Protokoll, wenn ein Zwischenzustand
  neu gelesen wird (ohne Tokens).
- Gerätetypen geprüft (Bridge `deviceType` und Web `type`: 0 Smart Lock 1/2, 1 Box – ignoriert,
  2 Opener, 3 Smart Door, 4 Smart Lock 3/4, 5 neuere Smart Locks): unverändert korrekt.
- Datenbank: Migration `002_state_diagnostics.sql` (neue Spalten in `lock_state`).

## 1.0.0
Braucht **GateControl ≥ 1.169.0** (Push-Bilder, Schnellaktionen in Mitteilungen,
5-Sekunden-Hintergrundlauf). Kostenpflichtiges Zusatz-Plugin (`license.required`), nicht in
GateControl Lifetime enthalten.
- **Nuki:** pro Schloss wählbar die lokale **Nuki Bridge** (HTTP-API über das Zugriffsziel
  „Nuki Bridge“, mehrere Bridges möglich, Anmeldung mit gehashtem Token `ts`/`rnr`/`hash` – der
  Token steht nie in einer URL; Anfragen pro Bridge nacheinander, mit Timeouts) oder **Nuki Web**
  (Cloud, API-Token). Smart Lock (Typ 0, 3, 4, 5): zusperren, aufsperren, öffnen (Falle);
  Opener (Typ 2): Summer. Pro Schloss: Name, Quelle, welche Aktionen es gibt, Türsensor ja/nein,
  „offen zu lange“ nach N Minuten (Standard 5, 0 = aus), Nachtkontrolle (Standard 22:00, aus
  möglich). Zustand: zu/auf/geöffnet/sperrt/blockiert …, Tür offen/zu, Batterie kritisch und %,
  erreichbar, Stand. Abfrage alle 30 s (die Bridge-Liste, kein Funkverkehr zum Schloss), direkt
  nach jeder Aktion und alle 10 s, solange ein automatisches Aufsperren auf die Tür wartet.
  Nuki Web: Bedienungen am Schloss / Keypad werden aus dem Protokoll in den Verlauf übernommen.
- **Ring (inoffiziell, ohne Gewähr):** Anmelde-Assistent auf der Seite „Geräte“ (E-Mail +
  Passwort → Bestätigungscode per SMS/E-Mail/App). Gespeichert wird **nur das Refresh-Token**
  (verschlüsselt, es erneuert sich laufend – immer das neueste), nie Passwort oder E-Mail; eine
  Geräte-ID wird einmal pro Installation erzeugt. Klingeln und Kameras mit Name, Akku, online;
  jede Kamera kann mit einem Schloss verknüpft werden. Klingeln und Bewegung werden ohne
  Push-Empfang **abgefragt** (alle 5 s die aktiven Ereignisse, alle 30 s die Ereignisliste als
  Nachlauf, ohne Doppelte); Verzögerung etwa 5–15 s plus Bild. Bei Fehlern wird gebremst (5 s …
  5 min, bei 429 nach Retry-After). Ist Ring gestört, zeigt das Plugin „Ring-Verbindung
  gestört“ und benachrichtigt die Administratoren höchstens einmal am Tag – Nuki läuft weiter.
- **Rechte** (Seite „Berechtigungen“): pro Person und Schloss keine / ansehen / zu-/aufsperren /
  auch öffnen; optional ein Wochen-Zeitfenster pro Person (z. B. Mo–Fr 07:00–20:00, auch über
  Mitternacht); „Automatisch aufsperren bei Ankunft erlauben“ (Standard aus); pro Kamera
  Klingel-Push (Standard an) und Bewegungs-Push (Standard aus). Admins bekommen nichts
  automatisch. Kiosk-Geräte und nur per Geräte-Vertrauen erkannte Portal-Besucher sehen nur.
  **Jede Aktion wird auf dem Server erneut geprüft** (Recht, Zeitfenster, höchstens 10 pro
  Minute und Person) und in den Verlauf geschrieben – auch abgelehnte.
- **Schnellaktionen** (App-Verknüpfungen, Schnelleinstellungen, Widget): pro Schloss und Recht
  „Haustür zusperren“ / „… aufsperren“ / „… öffnen“ (Opener „… Summer“), Rückfrage bei auf/öffnen,
  Zustand als Untertitel, Symbole Schloss / offenes Schloss / Tür. IDs `<lockId>:lock|unlock|open`.
- **Klingel-Push mit Bild** (Thema „Klingel“, hoch): an alle mit mindestens „ansehen“ auf dem
  verknüpften Schloss; wer „auch öffnen“ darf, bekommt den Knopf **„Tür öffnen“** (Rückfrage und
  Geräte-Entsperrung in der App) und alle „Ansehen“. Bewegung (Thema „Bewegung“, Standard aus)
  nur für wer sich pro Kamera angemeldet hat, höchstens eine pro Kamera in 5 Minuten.
- **Automatisch aufsperren bei Ankunft** über die Familie-Regel „Person kommt heim“ → Aktion
  „Haustür aufsperren“. Angenommen nur, wenn alles stimmt: nur aufsperren (nie öffnen),
  Zustimmung und mindestens „zu-/aufsperren“, Zeitfenster, höchstens alle 10 Minuten pro
  Person und Schloss, Schloss erreichbar und zugesperrt (frisch abgefragt), Tür zu (mit
  Türsensor). Sonst abgelehnt mit Verlaufseintrag und Mitteilung „Automatisches Aufsperren
  abgelehnt: …“. Nach dem Aufsperren „Haustür automatisch aufgesperrt“ mit „Wieder zusperren“;
  wird die Tür in 3 Minuten nicht geöffnet, sperrt das Plugin wieder zu (mit Türsensor) bzw.
  fragt per Mitteilung (ohne).
- **Sicherheit:** Tür zu lange offen, Schloss blockiert, > 10 Minuten nicht erreichbar,
  Batterie kritisch (einmal am Tag), Nachtkontrolle mit „Zusperren“ – Thema „Tür & Schloss“.
- **Verlauf** (eigene Tabelle, 90 Tage): jede Aktion mit wer, über was (App, Portal,
  Mitteilung, Automatik, System, Nuki, Keypad) und Ergebnis; Klingeln und Bewegung mit Bild
  (Bilder 1–30 Tage, Standard 7).
- **Oberfläche:** Admin-Seiten „Geräte“, „Berechtigungen“, „Verlauf“, „Einstellungen“; Portal-Tab
  mit Schlosskarten, letzten Bildern („Neues Bild“) und Verlauf; Start-Kacheln pro Schloss;
  App-API für den nativen Tab (README).
- Gemeinsamer Baustein `server/notify.js` (in allen Plugins gleich): reicht ein Bild (`image`)
  an GateControl weiter und schickt eine Mitteilung ohne Bild erneut, wenn GateControl das Bild
  ablehnt.
