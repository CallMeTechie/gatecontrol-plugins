<!-- version: 1.7.2 -->
# Tür & Kamera

## Was das Plugin kann

- **Nuki-Schlösser und -Opener** steuern: zusperren, aufsperren, öffnen (Falle ziehen), beim Opener den Summer – in der GateControl-App, im Widget, über Schnellaktionen und im Portal.
- **Ring-Klingeln und -Kameras** einbinden: Klingel-Push mit Bild und „Tür öffnen“, Bewegungs-Push, Bilder im Verlauf. Ring wird über die **inoffizielle Schnittstelle der Ring-App** angesprochen – ohne Gewähr, Ring kann das jederzeit ändern.
- **Ring-Modus** (Inaktiv / Zuhause / Abwesend) je Ring-Standort schalten – auch per Regel der Familie.
- **Kameras im Heimnetz** (ab 1.6.0): Kameras mit ONVIF oder RTSP (z. B. Reolink, Tapo, Hikvision) über ein GateControl-Gateway, ohne Hersteller-Cloud – Live-Bild, Standbild, Clips bei Bewegung auf deiner NAS bzw. am Gateway, Push mit Standbild, wenn die Kamera eine Person erkennt.
- **Automatisch aufsperren bei Ankunft** – nur, wenn du das für eine Person ausdrücklich erlaubst.
- **Rechte pro Person**, Schloss und Kamera, mit Zeitfenster. Jede Bedienung steht im Verlauf.
- **Sicherheits-Hinweise:** Tür zu lange offen, Schloss blockiert oder nicht erreichbar, Batterie fast leer, Nachtkontrolle.
- **Klingel im Familien-Chat:** mit dem Messenger-Plugin kommt jedes Klingeln als Karte mit Bild und „Tür öffnen“ in den Chat „Familie“.

Das Plugin ist kostenpflichtig (eigenes Abo) und nicht in GateControl Lifetime enthalten.

## Voraussetzungen

