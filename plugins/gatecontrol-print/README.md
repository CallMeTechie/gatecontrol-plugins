# Drucken & Scannen (`gatecontrol-print`)

Drucker und Scanner zu Hause – von überall über GateControl nutzbar, ohne sie
ins Internet zu stellen. *English below.*

## Voraussetzungen

- GateControl **1.236.0** oder neuer (Host-API `gc.print`, `permissions.print`).
- Ein Heim-Gateway **1.24.0** oder neuer mit **Gateways › Funktionen › „Geräte
  im Heimnetz“ › „Drucken & Scannen“** eingeschaltet. Das Gateway findet die
  Geräte selbst (mDNS, AirPrint/AirScan – IPP/eSCL), druckt und scannt. Es
  läuft im Gateway-Container; an der Compose-Datei ändert sich nichts.
- Für Scans: das Plugin **Drive** (Ablage, „Mit KI benennen und einsortieren“
  über Drives `suggest_folder`).
- Für durchsuchbare PDFs, Office-Dateien und Papier/Fach (1.1.0): GateControl
  **1.246.0** und ein Gateway **1.32.0** mit „Texterkennung für Scans“ bzw.
  „Office-Dateien drucken“ (Gateways › Funktionen › „Drucken & Scannen“).
  Office-Dateien brauchen am Gateway den Zusatzdienst `office` (LibreOffice,
  ≈ 200 MB Download); Text-Dateien gehen ohne.

## Was es kann

| Wo | Was |
|---|---|
| Admin › Geräte | gefundene Drucker/Scanner mit Ort, Adresse, Farbe, beidseitig, Einzug, Zustand und Tintenstand; „Neu suchen“, „Testseite“, ein geändertes Gerätezertifikat bestätigen |
| Admin › Berechtigungen | je Person drucken, scannen, Seiten am Tag (0 = keine Grenze), nur schwarz-weiß. Administratoren immer alles; Kinder der Familie (GateControl-Gruppe „Familie“, Rolle Kind) standardmäßig 20 Seiten/Tag, nur s/w; alle anderen ohne Grenze |
| Admin › Verlauf | gedruckt, gescannt, wartend – mit Person, Gerät und Grund |
| Admin › Einstellungen | Ziel der Scans (Mein Drive › Ordner je Person oder Familie › Ordner), KI an/aus, Mitteilungen, Aufbewahrung |
| Portal (Handy) | Scannen: Quelle (Einzug/Glas), Art (Dokument s/w 300 dpi, Foto), Vorschau, „Weitere Seite“, Seite entfernen, KI-Vorschlag für Name und Ordner, „Speichern“ als ein PDF – auf Wunsch durchsuchbar (Texterkennung, der Text geht mit ins Drive). Drucken: Datei hochladen (PDF, Bilder, Text, Office), Drucker, Kopien, Farbe, beidseitig, Papier und Fach, „Zu Hause drucken“ – wartet bis zu 24 h, wenn der Drucker aus ist; der Zustand nennt Halt-Gründe („Papier fehlt“ …) |
| Mitteilungen | `print_done` „Druck fertig“, `print_failed` „Druck fehlgeschlagen“ (Portal-Aufträge, an die Person) |

Die Rechte prüft der Server des Plugins vor jedem Auftrag und Scan; der Browser
entscheidet nichts. Die Seitenzahl eines PDFs zählt GateControl (`gc.print.pages`),
gezählt werden Seiten × Kopien der Aufträge des Tages, die nicht fehlgeschlagen
oder abgebrochen sind.

## API (Portal, `/api/v1/portal/plugins/gatecontrol-print/api/…`)

| Aufruf | Antwort |
|---|---|
| `GET overview` | `{ rights, pagesLeft, printers, scanners, drive, ai, ocr, target, jobs, scan, defaultName }` – Geräte ohne Adresse; `printers[].printer`: `{ state, color, duplex, copiesMax, formats, office, media: { sizes, default, sources, sourceDefault } }`; `ocr`: ein durchsuchbares PDF geht gerade |
| `POST print { deviceId, mediaId, copies, color, duplex, name, media?, source? }` | `{ job, pagesLeft }` – `mediaId` aus `GC.upload`; `media`/`source` nur aus `printer.media` |
| `GET jobs/<id>` | `{ job }` – frisch von GateControl: `state`, `error`, `message` (Halt-Grund beim Drucken, `converting`, `converting_office`), `pages`, `media`, `source` (eigene Aufträge; Administratoren alle) |
| `POST jobs/<id>/cancel` | `{ canceled }` |
| `POST scan { deviceId, source, mode }` | `{ scan }` – eine Scan-Sitzung |
| `GET scan/<id>` | `{ scan: { pages: [{ n, thumb }], scanning, error, suggestion } }` |
| `POST scan/<id>/more { source, mode }` | weitere Seite in dieselbe Sitzung |
| `POST scan/<id>/suggest` | `{ suggestion: { name, where, folderId } \| null }` |
| `POST scan/<id>/save { name?, useSuggestion?, searchable? }` | `{ scan: { state, savedName, savedWhere, searchable, ocrError, ocr? } }` – mit `searchable` und einem Gateway mit Texterkennung erst `state: 'ocr'` (`ocr: { page, pages }`), `GET scan/<id>` bis `saved` |
| `POST scan/<id>/remove-page { n }`, `POST scan/<id>/discard` | |

