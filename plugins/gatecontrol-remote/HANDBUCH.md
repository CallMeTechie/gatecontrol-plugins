<!-- version: 1.0.0 -->
# Fernzugriff – Handbuch

## Was das Plugin kann {#was-das-plugin-kann}

Fernzugriff ist das frühere „Remote Desktops“ von GateControl als eigenes Plugin. Du legst Geräte an – Windows-PCs, Server, einen Raspberry Pi, ein NAS – und verbindest dich mit ihnen:

- **im Browser** über RDP, VNC, SSH oder Telnet. Die Sitzung läuft auf einer Seite von GateControl in einem neuen Tab.
- **in den GateControl-Apps** (Android, Windows) mit RDP wie bisher. Die Apps merken vom Umzug nichts.

Dazu kommen Wake-on-LAN, Wartungsfenster, eine Erinnerung an das Erneuern der Zugangsdaten, Rechte je Person und Gruppe und der Verlauf aller Sitzungen.

Passwörter und SSH-Schlüssel speichert nicht das Plugin, sondern der verschlüsselte Tresor von GateControl. Das Plugin kennt nur einen Verweis darauf.

## Voraussetzungen {#voraussetzungen}

- GateControl **1.281.0** oder neuer. Die alte App-Schnittstelle beantwortet das Plugin erst mit der nächsten Version von GateControl. Bis dahin beantwortet sie GateControl selbst aus „Remote Desktops“, und es ändert sich für die Apps nichts.
- Eine **eigene Lizenz** für Fernzugriff: Monat, Jahr oder Lifetime des Plugins. Fernzugriff ist **nicht** im GateControl-Plan und nicht in einer Server-Lifetime-Lizenz enthalten.
- Für Geräte im Heimnetz: ein Home-Gateway, das das Gerät erreicht.

## Einrichten {#einrichten}

