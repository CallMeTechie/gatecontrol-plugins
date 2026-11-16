<!-- version: 1.5.0 -->
# Fernzugriff – Handbuch

## Was das Plugin kann {#was-das-plugin-kann}

Fernzugriff ist das frühere „Remote Desktops“ von GateControl als eigenes Plugin. Du legst Geräte an – Windows-PCs, Server, einen Raspberry Pi, ein NAS – und verbindest dich mit ihnen:

- **im Browser** über RDP, VNC, SSH oder Telnet. Die Sitzung läuft auf einer Seite von GateControl in einem neuen Tab.
- **in den GateControl-Apps** (Android, Windows) mit RDP wie bisher. Die Apps merken vom Umzug nichts.

Dazu kommen Wake-on-LAN, Wartungsfenster, eine Erinnerung an das Erneuern der Zugangsdaten, Rechte je Person und Gruppe und der Verlauf aller Sitzungen.

Seit 1.5.0 kann auch ein **Windows-PC seinen Bildschirm teilen** – mit „Bildschirm teilen“ in der GateControl-App für Windows, auch mit **Windows Home**. Wer hilft, sieht den Bildschirm im Browser und darf ihn nach der Bestätigung am PC mit Maus und Tastatur steuern (siehe [Windows-Bildschirm teilen](#windows-teilen)).

Seit 1.4.0 darf die helfende Person das Handy auf Wunsch auch **steuern** – tippen, wischen, schreiben, Zurück/Start/Übersicht –, wenn die Person am Handy das für diese Anfrage erlaubt. Das geht nur mit der App **von GitHub**; die App aus Google Play zeigt den Bildschirm nur (siehe [Handy steuern](#steuern)).

Seit 1.3.0 kann ein **Android-Handy seinen Bildschirm freigeben**: In der GateControl-App für Android schaltet die Person „Bildschirm freigeben“ ein, gibt den Code an die Person weiter, die helfen soll, und bestätigt am Handy. Wer hilft, sieht den Bildschirm im Browser – zunächst **nur ansehen** (siehe [Handy-Bildschirm freigeben](#handy)).

Seit 1.2.0 läuft **SSH im eigenen Terminal von GateControl** – im Browser und nativ in den Apps, mit **tmux** (die Sitzung läuft auf dem Gerät weiter, wenn die Verbindung abreißt) und geprüftem Host-Schlüssel. Sitzungen lassen sich auf Wunsch **aufzeichnen** und im Browser abspielen (siehe [SSH im Terminal](#terminal) und [Aufzeichnung](#aufzeichnung)).

Seit 1.1.0 melden sich **Windows-PCs selbst an**: Schaltet jemand in der GateControl-App für Windows „Remote Desktop erlauben“ ein, steht der PC sofort unter Fernzugriff › Geräte. Verbunden wird mit dem Code, der auf dem PC steht, und erst nach der Bestätigung am PC (siehe [Windows-PCs aus der App](#windows-pcs)).

Passwörter und SSH-Schlüssel speichert nicht das Plugin, sondern der verschlüsselte Tresor von GateControl. Das Plugin kennt nur einen Verweis darauf.

## Voraussetzungen {#voraussetzungen}

- Für „Bildschirm teilen“ am Windows-PC: GateControl **1.287.0** oder neuer und die GateControl-App für Windows (Pro) mit „Bildschirm teilen“. Maus und Tastatur so, wie sie sind (auch Tastenkombinationen, mehrere Bildschirme), bringt GateControl mit der Fernzugriff-Schnittstelle **Version 6** (GateControl 1.288.0 oder neuer); mit Version 5 geht Steuern mit Klicken, Ziehen, Scrollen und Text.
- Zum Steuern eines Handys: GateControl mit der Fernzugriff-Schnittstelle **Version 5** (GateControl 1.287.0 oder neuer) und die GateControl-App für Android **aus GitHub** mit eingeschalteter Bedienungshilfe „GateControl-Fernsteuerung“. Mit einem älteren GateControl oder der App aus Google Play geht nur Ansehen.
- Für die Bildschirm-Freigabe vom Handy: GateControl **1.286.0** oder neuer (Fernzugriff-Schnittstelle Version 4, Relais für den Bildstrom) und die GateControl-App für Android mit „Bildschirm freigeben“. Ein älteres GateControl lehnt die Anmeldung des Handys ab.
- GateControl **1.285.0** oder neuer (Fernzugriff-Schnittstelle Version 3: Terminal im Kern, tmux, Host-Schlüssel, Aufzeichnung; dazu Version 2: Anmeldung der Windows-PCs, Firewall je Sitzung, stille Signale an den PC).
- Für Aufzeichnungen: das Laufwerk `remote-recordings` aus der `docker-compose.yml` der neuen Version (GateControl und guacd). Ohne es wird nicht aufgezeichnet.
- Für Windows-PCs aus der App: die GateControl-App für Windows (Pro) mit „Remote Desktop erlauben“ und Windows **Pro, Enterprise oder Education**. Windows Home kann keinen Remote Desktop anbieten – dort gibt es „Bildschirm teilen“.
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
| Terminal (nur SSH) | Terminal von GateControl oder Guacamole, tmux, Host-Schlüssel, SSH-Schlüssel erzeugen |
| Aufzeichnung | aus, wählbar oder immer |

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

### Windows-Bildschirm teilen {#windows-teilen}

In der GateControl-App für Windows steht unter **Einstellungen › Sicherheit** neben „Remote Desktop erlauben“ der Schalter **„Bildschirm teilen“** – für Hilfe: Beide sehen dasselbe, niemand wird abgemeldet. Das geht mit jeder Windows-Ausgabe, auch **Windows Home**.

- **Helfen:** Im Portal den Tab Fernzugriff öffnen, **„Code eingeben“** tippen, den Code vom PC eintragen und „Ansehen und steuern“ oder „Nur ansehen“ wählen. Bietet der PC auch Remote Desktop an, wählst du die **Verbindung** („Bildschirm teilen“ oder „Remote Desktop“). Am PC erscheint die Frage mit deinem Namen; dort wählt die Person „Ablehnen“, „Nur ansehen“ oder „Ansehen und steuern“. Ohne Antwort ist nach 30 Sekunden Schluss.
- **Während der Freigabe** steht oben auf dem Bildschirm des PCs eine rote Leiste „… sieht deinen Bildschirm“ bzw. „… steuert deinen Bildschirm“ mit **„Beenden“** (beim Steuern auch **„Nur ansehen“**). Beenden trennt sofort, gedrückte Tasten werden losgelassen. Danach zeigt der PC einen neuen Code.
- **Steuern:** Maus und Tastatur gehen so an den PC, wie du sie benutzt – auch Tastenkombinationen. Was dein eigener Browser oder dein System abfängt (z. B. Alt+Tab), kommt nicht an. Einfügen schreibt Text. Hat der PC mehrere Bildschirme, wählst du oben in der Leiste, welchen du siehst.
- **Was nicht geht:** Die Windows-Abfrage für Administratorrechte (UAC), der Sperr- und Anmeldebildschirm und Strg+Alt+Entf lassen sich nicht fernbedienen – das kann nur die Person am PC. Solange so etwas offen ist, steht das Bild still und ein Hinweis erscheint.
- **Ohne Code für Berechtigte** spart beim Bildschirm nur den Code: **die Frage am PC bleibt immer.**
- **Über den Server:** Bild und Eingaben laufen über deinen GateControl-Server wie beim Handy. Er reicht sie nur weiter, speichert nichts und schreibt keine Eingabe ins Protokoll – es ist aber keine Ende-zu-Ende-Verschlüsselung.
- Für das Teilen braucht der PC kein offenes Port und keine VPN-Adresse; Remote Desktop braucht sie weiter.

### Handy-Bildschirm freigeben {#handy}

In der GateControl-App für Android steht unter **Fernzugriff** der Schalter **„Bildschirm freigeben“**. Ist er an, meldet die App das Handy an und zeigt einen Code aus 9 Ziffern.

- **Helfen:** Im Portal den Tab Fernzugriff öffnen, **„Code eingeben“** tippen und den Code vom Handy eintragen. Am Handy erscheint „… möchte deinen Bildschirm sehen“ mit deinem Namen und Bild. Nach „Erlauben“ fragt Android noch einmal („Jetzt starten“). Erst dann öffnet sich bei dir die Seite mit dem Bildschirm des Handys.
- **Ansehen oder steuern:** Wähle beim Code „Ansehen und steuern“ oder „Nur ansehen“. Steuern geht nur, wenn die App des Handys von GitHub kommt – sonst bietet das Portal nur „Nur ansehen“ an (siehe [Handy steuern](#steuern)).
- **Während der Freigabe** zeigt das Handy eine rote Leiste und eine Mitteilung „Bildschirm wird geteilt“, beide mit **„Beenden“**. Beenden trennt sofort. Danach zeigt das Handy gleich einen neuen Code.
- **Ohne Code für Berechtigte:** Auch am Handy gibt es den zweiten Schalter. Dann tippen Personen mit Zugriff auf das Handy im Portal auf „Verbinden“ und sparen sich den Code. **Die Frage am Handy und die Abfrage von Android bleiben immer.**
- **Wer es sieht:** zuerst nur die Person selbst und die Administratoren; freigeben wie bei einem PC. Mit dem Recht „Support-Codes einlösen“ geht es mit dem Code auch ohne Zugriff.
- **Über den Server:** Das Bild läuft über deinen GateControl-Server. Er reicht es nur weiter und speichert nichts, es ist aber keine Ende-zu-Ende-Verschlüsselung. Banking-Apps, Passwortfelder und die Tresor-Seiten der App bleiben beim Helfer schwarz.
- Das Handy braucht kein VPN für die Freigabe. Es gilt als offline, wenn sich die App 20 Minuten nicht gemeldet hat.

### Handy steuern {#steuern}

Mit der GateControl-App für Android **aus GitHub** darf die helfende Person das Handy bedienen – aber nur, wenn die Person am Handy es **für genau diese Anfrage** erlaubt.

- **Am Handy einmal einrichten:** In der Karte „Bildschirm freigeben“ steht „Steuerung ist noch aus“. **„Steuerung einrichten“** erklärt, was der Bedienungshilfe-Dienst tut, und führt zu den Bedienungshilfen von Android. Dort „GateControl-Fernsteuerung“ einschalten. Ab Android 13 muss bei einer App von GitHub vorher in der App-Info „Eingeschränkte Einstellungen zulassen“ gewählt werden – die App zeigt den Weg. Abschalten geht jederzeit in den Bedienungshilfen.
- **Anfragen:** Im Portal „Ansehen und steuern“ wählen (bei „ohne Code“ den gleichnamigen Knopf). Am Handy steht dann „… möchte deinen Bildschirm sehen und steuern“ mit dem Feld **„Nur ansehen lassen“**. Ohne Haken darf die helfende Person steuern, mit Haken nur zusehen. Ist die Bedienungshilfe aus, bleibt es beim Ansehen.
- **Während gesteuert wird** zeigt das Handy eine rote Leiste „… steuert deinen Bildschirm“, eine Mitteilung und einen roten Rahmen mit „Steuern beenden“ über allen Apps. **„Nur ansehen“** (Leiste, Mitteilung) oder „Steuern beenden“ (Rahmen) nimmt die Steuerung sofort weg, das Ansehen läuft weiter. Zurück zum Steuern geht nur mit einer neuen Anfrage. „Beenden“ trennt ganz.
- **Was die helfende Person kann:** auf dem Bild klicken (tippen), gedrückt halten (lange drücken), ziehen (wischen), mit dem Mausrad scrollen, mit der rechten Maustaste zurück; Knöpfe Zurück, Start, Übersicht und Text. Getippter Text landet im Feld, das am Handy ausgewählt ist.
- **Was nicht geht:** die Sperre, die PIN-Eingabe und die Abfragen von Android lassen sich nicht fernbedienen. In Passwortfelder kann nicht ferngeschrieben werden. Ist nur eine App geteilt, gibt es keine Steuerung.
- **Datenschutz:** Der Dienst tippt und wischt nur in einer Sitzung, die bestätigt wurde, und sendet nichts außerhalb davon. Eingaben laufen wie das Bild über deinen GateControl-Server und landen in keinem Protokoll.

### SSH im Terminal {#terminal}

Ein SSH-Gerät verbindet sich entweder mit dem **Terminal von GateControl** oder wie bisher mit **Guacamole**. Neue SSH-Geräte bekommen das Terminal, vorhandene und übernommene bleiben bei Guacamole, bis du sie umstellst.

- **Umstellen:** Öffne das Gerät, Reiter **Terminal**, und klicke **„Im Terminal testen“**. Klappt die Verbindung, zeigt das Gerät „Terminal getestet“. Dann **„Auf Terminal umstellen“** in der Liste – oder **„Alle SSH-Geräte umstellen“** oben. Zurück geht es im Reiter Terminal unter „Verbinden mit“.
- **tmux:** Mit „Sitzung mit tmux fortsetzen“ läuft die Sitzung auf dem Gerät weiter, wenn die Verbindung abreißt oder du vom Handy zum PC wechselst. Der Name ist „gc-“ und der Kurzname des Geräts oder frei wählbar (Buchstaben, Ziffern, `_` und `-`). Im Portal wählst du vor dem Verbinden „Fortsetzen“ mit dem Namen der Sitzung oder „Neue Sitzung starten“. Fehlt tmux auf dem Gerät, gibt es eine normale Shell und einen Hinweis.
- **Host-Schlüssel:** Bei der ersten Verbindung zeigt das Terminal den Fingerabdruck des Geräts. Vergleiche ihn (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`) und bestätige. Danach verbindet GateControl nur noch mit genau diesem Schlüssel. Ändert er sich, ist die Verbindung gesperrt. War die Änderung geplant (neu installiertes Gerät), setzt du den Schlüssel im Reiter Terminal mit **„Host-Schlüssel zurücksetzen“** zurück.
- **SSH-Schlüssel statt Passwort:** **„SSH-Schlüssel erzeugen“** legt einen Schlüssel in GateControl an. Den öffentlichen Teil trägst du auf dem Gerät in `~/.ssh/authorized_keys` ein. Der private Schlüssel bleibt im Tresor.

### Aufzeichnung {#aufzeichnung}

Aufgezeichnet wird nur, wenn du es erlaubst – je Gerät im Reiter **Aufzeichnung** und je Person oder Gruppe unter **Berechtigungen** (Spalte „Aufzeichnung“). Es gilt das Strengere von beiden.

- **Aus** (Standard): keine Aufzeichnung.
- **Wählbar:** Die Person hakt vor dem Verbinden „Diese Sitzung aufzeichnen“ an.
- **Immer:** Jede Sitzung wird aufgezeichnet, auch die von Familienmitgliedern. Vor dem Start erscheint immer der Hinweis „Diese Sitzung wird aufgezeichnet“, während der Sitzung ein roter Punkt. Die Person sieht es auch in ihrem Profil.

Beim SSH-Terminal wird aufgezeichnet, was das Terminal zeigt, keine Tastatureingaben. Bei RDP und VNC das Bild der Sitzung. Die Aufzeichnungen liegen verschlüsselt bei GateControl. Unter **Sitzungen › Aufzeichnungen** kannst du sie abspielen und löschen. Ansehen dürfen nur Administratoren und der Besitzer des Geräts, jedes Ansehen steht im Protokoll (Filter „Freigaben“). Wie lange sie bleiben, stellst du unter **Einstellungen** ein (Standard 30 Tage).

## Benutzen {#benutzen}

**Im Portal:** Der Tab **Fernzugriff** zeigt deine Geräte mit Zustand. „Verbinden“ öffnet die Sitzung in einem neuen Tab. Erscheint stattdessen „Sitzung öffnen“, tippe darauf. „Aufwecken“ schickt ein Wake-on-LAN-Paket. Bei einem Windows-PC „Nur mit Code“ steht dort „Code eingeben“. Mit dem Recht „Support-Codes einlösen“ gibt es „Code eingeben“ auch oben, für PCs, die du nicht in der Liste hast.

**In den Apps:** RDP-Geräte stehen wie bisher in den GateControl-Apps unter Remote Desktop. SSH-Geräte mit dem Terminal öffnen die Apps in einem eigenen Terminal, sobald die App das kann.

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

**„Der Host-Schlüssel des Geräts hat sich geändert“:** GateControl verbindet sich nicht, weil das Gerät einen anderen Schlüssel zeigt als beim ersten Mal. Hast du das Gerät neu aufgesetzt, setze den Schlüssel im Reiter Terminal zurück. Sonst: nicht verbinden und prüfen, wer da antwortet.

**Aufzeichnung startet nicht:** GateControl braucht das Laufwerk für Aufzeichnungen aus der neuen `docker-compose.yml`. Ohne es öffnet sich ein Gerät mit „immer aufzeichnen“ nicht. RDP- und VNC-Aufzeichnungen kommen erst, wenn auch guacd das Laufwerk hat (nach dem nächsten Update).

**tmux fehlt:** Installiere tmux auf dem Gerät (`sudo apt install tmux`). Bis dahin läuft die Sitzung ohne tmux.

**Das Handy erscheint nicht / „Bildschirm-Freigaben brauchen ein neueres GateControl“:** Die Person braucht das Recht „Eigene Geräte freigeben“, und GateControl braucht die Fernzugriff-Schnittstelle Version 4.

**Im Portal gibt es bei einem Handy nur „Nur ansehen“:** Die App am Handy kommt aus Google Play oder ist älter, oder GateControl hat die Fernzugriff-Schnittstelle Version 5 noch nicht. Steuern geht nur mit der App von GitHub.

**„Die Person am Gerät hat auf ‚Nur ansehen‘ gestellt“:** Am Handy wurde die Steuerung beendet. Du kannst weiter zusehen; zum Steuern brauchst du eine neue Anfrage.

**Der Helfer sieht nur „Warte auf das Bild vom Gerät …“:** Am Handy wurde die Abfrage von Android noch nicht mit „Jetzt starten“ bestätigt, oder die Person hat sie abgelehnt. Dann endet die Anfrage und der Helfer sieht „Die Freigabe wurde am Gerät beendet“.

**Der PC erscheint nicht:** Die Person braucht das Recht „Eigene Geräte freigeben“. Unter Windows Home gibt es keinen Remote Desktop – die App zeigt dann einen Hinweis.

**„Der PC hat die Verbindung nicht rechtzeitig geöffnet“:** Die App auf dem PC hat innerhalb von 15 Sekunden nicht gemeldet, dass Port 3389 offen ist. Ist die App gestartet und mit GateControl verbunden?

**„Zu viele falsche Codes“:** Warte 15 Minuten oder lass dir am PC einen neuen Code zeigen.

**Im Browser fragt Windows nach der Anmeldung nicht:** Verlangt der PC die Anmeldung auf Netzwerkebene (NLA), braucht die Sitzung im Browser Benutzername und Passwort, die die Sitzungsseite noch nicht abfragt. Verbinde dich dann aus der GateControl-App.

## Neu in 1.5.0 {#neu-1-5-0}

- **Windows-Bildschirm teilen** – „Bildschirm teilen“ in der GateControl-App für Windows, auch mit **Windows Home**: ansehen und nach der Bestätigung am PC mit Maus und Tastatur steuern, über dasselbe Relais wie die Handys.
- **Die Person am PC entscheidet jedes Mal** („Nur ansehen“ / „Ansehen und steuern“) und sieht oben eine Leiste mit „Beenden“; auch „ohne Code“ fragt der PC.
- **Portal:** bei einem PC mit Remote Desktop und Bildschirm die Wahl der Verbindung; Geräte-Liste mit „Windows · Bildschirm teilen“.
- Windows Home erscheint jetzt unter Geräte, sobald „Bildschirm teilen“ an ist.

## Neu in 1.4.0 {#neu-1-4-0}

- **Handy steuern** – „Ansehen und steuern“ für Handys mit der App von GitHub: tippen, wischen, scrollen, schreiben, Zurück/Start/Übersicht.
- **Die Person am Handy entscheidet jedes Mal** („Nur ansehen lassen“) und kann jederzeit auf „Nur ansehen“ stellen.
- Die App aus Google Play bleibt beim Ansehen; das Portal zeigt bei solchen Handys nur „Nur ansehen“.
- Verlauf: „steuern erlaubt“ und „Auf ‚Nur ansehen‘ gestellt“.

## Neu in 1.3.0 {#neu-1-3-0}

- **Android-Handys geben ihren Bildschirm frei** – Schalter „Bildschirm freigeben“ in der App, Code, Bestätigung am Handy und die Abfrage von Android; danach sofort ein neuer Code.
- Zunächst **nur ansehen**: der Bildschirm erscheint im Browser auf einer Seite von GateControl.
- **„Ohne Code für Berechtigte“** auch am Handy – die Frage am Handy bleibt.
- Handys stehen unter Geräte mit „Android-Handy“, im Portal mit „nur ansehen“; im Profil heißt der Abschnitt jetzt „Meine Geräte“.
- Protokoll: „Bildschirm wird angesehen“ und „Bildschirmfreigabe beendet“.

## Neu in 1.2.0 {#neu-1-2-0}

- **SSH im eigenen Terminal** von GateControl, im Browser und in den Apps – mit tmux („Fortsetzen“ / „Neue Sitzung“) und geprüftem Host-Schlüssel.
- Alte SSH-Geräte bleiben bei Guacamole; **umstellen** je Gerät oder alle auf einmal, vorher „Im Terminal testen“.
- **SSH-Schlüssel erzeugen** in GateControl, Host-Schlüssel ansehen und zurücksetzen.
- **Aufzeichnung** je Gerät und je Person oder Gruppe: aus, wählbar oder immer – „immer“ nur mit Hinweis vor dem Start.
- **Aufzeichnungen** unter Sitzungen abspielen und löschen, Aufbewahrung unter Einstellungen; Besitzer eines PCs sehen sie im Profil.

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
