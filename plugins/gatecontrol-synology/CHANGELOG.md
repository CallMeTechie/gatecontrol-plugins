# NAS (Synology) (gatecontrol-synology)

Synology-NAS überwachen und steuern (DSM Web API) als GateControl-Plugin – nur für Administratoren.

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
