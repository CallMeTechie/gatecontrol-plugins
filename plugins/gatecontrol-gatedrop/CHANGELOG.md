# GateDrop (gatecontrol-gatedrop)

Teilen wie Quick Share – über den eigenen GateControl-Server.

## 1.0.0
Braucht **GateControl ≥ 1.193.0** (Dateien bis 2 GB, Geräte der Person, stille Mitteilungen, Übergabe von Dateien an
andere Plugins, öffentliche Links). Kostenpflichtig wie die anderen Plugins (Lizenz).
- **Senden an Personen:** als Nachricht der sendenden Person im Messenger (Einzelchat oder Familien-Chat; Dienst
  `send_file` des Messengers ab 1.8.0). In den Chat kommen Dateien bis 25 MB (zusammen höchstens 100 MB je Sendung,
  höchstens 200 Übergaben je Person und Tag); größere – oder Typen, die der Messenger nicht nimmt – bleiben in GateDrop
  (Mitteilung „Anna hat dir … geschickt“, Herunterladen in GateDrop, 7 Tage), die Chat-Nachricht nennt sie („+2 Dateien
  in GateDrop: …“). Lehnt der Messenger ab (Blockierung, kein Mitglied, nur lesen …), schlägt die Zustellung fehl – es
  gibt keinen Umweg. Nur ohne Messenger bekommt die Person alles über GateDrop.
- **Familie:** eine Sendung an „Familie“ sehen nur die, die beim Senden zur Familie gehörten.
- **Senden an eigene Geräte** (Android, Windows): im gemeinsamen WLAN **direkt** (das Plugin vermittelt nur:
  einmaliges Ticket für 10 Minuten, Schlüssel, Adressen – nach Ende der Übertragung gelöscht; die Daten gehen nie über
  den Server), sonst **über den
  Server** mit einer Mitteilung an genau dieses Gerät. Klappt die Direktübertragung nicht, geht es automatisch über den
  Server (liegt die Datei nur auf dem sendenden Gerät, lädt es sie dann hoch).
- **Ablegen im NAS:** in Ordner, die ein Admin im Plugin **NAS (Synology)** ab 1.2.0 für GateDrop freigibt.
- **Link für Externe:** 1 Stunde, 1 Tag, 7 Tage oder 1× herunterladen, auf Wunsch mit 4-stelliger PIN (nach 5
  falschen PINs gesperrt; mit PIN ein allgemeiner Titel „Geteilte Dateien“ statt des Dateinamens); die Seite zum Herunterladen liefert GateControl. **Standardmäßig aus** – ein Admin schaltet
  sie unter Einstellungen › Plugins › GateDrop › Berechtigungen ein. „Link geladen“ als Mitteilung.
- **Wer darf was:** an Personen und eigene Geräte senden alle Konten (keine Kiosk-Geräte); Links und NAS-Ablage nur
  Admins und Eltern aus dem Familie-Plugin (Dienst `family_roles`, Familie ab 1.13.2).
- **Inhalte:** 1–20 Dateien je Sendung (je ≤ 2 GB), Text (≤ 20 000 Zeichen), Link, Notiz. Empfangenes bleibt **7 Tage**
  auf dem Server, danach löscht der Hintergrund die Dateien (der Verlauf bleibt 30 Tage). Speicher gesamt 10 GB
  (änderbar unter Plugins › GateDrop › Übersicht → Medien).
- **Portal-Tab „GateDrop“:** Dateien ziehen, auswählen oder einfügen, Text/Link, Ziele, Senden; aktive Links mit
  „Beenden“; Verlauf (gesendet/empfangen, Herunterladen).
- **Admin-Seite „Übersicht“:** Speicher, Aufbewahrung, aktive Links, Sendungen, Hinweis zum Links-Schalter, was mit
  GateDrop zusammenspielt – keine Inhalte.
- **App-API** für die Android-App und den Windows-Client (Teilen-Blatt, „Geteilt“, Presence, Direktübertragung):
  siehe README.
