# NAS (Synology) (gatecontrol-synology)

Synology-NAS überwachen und steuern (DSM Web API) als GateControl-Plugin – nur für Administratoren.

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
