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

## Was es kann

| Wo | Was |
|---|---|
| Admin › Geräte | gefundene Drucker/Scanner mit Ort, Adresse, Farbe, beidseitig, Einzug, Zustand und Tintenstand; „Neu suchen“, „Testseite“, ein geändertes Gerätezertifikat bestätigen |
| Admin › Berechtigungen | je Person drucken, scannen, Seiten am Tag (0 = keine Grenze), nur schwarz-weiß. Administratoren immer alles; Kinder der Familie (GateControl-Gruppe „Familie“, Rolle Kind) standardmäßig 20 Seiten/Tag, nur s/w; alle anderen ohne Grenze |
| Admin › Verlauf | gedruckt, gescannt, wartend – mit Person, Gerät und Grund |
| Admin › Einstellungen | Ziel der Scans (Mein Drive › Ordner je Person oder Familie › Ordner), KI an/aus, Mitteilungen, Aufbewahrung |
| Portal (Handy) | Scannen: Quelle (Einzug/Glas), Art (Dokument s/w 300 dpi, Foto), Vorschau, „Weitere Seite“, Seite entfernen, KI-Vorschlag für Name und Ordner, „Speichern“ als ein PDF. Drucken: Datei hochladen (PDF, Bilder), Drucker, Kopien, Farbe, beidseitig, „Zu Hause drucken“ – wartet bis zu 24 h, wenn der Drucker aus ist |
| Mitteilungen | `print_done` „Druck fertig“, `print_failed` „Druck fehlgeschlagen“ (Portal-Aufträge, an die Person) |

Die Rechte prüft der Server des Plugins vor jedem Auftrag und Scan; der Browser
entscheidet nichts. Die Seitenzahl eines PDFs zählt GateControl (`gc.print.pages`),
gezählt werden Seiten × Kopien der Aufträge des Tages, die nicht fehlgeschlagen
oder abgebrochen sind.

## API (Portal, `/api/v1/portal/plugins/gatecontrol-print/api/…`)

| Aufruf | Antwort |
|---|---|
| `GET overview` | `{ rights, pagesLeft, printers, scanners, drive, ai, target, jobs, scan, defaultName }` – Geräte ohne Adresse |
| `POST print { deviceId, mediaId, copies, color, duplex, name }` | `{ job, pagesLeft }` – `mediaId` aus `GC.upload` |
| `POST jobs/<id>/cancel` | `{ canceled }` |
| `POST scan { deviceId, source, mode }` | `{ scan }` – eine Scan-Sitzung |
| `GET scan/<id>` | `{ scan: { pages: [{ n, thumb }], scanning, error, suggestion } }` |
| `POST scan/<id>/more { source, mode }` | weitere Seite in dieselbe Sitzung |
| `POST scan/<id>/suggest` | `{ suggestion: { name, where, folderId } \| null }` |
| `POST scan/<id>/save { name? }` | `{ scan: { savedName, savedWhere } }` |
| `POST scan/<id>/remove-page { n }`, `POST scan/<id>/discard` | |

Fehlercodes: `invalid`, `forbidden`, `no_right`, `not_found`, `limit` (mit
`left`, `pages`), `format` (keine PDF-Datei und kein Bild), `damaged` (Datei
beschädigt), `gateway_update` / `convert_off` / `printer_format` (Drucker ohne
PDF: Gateway zu alt zum Umwandeln, Umwandeln am Gateway aus, kein Format zum
Umwandeln), `busy`, `no_drive`, `no_pages`, `scan_running`, `cert_changed`,
`too_large`, `offline`, `print_failed`, `drive_failed`. Die Format-Codes
kommen aus `ERR_PRINT_FORMAT` und dessen `e.reason` (GateControl ≥ 1.242.0;
bei älteren aus der Meldung).

## Drucker ohne PDF

Viele Tintenstrahler (z. B. HP OfficeJet Pro 8720) nennen per IPP kein
`application/pdf`. Mit GateControl ≥ 1.242.0 und einem Gateway ≥ 1.29.0
wandelt das Gateway PDF-Dateien für sie beim Drucken um (PWG-Raster, URF oder
JPEG, passend zu Auflösung, Farbe, Papier und beidseitig); `printer.convert`
in `gc.print.devices()` nennt das Zielformat. Schaltbar je Gateway (Gateways ›
Funktionen › „Drucken & Scannen“ › „PDF für Drucker ohne PDF umwandeln“).
Während das Gateway umwandelt, hat der Auftrag `state: 'sending'`,
`message: 'converting'`; misslingt es, `failed` mit `convert_failed` bzw.
`convert_too_large`.

## Noch nicht

Texterkennung (durchsuchbares PDF), Office-Dateien (Word, Excel – nur PDF und
Bilder).

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
GateControl ≥ 1.242.0 and a gateway ≥ 1.29.0 the gateway converts it, and a
refused file names the real reason (gateway too old, converting off, no
suitable format, damaged) instead of “PDF files and pictures work”. Not yet:
OCR, Office files.
