# Changelog

## 1.0.0

Erste Version: die Verwaltung des DNS-Schutzes von GateControl für die VPN-Geräte. GateControl (ab 1.264.0) filtert
selbst – ein eigener Filter-Dienst hinter dem DNS des VPN –, dieses Plugin legt fest, was für wen gesperrt wird,
unterbricht den Schutz und zeigt Zähler (`permissions.vpnDns`, `gc.vpnDns`). Ohne das Plugin (oder ohne Lizenz) läuft
der Filter nicht; die Einstellungen bleiben erhalten.

* **Einstellungsseite** (Einstellungen › Plugins › DNS-Schutz › Einstellungen) mit den Reitern
  * **Übersicht** – Zustand (aktiv, unterbrochen, Rückfall), Zähler von heute, Top gesperrte Domains, aktive Listen;
    Unterbrechen für alle VPN-Geräte (5 Min., 30 Min., 1 Std., bis ich wieder einschalte), „+30 Min.“, „Wieder
    einschalten“, im Rückfall „Filter-Dienst neu starten“.
  * **Listen & Ausnahmen** – Listen aus dem Katalog für das Standardprofil, „Jetzt aktualisieren“, „Domain prüfen“
    (für ein Gerät oder Profil, mit „Für alle erlauben“ / „Nur im Profil … erlauben“), „Immer erlaubt“ und „Immer
    gesperrt“.
  * **Profile** – Listen, Sichere Suche, Zeiten, eigene Einträge und Mitglieder (Gruppen, Personen, Geräte); Gerät
    schlägt Person schlägt Gruppe schlägt Standard; „Mitglieder dürfen unterbrechen“ je Profil.
  * **Geräte** – alle VPN-Geräte mit wirksamem Profil und Zählern, Hinweis auf Geräte mit eigenem DNS-Server,
    „Profil ändern“ (eigenes Profil, ganz ausnehmen), Unterbrechung eines Geräts beenden.
  * **Protokoll** – Abfrageprotokoll ein/aus (Standard aus), Aufbewahrung, wer es sehen darf, Suche und Filter,
    „Erlauben“ / „Sperren“ aus einer Zeile, „Protokoll leeren“.
  * **Einstellungen** – Schutz aus-/einschalten, „Weiterleiten an“ (Quad9, Cloudflare, eigener Dienst, DNS-Server
    des Servers) mit Rückfall, wer in der App unterbrechen darf (nur Admins, alle, je Profil), längste Dauer,
    „Bis ich wieder einschalte“ für Benutzer, Mitteilungen.
* **Einrichten und Umzug von Pi-hole** – ein Dialog in vier Schritten beim ersten Aufruf: erkennt eine aktive
  Pi-hole-DNS-Kette, Listen wählen (Ausnahmen aus Pi-hole einfügen), umschalten mit Proben, fertig. Pi-hole gibt die
  DNS-Kette erst ab, wenn der Filter wirklich antwortet; scheitert ein Schritt, bleibt alles wie zuvor.
* **Unterbrechen** – jeder für die eigenen Geräte; Admins für alle; Eltern (Familie-Plugin, Personengruppe der Art
  „Familie“) auch für die Mitglieder ihrer Familie, nie für Admins. „Bis ich wieder einschalte“ ist für Benutzer
  gesperrt, bis ein Admin es freigibt; jede Unterbrechung endet für Benutzer spätestens nach der längsten Dauer.
* **Portal-Tab „DNS-Schutz“** – eigener Zustand, Unterbrechen und Wieder einschalten, eigene Geräte, für Admins
  und Eltern „Für andere unterbrechen“, das eigene Abfrageprotokoll (wenn der Admin es Benutzern zeigt).
* **App-API** für die Android- und die Windows-App (`/api/v1/client/plugins/gatecontrol-dns/api/…`): `GET status`,
  `POST pause`, `POST resume`, `GET people`, `GET log` – siehe README.
* **Mitteilungen**: Filter ausgefallen / läuft wieder (an die Admins), Unterbrechung beendet (an die Person),
  Wochenbericht montags (an die Admins, abschaltbar).

Noch nicht enthalten, weil GateControl 1.264.0 es noch nicht kann: „Fremden DNS und DoT sperren“ und „Profile
gemeinsam nutzen mit dem Heimnetz“.
