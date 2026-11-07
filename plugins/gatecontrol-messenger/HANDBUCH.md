<!-- version: 1.11.1 -->
# Messenger

## Was das Plugin kann

- **Chats zwischen den GateControl-Konten** – in der GateControl-App (Tab „Chats“), im Windows-Client und im Portal-Tab „Chats“.
- **Einzel- und Gruppenchats** mit Text, Bildern, Videos, Sprachnachrichten, Dateien und Standort; Antworten mit Zitat, Reaktionen, Bearbeiten und Löschen, Lesebestätigungen, „schreibt …“, selbstlöschende Chats.
- **Push mit Antwortfeld.**
- **Status und Storys, Abstimmungen, Termine mit Zusagen, Live-Ankunft** und **Haus-Aktionen** (z. B. Licht oder Tür aus einem anderen Plugin) im Chat.
- **Mitteilungen in Chats:** Jede Person kann wählen, ob die Mitteilungen eines Themas in GateControl, im Familien-Chat oder in einem eigenen Chat erscheinen.
- **Gruppenchats für GateControl-Gruppen**, die sich von selbst mit den Mitgliedern abgleichen.
- **In Drive speichern:** Bilder, Sprachnachrichten und Dateien eines Chats ins Plugin Drive.

Alles bleibt auf deinem Server. Texte, Standorte, Dateinamen und Gruppentitel werden verschlüsselt gespeichert. Administratoren können private Chats nicht lesen.

## Voraussetzungen

- GateControl **1.193.0** oder neuer (Gruppenchats für GateControl-Gruppen ab 1.200.0, Virenscan ab der Version nach 1.222.0).
- Eine Lizenz für das Plugin.
- Für „In Drive speichern“: das Plugin Drive. Für den Familien-Chat: das Plugin Familie.

## Einrichten

Nach der Installation kann jedes aktive GateControl-Konto chatten. Als Administrator stellst du auf der Seite **„Übersicht“** ein:

- maximale Länge von Sprachnachrichten, **Aufbewahrung** (unbegrenzt, 30, 90, 180, 365, 730 Tage), selbstlöschende Chats erlauben,
- wie lange man eine Nachricht für alle bearbeiten oder löschen darf (Standard 15 Minuten),
- Vorgaben für neue Konten (Lesebestätigungen, „schreibt …“, Inhalt in Mitteilungen),
- „Storys erlauben“ und „Haus-Aktionen in Chats“ (beide Standard an), wie lange eine Anfrage offen bleibt, wer Anfragen ohne Namen freigibt, „Kinder dürfen anfragen“,
- **Gruppenchats für GateControl-Gruppen:** Gruppen wählen, für die der Messenger einen Gruppenchat führt. Die Familie-Gruppe führt das Plugin Familie selbst.

Dateien speichert GateControl verschlüsselt (Standard 10 GB insgesamt, 25 MB je Datei). Die Grenzen änderst du unter **Einstellungen › Plugins › Messenger › Übersicht › Medien**. In Sicherungen sind die Dateien nur mit „Plugin-Medien im Backup“.

## Benutzen

- **Chat beginnen:** in der App oder im Portal eine Person oder mehrere wählen.
- **Anhängen:** Datei oder Foto, Standort (Karte, „Mein Standort“), Abstimmung, Termin, Haus-Aktion.
- **Nachricht antippen bzw. Menü:** antworten, reagieren, bearbeiten, löschen, anheften, „Erinnern“, „In Drive speichern“ (nach Meine Dateien › Messenger).
- **Chat-Info:** Mitglieder, geteilte Medien, archivieren, exportieren, blockieren.
- **Status und Storys:** oben in der Liste „Mein Status“; Storys als Text oder Foto.
- **Wo Mitteilungen erscheinen:** in den Einstellungen des Messengers je Thema GateControl, Familien-Chat oder eigener Chat. Gesperrte Themen bleiben immer in GateControl.
- Der angeheftete Eintrag **„GateControl“** ist dein Posteingang von GateControl.

Im Portal öffnen sich Dateien außer Bildern, Ton und Video in den Apps.

## Berechtigungen

- Jedes aktive Konto darf chatten. Kiosk-Geräte (Wand-Tablet) haben keinen Tab „Chats“ und werden nicht als Person angeboten.
- In Gruppenchats für GateControl-Gruppen ändern Mitglieder weder Mitglieder noch Titel und können nicht austreten; Chat-Admins sind die Leitungen der Gruppe.
- Den Familien-Chat als Ziel für Mitteilungen dürfen nur Administratoren und Eltern aus dem Plugin Familie für den Haushalt einstellen.
- Administratoren sehen auf „Übersicht“ und „Protokoll“ nur Zahlen und Fehler – nie Texte, Titel, Dateinamen, Mitglieder oder wer wem schreibt.

## Häufige Fragen / Fehlersuche

**„Nicht gesendet – Schadsoftware gefunden.“**
Der Virenscan von GateControl hat in der Datei etwas gefunden. Gesperrte Dateien zeigen „Datei gesperrt“.

**Eine Datei lässt sich im Portal nicht öffnen.**
Das Portal zeigt nur Bilder, Ton und Video. Andere Dateien öffnest du in der App.

**„Mein Standort“ fragt nicht nach.**
Der Browser erlaubt den Standort im Portal nicht. Setz den Punkt auf der Karte von Hand.

**Ich finde den Familien-Chat nicht.**
Den führt das Plugin Familie (Seite „Funktionen“ › Messenger-Gruppe).

**Alte Nachrichten sind weg.**
Der Administrator hat eine Aufbewahrung eingestellt, oder der Chat ist selbstlöschend.

## Neu in 1.11.1

- Dieses Handbuch im Reiter „Handbuch“ (GateControl ≥ 1.241.0).

Zuletzt in 1.11.0: Der Messenger übernimmt den Virenscan von GateControl – Dateien in Quarantäne werden nicht gesendet, gesperrte Dateien sind nicht abrufbar.
