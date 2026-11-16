<!-- version: 1.1.0 -->
# Fernzugriff – Handbuch

## Was das Plugin kann {#was-das-plugin-kann}

Fernzugriff ist das frühere „Remote Desktops“ von GateControl als eigenes Plugin. Du legst Geräte an – Windows-PCs, Server, einen Raspberry Pi, ein NAS – und verbindest dich mit ihnen:

- **im Browser** über RDP, VNC, SSH oder Telnet. Die Sitzung läuft auf einer Seite von GateControl in einem neuen Tab.
- **in den GateControl-Apps** (Android, Windows) mit RDP wie bisher. Die Apps merken vom Umzug nichts.

Dazu kommen Wake-on-LAN, Wartungsfenster, eine Erinnerung an das Erneuern der Zugangsdaten, Rechte je Person und Gruppe und der Verlauf aller Sitzungen.

Seit 1.1.0 melden sich **Windows-PCs selbst an**: Schaltet jemand in der GateControl-App für Windows „Remote Desktop erlauben“ ein, steht der PC sofort unter Fernzugriff › Geräte. Verbunden wird mit dem Code, der auf dem PC steht, und erst nach der Bestätigung am PC (siehe [Windows-PCs aus der App](#windows-pcs)).

Passwörter und SSH-Schlüssel speichert nicht das Plugin, sondern der verschlüsselte Tresor von GateControl. Das Plugin kennt nur einen Verweis darauf.

## Voraussetzungen {#voraussetzungen}

- GateControl **1.284.0** oder neuer (Fernzugriff-Schnittstelle Version 2: Anmeldung der Windows-PCs, Firewall je Sitzung, stille Signale an den PC).
- Für Windows-PCs aus der App: die GateControl-App für Windows (Pro) mit „Remote Desktop erlauben“ und Windows **Pro, Enterprise oder Education**. Windows Home kann keinen Remote Desktop anbieten.
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

### Windows-PCs aus der App {#windows-pcs}

Schaltet jemand in der GateControl-App für Windows **„Remote Desktop erlauben“** ein, meldet die App den PC an. Er steht dann sofort unter **Fernzugriff › Geräte** mit dem Hinweis „Angemeldet von der App“, dem Besitzer und der angemeldeten Person am PC.

- **Wer ihn sieht:** zuerst nur der Besitzer und die Administratoren. Der Besitzer kann in der App weitere Personen und Gruppen freigeben.
- **Nur mit Code (Standard):** Der PC zeigt einen Code aus 9 Ziffern (z. B. 482-913-075). Wer helfen will, öffnet im Portal den Tab Fernzugriff, tippt **„Code eingeben“** und wählt „Ansehen und steuern“ oder „Nur ansehen“. Am PC erscheint die Frage mit Name und Bild der Person. Erst wenn sie dort jemand erlaubt, öffnet sich die Sitzung. Ohne Antwort ist nach 30 Sekunden Schluss. Ein Code gilt einmal und höchstens 10 Minuten. Nach jeder Sitzung zeigt der PC einen neuen.
- **Ohne Code für Berechtigte:** Ein zweiter Schalter in der App. Dann verbinden sich Personen mit dem Recht „Remote Desktops nutzen“ und Zugriff auf den PC direkt, ohne Code und ohne Frage. Als Administrator kannst du das je PC mit **„„Ohne Code“ sperren“** verbieten.
- **Firewall je Sitzung:** Zwischen den Sitzungen ist Port 3389 am PC zu. Für eine Sitzung öffnet die App ihn nur für genau einen Gegenüber – im Browser für GateControl selbst, in einer App für das Gerät des Helfers – und schließt ihn mit dem Ende der Sitzung, spätestens nach 8 Stunden.
- **Schalter aus:** Der PC bleibt als „Abgemeldet“ in der Liste, der Verlauf bleibt. Offene Sitzungen enden, der Code verfällt.
- **Raten:** Nach 5 falschen Codes in 10 Minuten muss eine Person 15 Minuten warten. Für den ganzen Server gelten 30 Versuche je Stunde. Nach 10 falschen Codes auf einen PC verfällt dessen Code.

## Benutzen {#benutzen}

**Im Portal:** Der Tab **Fernzugriff** zeigt deine Geräte mit Zustand. „Verbinden“ öffnet die Sitzung in einem neuen Tab. Erscheint stattdessen „Sitzung öffnen“, tippe darauf. „Aufwecken“ schickt ein Wake-on-LAN-Paket. Bei einem Windows-PC „Nur mit Code“ steht dort „Code eingeben“. Mit dem Recht „Support-Codes einlösen“ gibt es „Code eingeben“ auch oben, für PCs, die du nicht in der Liste hast.

**In den Apps:** RDP-Geräte stehen wie bisher in den GateControl-Apps unter Remote Desktop.

**Als Administrator:** Unter **Fernzugriff › Geräte** kannst du dich mit jedem Gerät verbinden – mit einem Windows-PC aus der App nur „ohne Code“, sonst wie alle mit dem Code. Unter **Sitzungen** siehst du den Verlauf, kannst offene Browser-Sitzungen beenden und alles als CSV laden. Der Filter **„Freigaben“** zeigt eingelöste und falsche Codes, Anfragen, Änderungen an „Ohne Code“ und das Öffnen und Schließen der Firewall.

**Im Profil:** Im Portal unter „Meine Geräte“ zeigt der Abschnitt **Fernzugriff**, was du darfst, deine angemeldeten PCs und den Verlauf ihrer Freigaben.

## Berechtigungen {#berechtigungen}

| Recht | Bedeutung |
|---|---|
| Remote Desktops nutzen | RDP und VNC zu den Geräten, die die Person erreichen darf |
| SSH nutzen | SSH und Telnet |
| Support-Codes einlösen | mit dem Code eines Windows-PCs verbinden, auch ohne Zugriff auf den PC; Standard aus |
| Eigene Geräte freigeben | den eigenen PC in der App anmelden und Codes zeigen; Standard an |

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

**Der PC erscheint nicht:** Die Person braucht das Recht „Eigene Geräte freigeben“. Unter Windows Home gibt es keinen Remote Desktop – die App zeigt dann einen Hinweis.

**„Der PC hat die Verbindung nicht rechtzeitig geöffnet“:** Die App auf dem PC hat innerhalb von 15 Sekunden nicht gemeldet, dass Port 3389 offen ist. Ist die App gestartet und mit GateControl verbunden?

**„Zu viele falsche Codes“:** Warte 15 Minuten oder lass dir am PC einen neuen Code zeigen.

**Im Browser fragt Windows nach der Anmeldung nicht:** Verlangt der PC die Anmeldung auf Netzwerkebene (NLA), braucht die Sitzung im Browser Benutzername und Passwort, die die Sitzungsseite noch nicht abfragt. Verbinde dich dann aus der GateControl-App.

## Neu in 1.1.0 {#neu-1-1-0}

- **Windows-PCs aus der App:** „Remote Desktop erlauben“ in der GateControl-App für Windows meldet den PC an. Er erscheint sofort unter Geräte und bei allen Berechtigten.
- **Nur mit Code** (Standard) mit Bestätigung am PC, oder **ohne Code für Berechtigte**. Als Administrator kannst du „Ohne Code“ je PC sperren.
- **„Code eingeben“** im Portal-Tab, mit „Warte auf Bestätigung am Gerät …“.
- **Firewall je Sitzung:** Port 3389 öffnet sich nur für genau einen Gegenüber und nur für die Dauer der Sitzung.
- Die Rechte „Support-Codes einlösen“ und „Eigene Geräte freigeben“ wirken jetzt.
- Filter „Freigaben“ unter Sitzungen, deine PCs und ihr Verlauf im Profil.
- Neue Berechtigung **Benachrichtigungen** (nur stille Signale an den eigenen PC) – du bestätigst sie beim Update.

## Neu in 1.0.0 {#neu}

- Erste Version: Remote Desktops als Plugin mit den Seiten Geräte, Berechtigungen, Sitzungen und Einstellungen.
- Portal-Tab „Fernzugriff“ und Profil-Abschnitt „Fernzugriff“.
- Übernahme aus „Remote Desktops“ mit „Erneut übernehmen“.
- Die GateControl-Apps verbinden sich unverändert weiter, Zugangsdaten nur Ende-zu-Ende verschlüsselt.
- Eigene Lizenz, nicht im Plan und nicht in einer Server-Lifetime enthalten.
