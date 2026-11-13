# NAS (Synology) (gatecontrol-synology)

Synology-NAS überwachen und steuern (DSM Web API) als GateControl-Plugin – nur für Administratoren.

## 1.2.3

- **Noch weniger Schreibvorgänge:** Im Protokoll vom 12./13.11. war das Speichern des Standes (`INSERT INTO snapshots … ON CONFLICT … DO UPDATE`) weiterhin der langsame Schreibvorgang des Plugins (32 Warnungen in 24 Stunden, bis 5,2 s). 1.2.2 speicherte den Stand und die Abfragezeiten alle 5 Minuten – je 240 bis 288 Mal am Tag und NAS –, obwohl sich fast nur die Live-Werte änderten (CPU, RAM, Temperaturen, Laufzeit, belegte Bytes). Der Stand selbst ist klein (rund 2 kB); teuer ist jeder einzelne Schreibvorgang, nicht seine Größe.
  - Der neueste Stand und die Abfragezeiten liegen im Arbeitsspeicher und werden zuerst gelesen: Seite, Apps (Widget, Kacheln, Schnellaktionen) und Benachrichtigungen sehen wie bisher jede Abfrage.
  - Gespeichert wird der Stand **sofort**, wenn sich mehr als die Live-Werte ändert – Modell/DSM-Version, Zustand von Volume, Speicherpool oder Laufwerk, Hyper-Backup-Aufgaben, DSM-Update, USV-Zustand, alles, was die Seite als Problem markiert (Schwellen aus den Einstellungen: Speicher fast voll, Laufwerk zu heiß), oder ein Volume/Pool um einen ganzen Prozentpunkt voller oder leerer –, sonst **einmal je Stunde** und **beim Beenden** des Plugins.
  - Die Abfragezeiten allein (`last_attempt_at`, `last_success_at`, `next_poll_at`) lösen keinen Schreibvorgang mehr aus; sie werden mit dem nächsten Schreiben der Zeile (Status, Fehler, Neustart, Update-Prüfung alle 6 Stunden) und beim Beenden gespeichert.
  - Nach einem Neustart steht der gespeicherte Stand mit seiner eigenen Abrufzeit da (nie neuer, als er ist; Live-Werte höchstens eine Stunde alt, Zustand und markierte Probleme aktuell), die nächste Abfrage ist sofort fällig. „Aktualisiert“ und „Zuletzt erreichbar“ nehmen die neuere Zeit aus Zeile und gespeichertem Stand. Der erste Abruf nach dem Start schreibt nur, wenn sich etwas geändert hat.
  - Benachrichtigungen unverändert: sie werden aus der Abfrage selbst ausgewertet, ihr Zustand (`notify.state`) wird wie bisher nur bei Änderung gespeichert. Einen Verlauf speichert das Plugin nicht.
- Keine Migration, keine neue Mindestversion (`>=1.193.0`).
- Tests (`writes.test.js`): ein simulierter Tag (720 Abfragen alle 2 Minuten, wechselnde Live-Werte, ein Backup-Lauf, wachsendes Volume) – 24 Schreibvorgänge für den Stand und 3 für die NAS-Zeile statt 240 + 240; Live-Werte allein schreiben nichts, jede wesentliche Änderung sofort; Neustart (Absturz und reguläres Beenden); Benachrichtigungen bei der Abfrage, die es sieht.

## 1.2.2

- **Weniger Schreibvorgänge:** der Stand eines NAS (Snapshot) und seine Abfragezeiten (`last_attempt_at`, `last_success_at`, `next_poll_at`) werden höchstens alle 5 Minuten gespeichert; der neueste Stand liegt im Speicher und wird zuerst gelesen. Ein Fehler, ein neuer Status oder ein Neustart wird sofort gespeichert. Vorher zwei Schreibvorgänge je Abfrage (im Protokoll von GateControl 1.253.5 je ~400 ms auf einem langsamen Datenträger).
- Tests: `due()` setzt `next_poll_at` über den Store (die Zeiten liegen zwischen zwei Schreibvorgängen im Speicher); eine Stunde Abfragen jede Minute speichert Snapshot und Zeiten je höchstens 13 Mal statt 60 (`writes.test.js`).

## 1.2.1

