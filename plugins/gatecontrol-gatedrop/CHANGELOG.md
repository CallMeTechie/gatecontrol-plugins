# GateDrop (gatecontrol-gatedrop)

Teilen wie Quick Share – über den eigenen GateControl-Server.

## 1.1.0
- **Senden an ausgeschaltete Geräte:** ist das eigene Gerät beim Senden offline (z. B. der Windows-PC ist aus), klappt
  das Senden trotzdem – die Dateien bleiben auf dem Server, die Zustellung steht auf **„Wartet, bis „Büro-PC“ online
  ist“** (Status `waiting`, kein Fehler) und die Mitteilung geht wie bisher raus (GateControl stellt sie zu, sobald das
  Gerät wieder da ist). Sobald das Gerät wieder online ist, holt es die Dateien **automatisch**: die Apps fragen den neuen
  Endpunkt `GET pending` ab (alles, was über den Server an dieses Gerät ging und dort noch nicht als empfangen gemeldet
  ist; danach „zugestellt“). Mit `POST sends/<id>/opened` meldet das Gerät den Empfang, dann verschwindet die Sendung aus
  der Liste. Direktübertragung im WLAN weiterhin nur an Geräte, die online sind.
- **Portal:** ausgeschaltete Geräte lassen sich auswählen, mit dem Hinweis „offline · kommt an, sobald es online ist“;
  das Ergebnis nach dem Senden zeigt „Wartet, bis „<Gerät>“ online ist“.
- **„Geöffnet“ je Gerät:** eine Zustellung an ein Gerät markiert nur dieses Gerät selbst als geöffnet – das Öffnen im
  Portal oder auf einem anderen Gerät nimmt dem Gerät die Sendung nicht mehr weg.
- **App-API:** `GET pending`, Zustellstatus `waiting` – siehe README.

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
