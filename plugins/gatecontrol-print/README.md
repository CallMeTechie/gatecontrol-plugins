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
`left`, `pages`), `format`, `busy`, `no_drive`, `no_pages`, `scan_running`,
`cert_changed`, `too_large`, `offline`, `print_failed`, `drive_failed`.

## Noch nicht

Texterkennung (durchsuchbares PDF), „Teilen › GateControl drucken“ in den
Apps, Office-Dateien (Word, Excel – nur PDF und Bilder), PDF an Drucker ohne
PDF-Unterstützung (Rasterung).

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
when the printer is off. Not yet: OCR, “Share › Print with GateControl” in the
apps, Office files.