- Handbuch im Reiter „Handbuch“ (GateControl ≥ 1.241.0): `HANDBUCH.md` / `HANDBOOK.md` im Paket, in `plugin.json` unter `handbook`. Ältere GateControl-Versionen ignorieren es; die Mindestversion bleibt `>=1.193.0`.

## 1.2.0
Braucht **GateControl ≥ 1.193.0** (Dateien bis 2 GB von anderen Plugins übernehmen, Upload zum NAS). Neu beim
Aktualisieren: Dateispeicher (nur übergebene Dateien, keine eigenen Uploads) und zwei Dienste für andere Plugins.
- **Ablage für GateDrop:** Auf der Plugin-Seite unter „Einstellungen“ gibt ein Admin NAS-Ordner frei („Ablage für
  GateDrop“: NAS, Pfad wie in der File Station, z. B. `/Familie/Fotos`, Name). Nur in diese Ordner (und Unterordner, die
  bei Bedarf angelegt werden) darf GateDrop Dateien ablegen; wer das darf, entscheidet GateDrop (Admins und Eltern).
  Admin-API `POST /drop-folders`, `PUT`/`DELETE /drop-folders/:id`, `GET /status` → `drop_folders`. Wird ein NAS
  entfernt, verschwinden seine Ordner; ein ausgeschaltetes NAS bietet keine an.
- **Dienste** (nur für `gatecontrol-gatedrop`): `list_drop_folders {}` → `[{ id, label, path }]`; `save_file { user,
  folderId, mediaId, name, path }` → `{ ok: true, path, nasId }` (genau der gewählte Ordner, `path` muss darin liegen;
  ohne `folderId` nur, wenn genau ein Ordner passt) – die von GateDrop übergebene Datei wird mit
  `SYNO.FileStation.Upload` hochgeladen (GateControl streamt sie direkt zum NAS, `gc.net.uploadTarget`); ein schon
  vorhandener Name wird zu „name (2).ext“. Danach wird die übergebene Kopie gelöscht. Fehler `forbidden`, `invalid`,
  `not_found`, `nas_disabled`, `unsupported`, `unreachable`, `auth`, `permission`, `no_space`, `upload_failed`. Das
  DSM-Konto braucht Schreibrecht im Ordner.

## 1.1.0
- **Schnellaktionen und Widget in den GateControl-Apps** (nur für GateControl-Administratoren;
  alle anderen sehen nichts): je NAS ein Gerät mit
  - **„Aktualisieren“** – fragt das NAS sofort ab und trägt das **NAS-Widget**: großer Wert
    „Speicher belegt“ (alle Volumes zusammen, in %), daneben CPU, RAM und Temperatur (gelb bei
    CPU/RAM ab 90 % bzw. bei der Temperaturwarnung von DSM), oben rechts der **Zustand** als
    Schild (grün/gelb/rot wie auf der Plugin-Seite) und als Statuszeile das wichtigste Problem
    („Speicherpool 1 beeinträchtigt“, „Nicht erreichbar“ …) oder „Alles in Ordnung“. Antwortet
    das NAS nicht, bleibt die letzte bekannte Belegung stehen, CPU/RAM/Temperatur entfallen.
  - **„Backup jetzt“** – je Hyper-Backup-Aufgabe (bei mehreren mit dem Namen der Aufgabe, höchstens
    vier je NAS), **„Neustart“** und **„Herunterfahren“** – die App fragt vorher nach. Sie laufen
    über dieselben Prüfungen wie die Plugin-Seite (NAS aktiv, Aufgabe bekannt) und stehen im
    Plugin-Protokoll mit dem Weg („von admin (App)“, „von admin (Regel)“ für die Regel eines
    anderen Plugins); Neustart/Herunterfahren senden wie bisher die Meldung „NAS neu gestartet /
    heruntergefahren“. Fehler von DSM kommen als verständliche Antwort in der App an. Einschalten
    eines heruntergefahrenen NAS ist weiterhin nicht möglich – deshalb kann eine **Regel** das NAS
    nie herunterfahren (nur per Hand in der App); Neustart und Backup gehen auch per Regel.
- **Startkachel in den Apps** je NAS: „62 % belegt“ mit Speicher, Temperatur und Zustand; Farbe
  nach dem Zustand. Dafür bekommt das Plugin die Portal-Berechtigung und einen Portal-Bereich
  „NAS (Synology)“, der nur die Kacheln der Apps trägt – im Web-Portal erscheint nichts.
