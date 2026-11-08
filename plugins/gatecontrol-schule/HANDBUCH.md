<!-- version: 1.8.0 -->
# Schule

## Was das Plugin kann

- Den **Stundenplan aus WebUntis** in GateControl – für Schüler- und Elternkonten, je Kind in seiner Farbe: auf der Seite „Schule“, im Portal, am Wand-Tablet der Familie und in der App.
- **Push bei Änderungen:** Ausfälle, Vertretungen, Zusatzstunden und „findet doch statt“ für heute und die nächsten Tage.
- **Arbeiten und Hausaufgaben** mit Erinnerung am Vorabend.
- **Nachrichten der Schule** mit Volltext und Anhängen, Lesebestätigung, und **Fehlzeiten** aus dem Klassenbuch.
- **Anhänge in Drive** speichern – von Hand oder automatisch.
- **Startkachel und Widget** je Kind.
- Mit dem Plugin **Familie:** Regeln mit „Stunde fällt aus“, Hinweis bei frühem Schluss zum Abholen, „Schule heute“ am Wand-Tablet.
- Mit dem Plugin **„Notizen & Aufgaben“:** Hausaufgaben und Arbeiten jedes Kindes in „Mein Tag“ – Hausaufgaben dort abhaken.

> **Hinweis:** Das Plugin nutzt die **inoffizielle Schnittstelle der WebUntis-Web-App** – ohne Gewähr. Untis unterstützt das nicht; es kann sich jederzeit ändern, und die Schule kann Zugriffe einschränken. Das Plugin ist kein Angebot der Untis GmbH.

## Voraussetzungen

- GateControl **1.216.0** oder neuer.
- Ein **WebUntis-Konto** der Schule: Schülerkonto oder Elternkonto.
- Für Anhänge in Drive: das Plugin Drive ab 1.4.0.
- Für Regeln, Abholen und Wand-Tablet: das Plugin Familie (ab 1.12.0 bzw. 1.13.0).

## Einrichten

Alles Einrichten steht unter **Einstellungen › Plugins › Schule › Einstellungen** („Konten & Kinder“).

### Schritt 1: QR-Code in WebUntis finden

WebUntis im Browser öffnen und mit dem Konto des Kindes oder dem Elternkonto anmelden. Dann meist unten links auf das **Profil** (Name) › Reiter **„Freigaben“** › bei **„Zugriff über Untis Mobile“** auf **„Anzeigen“**. Je nach Schule und Version heißt das etwas anders. WebUntis zeigt einen QR-Code.

### Schritt 2: Konto hinzufügen

**„WebUntis-Konto hinzufügen“** und eine der drei Arten wählen:

- **„QR-Code scannen“** – GateControl öffnet seinen Kamera-Dialog und liest den QR-Code vom Bildschirm. Das Bild bleibt in GateControl.
- **„QR-Bild hochladen“** – ein Screenshot oder Foto des QR-Codes.
- **„Manuell eingeben“** – Server (z. B. `xyz.webuntis.com`), Schule, Benutzer und den Schlüssel unter dem QR-Code oder das Passwort des Kontos.

Das Plugin meldet sich einmal an und zeigt die gefundenen Schüler: Ein Schülerkonto ist der Schüler selbst, ein Elternkonto liefert seine Kinder. Den Zugang kannst du in WebUntis jederzeit wieder entziehen.

### Schritt 3: Kinder einstellen

Unter **„Kinder“** je Kind **„Bearbeiten“**: Anzeigename (z. B. „Lena“), der **GateControl-Benutzer des Kindes** (optional), **Farbe**, **weitere Empfänger** (z. B. die Eltern), **„Am Wand-Tablet zeigen“** und an/aus.

### Schritt 4: Einstellungen

Zeitzone der Schule, Abrufintervall (Standard 15 Minuten), Sprache der Mitteilungen, Push für die nächsten … Tage, **Ruhezeit** (Standard 21:00–06:00), **Erinnerung am Vorabend** (Standard 18:00, leer = aus), „Fehlzeiten auch dem Kind melden“ (Standard aus), „Benutzer dürfen ihr WebUntis-Konto selbst verknüpfen“ (Standard an) und „Anhänge von Schulnachrichten automatisch in Drive ablegen“ (Standard aus).

### Eigenes Schülerkonto im Profil verknüpfen

Jede angemeldete Person kann ihr **eigenes Schülerkonto** selbst verknüpfen: im Portal unter **„Meine Geräte“** › Abschnitt **„WebUntis“** – QR-Code scannen, Bild hochladen oder eingeben. Elternkonten richtet ein Administrator ein.