- GateControl **1.169.0** oder neuer.
- Für Nuki: eine **Nuki Bridge** im Heimnetz (empfohlen) oder ein Konto bei **Nuki Web**.
- Für Ring: dein Ring-Konto (E-Mail, Passwort und den Bestätigungscode, den Ring dir schickt).
- Für Kameras im Heimnetz: GateControl **1.240.0** oder neuer, ein Gateway **1.28.0** oder neuer und eine Kamera mit ONVIF oder RTSP. Alles dazu im Kapitel [Kameras im Heimnetz einrichten](#kameras-einrichten).
- Für die Klingel im Familien-Chat: das Messenger-Plugin ab 1.4.0 (GateControl 1.177.0 oder neuer).
- Für „Automatisch aufsperren“ und den Ring-Modus in Regeln: das Plugin Familie mit Anwesenheit.

## Einrichten

### Nuki Bridge (empfohlen, bleibt im Heimnetz)

1. In der **Nuki-App**: Bridge › Bridge verwalten › **HTTP-API aktivieren** und den angezeigten **API-Token** notieren.
2. In GateControl: **Einstellungen › Plugins › Tür & Kamera › Zugriffsziele**. Dem Ziel **„Nuki Bridge“** die Bridge zuweisen – ihre Adresse im Heimnetz mit Port 8080 oder eine Route. Für mehrere Bridges weist du das Ziel mehrfach zu.
3. Im Plugin auf der Seite **„Geräte“** › **„Bridge hinzufügen“**: Name, Zugriffsziel und API-Token eintragen, speichern.
4. **„Geräte suchen“** zeigt die Schlösser und Opener der Bridge. Füge die gewünschten hinzu (siehe [Schlösser anlegen](#schloesser-anlegen)).

Der Token wird verschlüsselt gespeichert und danach nie wieder angezeigt. Das Plugin schickt ihn nie im Klartext an die Bridge, sondern meldet sich mit einem Hash an.

### Nuki Web (ohne Bridge, über die Nuki-Cloud)

1. Auf **web.nuki.io** › Menü › API › **API-Token generieren**. Rechte: Smart Locks ansehen und bedienen, Log ansehen.
2. Im Plugin auf **„Geräte“** › Abschnitt „Nuki Web (Cloud)“ den Token eintragen und **„Token speichern“**.

Nuki Web liefert nur die Kopie der Cloud. Ist das Schloss gerade nicht mit dem Internet verbunden, kann der angezeigte Zustand veraltet sein. Für eine zuverlässige Anzeige ist die Bridge besser.

### Schlösser anlegen

Auf **„Geräte“** › **„Schloss hinzufügen“**:

- **Name**, z. B. „Haustür“.
- **Quelle:** Bridge oder Nuki Web, dazu die Nuki-ID und der Gerätetyp (Smart Lock oder Opener).
- **Verfügbare Aktionen:** zusperren, aufsperren, öffnen (Falle ziehen); beim Opener der Summer. Was du hier weglässt, bietet das Plugin niemandem an.
- **Türsensor vorhanden:** nur ankreuzen, wenn am Schloss wirklich ein Türsensor hängt.
- **„Offen zu lange“ nach Minuten** (Standard 5, 0 = aus).
- **Nachtkontrolle** (Standard 22:00, leer = aus): ist die Tür dann nicht zugesperrt, kommt eine Mitteilung.

### Ring verbinden (inoffiziell, ohne Gewähr)

1. Auf **„Geräte“** › **„Mit Ring anmelden“**: E-Mail und Passwort deines Ring-Kontos.
2. Den **Bestätigungscode** eingeben, den Ring dir per SMS, E-Mail oder Authenticator-App schickt.
3. In der Ring-App erscheint danach ein angemeldetes Gerät „GateControl“.
4. Unter „Kameras & Klingeln“ jede Kamera mit einem **Schloss verknüpfen**. Kameras ohne Schloss (z. B. am Briefkasten) gibst du stattdessen auf der Seite „Berechtigungen“ frei.

Das Passwort geht nur für diese Anmeldung an Ring und wird nicht gespeichert. Gespeichert wird nur ein Token, das sich laufend erneuert.

### Einstellungen

Auf der Seite **„Einstellungen“** des Plugins:

- **Zeitzone** (für Zeitfenster und Nachtkontrolle; leer = die des Servers) und **Sprache der Mitteilungen**.
- **Bilder aufbewahren** 1 bis 30 Tage (Standard 7).
- **Bewegungs-Push** höchstens alle … Minuten pro Kamera.
- **Ring abfragen** an/aus. Aus heißt: kein Klingeln, keine Bewegung, keine Mitteilung – Gong und Fernseher klingeln weiter direkt von Ring.
- **Nuki-Web-Protokoll übernehmen:** Bedienungen am Schloss und am Keypad erscheinen im Verlauf.
- **Klingel in den Familien-Chat** (Standard an, braucht das Messenger-Plugin).
- Darunter die **Klingel-Diagnose**: das zuletzt erkannte Klingeln, wie schnell es erkannt wurde und was daraus wurde.

## Kameras im Heimnetz einrichten {#kameras-einrichten}

Kameras im Heimnetz laufen ohne Hersteller-Cloud: Das Gateway spricht mit der Kamera, Bilder und Clips bleiben am Gateway (bei der Synology auf der NAS). Mach die Schritte einmal in dieser Reihenfolge.

### Schritt 1: GateControl, Gateway und Plugin aktualisieren

1. **GateControl** auf **1.240.0** oder neuer aktualisieren.
2. Jedes Gateway, an dem Kameras hängen sollen, auf **1.28.0** oder neuer: **Gateways** › dein Gateway › **„Update auf …“** und warten, bis die neue Version angezeigt wird.
3. Dieses Plugin auf **1.6.0** oder neuer: **Einstellungen › Plugins** › „Nach Updates suchen“.

Ist das Gateway zu alt, steht bei „Kameras“ „Gateway zu alt – ab 1.28.0“. Ist GateControl zu alt, steht auf der Seite „Geräte“ „Kameras im Heimnetz brauchen GateControl ab 1.240.0“. Ring und die Schlösser funktionieren in beiden Fällen weiter.

### Schritt 2: Compose-Datei erneuern (Synology und Linux) {#kameras-compose}

Live-Bild und Clips macht der neue Dienst `kameras` neben dem Gateway (ein kleiner Container mit ffmpeg, ohne Rechte und ohne offenen Port). Den bekommt ein Gateway auf **Synology** oder **Linux/Docker** nur mit der neuen Compose-Datei. Ohne ihn gehen Suche, Testbild und Bewegungsmeldungen schon, Live-Bild und Clips aber nicht.

1. In GateControl: **Gateways** › dein Gateway › **Funktionen** › „Geräte im Heimnetz“ › Zeile **„Kameras“** › **„docker-compose.yml herunterladen“**. Das erzeugt keine neuen Schlüssel – lade **nicht** das ganze Paket oder die `gateway.env` neu herunter.
2. **Synology:** File Station › `docker/gatecontrol-gateway` › die alte `docker-compose.yml` sichern. Container Manager › **Projekt** › `gatecontrol-gateway` › **Stoppen**, im Reiter „YAML-Konfiguration“ den Inhalt durch die neue Datei ersetzen, speichern, das Projekt **neu erstellen und starten**.
3. **Linux/Docker:** im Ordner des Gateways (meist `/opt/gatecontrol-gateway`) die alte Datei sichern, die neue hineinlegen und `sudo docker compose up -d` ausführen.
4. Prüfen: Im Container Manager bzw. mit `sudo docker compose ps` läuft jetzt auch der Dienst `kameras`.

**Clips auf einem freigegebenen Ordner (optional):** Ohne weitere Angabe landen die Clips im Docker-Volume `cam-recordings`. Auf der Synology kannst du sie in einen Ordner der NAS legen: Ordner anlegen (z. B. `/volume1/kameras` in der File Station), dann in GateControl **Gateways** › dein Gateway › **Funktionen** › Zeile „Kameras“ › **„Speicherort und Netze“** › „Speicherort für Clips“ eintragen (GateControl ≥ 1.242.0) und danach die Compose-Datei wie oben herunterladen und das Projekt neu erstellen. Die Zeile zeigt „Clips im Ordner /volume1/kameras“; solange das Gateway noch den alten Speicher nutzt, steht dort „gilt erst mit der neuen Compose-Datei“. Ältere GateControl-Versionen: neben der Compose-Datei eine Datei `.env` mit der Zeile `GC_CAMERA_DIR=/volume1/kameras` anlegen.

**Raspberry Pi:** Das Pi-Image pflegt seine Compose-Datei selbst. Den Dienst `kameras` bringt erst das **neue Pi-Image** mit; damit startet er von selbst, sobald du die Kameras einschaltest.

Hattest du in der alten Compose-Datei eigene Änderungen (z. B. einen anderen Ordner), übernimm sie in die neue Datei.

### Schritt 3: „Kameras“ am Gateway einschalten

**Gateways** › dein Gateway › **Funktionen** › „Geräte im Heimnetz“ › **„Kameras“** einschalten. Auf einem Raspberry Pi steht dort ein Hinweis, wie viele Kameras mit Bewegungserkennung er schafft (Pi 3 B+: eine, Pi 4: vier) – einschalten geht trotzdem.

### Schritt 4: ONVIF und RTSP an der Kamera einschalten {#kameras-onvif}

Das Gateway erreicht eine Kamera nur über ONVIF oder RTSP. Beides ist bei vielen Kameras ab Werk aus.

- **Reolink:** in der Reolink-App oder der Weboberfläche › Einstellungen › **Netzwerk › Erweitert › Server-Einstellungen** › **ONVIF** und **RTSP** einschalten. Der ONVIF-Port ist meist **8000**.
- **Tapo:** in der **Tapo-App** › Kamera › Kamera-Einstellungen › **Erweitert › Kamera-Konto** anlegen. Benutzer und Passwort dieses Kontos trägst du später in GateControl ein – **nicht** dein TP-Link-Konto. Der ONVIF-Port ist **2020**.
- **Andere Kameras:** im Handbuch der Kamera nach „ONVIF“ oder „RTSP“ suchen.

Die Kamera braucht eine **private IPv4-Adresse** (z. B. 192.168.x.x) im Heimnetz des Gateways. Kameras in einem anderen Netz (etwa einem eigenen Kamera-VLAN) erreicht das Gateway nur, wenn das Netz in GateControl unter **Gateways** › dein Gateway › **Funktionen** › „Kameras“ › **„Speicherort und Netze“** › „Weitere Netze für die Kamera-Suche“ steht (z. B. `192.168.20.0/24`). Am besten gibst du der Kamera im Router eine feste Adresse.

### Schritt 5: Kamera hinzufügen

1. Im Plugin auf **„Geräte“** › Karte „Kameras“ › **„Kamera hinzufügen“**.
2. Das Gateway sucht Kameras im Heimnetz, z. B. „Reolink E1 Zoom · 192.168.1.73 · ONVIF – neu gefunden“. Wähle eine aus – oder **„Adresse selbst eingeben“** mit `rtsp://…` oder nur der IP-Adresse (z. B. `rtsp://192.168.1.80:554/stream1` oder `192.168.1.80`).
3. **Gateway**, **Name** (z. B. „Einfahrt“), **Benutzer der Kamera** und **Passwort der Kamera** eintragen.
4. **„Verbinden und testen“.** Erst wenn ein Testbild kommt, ist die Kamera gespeichert.

**Kameras mit HTTPS** (ab 1.7.0, GateControl ≥ 1.242.0, Gateway ≥ 1.29.0): Bietet die Kamera ONVIF nur verschlüsselt an, setze **„HTTPS“** (ohne Haken probiert das Gateway am Ende auch Port 443). Das Zertifikat der Kamera wird **immer geprüft**. Die meisten Kameras haben ein selbst signiertes Zertifikat – dann kommt „Das Zertifikat der Kamera ist nicht vertrauenswürdig“. Nur wenn du der Kamera in deinem Heimnetz vertraust, setze **„Zertifikat nicht prüfen“** und verbinde noch einmal. Die Verbindung bleibt verschlüsselt; unter „Aufnahmen“ kannst du den Haken später wieder entfernen.

Das Passwort liegt verschlüsselt in GateControl und geht nur an das Gateway. Pro Gateway gehen höchstens 16 Kameras.

### Schritt 6: Aufnahmen einstellen

Auf **„Geräte“** › **„Aufnahmen“**, je Kamera:

- **Clips aufnehmen:** „bei Bewegung (Personen, Autos, Tiere)“, „bei Bewegung, nur wenn niemand zu Hause ist“ oder „nie – nur Live-Bild“. „Niemand zu Hause“ kommt aus der Anwesenheit der Familie. Ist die unbekannt, nimmt das Gateway in diesem Modus nicht auf.
- Bewegung, Personen, Autos und Tiere erkennt die **Kamera selbst** (ONVIF-Ereignisse) – das Gateway rechnet nichts nach.
- **Speichern auf:** das Gateway mit seinem freien Platz.
- **Aufbewahren:** 7, 14 (Standard) oder 30 Tage.
- **Push mit Standbild bei Personen** – höchstens einmal pro Kamera alle 5 Minuten.
- **Ton aufnehmen** (Standard aus). Gespräche aufzuzeichnen ist nur mit Einverständnis aller erlaubt. „Ton“ im Portal und in der App gibt es nur, wenn der Ton an ist und die Kamera Ton liefert.
- **Zertifikat nicht prüfen** (nur bei Kameras mit HTTPS).

Ein Clip beginnt 5 Sekunden vor der Bewegung und endet 10 Sekunden danach, höchstens 2 Minuten. Bei weniger als 1 GB freiem Platz nimmt das Gateway nichts Neues auf.

### Schritt 7: Festlegen, wer die Kamera sieht

Auf **„Berechtigungen“** hat jede Heimnetz-Kamera eine Spalte **„sieht“**. Nur Personen mit Haken sehen die Kamera in Portal und App, finden ihre Clips und bekommen ihren Push. Das gilt auch für Administratoren: Ohne Haken sehen auch sie die Kamera nur auf den Admin-Seiten.

## Automatisch aufsperren bei Ankunft

1. Auf **„Berechtigungen“** für die Person mindestens „zu-/aufsperren“ geben und **„Automatisch aufsperren bei Ankunft erlauben“** ankreuzen.
2. Im Plugin Familie › Anwesenheit & Smart Home › neue Regel **„Person kommt heim“** (Person wählen) › Aktion **„Haustür aufsperren“** (Tür & Kamera).

Die Regel läuft als die Person, die ihre Aktionen festgelegt hat – deren Rechte gelten. Das Plugin sperrt nur auf, wenn alles stimmt: nur „aufsperren“ (öffnen nie automatisch), im Zeitfenster, höchstens alle 10 Minuten, Schloss erreichbar und zugesperrt, Tür zu (mit Türsensor). Sonst lehnt es ab und schreibt den Grund in Verlauf und Mitteilung. Wird die Tür danach 3 Minuten nicht geöffnet, sperrt es mit Türsensor wieder zu; ohne Türsensor fragt eine Mitteilung „Zusperren“.

> **Hinweis:** „Zuhause“ heißt: das Handy ist im WLAN des Heimnetzes. Das kann auch vor der Haustür oder beim Nachbarn so sein. Schalte es nur für Personen ein, die das wollen, am besten mit Türsensor und Zeitfenster. Tipp: Regel „Alle sind unterwegs“ › Aktion „Haustür zusperren“.

## Ring-Modus

Wie in der Ring-App unter „Modi“: Welche Kameras in welchem Modus aufnehmen, legst du in der Ring-App fest. Das Plugin zeigt und schaltet nur den Modus. Die Modi müssen für den Standort in der Ring-App eingeschaltet sein.

- Schalten auf „Geräte“ › Ring-Modus, im Portal, über die Start-Kachel und die Schnellaktionen der App (Schalter Zuhause ⇄ Abwesend und Knopf „Inaktiv“).
- In Regeln der Familie, z. B. „Alle sind unterwegs“ › „Abwesend“ und „Erste Person kommt heim“ › „Zuhause“.
- Recht „Ring-Modus schalten“ je Person und Standort auf „Berechtigungen“. Administratoren dürfen immer.
- Standorte mit einer Ring-Alarmanlage schaltet das Plugin nie – dort gehört der Modus der Alarmanlage.

## Benutzen

### Portal und App

Im Portal-Tab und im App-Tab **„Tür“** siehst du die Schlösser, die für dich freigegeben sind, mit Zustand, Batterie und Knöpfen für die Aktionen, die du darfst. Dazu die Kameras, den Verlauf und – mit Recht – den Ring-Modus. Ohne Anmeldung (z. B. ein Kiosk-Gerät) kannst du nur ansehen.

Die App bietet außerdem Schnellaktionen und ein Widget für deine Schlösser und den Ring-Modus.

### Kameras im Portal

- Jede Heimnetz-Kamera, die du sehen darfst, mit Standbild, Auflösung (z. B. 2560×1440) und „mit Ton“.
- **Live-Bild** („● LIVE · HD · über VPN“) nur, wenn das Handy oder der PC im **VPN** ist (oder im selben Netz wie der Server). Ohne VPN zeigt die App alle 10 Sekunden ein neues Standbild. Ab 1.7.0 (GateControl ≥ 1.242.0) läuft das Live-Bild auch in **Firefox** und in Chrome/Edge am PC (über den Player von GateControl).
- **„Push bei Personen an mich“** je Kamera: schaltet den Push „Personen an der Kamera“ nur für dich ab oder wieder an (ab 1.7.0, auch in den Apps).
- **„Standbild“** (speichern), **„Vollbild“**, **„Ton“**.
- **„Clips heute“** mit Vorschaubild und die **„Letzte Meldung“**.
- Ring-Kameras zeigen das letzte Bild aus der Ring-Cloud.

### Mitteilungen

| Thema | Wann |
|---|---|
| Klingel | es klingelt – mit Bild, bei Recht „auch öffnen“ mit „Tür öffnen“ |
| Bewegung an der Kamera (Standard aus) | Ring meldet Bewegung, höchstens alle paar Minuten pro Kamera |
| Personen an der Kamera (Heimnetz) | eine Heimnetz-Kamera erkennt eine Person – mit Standbild, „Niemand ist zu Hause“, wenn niemand da ist, und dem Knopf **„Ansehen“** (öffnet die Kamera in der App). Je Kamera für dich abschaltbar |
| Tür & Schloss | offen zu lange, blockiert, nicht erreichbar, Batterie kritisch, Nachtkontrolle |
| Automatisches Aufsperren | aufgesperrt, abgelehnt, wieder zugesperrt, Rückfrage |

Welche Themen du bekommst, stellst du in den Mitteilungs-Einstellungen von GateControl ein.

## Berechtigungen

Auf der Seite **„Berechtigungen“**, je Person:

- je **Schloss**: keine / ansehen / zu-/aufsperren / auch öffnen, optional ein **Wochen-Zeitfenster** (über Mitternacht gehört es zum Starttag).
- **Automatisch aufsperren bei Ankunft erlauben.**
- je **Ring-Kamera**: Klingel- und Bewegungs-Push. Kameras an einem Schloss folgen den Rechten des Schlosses; Kameras ohne Schloss gibst du mit Haken frei.
- je **Heimnetz-Kamera**: „sieht“.
- je **Ring-Standort**: „Ring-Modus schalten“.

**Administratoren bekommen auf Schlösser nichts automatisch** – auch du musst dir die Rechte geben. Kiosk-Geräte und Portal-Besucher, die nur über Geräte-Vertrauen erkannt sind, sehen nur. Jede Aktion prüft der Server noch einmal (Recht, Zeitfenster, höchstens 10 pro Minute) und schreibt sie in den Verlauf – auch abgelehnte.

## Häufige Fragen / Fehlersuche

**Das Schloss zeigt „Zustand unklar – zuletzt: Zugesperrt“.**
Bridge oder Nuki Web hängen auf einem Zwischenzustand („Sperrt auf …“). Das Plugin fragt dann das Schloss selbst ab. Bei Nuki Web ist das Schloss oft nicht mit dem Internet verbunden – in der Nuki-App prüfen oder die Bridge verwenden. Die Seite „Geräte“ zeigt unter „Diagnose“ die rohen Werte; schick sie mit, wenn du Hilfe brauchst.

**Ein Klingeln kommt spät an.**
Das Plugin fragt Ring alle 5 Sekunden ab; rechne mit 5 bis 15 Sekunden, das Bild bis zu 8 Sekunden später. Schränkt Ring die Sofort-Abfrage für dein Konto ein, sind es 15 bis 60 Sekunden. Die Klingel-Diagnose auf „Einstellungen“ zeigt, was passiert ist.

**Ein Klingeln erreicht niemanden.**
Die Seite „Einstellungen“ warnt, wenn „Ring abfragen“ aus ist oder eine Kamera von niemandem gesehen wird. Verknüpfe die Kamera mit einem Schloss oder setze auf „Berechtigungen“ Haken.

**„Kamera hinzufügen“ findet meine Kamera nicht.**
ONVIF ist an der Kamera noch aus ([Schritt 4](#kameras-onvif)), oder die Kamera ist in einem anderen Netz als das Gateway. Gib die Adresse selbst ein (`rtsp://…` oder die IP-Adresse).

**„Die Kamera hat Benutzer oder Passwort abgelehnt.“**
Bei Tapo brauchst du das Kamera-Konto aus der Tapo-App, nicht dein TP-Link-Konto. Bei Reolink den Benutzer der Kamera (meist `admin`).

**„Diese Adresse liegt nicht im Heimnetz des Gateways.“**
Das Gateway verbindet sich nur mit privaten IPv4-Adressen in seinem eigenen Netz (oder in Netzen, die in seinen Einstellungen stehen).

**„Live-Bild und Clips brauchen den Dienst „kameras““.**
Die Compose-Datei des Gateways ist noch die alte – siehe [Schritt 2](#kameras-compose).

**Ich sehe kein Live-Video, nur alle 10 Sekunden ein Bild.**
Das Live-Video gibt es nur im VPN oder im Heimnetz des Servers. Schalte in der GateControl-App das VPN ein. Bei Kameras mit H.265 spielen manche Browser das Video nicht ab (Safari und iOS schon) – stell die Kamera dann in ihren eigenen Einstellungen auf H.264.

**„Das Zertifikat der Kamera ist nicht vertrauenswürdig.“**
Die Kamera spricht HTTPS mit einem selbst signierten Zertifikat. Vertraust du ihr, setze beim Hinzufügen (oder unter „Aufnahmen“) „Zertifikat nicht prüfen“.

**Das Live-Bild bleibt in Firefox schwarz.**
Firefox spielt das Live-Bild ab GateControl 1.242.0 über den eingebauten Player. Kameras mit H.265 kann Firefox nicht abspielen – stell die Kamera auf H.264 (Unterstrom).

**Es werden keine Clips aufgenommen.**
Prüfe unter „Aufnahmen“ den Modus. Bei „nur wenn niemand zu Hause ist“ muss die Anwesenheit der Familie bekannt sein. Unter 1 GB freiem Platz nimmt das Gateway nichts auf.

## Neu in 1.7.2

- **Schnelleres Aufräumen der Bilder:** Tür löscht abgelaufene Kamerabilder jede Stunde. Bisher wurden dabei alle gespeicherten Bilder gelesen – auch beim Öffnen von App und Portal. Jetzt wird nur noch gelesen, was wirklich gelöscht oder angezeigt wird. Auf einem langsamen Datenträger (NAS mit Festplatten) bleibt GateControl dadurch flüssiger. Deine Bilder und der Verlauf bleiben unverändert.

## Neu in 1.7.1

- **Weniger Schreibarbeit:** Tür speichert den Zustand eines Schlosses nur noch, wenn er sich geändert hat, sonst alle 5 Minuten. Angezeigt wird trotzdem immer die letzte Abfrage. Auf einem langsamen Datenträger (NAS mit Festplatten) bleibt GateControl dadurch flüssiger.

## Neu in 1.7.0

- **Push „Personen an der Kamera“ mit „Ansehen“** – öffnet in der App genau diese Kamera. Jede Person kann den Push je Kamera **für sich** abschalten („Push bei Personen an mich“ im Portal und in den Apps).
- **Auflösung und Ton** in der Kameraliste (z. B. „2560×1440 · mit Ton“); „Ton“ nur, wenn die Kamera Ton liefert.
- **Kameras mit HTTPS:** „HTTPS“ und „Zertifikat nicht prüfen“ beim Hinzufügen und unter „Aufnahmen“. Standard: das Zertifikat wird geprüft (GateControl ≥ 1.242.0, Gateway ≥ 1.29.0).
- **Live-Bild in Firefox** und in Chrome/Edge am PC über den Player von GateControl (≥ 1.242.0).
- Speicherort der Clips und weitere Netze stellst du jetzt in GateControl ein (Gateway › Funktionen › Kameras › „Speicherort und Netze“).

## Neu in 1.6.1

- Dieses Handbuch im Reiter „Handbuch“ (GateControl ≥ 1.241.0), mit dem Kapitel [Kameras im Heimnetz einrichten](#kameras-einrichten).
- Hinweise oben auf der Plugin-Seite, solange ein Gateway mit „Kameras“ die neue Compose-Datei noch nicht hat und bis du ONVIF/RTSP an den Kameras eingeschaltet hast.

Zuletzt in 1.6.0: Kameras im Heimnetz (ONVIF/RTSP) über die Gateways – Live-Bild über VPN, Clips bei Bewegung, Push mit Standbild bei Personen, Spalte „sieht“ je Kamera auf „Berechtigungen“.
