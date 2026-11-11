# Changelog

## 1.1.1

- **`GET jobs/<id>` mit den Zeiten des Auftrags:** Die Antwort (und jeder Auftrag in `GET overview` und im Verlauf) nennt zusätzlich `expiresAt` (bis wann GateControl es versucht – 24 Stunden nach dem Auftrag) und `doneAt` (wann er endete: gedruckt, fehlgeschlagen, verfallen, abgebrochen; sonst `null`). Damit können die Apps „wartet bis morgen 14:32“ und „gedruckt um 9:41“ zeigen, ohne die Liste zu laden. Neue Spalten `jobs.expires_at`/`done_at` (Migration 003); Aufträge, die vor 1.1.1 schon beendet waren und die GateControl nicht mehr kennt, haben `doneAt: null`.
- **`updatedAt` ist die letzte Änderung:** Bisher setzte jede Abfrage von `GET jobs/<id>` bei einem offenen Auftrag `updatedAt` auf „jetzt“ – eine App, die alle paar Sekunden fragt, sah nie, seit wann der Auftrag wartet. Jetzt ändert sich `updatedAt` nur noch, wenn sich Zustand, Grund, Meldung oder Seitenzahl geändert haben (Abfrage und Hintergrund nutzen dieselbe Übernahme).
- Tests: Administrator liest jeden Auftrag, eine andere Person keinen (404 `not_found`), unbekannte Nummer, Zeiten bei offen, fehlgeschlagen und abgebrochen.
- Abwärtskompatibel: nur neue Felder; ältere Apps (Android-Druckdienst ab 1.84.0) übergehen sie. Mindestversion von GateControl unverändert.

## 1.1.0

- **Durchsuchbares PDF (Texterkennung):** Beim Speichern eines Scans „Durchsuchbares PDF (Texterkennung)“ – angeboten, wenn ein Gateway mit „Texterkennung für Scans“ erreichbar ist (`gc.print.ocrAvailable`). Das Plugin startet `gc.print.ocr` (GateControl ≥ 1.247.0, Gateway ≥ 1.33.0 mit tesseract, Deutsch + Englisch), die Sitzung wartet im Zustand `ocr` (Fortschritt „Seite 1 von 3“); fertig, legt sie das durchsuchbare PDF ins Drive und gibt den erkannten Text an `save_file` (`text` – Drive nimmt ihn in seine Suche, ab Drive 1.23.0; ein älteres Drive übergeht ihn). Scheitert die Texterkennung (zu lange, Gateway aus, keins erreichbar), wird das normale PDF abgelegt und die Sitzung sagt warum (`searchable: false`, `ocrError`). Der Hintergrund führt das weiter, auch wenn niemand die Seite offen hat; „Verwerfen“ bricht die Texterkennung ab. Verlauf: „durchsuchbar“.
- **Office- und Text-Dateien drucken:** `media.types` um `text/plain` und docx, xlsx, pptx, odt, ods, odp, rtf erweitert. GateControl ≥ 1.247.0 macht Text selbst zu PDF und gibt Office-Dateien an Drucker, deren Gateway sie umwandelt (`printer.office` – „Office-Dateien drucken“); sonst die neuen Codes `office_off` und `office_missing` (409) mit eigenem Text. Das Portal nimmt die Dateien an (auch ohne Typ nach der Endung) und sagt vorher, wenn der gewählte Drucker sie nicht drucken kann. Die Seitenzahl übernimmt der Hintergrund vom Gateway (nach dem Umwandeln), für die Tagesgrenze zählt vorher die Zahl der Datei oder 1.
- **Papier und Fach:** `POST print { media?, source? }` – nur, was der Drucker nennt (`printer.media` in der Übersicht, sonst `invalid`); Portal: „Papier“ (A4, A5, Letter, Foto 10 × 15 cm …) und „Fach“ (Hauptfach, Fotofach …), sobald es mehr als eine Wahl gibt. Neue Spalten `jobs.media`/`source` (Migration 002).
- **Zustand beim Drucken:** Hält der Drucker an, steht der Grund beim Auftrag („Papier fehlt – bitte nachlegen“, „Klappe offen“, „Papierstau“ …), „wird in ein PDF umgewandelt (Office-Datei)“ während der Umwandlung; neue Fehlertexte `office_failed`, `office_timeout`, Wartegrund `office_starting`. Der Hintergrund übernimmt jetzt auch `message` und `pages`.
- **`GET jobs/<id>`** (Person: eigene, Administrator: alle) – der Auftrag frisch von GateControl (`gc.print.job`), für die Apps (Android-Druckdienst).
- Mit älterem GateControl (ohne `gc.print.ocr`, ohne `printer.media`) bleibt alles wie in 1.0.3; Office-Dateien lassen sich dann hochladen, aber nicht drucken (`format`).

## 1.0.3

