# Messenger (gatecontrol-messenger)

Chats zwischen den GateControl-Konten – in der GateControl-App (eigener Tab „Chats“), im
Windows-Client und im Portal (eigener Tab „Chats“). Alles bleibt auf dem eigenen Server.

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
