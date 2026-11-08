<!-- version: 1.12.1 -->
# Mail

## Was das Plugin kann

- **Alle E-Mail-Konten an einem Ort:** GMX, WEB.DE, T-Online, Gmail, Outlook.com, Microsoft 365 oder jedes andere IMAP-Konto – in der GateControl-App und im Portal-Tab „Mail“.
- **Ein gemeinsamer Posteingang** („Alle Posteingänge“), aufgeteilt in **Relevant** und **Sonstige**. Push bei neuer Mail.
- **Schutz vor Zählpixeln:** Bilder aus dem Internet lädt Mail erst nach „Bilder laden“ oder „Immer von diesem Absender“.
- **Senden** mit „Rückgängig“ (10 Sekunden) und „Später senden“.
- **Anhänge in Drive** speichern und aus Drive anhängen.
- **KI** über den KI-Anbieter von GateControl: „Kurz gesagt“, „Zu tun“ und Antwortvorschläge.
- **Kalender:** eigene GateControl-Kalender, die Kalender der Konten (Microsoft 365, CalDAV wie GMX oder WEB.DE, Gmail nur lesend), Einladungen, Erinnerungen; Termine aus Familie und Alltag und Geburtstage eingeblendet.
- **Kontakte:** ein Adressbuch mit den Kontakten der Konten, Gruppen und Dubletten-Abgleich.
- **Frei/Gebucht, geteilte Kalender und Ressourcen** (ab 1.9.0): Termine mit anderen planen, Kalender teilen, Räume, Fahrzeuge und Geräte buchen.

## Voraussetzungen

- GateControl **1.219.0** oder neuer (der Reiter „Ressourcen“ und Buchungsanfragen per E-Mail ab 1.225.0).
- Eine **Lizenz** mit Plätzen für Personen (Familie oder Business).
- Für Anhänge in Drive: das Plugin Drive ab 1.15.0. Für die KI: ein KI-Anbieter in GateControl.
- Für Outlook.com und Microsoft 365: die Microsoft-Anmeldung (die Registrierung des Herstellers ist voreingestellt).

## Einrichten

### Als Administrator

Unter **Einstellungen › Plugins › Mail › Einstellungen**:

1. **Wer Mail nutzen darf:** alle oder ausgewählte Personen und Gruppen. Jede erlaubte Person bekommt beim ersten Öffnen einen Platz der Lizenz, solange Platz ist. Die Karte **„Personen und Lizenz“** zeigt „x von y Personen“ und jede Person mit ihrem Platz.
2. **Konten je Person** (1–20), **Aufbewahrung** (1/3/6/12/24 Monate oder alles), **Anhänge** (bei Bedarf laden oder immer bis 10 MB) und **Speicher je Person** (1–100 GB).
3. **KI** (Leiste „Kurz gesagt“, Sortieren, automatisches Ablegen in Drive), **Kalender** und **Kontakte** ein- oder ausschalten.
4. **Microsoft:** die voreingestellte Registrierung oder eine eigene Client-ID. Blockiert eure Firma die Zustimmung durch Benutzer, öffnet der Microsoft-Admin den Freigabe-Link auf dieser Seite.
5. **Speicherorte** (optional): Wo die Anhänge liegen, wählst du unter **Einstellungen › Plugins › Mail › Übersicht › Speicherorte** – dieser Server oder ein Speicherziel (NAS, S3, OneDrive, Google Drive).
6. **Ressourcen** (optional): Reiter **„Ressourcen“** – Räume, Fahrzeuge, Geräte mit Name, Art, Standort, Plätzen, wer buchen darf, automatischer Zusage oder Freigabe und Regeln.

Administratoren sehen nur Zahlen – nie die Mails, Termine oder Kontakte anderer.

### Als Person: Konto hinzufügen

Im Portal-Tab **„Mail“** (oder in der App) › Einstellungen › **„Konto hinzufügen“** und den Anbieter wählen:

- **GMX / WEB.DE:** erst im Webmail unter Einstellungen › POP3/IMAP-Abruf den Zugriff per IMAP erlauben, dann E-Mail und Passwort.
- **T-Online:** das E-Mail-Passwort aus dem Telekom-Kundencenter, nicht das Passwort deines Telekom-Logins.
- **Gmail:** ein **App-Passwort** – Bestätigung in zwei Schritten einschalten, dann unter myaccount.google.com › Sicherheit › App-Passwörter eins erstellen.
- **Outlook.com / Microsoft 365:** Anmeldung bei Microsoft. Im Portal zeigt Mail einen Code, den du auf der Seite von Microsoft eingibst. GateControl sieht dein Passwort nie.
- **Anderes Konto (IMAP):** Server und Zugangsdaten deines Anbieters.

