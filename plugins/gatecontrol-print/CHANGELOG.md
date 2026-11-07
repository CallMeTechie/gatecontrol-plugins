# Changelog

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
