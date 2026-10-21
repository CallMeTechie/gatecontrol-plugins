# Tür & Kamera (gatecontrol-door)

Nuki-Schlösser und -Opener sowie Ring-Klingeln und -Kameras in GateControl – in der App
(eigener Tab „Tür“), im Widget/den Schnellaktionen und im Portal (eigener Tab „Tür“). Alles
bleibt auf dem eigenen Server. Einrichtung, Risiken, Datenschutz und die App-API: README.md.

**Ring: inoffizielle Schnittstelle, ohne Gewähr.** Ring bietet keine offizielle Schnittstelle
an; das Plugin nutzt die, die auch die Open-Source-Projekte ring-client-api (Homebridge) und
python-ring-doorbell (Home Assistant) verwenden. Sie kann sich jederzeit ändern oder wegfallen.

## 1.5.0
Braucht weiterhin **GateControl ≥ 1.169.0**.
- **Kameras ohne Schloss** (z. B. am Briefkasten oder im Garten): Bisher sah sie niemand – ein Klingeln
  dort ging an keine Person, stand bei niemandem im Verlauf und die Kamera fehlte in App und Portal.
  Unter „Berechtigungen“ gibt es jetzt pro Kamera ohne Schloss eine Spalte „sieht“: Wer einen Haken hat,
  sieht die Kamera, bekommt ihr Klingeln (und auf Wunsch die Bewegung) als Mitteilung und findet die
  Ereignisse im Verlauf – auch ohne jedes Recht auf ein Schloss. Kameras an einem Schloss folgen wie
  bisher den Rechten des Schlosses; wird eine Kamera später einem Schloss zugeordnet, gelten dessen Rechte.
- **Klingel-Diagnose warnt** auf der Seite „Einstellungen“:
  - wenn „Ring abfragen“ aus ist, obwohl Ring verbunden ist – dann erkennt das Plugin kein Klingeln und
    keine Bewegung (keine Mitteilung, keine Chat-Karte, kein Verlauf), Gong und Fernseher klingeln
    trotzdem. Der Hinweis steht auch direkt unter dem Schalter.
  - wenn eine Kamera (eingeschaltet) von niemandem gesehen wird: ohne Schloss niemand angehakt, mit
    Schloss niemand mit einem Recht darauf.
- **API:** `GET|PUT admin/settings` → `warnings: [{ code: 'ring_off' } | { code: 'no_viewers', camera, lock }]`;
  `GET admin/rights` → `cameraRights { <userId>: [cameraId] }`, `PUT admin/rights/<userId>` nimmt
  `cameraRights { <cameraId>: true|false }`. `GET me` / Verlauf / Ereignis berücksichtigen die neuen Rechte.

## 1.4.0
Braucht weiterhin **GateControl ≥ 1.169.0** (Familien-Chat: ≥ 1.177.0 und Messenger ab 1.4.0).
- **Behoben: ein Klingeln kam nicht im Familien-Chat an** (Gong und Fernseher klingelten). Ursachen:
  - Ring schränkt die Sofort-Abfrage `dings/active` für viele Konten ein. Antwortete sie mit einem
    Fehler, scheiterte die ganze Abfrage – auch die Ereignisliste, die dann die einzige Quelle für ein
    Klingeln ist, wurde nie gelesen (und die Seite zeigte „Ring-Verbindung gestört“). Jetzt pausiert
    nur `dings/active` für 10 Minuten (bei 429 so lange wie verlangt), die Ereignisliste läuft weiter,
    währenddessen alle 15 statt 30 Sekunden. Ein Anmeldefehler stoppt die Abfrage wie bisher.
  - Ein Klingeln, das Ring erst verzögert in der Ereignisliste führt (dazu bis zu 30 s Abfrage-Abstand
    oder eine Pause nach einem Fehler), wurde nach 2 Minuten verworfen und als „gesehen“ gemerkt – es
    war für immer verloren: kein Verlauf, kein Push, keine Karte. Jetzt gilt ein Klingeln 10 Minuten
    lang (Verlauf und Chat-Karte), der Push geht bis 5 Minuten danach raus. Bewegung bleibt bei
    2 Minuten. Doppelt wird nichts – auch nicht nach einem Neustart (der Verlauf merkt sich jedes
    Ereignis).
- **Ersatzweg ohne Gruppe „Familie“:** antwortet der Messenger `not_found` (Familie fehlt, die
  Messenger-Gruppe ist aus oder wurde freigegeben), geht die Karte an die Personen, die den
  Klingel-Push bekommen (Sichtrecht auf das verknüpfte Schloss, Klingel-Push nicht abgeschaltet) –
  jeweils in ihren eigenen, schreibgeschützten Kanal „Tür & Kamera“ (ein Aufruf, höchstens 20 Personen).
- **Klingel-Diagnose** auf der Seite „Einstellungen“: die zuletzt erkannte Klingel (Zeit, Kamera,
  nach wie vielen Sekunden, über welchen Weg, was daraus wurde – auch „zu spät erkannt“ oder „Kamera
  ausgeschaltet“), das letzte Chat-Ergebnis mit verständlichem Grund (u. a. `unavailable`,
  `not_found`, `rate_limit`, `timeout` – „die Karte kann trotzdem angekommen sein“) und ob Ring die
  Sofort-Abfrage gerade einschränkt.