## Benutzen

- **Seite und Portal-Tab „Schule“:** je Kind eine Karte (heute von–bis, Ausfälle, nächste Arbeit), darunter die Woche Mo–Fr (auf dem Handy Tag für Tag) und die Listen **Änderungen**, **Klassenarbeiten**, **Hausaufgaben**, **Nachrichten** und **Fehlzeiten**. Ausfälle sind rot durchgestrichen, Vertretungen orange.
- **Nachrichten:** Antippen öffnet den ganzen Text mit Anhängen. **„In Drive speichern“** legt einen Anhang in Drive ab (ohne gewählten Ordner im Familienbereich unter „Schule › Kind“). Bittet die Schule um eine Lesebestätigung, gibt es **„Lesen bestätigen“** – das geht erst nach einer Rückfrage an die Schule.
- **App:** Stundenplan, Nachrichten und Fehlzeiten, Startkachel „Schule · Name“ und ein Widget je Kind.
- **„Notizen & Aufgaben“** (wenn installiert): die Hausaufgaben und Arbeiten jedes Kindes stehen dort für das Kind und die Empfänger. Eine Hausaufgabe abhaken (Kind oder Eltern) gilt auch in Schule – sie ist dann überall erledigt, die Erinnerung am Vorabend fällt weg. Was WebUntis schon als erledigt meldet, lässt sich nicht zurücknehmen. Arbeiten zeigt der Hub nur an.
- **Mitteilungen:** Stundenplan-Änderungen, Klassenarbeiten, Hausaufgaben, Nachrichten der Schule, Fehlzeiten. Erkanntes in der Ruhezeit kommt an ihrem Ende. Der erste Abruf legt nur den Stand fest und meldet nichts.

## Berechtigungen

- **Administratoren** sehen alle Schüler (Push nur, wenn sie als Empfänger eingetragen sind).
- Das **zugeordnete Kind** und die **Empfänger** sehen „ihre“ Schüler – im Portal, in der Kachel, im Widget und in der App.
- **Kiosk-Geräte** (Wand-Tablet) sehen nur Schüler mit „Am Wand-Tablet zeigen“ – keine Nachrichten und keine Fehlzeiten.
- **Andere Personen** sehen nichts, auch kein Portal-Besuch, der nur über Geräte-Vertrauen erkannt ist.
- **Nachrichten** eines Elternkontos lesen Administratoren und die Empfänger – nicht das Kind. **Fehlzeiten** sehen Administratoren, die Empfänger und das Kind.

## Häufige Fragen / Fehlersuche

**Ich finde den QR-Code in WebUntis nicht.**
Er steht meist unter Profil › „Freigaben“ › „Zugriff über Untis Mobile“. Manche Schulen schalten das ab; dann geht „Manuell eingeben“ mit Benutzer und Passwort.

**„Klassenarbeiten sind für dieses Konto in WebUntis nicht freigegeben“.**
Die Schule gibt das für dieses Konto nicht frei. Der Stundenplan läuft trotzdem; das Plugin schaut einmal am Tag wieder nach. Dasselbe gilt für Nachrichten.

**Die Anmeldung wird abgelehnt.**
Prüfe den Zugang mit „Zugang ändern“, z. B. mit einem neuen QR-Code. Nach Fehlanmeldungen versucht das Plugin es seltener, damit WebUntis das Konto nicht sperrt.

**Es kommen keine Mitteilungen.**
Ist das Kind einem GateControl-Benutzer zugeordnet oder sind Empfänger eingetragen? Läuft gerade die Ruhezeit? Die Diagnose unter „Konten & Kinder“ zeigt die letzten Abrufe und Fehler.

**Anhänge landen nicht in Drive.**
Drive muss installiert sein, und die Person braucht einen Drive-Zugang. Für das automatische Ablegen braucht ein Empfänger des Kindes einen Drive-Zugang und eine Familie in Drive.

## Neu in 1.8.0

- **Hausaufgaben und Arbeiten in „Notizen & Aufgaben“:** Mit dem Plugin „Notizen & Aufgaben“ stehen sie dort für das Kind und die Eltern; Hausaufgaben lassen sich dort abhaken und gelten dann auch in Schule als erledigt.
- Braucht jetzt GateControl 1.216.0.

## Neu in 1.7.2

- Dieses Handbuch im Reiter „Handbuch“ (GateControl ≥ 1.241.0).

Zuletzt in 1.7.1 und 1.7.0: Anhänge von Schulnachrichten in Drive speichern (auch automatisch) und eine genauere Protokollzeile bei Abruffehlern.
