# Messenger (gatecontrol-messenger)

Chats zwischen den GateControl-Konten – in der GateControl-App (eigener Tab „Chats“), im
Windows-Client und im Portal (eigener Tab „Chats“). Alles bleibt auf dem eigenen Server.

## 1.4.1
- **Dauer einer Story wählbar:** 1, 3, 6, 12 oder 24 Stunden (`durationH` bei `POST status/stories`, Funktion
  `story_duration`); ohne Angabe wie bisher 24 Stunden.

## 1.4.0
Braucht **GateControl ≥ 1.180.0** (Haus-Aktionen als Tipp einer Person: `permissions.actions { interactive: true }`;
Dienst-Aufrufe bis 512 KB für das Klingelbild). Neue Felder und Routen stehen im README unter „Since 1.4.0“; die Apps
zeigen eine Funktion nur, wenn `GET me` → `features.<key>` sie meldet (`status`, `stories`, `polls`, `events`,
`arrival`, `actions`, `msg_tools`, `privacy2`).
- **Status und Storys:** eine Statuszeile pro Person (Homeoffice, Unterwegs mit Ziel und Ankunft, Bitte nicht stören,
  Ort automatisch aus Familie, eigener Text bis 60 Zeichen, mit Ende) und Storys für 24 Stunden (Text auf Farbe,
  Foto, Video) für alle, die Familie oder ausgewählte Personen; „angesehen von“ mit Reaktionen, Antworten als
  Direktnachricht mit Bezug auf die Story. „Bitte nicht stören“ hält alle Chat-Pushes zurück. Optional eine
  tägliche Zusammenfassung neuer Storys (Thema „Status-Zusammenfassung“, standardmäßig aus).
- **Privatsphäre und Einstellungen:** zuletzt online / online (symmetrisch wie Lesebestätigungen), Profilbild,
  Status-Standard, Ort im Status, wer mich zu Gruppen hinzufügen darf, selbstlöschende Nachrichten für neue Chats;
  Benachrichtigungen (Gruppen nur bei Erwähnung, Reaktionen, Standard-Erinnerung für Termine); archivierte Chats
  bleiben archiviert.
- **Chat-Werkzeuge:** blockieren, archivieren, bis zu drei Nachrichten anheften, eigene Chat-Listen, Chat-Export als
  Text, „Erinnern“ an eine Nachricht (Push zur gewählten Zeit), Vorschläge aus einer Nachricht (Einkäufe → Familie-
  Liste, Termine → Familienkalender; deutscher Parser auf dem Server, kein externer Dienst).
- **Abstimmungen:** Frage mit 2–12 Optionen, Mehrfachauswahl, anonym, weitere Optionen durch andere, Ende zu einer
  Zeit, „Erinnern“ an alle, die noch nicht abgestimmt haben; beim Ende eine Systemnachricht mit dem Ergebnis.
- **Termine:** Zu-/Absagen mit Begleitpersonen, Checkliste, Erinnerung vor dem Beginn, Abfahrt-Hinweis 45 Minuten
  vorher, optional im Familienkalender (Familie-Dienste `calendar_upsert` / `calendar_remove`); der nächste Termin
  steht oben im Chat.
- **Live-Ankunft:** Die App teilt alle 20 s den Standort; der Server rechnet Entfernung, Ankunftszeit und
  Fortschritt, meldet die Ankunft (Systemnachricht und Push), kann dabei eine Haus-Aktion ausführen und stoppt
  nach 3 Stunden. Der Standort liegt nur verschlüsselt und nur, solange die Ankunft läuft.
- **Haus-Aktionen und Plugin-Karten:** Schnellaktionen anderer Plugins als Knopf im Chat, als Bitte an die, die sie
  ausführen dürfen, oder für eine Person bis zu einer Zeit freigegeben – immer mit den Rechten der ausführenden
  Person in GateControl (Freigaben laufen mit den Rechten der freigebenden Person; sensible Aktionen lassen sich
  nicht freigeben). Andere Plugins schicken Karten mit Bild und Knöpfen (`send_message` mit `card`), z. B. die
  Türklingel mit Schnappschuss, „Tür öffnen“ und „Live-Bild“.