Die Zugangsdaten werden verschlüsselt gespeichert. Die erste Synchronisierung holt die neuesten Mails zuerst.

## Benutzen

### Mails

- **Relevant / Sonstige:** Newsletter und automatische Mails landen meist in „Sonstige“, Mails von Leuten, denen du schreibst, in „Relevant“. Ordnest du einen Absender um, merkt sich Mail das.
- **Unterhaltungen und Filter:** Mit „Mit Anhang“ (oder in Relevant/Sonstige) steht eine Unterhaltung mit ihrer neuesten Mail, die zum Filter passt.
- **Lesen:** Bilder erst nach „Bilder laden“. Anhänge mit **„In Drive speichern“** (mit Vorschlag für den Ordner) oder „Alle in Drive speichern“.
- **Schreiben:** „Senden“ geht nach 10 Sekunden raus – bis dahin „Rückgängig“. „Später senden“ plant die Mail. Ist der Server nicht erreichbar, versucht Mail es dreimal; danach kommt die Mitteilung „Eine Mail konnte nicht gesendet werden“.
- **KI:** „Kurz gesagt“ fasst zusammen, „Zu tun“ findet Aufgaben, dazu Antwortvorschläge. Einen Punkt aus „Zu tun“ antippen › **„Erledigt“** hakt ihn ab (durchgestrichen), „Wieder offen“ nimmt das zurück.
- **„Notizen & Aufgaben“** (wenn installiert): die Punkte aus „Zu tun“ und deine markierten Mails stehen dort in „Mein Tag“ bzw. bei den Aufgaben – Mails geschäftlicher Konten unter „Arbeit“. Dort abhaken erledigt den Punkt in Mail bzw. entfernt die Markierung der Mail; antippen öffnet die Mail.

### Kalender und Kontakte

- **Kalender:** Tag, Woche, Monat, Liste; Termine anlegen, ändern, löschen; Einladungen beantworten (die Karte in der Mail). Erinnerungen kommen als Push.
- **Frei/Gebucht:** Im Termin zeigt Mail je Person und Ressource frei oder gebucht – nie Titel – und **„Vorschläge, bei denen alle können“** in deiner Arbeitszeit.
- **Arbeitszeit:** im Portal unter Kalender › Kalender-Einstellungen, in den Apps unter Mail › Einstellungen › Kalender – die Arbeitstage und „Von“/„Bis“ (Standard Mo–Fr 8–18 Uhr). Vorschläge kommen nur aus dieser Zeit.
- **Teilen:** im Menü eines eigenen Kalenders „Teilen“ mit Personen oder Gruppen – Frei/Gebucht, Lesen oder Bearbeiten. Mit dir Geteiltes steht unter „Mit mir geteilt“. Ist ein Kalender mit dir auf „Bearbeiten“ geteilt, kannst du dort auch neue Termine anlegen (ohne Teilnehmer).
- **Ressource buchen** im Kalender oder „Ressource hinzufügen“ im Termin. Mit Freigabe geht eine Anfrage an die Freigebenden; sie sehen sie unter „Anfragen“.
- **Kontakte:** Suche, Gruppen, Dubletten zusammenführen, vCard-Import und -Export, „Als Kontakt speichern“ aus einer Mail.

### Mitteilungen

Neue Mail, Mail nicht gesendet, Termin-Erinnerung, Einladung, geteilter Kalender, Buchungsanfrage, Zusage oder Absage einer Buchung. Jede Person schaltet die Themen in den Mitteilungs-Einstellungen von GateControl ab.

Buchungsanfragen sowie Zusagen und Absagen kommen ab GateControl 1.225.0 auch per E-Mail an die Adresse deines GateControl-Kontos. Abschalten kannst du das je Thema mit **„Auch per E-Mail“**: im Portal unter Benachrichtigungen und in den Apps unter Einstellungen › Benachrichtigungen.

## Berechtigungen