- **PDF an Drucker ohne PDF:** Viele Tintenstrahler (z. B. HP OfficeJet Pro 8720) nehmen per AirPrint/IPP kein PDF an, nur ihre Rasterformate. Bisher kam beim Drucken – auch aus dem Android-Druckdienst – „Diese Datei kann der Drucker nicht drucken. Es gehen PDF-Dateien und Bilder“, obwohl es ein PDF war. Mit GateControl ≥ 1.243.0 und einem Gateway ≥ 1.30.0 wandelt das Gateway das PDF jetzt beim Drucken passend um (PWG-Raster, URF oder JPEG); das Plugin braucht dafür nichts Neues.
- **Der echte Grund statt „Es gehen PDF-Dateien und Bilder“:** `ERR_PRINT_FORMAT` wird nach `e.reason` (GateControl ≥ 1.243.0, bei älteren nach der Meldung) zu eigenen Codes mit eigenem Text: `format` (keine PDF-Datei und kein Bild – nur dann der alte Hinweis, jetzt mit „keine Office- oder Textdateien“), `damaged` (Datei beschädigt), `gateway_update` (Drucker ohne PDF, Gateway zu alt zum Umwandeln), `convert_off` (Umwandeln am Gateway ausgeschaltet), `printer_format` (Drucker nennt kein Format zum Umwandeln). Alle mit Status 409.
- Neue Gründe im Verlauf und in „Druck fehlgeschlagen“: `convert_failed` (PDF ließ sich nicht umwandeln – beschädigt oder mit Kennwort), `convert_too_large`; während das Gateway umwandelt, steht beim Auftrag „wird für den Drucker umgewandelt“.
- Portal: Die Art einer hochgeladenen Datei zählt nach ihrem Inhalt – ein PDF, das das Handy ohne Typ oder unter einem Namen ohne „.pdf“ liefert, geht als PDF hoch statt abgelehnt zu werden.

## 1.0.2

- Handbuch im Reiter „Handbuch“ (GateControl ≥ 1.241.0): `HANDBUCH.md` / `HANDBOOK.md` im Paket, in `plugin.json` unter `handbook`. Ältere GateControl-Versionen ignorieren es; die Mindestversion bleibt `>=1.236.0`.
- Einrichtungshinweis (`setupNotices`, GateControl ≥ 1.241.0) `gateway-print`: bleibt stehen, solange ein Gateway mit „Drucken & Scannen“ älter als 1.24.0 ist.
- README: „Teilen › Mit GateControl drucken“ steht nicht mehr unter „Noch nicht“ – das geht seit 1.0.1 (Android-App ab 1.84.0).

## 1.0.1

- **Drucken aus den Apps:** Das Plugin ist jetzt für die GateControl-Apps freigegeben (`permissions.app`). Damit funktionieren der Android-Druckdienst „GateControl“ im System-Druckdialog und „Teilen › Mit GateControl drucken“ – mit und ohne VPN, der Auftrag läuft über den Server und das Gateway zu Hause. Ohne diese Freigabe antwortete GateControl den Apps mit 404.
- Die Druckerliste für Personen nennt zusätzlich die Dokumentformate des Druckers (`printer.formats`), damit die Apps PDF oder JPEG passend wählen.

## 1.0.0

Erste Fassung von „Drucken & Scannen“ (GateControl ≥ 1.236.0, Gateway ≥ 1.24.0 mit „Drucken & Scannen“ unter Gateways › Funktionen).

- **Geräte** (Admin): die Drucker und Scanner, die die Gateways im Heimnetz finden (AirPrint/AirScan – IPP/eSCL), mit Ort, Adresse, Farbe, beidseitig, Einzug, Zustand (bereit/Standby/nicht erreichbar) und Tintenstand („Magenta fast leer“); „Neu suchen“, „Testseite“, ein geändertes Gerätezertifikat bestätigen.
- **Berechtigungen** je Person: drucken ja/nein, scannen ja/nein, Seiten am Tag, nur schwarz-weiß – serverseitig vor jedem Auftrag geprüft. Administratoren dürfen immer alles; Kinder der Familie (GateControl-Gruppe „Familie“) standardmäßig 20 Seiten am Tag, nur schwarz-weiß; alle anderen ohne Grenze.
- **Portal (Handy):** Scannen – Scanner, Quelle (Einzug/Glas), Art (Dokument s/w 300 dpi / Foto), Vorschau der Seiten, „Weitere Seite“, Seite entfernen, „Speichern“ als ein PDF ins Drive (Mein Drive › Scans je Person oder Familie › …), mit „Mit KI benennen und einsortieren“ Name und Ordner von Drives KI (`suggest_folder`, die erste Seite als Bild). Drucken – Datei vom Gerät hochladen (PDF, Bilder), Drucker, Kopien, Farbe, beidseitig, „Zu Hause drucken“; ist der Drucker aus, wartet der Auftrag bis zu 24 Stunden; die eigenen letzten Aufträge mit Zustand und „Abbrechen“.
- **Verlauf** (Admin): gedruckt, gescannt, wartend – mit Person und Gerät.
- **Mitteilungen:** „Druck fertig“ / „Druck fehlgeschlagen“ an die Person (abschaltbar).
- Nicht in 1.0.0: Texterkennung (durchsuchbares PDF), „Teilen › GateControl drucken“ in den Apps, Office-Dateien.