- **API:** `GET me` trägt `doorbell: { lastRingAt, source, chat: { at, ok, error, fallback } | null } | null`
  (für Personen, die eine Kamera sehen – für den Bildschirm „Haus-Aktionen“ der Apps). `GET|PUT
  admin/settings`: `chat.last.fallback { to, sent, failed }` und `chat.detect { lastDing, active }`.
- Hinweis zur Bildgröße: ab GateControl 1.180.0 nimmt der Dienst-Aufruf bis 512 KB an – das Bild
  (≤ 300 KB) passt dann immer.

## 1.3.0
Braucht weiterhin **GateControl ≥ 1.169.0**; die Klingel im Familien-Chat braucht GateControl ≥ 1.177.0
und das **Messenger-Plugin ab 1.4.0**. Neu beim Aktualisieren: die Berechtigung „Dienste anderer
Plugins“ (`gatecontrol-messenger: send_message`).
- **Klingel in den Familien-Chat:** Jedes Klingeln kommt zusätzlich zu den Pushs als **Karte** in den
  Chat „Familie“ des Messengers – Titel „Klingel · Haustür“ (das verknüpfte Schloss, sonst die Kamera),
  Kamera und Uhrzeit, das **Bild** des Klingelns und der Knopf **„Tür öffnen“** (die Schnellaktion
  `<Schloss>:open`, beim Opener „Summer“) – nur wenn das Schloss öffnen kann. Bewegung kommt nie in den
  Chat.
- **„Tür öffnen“ aus dem Chat ist eine Aktion der Person:** GateControl führt den Knopf als
  interaktiven Lauf aus (`user.interactive: true`, `automation: false`, `via: 'gatecontrol-messenger'`).
  Das Plugin behandelt ihn wie einen Tipp in der App – mit den Rechten, dem Zeitfenster und dem
  Rate-Limit dieser Person, nie mit den Regeln fürs automatische Aufsperren (kein `auto_open`, kein
  `auto_off`, keine „Automatisch“-Pushs). Im Verlauf steht „Chat“ (`via: 'chat'`) mit dem aufrufenden
  Plugin (`caller: 'gatecontrol-messenger'`); das gilt auch für den Ring-Modus.
- **Schalter auf der Seite „Einstellungen“:** „Klingel in den Familien-Chat“ (Standard: an). Darunter
  steht, ob der Messenger verfügbar ist (ab GateControl 1.178.0 kostenlos gefragt) und ob die letzte
  Karte nicht ankam. Ohne Messenger, ohne Gruppe „Familie“ oder auf älterem GateControl ändert sich
  nichts – die Klingel funktioniert wie bisher.
- **Bildgröße:** GateControl nimmt pro Dienst-Aufruf höchstens 16 KB an; ist das Bild dafür zu groß
  (oder lehnt der Messenger es ab), geht die Karte ohne Bild – das zählt nicht gegen die 60 Aufrufe
  pro Stunde. Bilder über 300 KB werden nie mitgeschickt.
- **API:** `send_message { conversation: 'family', card: { kind: 'doorbell', title, text, imageBase64?
  (JPEG, Base64), actions: ['<lockId>:open'] | [] } }`. `GET|PUT admin/settings` tragen `familyChat`
  in `config` und zusätzlich `chat: { api, available (true | false | null = unbekannt), last: { at, ok,
  error, image } | null }`.

## 1.2.1
- **Nuki: seltene „Bridge-Token ungültig“-Fehler behoben.** Jede Anfrage an die Bridge trägt eine
  Zufallszahl (`rnr`), die die Bridge nicht zweimal annimmt. Sie wurde bisher jedes Mal neu
  gewürfelt und konnte sich wiederholen – dann lehnte die Bridge die Aktion ab, als wäre der
  Token falsch. Jetzt zählt das Plugin von einem zufälligen Start aus hoch; Wiederholungen
  gibt es erst nach 65 536 Anfragen.

## 1.2.0
- **Schnellaktion Ring-Modus: ein Schalter statt zwei Knöpfen.** Pro Standort gibt es jetzt
  einen Schalter **Zuhause ⇄ Abwesend** (`mode:<Standort>`; an = Abwesend, aus = Zuhause) statt
  der Knöpfe „Zuhause“ und „Abwesend“. Titel = der aktuelle Modus („Zuhause“ / „Abwesend“; bei
  Inaktiv „Ring-Modus“ ohne Zustand), Symbol wie in der Ring-App (Schild mit Person bzw. mit
  laufender Person), ohne Rückfrage. Antippen: Abwesend → Zuhause, Zuhause → Abwesend,
  Inaktiv → Zuhause.
- **Regeln** setzen über den Schalter einen festen Zielzustand (`targets`, „Abwesend“ /
  „Zuhause“) – genau diesen Modus, auch wenn er schon gilt; umgeschaltet wird dabei nie.
- Der Knopf **„Inaktiv“** bleibt. Das **Widget** „Ring-Modus“ (aktueller Modus, Auswahl der drei
  Modi) hängt jetzt am Schalter; die Auswahl funktioniert wie bisher.
- **Angeheftete Knöpfe „Zuhause“ / „Abwesend“ (`mode_home:` / `mode_away:`) verschwinden** – die
  App entfernt Schnellaktionen, die das Plugin nicht mehr anbietet; bitte den Schalter neu
  anheften. Regeln mit diesen Aktionen auf den Schalter umstellen.
- Rechte, Rate-Limits, Verlauf, Seite „Geräte“ und Portal unverändert.

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
