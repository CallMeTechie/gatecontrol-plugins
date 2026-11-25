# Changelog

## 1.0.0

Neues Plugin **Medien** (eigene Lizenz, nicht im GateControl-Plan oder einer Lifetime-Lizenz enthalten). Mindestversion
**GateControl 1.301.0**; mit GateControl ≥ 1.322.0 Widerruf sofort über den Hook `devicesChanged`.

- **Quellen zentral im Server** (Einstellungen › Plugins › Medien › Quellen): Jellyfin-Server (Zugriffsziel `jellyfin`,
  API-Schlüssel als Geheimnis, Prüfung von Erreichbarkeit, Version ≥ 10.9, Schlüssel, Quick Connect und Bibliotheken,
  „In Jellyfin einschalten“ für Quick Connect) und NAS-Freigaben als SMB/WebDAV-Paar oder einzeln (Lese-Benutzer, Passwort
  als Geheimnis, WebDAV nur HTTPS, Zertifikat zum Anheften, Prüfung per WebDAV über das Zugriffsziel `webdav`,
  „Passwort ersetzen“ verteilt das neue Passwort).
- **Personen** (Reiter Personen): Recht „Medien“ je Person und Gruppe, Zuordnung zu Jellyfin-Benutzern automatisch per
  Name, von Hand, „bewusst ohne“ oder „In Jellyfin anlegen“; Jellyfin-Administratoren werden nie angeboten. Sicht je
  Quelle, „Personen oder Gruppen wählen …“; Kinder der Familie sehen NAS-Freigaben nur mit der Einstellung.
- **Geräte ohne Eingabe**: Ablauf A – das Gerät startet Quick Connect mit der DeviceId des Plugins, das Plugin bestätigt den
  Code mit dem API-Schlüssel für den verknüpften Benutzer (Spike M0: Jellyfin 10.9.11, 10.10.7, 10.11.11). Reiter Geräte
  mit „Abmelden“; Widerruf löscht das Gerät in Jellyfin und schickt eine stille Mitteilung `media.revoke`.
- **Netz-Regel**: zu Hause direkt im Heimnetz, unterwegs nur über VPN; Ausnahme „Unterwegs ohne VPN erlauben“ je Quelle oder
  für alle mit einer HTTPS-Adresse für unterwegs (`away` in `v1/sources`), Heimnetz-Erkennung über `network.home.probes`.
- **App-API v1** (README): `sources`, `sources/{id}/secret`, `jellyfin/pair`, `jellyfin/paired`, `jellyfin/device`,
  `shares/{id}/checked`, `sources/{id}/report`, Cast (`cast/targets`, `cast/{session}/message`, `handoff`) für
  „Auf TV/PC abspielen“ nach dem Cast-Vertrag; Ereignisse `media.changed`, `media.cast`, Signal `media.revoke`.
- Abgleich alle 5 Minuten (entfernte Geräte, Rechte, Zuordnungen, Jellyfin-Versionen), Protokoll ohne Geheimnisse,
  Handbuch DE/EN.
