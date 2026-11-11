<!-- version: 1.1.1 -->
# Drucken & Scannen

## Was das Plugin kann

- Die **Drucker und Scanner bei dir zu Hause** von überall nutzen – ohne sie ins Internet zu stellen. Die Aufträge laufen über GateControl und ein Gateway im Heimnetz.
- **Scannen** vom Handy aus: vom Glas oder aus dem Einzug, mit Vorschau, mehreren Seiten und Ablage als ein PDF im Drive – auf Wunsch **durchsuchbar** (Texterkennung) und von der KI benannt und einsortiert.
- **Drucken** von PDFs, Bildern, Text- und Office-Dateien (Word, Excel, PowerPoint, OpenDocument, RTF): Drucker, Kopien, Farbe, beidseitig, Papier und Fach. Ist der Drucker aus, wartet der Auftrag bis zu 24 Stunden.
- **Drucken aus den GateControl-Apps:** in Android der Druckdienst „GateControl“ im Druckdialog und „Teilen › Mit GateControl drucken“.
- **Rechte je Person:** drucken, scannen, Seiten am Tag, nur schwarz-weiß.
- **Übersicht der Geräte** mit Zustand und Tintenstand, Testseite und Verlauf.

## Voraussetzungen

- GateControl **1.236.0** oder neuer.
- Ein Gateway **1.24.0** oder neuer im Heimnetz der Drucker. An der Compose-Datei des Gateways ändert sich nichts.
- Drucker und Scanner mit **AirPrint** bzw. **AirScan** (IPP/eSCL). Das können fast alle Geräte seit etwa 2015. Ältere Geräte ohne diese Funktion erscheinen nicht.
- Für Drucker, die kein PDF annehmen (z. B. HP OfficeJet Pro 8720): GateControl **1.243.0** und ein Gateway **1.30.0** oder neuer – das Gateway wandelt PDF-Dateien dann selbst um.
- Für **Texterkennung**, **Office-Dateien** und **Papier/Fach**: GateControl **1.247.0** und ein Gateway **1.33.0** oder neuer; am Gateway „Texterkennung für Scans“ bzw. „Office-Dateien drucken“ eingeschaltet (siehe [Einrichten](#einrichten)). Text-Dateien gehen auch ohne „Office-Dateien drucken“.
- Zum Drucken aus der Android-App: die GateControl-App **1.84.0** oder neuer.
- Für Scans: das Plugin **Drive**. Ohne Drive kannst du drucken, aber keine Scans ablegen.
- Für „Mit KI benennen und einsortieren“: ein KI-Anbieter in GateControl.

## Einrichten

1. **Gateway aktualisieren:** **Gateways** › dein Gateway › „Update auf …“, bis es mindestens 1.24.0 hat.
2. **Einschalten:** **Gateways** › dein Gateway › **Funktionen** › „Geräte im Heimnetz“ › **„Drucken & Scannen“**.
3. **Geräte prüfen:** im Plugin auf der Seite **„Geräte“**. Nach etwa einer Minute stehen dort die Drucker und Scanner, die das Gateway gefunden hat – mit Ort, Adresse, Farbe, beidseitig, Einzug, Zustand und Tintenstand. **„Neu suchen“** sucht sofort noch einmal, **„Testseite“** druckt eine Probe. Am Drucker selbst musst du nichts einrichten.
4. **Rechte festlegen** auf der Seite **„Berechtigungen“** (siehe [Berechtigungen](#berechtigungen)).
5. **Texterkennung und Office-Dateien** (Gateway ab 1.33.0): **Gateways** › dein Gateway › **Funktionen** › „Drucken & Scannen“ › **„Texterkennung für Scans (durchsuchbare PDFs)“** und/oder **„Office-Dateien drucken“** anhaken. Für Office-Dateien lädt das Gateway einmal einen Zusatzdienst mit LibreOffice (≈ 200 MB, ≈ 700 MB auf dem Datenträger); was zu tun ist, steht dort in der Zeile. Die Texterkennung ist schon im Gateway.
6. **Scans ablegen** auf der Seite **„Einstellungen“**: Ziel im Drive – „Mein Drive › Ordner“ (je Person) oder „Familie › Ordner“ – und ob die KI Name und Ordner vorschlagen soll. Dazu die Mitteilungen und wie lange der Verlauf aufbewahrt wird.

## Benutzen

### Scannen (Portal, am Handy)

1. Im Portal den Tab **„Drucken & Scannen“** öffnen › **„Scannen“**.
2. Scanner, **Quelle** (Einzug für mehrere Seiten oder Glas) und **Art** (Dokument s/w 300 dpi oder Foto in Farbe) wählen.
3. **„Scannen“**. Die Seite erscheint als Vorschau. **„Weitere Seite“** hängt die nächste an, eine falsche Seite entfernst du wieder.
4. Mit KI schlägt das Plugin Name und Ordner vor, z. B. „2026-11-06 Stadtwerke Rechnung.pdf“ nach „Finanzen › Strom“. Du kannst den Namen ändern.
5. Auf Wunsch **„Durchsuchbares PDF (Texterkennung)“** anhaken – das steht da, wenn ein Gateway mit Texterkennung erreichbar ist.
6. **„Speichern“** legt alle Seiten als ein PDF im Drive ab. Mit Texterkennung steht kurz „Texterkennung läuft – Seite 1 von 3“; du kannst die Seite schließen, das PDF kommt trotzdem ins Drive. Der erkannte Text liegt unsichtbar im PDF und geht mit ins Drive – dort findest du das Dokument über seinen Inhalt. Klappt die Texterkennung nicht, wird das normale PDF abgelegt und die Meldung sagt, warum.

Für den KI-Vorschlag geht die erste Seite als Bild an den KI-Anbieter von GateControl – nur, wenn GateControl Bilder an die KI erlaubt.

### Drucken

- **Portal:** Tab „Drucken & Scannen“ › **„Drucken“** › Datei hochladen (PDF, Bild, Text oder Office-Datei) › Drucker, Kopien, Farbe, beidseitig, **Papier** (A4, A5, Letter, Foto 10 × 15 cm …) und **Fach**, soweit der Drucker sie nennt › **„Zu Hause drucken“**. Deine letzten Aufträge stehen darunter, mit Zustand („Papier fehlt“, „Klappe offen“ …) und „Abbrechen“.
- **Android-App:** im Druckdialog einer App den Drucker „GateControl“ wählen, oder eine Datei über **„Teilen › Mit GateControl drucken“**. Das geht mit und ohne VPN.

Ist der Drucker aus, wartet der Auftrag bis zu 24 Stunden und druckt, sobald er wieder da ist.

### Mitteilungen

„Druck fertig“ und „Druck fehlgeschlagen“ an die Person, die gedruckt hat. Abschaltbar auf „Einstellungen“ und in den Mitteilungs-Einstellungen von GateControl.

## Berechtigungen

Auf der Seite **„Berechtigungen“** je Person: **Drucken**, **Scannen**, **Grenze** (Seiten am Tag, 0 = keine) und **nur s/w**.

- **Administratoren** dürfen immer alles.
- **Kinder der Familie** (GateControl-Gruppe „Familie“, Rolle Kind) drucken ohne Änderung höchstens 20 Seiten am Tag und nur schwarz-weiß.
- **Alle anderen** drucken und scannen ohne Grenze.

Gezählt werden Seiten × Kopien der Aufträge des Tages, die nicht fehlgeschlagen oder abgebrochen sind. Der Server prüft die Rechte vor jedem Auftrag und Scan. **„Zurücksetzen“** stellt die Voreinstellung einer Person wieder her.

## Häufige Fragen / Fehlersuche

**Auf „Geräte“ steht nichts.**
Ist „Drucken & Scannen“ am Gateway eingeschaltet und das Gateway online? Warte eine Minute oder klicke „Neu suchen“. Das Gerät muss AirPrint/AirScan können und im selben Netz wie das Gateway sein.

**„Kein Gateway mit „Drucken & Scannen“ ist gerade erreichbar.“**
Das Gateway ist offline oder die Funktion ist aus. Prüfe es unter Gateways.

**Bei einem Gerät steht „Zertifikat geändert“.**
Das Gerät meldet sich mit einem anderen Sicherheitszertifikat, etwa nach einem Firmware-Update. Klicke „Neues Zertifikat bestätigen“ nur, wenn du das Gerät kennst und nichts ausgetauscht wurde.

**Ein Druck wird abgelehnt.**
Die Tagesgrenze der Person ist erreicht oder sie darf nur schwarz-weiß drucken. Ändere es auf „Berechtigungen“.

**Scans lassen sich nicht speichern.**
Das Plugin „Drive“ fehlt oder läuft nicht.

**Word- oder Excel-Dateien gehen nicht.**
Dafür muss am Gateway des Druckers „Office-Dateien drucken“ eingeschaltet sein (Gateway ab 1.33.0) – die Meldung sagt, was fehlt:
- „… erst, wenn ein Administrator „Office-Dateien drucken“ … einschaltet“: **Gateways** › dein Gateway › **Funktionen** › „Drucken & Scannen“ › „Office-Dateien drucken“.
- „… der Office-Dienst des Gateways läuft aber noch nicht“: Beim ersten Mal lädt das Gateway den Dienst (ein paar Minuten). Steht in der Zeile am Gateway „… brauchen einmalig die aktuelle Compose-Datei“, dort „docker-compose.yml herunterladen“ und übernehmen.
- Ältere Word-Formate (.doc, .xls, .ppt) gehen nicht – speichere die Datei als .docx/.xlsx/.pptx oder PDF.

**„Durchsuchbares PDF“ fehlt beim Scannen.**
Kein Gateway mit Texterkennung ist gerade erreichbar, oder sie ist nirgends eingeschaltet (**Gateways** › **Funktionen** › „Drucken & Scannen“ › „Texterkennung für Scans“, Gateway ab 1.33.0).

**„Gespeichert … – ohne Texterkennung“.**
Die Texterkennung hat zu lange gedauert oder das Gateway war nicht erreichbar. Das PDF liegt trotzdem im Drive, nur ohne Text. Auf einem Raspberry Pi 3 oder Zero dauert eine Seite etwa eine Minute.

**Papier oder Fach lässt sich nicht wählen.**
Angeboten wird nur, was der Drucker selbst meldet (Gateway ab 1.33.0). Nennt er nichts, druckt er auf seinem Standardpapier.

**Ein PDF wird abgelehnt: „Dieser Drucker nimmt keine PDF-Dateien direkt an …“.**
Manche Drucker (z. B. HP OfficeJet Pro 8720) nehmen über das Netz kein PDF an. Das Gateway wandelt PDF-Dateien für sie um – der Text sagt, was fehlt:
- „… ab Version 1.30.0 …“: **Gateways** › dein Gateway › „Update auf …“ (und GateControl aktuell halten).
- „… Umwandeln ist am Gateway ausgeschaltet“: **Gateways** › dein Gateway › **Funktionen** › „Drucken & Scannen“ › „PDF für Drucker ohne PDF umwandeln“ einschalten.
- „… nennt kein Format, in das das Gateway sie umwandeln kann“: Der Drucker kann weder PWG-Raster noch URF noch JPEG. Bilder gehen, PDF-Dateien nicht.

**Im Verlauf steht „Die PDF-Datei ließ sich für den Drucker nicht umwandeln“.**
Das PDF ist beschädigt oder mit einem Kennwort geschützt. Öffne es am Handy oder PC und speichere bzw. drucke es dort als neues PDF.

**Ein Auftrag steht lange auf „wird für den Drucker umgewandelt“.**
Das Gateway rechnet die Seiten für den Drucker um. Auf einem Raspberry Pi 3 oder Zero dauert das bei großen PDF-Dateien ein paar Minuten.

## Neu in 1.1.1

- **Zeiten beim Auftrag:** Jeder Auftrag nennt jetzt, bis wann GateControl es versucht (24 Stunden nach dem Auftrag) und wann er endete. Die Apps können damit „wartet bis morgen 14:32“ oder „gedruckt um 9:41“ zeigen.
- Für die Apps: `GET jobs/<id>` liefert zusätzlich `expiresAt` und `doneAt`; `updatedAt` ist die letzte Änderung des Auftrags und ändert sich nicht mehr durch bloßes Nachfragen. Eigene Aufträge, Administratoren alle.
- Am Portal und an den Rechten ändert sich nichts; ältere Apps arbeiten unverändert weiter.

## Neu in 1.1.0

- **Durchsuchbares PDF:** Beim Scannen „Durchsuchbares PDF (Texterkennung)“ anhaken – ein Gateway erkennt den Text (Deutsch und Englisch), das PDF im Drive ist durchsuchbar und der Text geht mit in die Suche des Drive. Klappt es nicht, wird das normale PDF abgelegt.
- **Office- und Text-Dateien drucken:** Word, Excel, PowerPoint, OpenDocument und RTF, wenn am Gateway „Office-Dateien drucken“ an ist; Text-Dateien immer. Die Seitenzahl steht nach dem Umwandeln im Verlauf.
- **Papier und Fach** wählen – A4, A5, Letter, Fotopapier – soweit der Drucker sie nennt.
- **Der echte Zustand beim Drucken:** „Papier fehlt“, „Klappe offen“, „Papierstau“ … beim Auftrag; die Android-App zeigt ihn im Druckdialog.
- Für die Apps: `GET jobs/<id>` liefert einen Auftrag mit seinem aktuellen Zustand.
- Alles braucht GateControl 1.247.0 und ein Gateway ab 1.33.0; mit älteren bleibt alles wie in 1.0.3.

## Neu in 1.0.3

- **PDF an Drucker ohne PDF** (z. B. HP OfficeJet Pro 8720): Mit GateControl 1.243.0 und einem Gateway ab 1.30.0 wandelt das Gateway das PDF beim Drucken passend um – aus dem Portal, dem Android-Druckdienst und „Teilen“.
- Statt „Es gehen PDF-Dateien und Bilder“ steht jetzt der echte Grund da: Gateway zu alt, Umwandeln aus, Drucker ohne passendes Format, Datei beschädigt – der alte Hinweis nur noch bei Dateien, die wirklich kein PDF und kein Bild sind.
- Beim Auftrag steht „wird für den Drucker umgewandelt“, solange das Gateway umwandelt.
- Ein PDF, das das Handy ohne Dateityp oder ohne „.pdf“ im Namen liefert, geht trotzdem als PDF hoch.

Davor in 1.0.2: dieses Handbuch im Reiter „Handbuch“ und ein Hinweis, solange ein Gateway mit „Drucken & Scannen“ älter als 1.24.0 ist.