- **Dienst `set_place_status`** für Familie (Ort im Status bei „Ort automatisch“); Messenger nutzt die
  Familie-Dienste `list_add`, `calendar_add`, `calendar_upsert`, `calendar_remove`, `places`, wenn Familie sie
  anbietet. `send_message` an `family` erreicht für Plugins ohne eigene Gruppe die Gruppe „Familie“.
- **Portal:** Statusleiste mit leuchtendem Ring für ungesehene Storys unter „Angeheftet“, Story-Ansicht, eigener
  Status, Abstimmungen, Termine, Live-Ankünfte (nur Anzeige), Haus-Aktionen und Karten mit Knöpfen, Listen und
  Archiv über der Chat-Liste, angeheftete Nachrichten, Einstellungen für Privatsphäre, Benachrichtigungen und
  Blockierungen.
- **Admin-Übersicht:** nur Zahlen (aktive Status / Storys, offene Abstimmungen, kommende Termine, laufende
  Ankünfte, Haus-Aktionen und Karten, Blockierungen, offene Erinnerungen) und die Schalter „Storys erlauben“ und
  „Haus-Aktionen in Chats“.
- Alles Neue wird wie Nachrichtentexte verschlüsselt gespeichert; Ablauf und Aufräumen übernimmt der
  Hintergrundlauf. Migration `002` baut die Tabellen `messages` und `media` für die neuen Arten um (Inhalte und
  Nummern bleiben).

## 1.3.0
Läuft weiterhin ab **GateControl ≥ 1.177.0**; das Vorschaubild im Push braucht wie bei Fotos 1.178.0.
- **Videos als eigene Kategorie:** Ein Video bleibt eine Dateinachricht (`kind: "file"` mit einer
  `video/*`-Datei) – ältere Apps zeigen es weiter als Datei. Neu darf sie `video: { durationMs, width,
  height }` mitbringen (ganze Zahlen, Dauer bis 24 h, Seiten 1…16384; nur bei einer Videodatei), die
  Nachricht gibt `video` zurück. `GET conversations/:id/media?kind=video` listet die Videos,
  `kind=file` nur noch die übrigen Dateien; `counts` hat `video`, `file` zählt keine Videos mehr.
- **Vorschaubilder für Dateien:** Dateinachrichten dürfen `thumbMediaId` haben (WebP, JPEG oder PNG,
  ≤ 64 KB, ≤ 640 px je Seite – eigener, noch unbenutzter Upload wie bei Fotos), die Nachricht gibt
  `thumbMediaId` zurück. Zugriff wie auf die Datei (nur Mitglieder, die die Nachricht sehen);
  gelöscht wird das Vorschaubild mit der Nachricht (Löschen für alle, selbstlöschende Chats,
  Aufbewahrung, gelöschte verwaltete Gruppe).
- **Push:** Ein Video mit Vorschaubild zeigt das Vorschaubild als Bild im Push – wie ein Foto, nur
  bei eingeschalteter Vorschau.
- **`GET me`:** `features.video_meta` und `features.file_thumbs` (beide `true`) – die Apps prüfen sie,
  bevor sie die neuen Felder senden; `limits.thumbMaxSide: 640`. Die Flags stehen im bestehenden
  Objekt `features` (die veröffentlichten Apps lesen es als Objekt).
- **Portal:** Beim Senden eines MP4-Videos liest der Browser Dauer und Größe aus der Datei und erzeugt
  ein Vorschaubild bei etwa 1 s (WebCodecs; der Rahmen darf Videos nicht über `blob:` öffnen). Ohne
  WebCodecs oder bei unbekanntem Codec gehen nur Dauer und Größe mit, sonst die Datei wie bisher.
  PDFs bekommen eine Vorschau der ersten Seite nur, wenn der Rahmen schon einen PDF-Renderer hat
  (derzeit nicht). Videos mit Vorschaubild erscheinen als Kachel mit Abspiel-Knopf und Dauer,
  Dateien mit Vorschaubild zeigen es auf der Dateikarte, „Zuletzt geteilt“ in der Chat-Info hat die
  Reiter Fotos / Videos.

