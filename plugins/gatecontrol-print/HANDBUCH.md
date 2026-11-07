<!-- version: 1.0.2 -->
# Drucken & Scannen

## Was das Plugin kann

- Die **Drucker und Scanner bei dir zu Hause** von überall nutzen – ohne sie ins Internet zu stellen. Die Aufträge laufen über GateControl und ein Gateway im Heimnetz.
- **Scannen** vom Handy aus: vom Glas oder aus dem Einzug, mit Vorschau, mehreren Seiten und Ablage als ein PDF im Drive – auf Wunsch von der KI benannt und einsortiert.
- **Drucken** von PDFs und Bildern: Drucker, Kopien, Farbe, beidseitig. Ist der Drucker aus, wartet der Auftrag bis zu 24 Stunden.
- **Drucken aus den GateControl-Apps:** in Android der Druckdienst „GateControl“ im Druckdialog und „Teilen › Mit GateControl drucken“.
- **Rechte je Person:** drucken, scannen, Seiten am Tag, nur schwarz-weiß.
- **Übersicht der Geräte** mit Zustand und Tintenstand, Testseite und Verlauf.

## Voraussetzungen

- GateControl **1.236.0** oder neuer.
- Ein Gateway **1.24.0** oder neuer im Heimnetz der Drucker. An der Compose-Datei des Gateways ändert sich nichts.
- Drucker und Scanner mit **AirPrint** bzw. **AirScan** (IPP/eSCL). Das können fast alle Geräte seit etwa 2015. Ältere Geräte ohne diese Funktion erscheinen nicht.
- Zum Drucken aus der Android-App: die GateControl-App **1.84.0** oder neuer.
- Für Scans: das Plugin **Drive**. Ohne Drive kannst du drucken, aber keine Scans ablegen.
- Für „Mit KI benennen und einsortieren“: ein KI-Anbieter in GateControl.

## Einrichten

1. **Gateway aktualisieren:** **Gateways** › dein Gateway › „Update auf …“, bis es mindestens 1.24.0 hat.
2. **Einschalten:** **Gateways** › dein Gateway › **Funktionen** › „Geräte im Heimnetz“ › **„Drucken & Scannen“**.
3. **Geräte prüfen:** im Plugin auf der Seite **„Geräte“**. Nach etwa einer Minute stehen dort die Drucker und Scanner, die das Gateway gefunden hat – mit Ort, Adresse, Farbe, beidseitig, Einzug, Zustand und Tintenstand. **„Neu suchen“** sucht sofort noch einmal, **„Testseite“** druckt eine Probe. Am Drucker selbst musst du nichts einrichten.
4. **Rechte festlegen** auf der Seite **„Berechtigungen“** (siehe [Berechtigungen](#berechtigungen)).
5. **Scans ablegen** auf der Seite **„Einstellungen“**: Ziel im Drive – „Mein Drive › Ordner“ (je Person) oder „Familie › Ordner“ – und ob die KI Name und Ordner vorschlagen soll. Dazu die Mitteilungen und wie lange der Verlauf aufbewahrt wird.

## Benutzen

### Scannen (Portal, am Handy)

1. Im Portal den Tab **„Drucken & Scannen“** öffnen › **„Scannen“**.
2. Scanner, **Quelle** (Einzug für mehrere Seiten oder Glas) und **Art** (Dokument s/w 300 dpi oder Foto in Farbe) wählen.
3. **„Scannen“**. Die Seite erscheint als Vorschau. **„Weitere Seite“** hängt die nächste an, eine falsche Seite entfernst du wieder.
4. Mit KI schlägt das Plugin Name und Ordner vor, z. B. „2026-11-06 Stadtwerke Rechnung.pdf“ nach „Finanzen › Strom“. Du kannst den Namen ändern.
5. **„Speichern“** legt alle Seiten als ein PDF im Drive ab.

Für den KI-Vorschlag geht die erste Seite als Bild an den KI-Anbieter von GateControl – nur, wenn GateControl Bilder an die KI erlaubt.

### Drucken

- **Portal:** Tab „Drucken & Scannen“ › **„Drucken“** › Datei hochladen (PDF oder Bild) › Drucker, Kopien, Farbe, beidseitig › **„Zu Hause drucken“**. Deine letzten Aufträge stehen darunter, mit Zustand und „Abbrechen“.
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
Gedruckt werden nur PDFs und Bilder. Speichere die Datei vorher als PDF.

## Neu in 1.0.2

- Dieses Handbuch im Reiter „Handbuch“ (GateControl ≥ 1.241.0).
- Ein Hinweis oben auf der Plugin-Seite, solange ein Gateway mit „Drucken & Scannen“ älter als 1.24.0 ist.

Zuletzt in 1.0.1: Drucken aus den GateControl-Apps (Android-Druckdienst „GateControl“, „Teilen › Mit GateControl drucken“).