1. Installiere Fernzugriff unter **Einstellungen › Plugins › Katalog** und trage die Lizenz unter **Einstellungen › Plugins › Fernzugriff › Lizenz** ein.
2. Hast du schon „Remote Desktops“ genutzt: Öffne **Einstellungen › Plugins › Fernzugriff** und klicke **„Daten übernehmen“** (siehe [Übernahme aus Remote Desktops](#uebernahme)).
3. Lege weitere Geräte unter **Fernzugriff › Geräte › „Gerät hinzufügen“** an (siehe [Geräte](#geraete)).
4. Vergib unter **Fernzugriff › Berechtigungen** die Rechte (siehe [Berechtigungen](#berechtigungen)).

### Übernahme aus Remote Desktops {#uebernahme}

„Daten übernehmen“ kopiert aus „Remote Desktops“:

- alle Ziele mit ihren Nummern und allen Einstellungen,
- die Zugangsdaten (sie bleiben im Tresor von GateControl),
- wer ein Ziel sehen durfte (Personen, Gruppen, alte App-Token),
- die Wartungsfenster und die letzten 20 000 Sitzungen.

Wer bisher ein RDP- oder VNC-Ziel sehen konnte, bekommt das Recht „Remote Desktops nutzen“. Wer ein SSH- oder Telnet-Ziel sah, bekommt „SSH nutzen“. Ein Ziel über ein Home-Gateway behält seinen Port auf dem Server.

**„Erneut übernehmen“** holt den Stand aus „Remote Desktops“ noch einmal. Übernommene Geräte und ihr Verlauf werden dabei ersetzt, Änderungen daran gehen verloren. Geräte, die du im Plugin angelegt hast, bleiben. Ein Recht, das du schon gesetzt hast, nimmt die Übernahme nie weg.

„Remote Desktops“ bleibt in GateControl erhalten, die Daten werden nur kopiert. Unter **Fernzugriff › Einstellungen** steht, wann zuletzt übernommen wurde.

> **Hinweis:** Steht bei einem Gerät „Zugangsdaten neu eingeben“, konnte GateControl sie nicht mehr lesen, etwa nach einer Wiederherstellung auf einem anderen Server. Öffne das Gerät, gib Benutzername und Passwort neu ein und speichere.

### Geräte {#geraete}

Ein Gerät hat diese Reiter:

| Reiter | Was du einstellst |
|---|---|
| Verbindung | Host, Port, Zugriff, Schlagwörter, Beschreibung, ob es regelmäßig geprüft wird |
| Anmeldung | Benutzername, Passwort, SSH-Schlüssel, Domäne und was die Apps bekommen |
| Anzeige, Ressourcen, Leistung, Sitzung | wie bei Remote Desktops (nur RDP, Anzeige auch VNC) |
| Wecken & Wartung | Wake-on-LAN mit MAC-Adresse, Wartungsfenster, Erinnerung an neue Zugangsdaten |
| Browser | ob man sich im Browser verbinden darf, Zwischenablage, Ton |

**Zugriff:**

- **Nur VPN (intern):** Host ist die VPN-Adresse oder der Name des Rechners.
- **Öffentlicher Port-Forward:** Der Browser verbindet sich über den externen Hostnamen und Port.
- **Beide:** Die Apps nehmen den externen Weg, der Browser den internen.
- **Über ein Home-Gateway:** Host ist die Adresse im Heimnetz, dazu wählst du das Gateway oder einen Gateway-Pool. GateControl öffnet auf dem Server einen Port, den das Gateway ins Heimnetz weitergibt. Ist der Port belegt, nimm eine andere Zahl.

**Wartungsfenster:** eine Zeile je Fenster, zum Beispiel `Mo-Fr 22:00-06:00` oder `Sa 08:00-12:00`. Tage: Mo Di Mi Do Fr Sa So. Es gilt die Uhrzeit des Servers. In dieser Zeit verbindet sich niemand, auch nicht aus den Apps.

Bei Zugangsdaten bleiben leere Felder, wie sie sind. Mit „Gespeicherte Zugangsdaten löschen“ entfernst du alle.

## Benutzen {#benutzen}

**Im Portal:** Der Tab **Fernzugriff** zeigt deine Geräte mit Zustand. „Verbinden“ öffnet die Sitzung in einem neuen Tab. Erscheint stattdessen „Sitzung öffnen“, tippe darauf. „Aufwecken“ schickt ein Wake-on-LAN-Paket.

**In den Apps:** RDP-Geräte stehen wie bisher in den GateControl-Apps unter Remote Desktop.

**Als Administrator:** Unter **Fernzugriff › Geräte** kannst du dich mit jedem Gerät verbinden. Unter **Sitzungen** siehst du den Verlauf, kannst offene Browser-Sitzungen beenden und alles als CSV laden.

**Im Profil:** Im Portal unter „Meine Geräte“ zeigt der Abschnitt **Fernzugriff**, was du darfst.

## Berechtigungen {#berechtigungen}

| Recht | Bedeutung |
|---|---|
| Remote Desktops nutzen | RDP und VNC zu den Geräten, die die Person erreichen darf |
| SSH nutzen | SSH und Telnet |
| Support-Codes einlösen | vorbereitet, wirkt mit einer späteren Version |
| Eigene Geräte freigeben | vorbereitet, wirkt mit einer späteren Version; Standard an |

- Ein Recht setzt du je **Gruppe** oder je **Person**. „ja“ oder „nein“ bei der Person gilt vor ihren Gruppen.
- Ohne Eintrag hat eine Person ein Recht, sobald eine ihrer Gruppen es hat.
- **Administratoren** dürfen immer alles und erreichen jedes Gerät.
- **Welche Geräte:** Je Gerät „Alle mit Recht“ oder „Nur ausgewählte“ Personen und Gruppen. Alte App-Token aus Remote Desktops gelten weiter, nur für die alten Apps.
- „Was darf diese Person?“ (Klick auf den Namen) zeigt Rechte und erreichbare Geräte einer Person.

Das Recht wird bei jedem Verbinden neu geprüft.

## Häufige Fragen / Fehlersuche {#fehlersuche}

**„Fernzugriff hat keine gültige Lizenz“:** Ohne Lizenz bleiben Geräte, Rechte und Verlauf erhalten, aber es öffnen sich keine neuen Sitzungen. Trag die Lizenz unter Einstellungen › Plugins › Fernzugriff › Lizenz ein.

**Ein Gerät fehlt im Portal:** Prüfe, ob die Person das Recht für das Protokoll hat und ob das Gerät auf „Nur ausgewählte“ steht. „Was darf diese Person?“ zeigt es dir.

**„Nur in den GateControl-Apps“:** Für das Gerät ist der Browser-Zugriff aus. Schalte ihn im Reiter „Browser“ ein.

**„Gateway-Port fehlt“:** Der Port auf dem Server ließ sich nicht einrichten, meist ist er belegt. Öffne das Gerät, wähle einen anderen „Port auf dem Server“ und speichere.

**Die Apps zeigen andere Geräte als das Portal:** Die Apps zeigen nur RDP-Geräte. Bis GateControl die neue Schnittstelle hat, kommt ihre Liste noch aus „Remote Desktops“.

**Aufzeichnung:** Sitzungen aufzeichnen kommt mit einer späteren Version.

## Neu in 1.0.0 {#neu}

- Erste Version: Remote Desktops als Plugin mit den Seiten Geräte, Berechtigungen, Sitzungen und Einstellungen.
- Portal-Tab „Fernzugriff“ und Profil-Abschnitt „Fernzugriff“.
- Übernahme aus „Remote Desktops“ mit „Erneut übernehmen“.
- Die GateControl-Apps verbinden sich unverändert weiter, Zugangsdaten nur Ende-zu-Ende verschlüsselt.
- Eigene Lizenz, nicht im Plan und nicht in einer Server-Lifetime enthalten.