## 1.2.0
Läuft weiterhin ab **GateControl ≥ 1.177.0**. Der eigene Standort des Browsers und der angeheftete Eintrag
„GateControl“ brauchen **GateControl ≥ 1.179.0** (`ui.geolocation`, `ui.inbox`); auf älteren Versionen
fehlen nur diese beiden, der Rest funktioniert.
- **Standort aus dem Portal senden:** Die Büroklammer öffnet ein kleines Menü „Datei oder Foto“ /
  „Standort“. „Standort senden“ zeigt eine Karte (Leaflet von GateControl, Kacheln über GateControls
  Kachel-Relay `GC.tiles`): Punkt antippen oder ziehen, oder Breite/Länge eingeben; optional eine
  Bezeichnung. „Mein Standort“ fragt den Browser nach der Position – nur wenn GateControl dem Rahmen
  das erlaubt (ab 1.179.0) und der Browser zustimmt; sonst bleibt die Karte. Gesendet wird die
  bestehende Nachrichtenart `location` (lat, lon, label, accuracy) – Apps und Push zeigen sie wie
  bisher. Eine Adresssuche gibt es nicht (kein Geocoder ohne Internetzugriff des Plugins).
- **Empfangene Standorte mit Kartenvorschau:** ein kleiner Kartenausschnitt mit Nadel in der Blase
  (einige Kacheln über das Relay, kein Leaflet pro Nachricht); ein Klick öffnet die Karte groß mit
  Genauigkeitskreis und dem Link „In OpenStreetMap öffnen“.
- **Angehefteter Eintrag „GateControl“** oben in der Chat-Liste wie in den Apps: die Mitteilungen von
  GateControl (Postfach des Portals) mit Zahl der ungelesenen und dem Titel der neuesten; ein Klick
  öffnet das Postfach des Portals. Das Plugin bekommt dafür von GateControl nur Zahl, Titel, Zeit und
  Priorität des eigenen Postfachs der angemeldeten Person (`GC.inbox`), nichts davon geht an den
  Server des Plugins.
- `plugin.json`: `ui.maps`, `ui.geolocation`, `ui.inbox` – im Installationsdialog als „Karten“,
  „Standort“ und „Postfach“ (die beiden letzten zeigt GateControl ab 1.179.0).

## 1.1.0
Braucht weiterhin **GateControl ≥ 1.177.0**; nur das Foto im Push braucht GateControl 1.178.0.
- **Gruppe zurückgeben (Dienst `release_group`):** Ein Plugin, das eine Gruppe verwaltet (z. B. Familie
  die Gruppe „Familie“), kann sie zurückgeben. Standard: Die Gruppe wird eine **normale Gruppe** – der
  Verlauf bleibt, Mitglieder können austreten, Namen und Bild ändern; Admins werden die vom Plugin
  genannten Mitglieder (sonst wer zuerst beigetreten ist); eine Systemnachricht „GateControl hat die
  Gruppe freigegeben“ sagt es allen. Mit `delete: true` wird die Gruppe stattdessen für alle
  **gelöscht** (Nachrichten, Dateien und Gruppenbild endgültig). Danach ist der Schlüssel frei: ein
  späterer Abgleich legt eine neue Gruppe an.
- **Eine Nachricht an mehrere Chats in einem Aufruf (`send_message`):** `conversation` darf eine Liste
  mit bis zu 20 Zielen sein (z. B. `["user:3", "user:7"]`) – eine Nachricht pro Ziel, ein einziger
  Dienst-Aufruf (GateControl erlaubt 60 pro Stunde), die Antwort nennt das Ergebnis je Ziel; ein
  abgelehntes Ziel hält die anderen nicht auf. Ein einzelnes Ziel funktioniert wie bisher.
- **Foto im Push:** Ein Foto kommt mit seinem Vorschaubild in der Benachrichtigung an (Android zeigt es
  in der Chat-Mitteilung) – nur bei „Inhalt in Benachrichtigungen“ an. Braucht **GateControl ≥ 1.178.0**;
  auf 1.177 bleibt der Push wie bisher ohne Bild. Lehnt GateControl das Bild ab (z. B. zu klein), geht
  der Push ohne Bild hinaus.
- **App-API (für Android und Windows, Details im README „App-API“):**
  - `GET conversations/:id/messages?around=<id>&limit=n`: die Nachricht und die davor und danach – zum
    Springen zu einem Suchtreffer oder einem Zitat; die Antwort trägt `hasMoreBefore` / `hasMoreAfter`.
  - Jede Antwort von `GET conversations/:id/messages` trägt `serverTime` (wie die Chat-Liste) – als
    nächstes `changedSince` verwendbar.
  - Das Live-Ereignis `read` trägt `readUpTo` und `deliveredUpTo`, so wie `GET conversations/:id` sie
    dem jeweiligen Empfänger geben würde – die Apps brauchen nach einem `read` keinen Abruf mehr (gilt
    auch für „zugestellt“, das dasselbe Ereignis ist).
  - Neues Systemereignis `released` und `conversation.update` mit `reason: "released"`.

