# Messenger (gatecontrol-messenger)

Chats zwischen den GateControl-Konten – in der GateControl-App (eigener Tab „Chats“), im
Windows-Client und im Portal (eigener Tab „Chats“). Alles bleibt auf dem eigenen Server.

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
