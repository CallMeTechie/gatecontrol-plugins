# Changelog

## 1.0.0

Erste Fassung von „Drucken & Scannen“ (GateControl ≥ 1.236.0, Gateway ≥ 1.24.0 mit „Drucken & Scannen“ unter Gateways › Funktionen).

- **Geräte** (Admin): die Drucker und Scanner, die die Gateways im Heimnetz finden (AirPrint/AirScan – IPP/eSCL), mit Ort, Adresse, Farbe, beidseitig, Einzug, Zustand (bereit/Standby/nicht erreichbar) und Tintenstand („Magenta fast leer“); „Neu suchen“, „Testseite“, ein geändertes Gerätezertifikat bestätigen.
- **Berechtigungen** je Person: drucken ja/nein, scannen ja/nein, Seiten am Tag, nur schwarz-weiß – serverseitig vor jedem Auftrag geprüft. Administratoren dürfen immer alles; Kinder der Familie (GateControl-Gruppe „Familie“) standardmäßig 20 Seiten am Tag, nur schwarz-weiß; alle anderen ohne Grenze.
- **Portal (Handy):** Scannen – Scanner, Quelle (Einzug/Glas), Art (Dokument s/w 300 dpi / Foto), Vorschau der Seiten, „Weitere Seite“, Seite entfernen, „Speichern“ als ein PDF ins Drive (Mein Drive › Scans je Person oder Familie › …), mit „Mit KI benennen und einsortieren“ Name und Ordner von Drives KI (`suggest_folder`, die erste Seite als Bild). Drucken – Datei vom Gerät hochladen (PDF, Bilder), Drucker, Kopien, Farbe, beidseitig, „Zu Hause drucken“; ist der Drucker aus, wartet der Auftrag bis zu 24 Stunden; die eigenen letzten Aufträge mit Zustand und „Abbrechen“.
- **Verlauf** (Admin): gedruckt, gescannt, wartend – mit Person und Gerät.
- **Mitteilungen:** „Druck fertig“ / „Druck fehlgeschlagen“ an die Person (abschaltbar).
- Nicht in 1.0.0: Texterkennung (durchsuchbares PDF), „Teilen › GateControl drucken“ in den Apps, Office-Dateien.