## 1.0.0
Braucht **GateControl ≥ 1.177.0** (Plugin-Medien, Live-Ereignisse, Chat-Benachrichtigungen,
Dienste zwischen Plugins). Kostenpflichtiges Plugin (Lizenz wie Familie).
- **Einzel- und Gruppenchats** zwischen allen GateControl-Konten: Text, Fotos (mit Vorschaubild),
  Sprachnachrichten, Dateien und Standort (einmalig), Antworten mit Zitat, Reaktionen (eine pro
  Person), Bearbeiten und „Für alle löschen“ innerhalb eines Zeitfensters (Standard 15 Minuten),
  „Für mich löschen“, Suche im Chat (auf dem Server entschlüsselt, die letzten 2 000 Nachrichten).
- **Gruppen:** Wer eine Gruppe anlegt, ist Admin; Admins fügen Mitglieder hinzu, entfernen sie und
  vergeben Admin-Rechte; jedes Mitglied ändert Name, Gruppenbild und selbstlöschende Nachrichten und
  kann die Gruppe verlassen. Neue Mitglieder sehen den Verlauf ab ihrem Beitritt.
- **Lesebestätigungen** (gesendet/zugestellt/gelesen) und **„schreibt …“** – wer eines davon
  ausschaltet, sendet nichts und sieht auch bei anderen nichts (wie WhatsApp). „Inhalt in
  Benachrichtigungen“ aus: der Push sagt nur „Neue Nachricht von Anna“.
- **Push mit Antwortfeld** über GateControls Chat-Benachrichtigungen: eine Mitteilung pro Nachricht,
  gruppiert pro Chat, mit „Antworten“ und „Gelesen“; keine Mitteilung bei stummgeschaltetem Chat
  oder wenn der Chat gerade auf einem Gerät offen ist (die Apps melden das alle 20 Sekunden).
- **Live** in Apps und Portal: neue, geänderte und gelöschte Nachrichten, Reaktionen, gelesen,
  „schreibt …“, Änderungen an Chats.
- **Selbstlöschende Chats** (1 Tag / 1 Woche / 1 Monat, abschaltbar durch den Admin) und
  **Aufbewahrung** (unbegrenzt bis 2 Jahre) – Nachrichten und ihre Dateien werden im Hintergrund
  endgültig gelöscht.
- **Datenschutz:** Texte, Standorte, Dateinamen und Gruppennamen liegen mit AES-256-GCM
  verschlüsselt in der Datenbank (Schlüssel als geheime Plugin-Einstellung), Dateien verschlüsselt
  bei GateControl. Dateien sieht nur, wer Mitglied des Chats ist. Ehrlich: Wer Root auf dem
  Server hat, kann technisch entschlüsseln; Ende-zu-Ende-Verschlüsselung folgt später.
- **Admin-Seiten ohne Inhalte:** „Übersicht“ mit Konten, Chats, Nachrichten heute, Speicher je Typ,
  den Medien-Grenzen von GateControl (nur Anzeige – ändern unter Einstellungen → Plugins →
  Messenger → Übersicht → Medien), Aufbewahrung, Bearbeiten-Fenster, Länge von Sprachnachrichten
  und Standards für neue Konten; „Protokoll“ nur mit Fehlern und erreichten Limits.
- **Portal-Tab „Chats“:** Liste, Chat und Info nebeneinander, am Handy gestapelt; Fotos und Dateien
  hochladen (Fotos werden im Browser verkleinert), Sprachnachrichten aufnehmen (wenn der Browser
  das Mikrofon erlaubt). Dateien außer Fotos, Audio und Video öffnet man in den Apps (das Portal
  darf keine Downloads starten).
- **Für Familie (ab Familie 1.6.0):** Dienst `sync_group` hält die Gruppe „Familie“ aktuell (ihre
  Mitglieder pflegt nur Familie), Dienst `send_message` schreibt Regel-Nachrichten als
  Systemnachricht von „GateControl“ in die Familie, eine Gruppe oder an eine Person.
- App-API für Android und Windows: siehe README.