Fehlercodes: `invalid`, `forbidden`, `no_right`, `not_found`, `limit` (mit
`left`, `pages`), `format` (keine PDF-Datei, kein Bild, kein Text, keine
Office-Datei), `damaged` (Datei beschädigt), `gateway_update` / `convert_off` /
`printer_format` (Drucker ohne PDF: Gateway zu alt zum Umwandeln, Umwandeln am
Gateway aus, kein Format zum Umwandeln), `office_off` / `office_missing`
(Office-Datei: „Office-Dateien drucken“ am Gateway aus bzw. Dienst läuft noch
nicht), `ocr_unavailable`, `busy`, `no_drive`, `no_pages`, `scan_running`, `cert_changed`,
`too_large`, `offline`, `print_failed`, `drive_failed`. Die Format-Codes
kommen aus `ERR_PRINT_FORMAT` und dessen `e.reason` (GateControl ≥ 1.243.0;
bei älteren aus der Meldung).

## Drucker ohne PDF

Viele Tintenstrahler (z. B. HP OfficeJet Pro 8720) nennen per IPP kein
`application/pdf`. Mit GateControl ≥ 1.243.0 und einem Gateway ≥ 1.30.0
wandelt das Gateway PDF-Dateien für sie beim Drucken um (PWG-Raster, URF oder
JPEG, passend zu Auflösung, Farbe, Papier und beidseitig); `printer.convert`
in `gc.print.devices()` nennt das Zielformat. Schaltbar je Gateway (Gateways ›
Funktionen › „Drucken & Scannen“ › „PDF für Drucker ohne PDF umwandeln“).
Während das Gateway umwandelt, hat der Auftrag `state: 'sending'`,
`message: 'converting'`; misslingt es, `failed` mit `convert_failed` bzw.
`convert_too_large`.

## Durchsuchbare PDFs, Office-Dateien, Papier und Fach (1.1.0)

- **Texterkennung:** `POST scan/<id>/save { searchable: true }` startet
  `gc.print.ocr` (ein Gateway mit tesseract, Deutsch + Englisch); fertig, geht
  das durchsuchbare PDF ins Drive und der Text an `save_file { text }` (Drives
  Suche, ab Drive 1.23.0). Misslingt es, wird das normale PDF abgelegt
  (`searchable: false`, `ocrError`). Der Hintergrund führt wartende Sitzungen
  zu Ende.
- **Office-Dateien und Text:** docx, xlsx, pptx, odt, ods, odp, rtf und
  `text/plain` sind Medientypen des Plugins. Text macht GateControl zu PDF,
  Office-Dateien wandelt das Gateway des Druckers (Dienst `office`), wenn
  `printer.office`; sonst `office_off` / `office_missing`.
- **Papier und Fach:** was der Drucker nennt (`printer.media`), sonst sein
  Standard. Halt-Gründe beim Drucken kommen als `message` (`media-empty`,
  `media-jam`, `door-open` …).

Seit 1.0.1 ist das Plugin für die GateControl-Apps freigegeben
(`permissions.app`): die Android-App (ab 1.84.0) druckt über den Druckdienst
„GateControl“ im System-Druckdialog und über „Teilen › Mit GateControl
drucken“ – mit und ohne VPN.

---

## English

Printers and scanners at home, usable from anywhere through GateControl
without exposing them to the internet. Needs GateControl ≥ 1.236.0, a gateway
≥ 1.24.0 with “Print & scan” switched on (Gateways › Features › “Devices at
home”), and Drive for scans. Admin pages: devices (ink, test page, search
again, confirm a changed certificate), permissions per person (print, scan,
pages per day, black and white only — admins always everything, children of
the family 20 pages a day in b/w by default), history, settings. Portal tab
(phone first): scan from the glass or the feeder with previews, more pages and
the AI's name and folder into Drive as one PDF; print an uploaded PDF or
picture with copies, colour and double-sided — the job waits up to 24 hours
when the printer is off. Since 1.0.1 the GateControl apps may use it
(`permissions.app`): the Android app (1.84.0 or later) prints through the print
service “GateControl” and “Share › Print with GateControl”. Since 1.0.3 a PDF
also prints on printers without PDF (e.g. HP OfficeJet Pro 8720): with
GateControl ≥ 1.243.0 and a gateway ≥ 1.30.0 the gateway converts it, and a
refused file names the real reason (gateway too old, converting off, no
suitable format, damaged) instead of “PDF files and pictures work”. Since
1.1.0 (GateControl ≥ 1.246.0, gateway ≥ 1.32.0): searchable PDFs of scans
(text recognition on a gateway, the text goes to Drive's search), text and
office files (Word, Excel, PowerPoint, OpenDocument, RTF – when “Print office
files” is on at the gateway), paper and tray, the printer's stop reasons, and
`GET jobs/<id>` for the apps.