- Mail nutzt nur, wen der Administrator erlaubt und wer einen Platz der Lizenz hat. Ohne Platz zeigt das Portal „Mail ist für dich noch nicht freigeschaltet“.
- Jede Person sieht nur ihre eigenen Konten, Mails, Kalender und Kontakte – und was andere mit ihr teilen.
- Private Termine sind bei jeder Freigabe „gebucht“. Frei/Gebucht schaltet jede Person in ihren Mail-Einstellungen ab.
- Ressourcen buchen nur die Personen und Gruppen, die der Administrator einträgt.

## Häufige Fragen / Fehlersuche

**GMX oder WEB.DE lehnt die Anmeldung ab.**
Erlaube im Webmail unter Einstellungen › POP3/IMAP-Abruf den Zugriff per IMAP.

**Gmail lehnt das Passwort ab.**
Gmail braucht ein App-Passwort statt deines normalen Passworts.

**„Die Microsoft-Anmeldung ist noch nicht eingerichtet“.**
Der Administrator richtet sie unter Einstellungen › Plugins › Mail › Einstellungen ein.

**Für mein Microsoft-Konto fehlen die Rechte für Kalender und Kontakte.**
Melde dich noch einmal bei Microsoft an. Erlaubt eure Firma das nur dem Microsoft-Admin, gib ihm den Freigabe-Link weiter.

**„Notizen & Aufgaben“ sagt „Microsoft braucht noch deine Zustimmung“.**
Dort unter „Umziehen › Microsoft To Do“ auf „Bei Microsoft zustimmen“ tippen und den Code eingeben. Blockiert eure Firma die Zustimmung durch Benutzer, gibt der Microsoft-Admin `Tasks.ReadWrite` über den Freigabe-Link frei.

**Ein Anhang lässt sich gerade nicht öffnen.**
Liegen die Anhänge auf einem Speicherziel, das nicht erreichbar ist, versucht Mail es später erneut.

**Frei/Gebucht zeigt „unbekannt“.**
Die Person hat Frei/Gebucht abgeschaltet oder ist nicht in GateControl. Kolleginnen in Microsoft 365 erscheinen über dein Microsoft-Konto.

## Neu in 1.12.1

- **Weniger Schreibarbeit beim Kalenderabgleich mit Microsoft 365:** Mail schreibt Termine und Ordner nur noch, wenn sich wirklich etwas geändert hat. Auf einem langsamen Datenträger (NAS mit Festplatten) bleibt GateControl dadurch flüssiger.

## Neu in 1.12.0

- **Umzug von Microsoft To Do:** „Notizen & Aufgaben“ kann deine Aufgaben aus Microsoft To Do übernehmen – über dein Microsoft-Konto in Mail. Microsoft fragt dazu einmal nach deiner Zustimmung (Code auf microsoft.com/devicelogin). „Notizen & Aufgaben“ bekommt nur Zugang zu deinen Aufgaben, nie zu deinen Mails. Deine Mails laufen dabei normal weiter.
- Eigene Microsoft-Registrierung: sie braucht zusätzlich die Berechtigung `Tasks.ReadWrite` (steht auf der Admin-Seite).

## Neu in 1.11.0

- **„Zu tun“ abhaken:** Punkte aus „Zu tun“ lassen sich als erledigt markieren.
- **„Notizen & Aufgaben“:** Mit dem Plugin „Notizen & Aufgaben“ stehen „Zu tun“ und markierte Mails dort und lassen sich dort abhaken. Ohne das Plugin ändert sich nichts.

## Neu in 1.10.1

- **Schneller bei großen Postfächern:** Mail liest für den belegten Speicher und den Hintergrundabgleich nicht mehr alle gespeicherten Mails. Der erste Start nach dem Update bereitet das einmal vor – bei sehr vielen Mails dauert das bis zu einer Minute.
- **„Mit Anhang“** in der Unterhaltungsansicht zeigt jetzt jede Unterhaltung mit einem Anhang, auch wenn die letzte Antwort keinen hat.

Zuletzt in 1.10.0: die **Arbeitszeit** im Portal einstellen (Kalender-Einstellungen). In 1.9.1: dieses Handbuch im Reiter „Handbuch“ (GateControl ≥ 1.241.0). In 1.9.0: Frei/Gebucht mit Terminvorschlägen, geteilte GateControl-Kalender und buchbare Ressourcen (Räume, Fahrzeuge, Geräte).