- Widget-Schild ab GateControl 1.175.0, Geräte-Gruppierung ab 1.172.0, Widget ab 1.171.0,
  Startkacheln in den Apps ab 1.169.0, Schnellaktionen ab 1.159.0; ältere Versionen lassen das
  Unbekannte weg. Das Plugin läuft weiter ab GateControl 1.154.0.

## 1.0.0
- **Mehrere NAS** über das Zugriffsziel „Synology-NAS (DSM)“ (GateControl-Route, VPN-Peer oder
  Adresse; HTTP). Je NAS ein DSM-Konto – Benutzername, Passwort und Geräte-Token werden als
  Plugin-Geheimnisse verschlüsselt gespeichert und nie an den Browser gegeben.
- **Anmeldung** über SYNO.API.Auth (Version 6, DSM 6.0 bis 7.2) mit Sitzungs-ID und SynoToken;
  die Sitzung wird zwischen den Abfragen weiterverwendet, bei abgelaufener Sitzung (106/107/119,
  105) einmal neu angemeldet. **2-Faktor:** einmal den Bestätigungscode eingeben – DSM vergibt
  ein Geräte-Token („GateControl“), spätere Anmeldungen brauchen keinen Code. Nach einem
  Anmeldefehler pausiert die Abfrage (DSM sperrt Adressen nach wiederholten Fehlanmeldungen).
- **Status:** Modell, DSM-Version, Laufzeit, Temperatur (SYNO.DSM.Info, Ersatz SYNO.Core.System),
  CPU/RAM (SYNO.Core.System.Utilization), Volumes, Speicherpools und Laufwerke mit
  S.M.A.R.T.-Zustand und Temperatur (SYNO.Storage.CGI.Storage, Ersatz SYNO.Core.System
  type=storage), DSM-Update (SYNO.Core.Upgrade.Server, alle 6 Stunden), Hyper-Backup-Aufgaben
  (SYNO.Backup.Task) und USV (SYNO.Core.ExternalDevice.UPS), soweit vorhanden.
- **Steuerung:** Neu starten, Herunterfahren (mit ausdrücklicher Bestätigung) und Hyper Backup
  „Jetzt sichern“; jede Aktion steht im Plugin-Protokoll, Neustart/Herunterfahren zusätzlich im
  Aktivitätsprotokoll (Thema „NAS neu gestartet / heruntergefahren“).
- **Hintergrund:** Abfrage je NAS im eingestellten Intervall (Vorgabe 120 s), nach Fehlern
  wachsender Abstand (höchstens 15 Minuten); die letzten guten Daten bleiben sichtbar.
- **Benachrichtigungen:** NAS nicht erreichbar (nach N Fehlversuchen, Vorgabe 3; nicht während
  eines hier angeforderten Neustarts/Herunterfahrens), Volume/Speicherpool beeinträchtigt oder
  abgestürzt, Speicher fast voll (Vorgabe 90 %), Laufwerk Warnung/Ausfall, Laufwerk zu heiß
  (Vorgabe 55 °C), DSM-Update verfügbar (einmal je Version), Hyper Backup fehlgeschlagen – mit
  Fakten (NAS, Volume, Belegung, Laufwerk, Modell …). Beim ersten Sehen wird nichts gemeldet, ein
  Neustart von GateControl wiederholt nichts.
- **Seite:** NAS-Karten mit Status, Belegungsbalken, Laufwerksübersicht und Hinweisen;
  Detailansicht mit Volumes, Pools, Laufwerkstabelle, Sicherungen und USV; Dialog zum
  Hinzufügen/Bearbeiten mit „Verbindung testen“ (Modell, DSM-Version, Administratorrechte);
  Einstellungen (Intervall, Schwellen, Sprache der Benachrichtigungen).
- **HTTPS:** GateControl prüft Zertifikate immer; das selbstsignierte DSM-Zertifikat wird erkannt
  und die Lösung angezeigt (Route über ein Heim-Gateway mit HTTPS zum Backend, DSM per HTTP auf
  Port 5000 im VPN/LAN oder ein gültiges Zertifikat).
