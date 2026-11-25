# Changelog

## 1.1.0

Mindestversion **GateControl 1.324.0** (neue Host-API `window.GC.targets`, Berechtigung
`permissions.network.assignTargets`).

- **Einrichtung an einer Stelle:** Der Dialog „Jellyfin-Server hinzufügen/bearbeiten“ hat statt der Auswahl eines
  zugewiesenen Zugriffsziels jetzt **„Erreichbar über“** mit den Routen und VPN-Peers von GateControl. Beim Speichern
  (und bei „Prüfen“) weist Medien das Zugriffsziel `jellyfin` selbst zu. Eine vorhandene gleiche Zuweisung wird
  wiederverwendet, eine neue angehängt, der Index anderer Quellen ändert sich nie. Ebenso **„WebDAV prüfen über“** bei
  NAS-Freigaben (Ziel `webdav`, optional). Zuweisungen am Ende der Liste, die keine Quelle mehr nutzt, entfernt Medien nach
  dem Bearbeiten oder Entfernen einer Quelle wieder.
- **Vorbelegung:** Heimnetz-Adresse aus dem Ziel der Route (z. B. `http://192.168.2.151:8096`, nicht bei Peer-Routen), HTTPS-Adresse
  für unterwegs aus der Domain der Route (`https://<Domain>`). Beides überschreibbar.
- „Zugriffsziele öffnen“ entfällt. Der Knopf öffnete die Einstellungen im Dialog und blockierte die Seite. Der Hinweistext
  ist ersetzt.
- **Rückwärts:** Bestehende Zuweisungen und `targetIndex` der Quellen bleiben gültig. Eine von Hand zugewiesene Adresse
  erscheint unter „Bereits zugewiesen“. Ohne `GC.targets` bleibt die bisherige Auswahl.
- Handbuch: „Zugriffsziele“, „Jellyfin hinzufügen“, „NAS-Freigabe“, „Neu in 1.1.0“.

## 1.0.1

Mindestversion unverändert **GateControl 1.301.0**.

- **Heimnetz-Erkennung für jede Quelle** (`network.home.probes` in `v1/sources`): bisher gab es Proben nur für Jellyfin mit
  bekannter Server-ID und WebDAV mit `certSha256` – ohne Probe hielt sich ein Gerät auch zu Hause für unterwegs und ging
  durch das VPN. Neu die Probe-Art `tcp` `{ host, port }` (TCP-Verbindung über die LAN-Schnittstelle) für Jellyfin ohne
  bekannte Server-ID und Freigaben ohne Zertifikat (SMB 445, WebDAV-Port). Jede Probe hat zusätzlich `sourceId` und
  `unique`; höchstens 20, eindeutige zuerst. `jellyfin`/`tls` unverändert, App-API bleibt v1.
- **Jellyfin-Server-ID** wird beim Speichern, Bearbeiten und Prüfen ermittelt und in der Quelle gespeichert (bleibt, wenn
  Jellyfin später nicht erreichbar ist; neue Adresse oder neues Zugriffsziel → neu ermitteln). Fehlt sie, holt der Abgleich
  alle 5 Minuten sie nach und schickt `media.changed`.
- **Admin**: Reiter Quellen mit Zeile „Heimnetz-Erkennung“, Zeichen und Hinweis **„Heimnetz nicht eindeutig“** für Quellen
  ohne eindeutige Probe; ebenso in der Übersicht. Admin-API: `home { level, why, probes }` je Quelle.
- README (App-API, Netz-Regel), Handbuch „Netz“ und „Neu in 1.0.1“.

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
