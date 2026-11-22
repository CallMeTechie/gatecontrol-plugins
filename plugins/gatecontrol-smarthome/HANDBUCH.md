<!-- version: 1.18.0 -->
# Smart Home

## Was das Plugin kann

- **Phoscon/deCONZ-Gateways** einbinden (z. B. ConBee oder RaspBee): Lichter, Steckdosen, Gruppen, Szenen, Sensoren und Schalter. Ein/Aus, Helligkeit, Farbe, Farbtemperatur, Szenen.
- **Shelly und Tasmota** über ein GateControl-Gateway im Heimnetz (ab 1.7.0): Schalter mit Leistungsmessung, Dimmer, Rollläden, Markisen und Tore, Temperatur- und Feuchtesensoren – ohne Hersteller-Cloud.
- **Bluetooth-Sensoren** über ein GateControl-Gateway (ab 1.8.0): Thermometer und Sensoren, die du in GateControl unter Funk übernommen hast – auch verschlüsselte, wenn ihr Schlüssel dort eingetragen ist.
- **Zigbee-Geräte von zigbee2mqtt** über ein GateControl-Gateway (ab 1.9.0): Lichter, Steckdosen, Rollläden, Sensoren und Taster, die du in GateControl unter Funk mit zigbee2mqtt angelernt hast. Ab 1.10.0 auch Schalter mit mehreren Kanälen, Thermostate und Firmware-Updates.
- **Besitzer und Bereiche:** Du weist Geräte Personen zu. Diese Personen bedienen sie im Portal „Zuhause“ und in der App.
- **Logikketten:** für deCONZ auf dem deCONZ-Gateway; für Shelly und Tasmota auf dem GateControl-Gateway (ab 1.10.0) – seit 1.11.0 mit Tastern, Uhrzeit, Bedingungen mit UND/ODER, Schritten mit Wartezeiten, Testlauf und Protokoll; seit 1.12.0 mit Sonnenauf-/untergang, „seit X min“, Ketten über mehrere Gateways (am Server), Mitteilungen und Schnellaktionen in der App; seit 1.15.0 auch mit Geräten von zigbee2mqtt am Gateway, sobald ein Admin das für das Gateway bestätigt hat.
- **Heizung** (ab 1.14.0): Heizkörper-Thermostate von zigbee2mqtt, deCONZ und – ab 1.17.0 – Shelly TRV und Shelly BLU TRV je Raum mit Presets, Wochenplänen, Boost, „Fenster offen“, Urlaub und „Heizung abwesend“ ([Heizung](#heizung)). Hängen alle Thermostate eines Raums an einem Gateway (Shelly TRV, BLU TRV, ab 1.18.0 auch zigbee2mqtt nach Bestätigung), läuft sein Plan dort – auch ohne Server.
- **Mitteilungen:** Alarm (Wasser, Rauch, CO), Fenster lange offen, Batterie schwach, Gateway nicht erreichbar.
- **Schnellaktionen und Widgets** in den GateControl-Apps für die eigenen Geräte – seit 1.13.0 mit dem Batteriestand von Batteriegeräten.

## Voraussetzungen

- GateControl **1.317.0** oder neuer (seit 1.15.0).
- Für deCONZ: ein Phoscon/deCONZ-Gateway, das GateControl erreicht (über eine Route, ein VPN-Gerät oder eine Adresse).
- Für Shelly und Tasmota: ein GateControl-Gateway **1.19.0** oder neuer im selben Heimnetz, mit den Diensten `edge` und `mqtt` in seiner Compose-Datei.
- Für Bluetooth-Sensoren: ein GateControl mit Funk (Reiter „Funk“ beim Gateway) und ein Gateway mit Bluetooth.
- Für zigbee2mqtt: ein GateControl, das zigbee2mqtt kennt, und ein Gateway nach 1.30.0 mit „zigbee2mqtt“ im Reiter „Funk“ (dafür sind Edge und MQTT des Gateways an). Für mehrere Kanäle, Thermostate und Firmware-Updates: GateControl nach 1.258.4 und ein Gateway nach 1.34.2.
- Für zigbee2mqtt in Logikketten am Gateway (ab 1.15.0): ab Gateway 1.46.0 und die Bestätigung unter **Gateways › Gateway › Edge-Plugins** ([zigbee2mqtt am Gateway](#logikketten-z2m)).

## Einrichten

### Phoscon/deCONZ verbinden

1. **Zugriffsziel zuweisen:** **Einstellungen › Plugins › Smart Home › Einstellungen › Zugriffsziele** › dem Ziel „Phoscon/deCONZ-Gateway“ dein Gateway zuweisen (Route, VPN-Gerät oder Adresse). Für mehrere Gateways weist du das Ziel mehrfach zu.
2. In **Phoscon** › Einstellungen › Gateway › Erweitert › **„App authentifizieren“** drücken. Danach hast du 60 Sekunden.
3. Im Plugin › **„Quelle hinzufügen“** › **„Phoscon verbinden“**: Name und Zugriffsziel wählen. Das Feld **API-Key** leer lassen – GateControl holt den Key dann selbst. Hast du schon einen Key, kannst du ihn eintragen.
4. **„Verbindung testen“** und **„Synchronisieren“**. Danach stehen Lichter, Steckdosen, Gruppen, Szenen, Sensoren und Schalter auf der Seite.

Der API-Key wird verschlüsselt gespeichert.

### Shelly und Tasmota über ein Gateway {#shelly-tasmota}

1. **Compose-Datei prüfen:** Das Gateway braucht die Dienste `edge` und `mqtt` (Gateway ab 1.19.0). Fehlen sie, steht auf der Gateway-Seite „Edge-Dienst fehlt“ mit dem Knopf „docker-compose.yml herunterladen“. Neue Datei einsetzen und das Projekt neu erstellen. Das Raspberry-Pi-Image pflegt seine Compose-Datei selbst.
2. **MQTT einschalten:** **Gateways** › dein Gateway › **MQTT**.
3. **Edge-Teil einschalten:** **Gateways** › dein Gateway › **Edge-Plugins** › „Smart Home“ einschalten.
4. Im Plugin › **„Quelle hinzufügen“**: Je Gateway steht dort, ob der Edge-Teil läuft und der MQTT-Broker an ist.
5. **„Gerät hinzufügen“:** Das Gateway sucht Shelly- und Tasmota-Geräte im Heimnetz. Wähle eines, gib Name und Bereich ein und klicke **„Automatisch einrichten“**. Hat das Gerät ein Passwort, fragt GateControl einmal danach (es wird nicht gespeichert). GateControl legt ein eigenes MQTT-Konto für das Gerät an, trägt es im Gerät ein und startet es neu.
6. Geräte, die nicht in der Liste stehen (z. B. ein schlafender Shelly H&T), richtest du **„Von Hand …“** ein: GateControl zeigt Server, Benutzer, Passwort und Präfix zum Kopieren und eine Anleitung je Gerätetyp. Das Passwort siehst du nur in diesem Fenster.
7. **Anderer Benutzername am Gerät:** Fragt GateControl nach dem Gerätepasswort, steht darüber das Feld „Benutzername am Gerät“ (Shelly der ersten Generation und Tasmota). Voreingestellt ist `admin`; hast du am Gerät einen anderen Namen vergeben, trägst du ihn hier ein. GateControl merkt sich den Namen beim Gerät, das Passwort nicht. Später änderst du ihn unter **„Bearbeiten“ › Verbindung**. Shelly ab der zweiten Generation kennen nur `admin`.

GateControl ändert am Gerät nur die MQTT-Einstellungen. Cloud, WLAN und Zeitpläne bleiben, wie sie sind.

**Heizkörper-Thermostate (ab 1.17.0):** Ein **Shelly TRV** richtest du wie jedes Shelly-Gerät ein. Ein **Shelly BLU TRV** kommt über ein **Shelly BLU Gateway Gen3**: Richte das BLU Gateway hier ein und koppel die BLU TRVs in der Shelly-App mit dem BLU Gateway – jedes gekoppelte TRV erscheint dann als eigenes Thermostat. Die Thermostate stehen danach unter **Heizung** ([Heizung](#heizung)); ihr Soll stellst du dort, nicht auf der Gerätekarte.

### Bluetooth-Sensoren

1. In GateControl beim Gateway im Reiter **„Funk“** den Sensor anlernen und **übernehmen** (BTHome, Xiaomi mit ATC/pvvx-Firmware, Shelly BLU).
2. Der Sensor erscheint im Plugin unter der Quelle „Funk (GateControl-Gateway)“ mit Temperatur, Feuchte und Batterie. Gibst du ihn in GateControl zurück, verschwindet er hier.
3. Sendet er verschlüsselt (BTHome mit Schlüssel, Xiaomi-Originalfirmware), trägst du seinen Schlüssel in GateControl beim Sensor ein – danach kommen seine Werte auch hier an.

### Zigbee-Geräte von zigbee2mqtt {#zigbee2mqtt}

1. In GateControl beim Gateway im Reiter **„Funk“** als Zigbee-Dienst **„zigbee2mqtt“** wählen und mit **„Anlernen starten“** die Geräte koppeln.
2. Die Geräte erscheinen von selbst im Plugin unter der Quelle „Funk (GateControl-Gateway)“ des Gateways: Lichter mit Helligkeit, Farbe und Farbtemperatur, Steckdosen und Schalter, Rollläden (Auf / Stopp / Zu), Sensoren und Taster.
3. Besitzer, Bereich und Name gibst du wie bei den anderen Geräten. Ein Name, den du hier vergibst, bleibt; sonst gilt der Name aus zigbee2mqtt.
4. Entfernst du ein Gerät in GateControl aus dem Zigbee-Netz, wird es hier ausgeblendet – seine Besitzer bleiben, falls es wiederkommt.
5. **Mehrere Kanäle:** Ein 2- oder 3-fach-Schalter steht als eine Karte je Kanal da („Kanal 1“, „Kanal 2“ …). Jeder Kanal hat eigenen Namen, Bereich und Besitzer und wird einzeln geschaltet. Seit 1.13.0 wählst du je Kanal unter **„Besitzer verwalten“ › Art**, wofür er steht: Licht, Steckdose oder Schalter. Das ändert Symbol, Begriffe und die Schnellaktion der Apps, nicht das Gerät; ein Kanal wird nur ein- und ausgeschaltet, nie gedimmt.
6. **Thermostate:** Die Karte zeigt Ist- und Soll-Temperatur. Das Soll stellst du mit dem Regler, den Modus (Aus, Heizen, Automatik) mit den Knöpfen darunter. Zugewiesene Personen stellen das Soll im Portal mit − und +.
7. **Firmware-Updates:** Kann ein Gerät Updates über Funk, steht unten auf seiner Karte „Firmware“. **„Nach Update suchen“** fragt zigbee2mqtt; gibt es eines, steht dort „Update verfügbar“ mit dem Knopf **„Aktualisieren“**. Ein Update dauert 10 bis 60 Minuten, die Karte zeigt den Fortschritt. Ein Batteriegerät muss dafür wach sein – betätige es einmal.

### Geräte zuweisen und benennen

- **„Besitzer verwalten“** (Dialog „Besitzer zuweisen“): welche Personen ein Gerät bedienen dürfen, und der **Bereich** (z. B. Wohnzimmer). Seite und Portal gruppieren nach Bereich.
- Im selben Dialog kannst du Lampen und Sensoren umbenennen. deCONZ-Geräte werden dabei direkt in deCONZ umbenannt, Geräte von zigbee2mqtt und Bluetooth-Sensoren hier.
- Bei Shelly und Tasmota legst du unter **„Bearbeiten“** außerdem die Art je Ausgang fest (Licht, Steckdose, Schalter) – bei einem Shelly 2PM, Pro 4PM oder Tasmota mit mehreren Relais für jeden Ausgang einzeln. Ein Paar als Rollladen, Markise oder Tor gibt es nur, wenn das Gerät selbst im Rollladen-Modus läuft. Die Art bestimmt Symbol, Begriffe und Schnellaktion; in Logikketten bleibt jeder Ausgang schaltbar, gedimmt wird nur ein Dimmer.
- Bei zigbee2mqtt-Geräten mit mehreren Kanälen wählst du die Art je Kanal im Dialog „Besitzer verwalten“ ([zigbee2mqtt](#zigbee2mqtt)).

### Einstellungen

Unter **Einstellungen › Plugins › Smart Home › Einstellungen**: Abfrageintervall (Sekunden), „Fenster offen“ nach … Minuten (Standard 15), „Batterie schwach“ unter … % (Standard 15), Sprache der Mitteilungen.

## Benutzen

- **Portal „Zuhause“:** Jede Person sieht dort die Geräte, die ihr zugewiesen sind – schalten, dimmen, Farbe, Szenen, Rollläden mit Auf / Stopp / Zu. Wer keine Geräte hat, sieht den Abschnitt nicht.
- **App:** Schnellaktionen (Startbildschirm, Schnelleinstellungen, Widget) für die eigenen Lampen, Steckdosen, Gruppen und Szenen, Rollläden mit Positionsregler, Leistung im Widget. Seit 1.13.0 zeigen Batteriegeräte ihren Batteriestand als kleines Symbol mit Prozentwert neben dem Namen – gelb ab der Einstellung „Batterie schwach“, rot ab 5 %. Sensoren mit Batterie (Shelly H&T, Zigbee-, Bluetooth-Sensoren) stehen als Karte mit ihrem Wert dabei; ein schlafender Shelly H&T zeigt den letzten Wert und wie alt er ist, nach mehr als 26 Stunden ohne Meldung „Batterie leer?“. Auf der Seite und im Portal steht dasselbe Batteriesymbol an der Karte.
- **Logikketten** (Seite „Logikketten“): Die Liste zeigt alle Quellen, nach Ort gruppiert. Regeln eines deCONZ-Gateways laufen auf diesem Gateway. Ketten für Shelly und Tasmota laufen auf dem GateControl-Gateway, an dem die Geräte hängen – siehe [Logikketten für Shelly und Tasmota](#logikketten-edge).
- **Regeln anderer Plugins** (z. B. Familie: „Alle weg → Licht aus“) schalten genau den gewünschten Zustand.

### Logikketten für Shelly und Tasmota {#logikketten-edge}

Die Seite **„Logikketten“** zeigt zuerst **alle Quellen**, nach Ort gruppiert. An jeder Kette steht, wo sie läuft: grün **„läuft am Gateway“** (Shelly und Tasmota, auch ohne Server), blau **„läuft auf deCONZ“** (wie bisher). Oben wählst du eine einzelne Quelle.

Eine Kette hat drei Teile:

1. **WENN – eines davon passiert** (ein Ereignis genügt): ein **Taster** (Taste 1–4: kurz, doppelt, dreifach, lang), ein Ausgang **geht an** oder **aus**, ein Rollladen **wird geöffnet** oder **geschlossen**, **Leistung**, **Temperatur** oder **Feuchte** steigen über oder fallen unter einen Wert, eine **Uhrzeit**.
2. **NUR WENN** (optional) – **alle (UND)** oder **eine (ODER)** dieser Bedingungen gilt gerade: ein Gerät ist an/aus/offen/geschlossen, ein Wert liegt über/unter, **Zeit zwischen** zwei Uhrzeiten, **Wochentage**.
3. **DANN – der Reihe nach:** **Schalten** (an, aus, Helligkeit, Rollladen Auf/Zu/Stopp/Position) und **Warten** (Sekunden, Minuten, Stunden; höchstens 24 Stunden je Schritt). Höchstens 20 Schritte.

Darunter legst du fest, was passiert, wenn die Kette **ausgelöst wird, während sie noch läuft**: von vorn starten (die Wartezeit beginnt neu – gut für „Licht 3 Minuten an“), ignorieren, oder ignorieren und **abbrechen, sobald „Nur wenn“ nicht mehr gilt**.

**Taster:** Shelly Gen1 (`input_event`) und Shelly ab Gen2 (Plus i4 und andere) melden Tastendrücke von selbst. **Tasmota** meldet sie nur mit `SetOption73 1` – wähle beim automatischen Einrichten **„Tasten als Taster für Logikketten melden“** oder setze es in der Konsole des Geräts. Die Taste schaltet das Relais dann nicht mehr selbst.

**Prüfung beim Speichern:** Würden sich zwei Ketten sicher gegenseitig hin- und herschalten (A schaltet X aus, B schaltet X wieder an, ohne „Nur wenn“), lässt sich die Kette nicht speichern. Eine mögliche Schleife wird als Hinweis gezeigt, ebenso andere Ketten, die dasselbe Gerät schalten.

**Bremsen am Gateway:** Läuft eine Kette mehr als 10-mal in einer Minute, hält das Gateway sie an. Sie steht dann rot umrandet mit dem Grund in der Liste; **„Wieder starten“** schaltet sie wieder ein. Auf ihre eigene Rückmeldung reagiert eine Kette 2 Sekunden lang nicht. Je Gateway gehen höchstens 60 Befehle pro Minute hinaus.

**Testlauf:** „Testen“ an einer Kette (oder „Testlauf“ im Editor) zeigt, ob die Bedingungen gerade gelten – mit den Werten vom Gateway. Er schaltet nichts. **„Trotzdem ausführen“** schaltet wirklich und überspringt „Nur wenn“; im Protokoll steht das als „von Hand“.

**Protokoll:** die letzten 200 Läufe je Gateway – Zeit, Kette, Auslöser, Ergebnis (ausgeführt, übersprungen, teilweise, abgebrochen, angehalten) und der Ablauf eines Laufs. Läufe, während der Server nicht erreichbar war, kommen nach („nachgereicht“), sobald das Gateway wieder verbunden ist.

Die Ketten laufen im Edge-Teil auf dem Gateway, auch wenn der Server gerade nicht erreichbar ist. Uhrzeiten gelten in der Zeitzone des Servers; das Gateway rechnet sie selbst. Je Gateway gehen höchstens 40 Ketten. Alle Geräte einer Kette müssen am selben Gateway hängen.

### zigbee2mqtt am Gateway (ab 1.15.0) {#logikketten-z2m}

Auch Geräte von zigbee2mqtt am selben Gateway – Lichter, Steckdosen, Schalter mit mehreren Kanälen, Rollläden, Kontakte, Bewegungsmelder, Wassersensoren und Fernbedienungen (als Taster) – können in einer Kette am Gateway stehen. Sie laufen dann wie Shelly und Tasmota auf dem Gateway, auch ohne Server. Thermostate gehören zur Heizung und stehen in keiner Kette am Gateway ([Plan am Gateway](#heizung-gateway)).

- **Bestätigung:** Dafür braucht der Edge-Teil zusätzlich das MQTT-Thema `zigbee2mqtt/#`. Das ist eine **optionale Fähigkeit**: Smart Home läuft auf allen Gateways ohne neue Bestätigung weiter, nur zigbee2mqtt in Ketten muss ein Admin je Gateway freigeben – unter **Gateways › Gateway › Edge-Plugins › Zusätzliche Rechte (optional)**.
- **Beim Speichern** einer Kette mit einem zigbee2mqtt-Gerät fragt Smart Home diese Freigabe an (Hinweis im Aktivitätsprotokoll, höchstens einmal am Tag). Die Kette wird gespeichert; der Editor und die Liste zeigen **„wartet auf Bestätigung“** mit dem Hinweis „Für zigbee2mqtt bitte unter Gateways › Gateway › Edge-Plugins bestätigen“ und dem Knopf **„Zum Gateway“**. Bis dahin laufen nur diese Ketten nicht – alle anderen Ketten des Gateways laufen weiter.
- **Nach der Bestätigung** bekommt das Gateway die Ketten innerhalb von etwa einer halben Minute; der Hinweis verschwindet. Nimmt ein Admin die Freigabe zurück, warten die Ketten wieder.
- **Ältere Gateways** (vor Gateway 1.46.0) kennen optionale Fähigkeiten noch nicht und lehnen `zigbee2mqtt/#` ab. Die Kette steht dann mit der Pille **„ab Gateway 1.46.0“** in der Liste; Shelly und Tasmota laufen weiter. Nach einem Update ab Gateway 1.46.0 geht es von selbst.
- Die Geräte heißen in zigbee2mqtt so, wie zigbee2mqtt sie nennt (`zigbee2mqtt/bridge/devices`); ein Umbenennen in zigbee2mqtt stört die Ketten nicht.
- Mit einem GateControl vor 1.317.0 stehen zigbee2mqtt-Geräte nur in [Ketten am Server](#logikketten-server) zur Verfügung.

**Bestehende Regeln (bis 1.10)** laufen unverändert weiter. Im Editor erscheinen ihre Auslöser als **„wird wahr: A und B“**; beim Speichern wird daraus eine Kette im neuen Format.

### Sonne, „seit X min“, andere Ketten, Mitteilungen (ab 1.12.0) {#logikketten-stufe-2}

- **Sonnenauf- und -untergang:** „+ Uhrzeit / Sonne“ löst bei Sonnenaufgang oder -untergang aus, mit Minuten davor (−) oder danach. Auch **„Zeit zwischen“** kennt die Sonne, z. B. „Sonnenuntergang–23:30“. Dafür braucht die Kette den **Standort des Gateways**: Fehlt er, zeigt der Editor einen Hinweis mit zwei Feldern für Breite und Länge (auf 0,01° gerundet, etwa 1 km). Ohne Standort löst „Sonne“ nie aus, und „Zeit zwischen“ mit Sonne gilt als offen. Der Testlauf zeigt die Sonnenzeit des Tages, z. B. „Sonnenuntergang (16:31)“.
- **„seit X min“:** Ein Zustand oder Wert muss so lange gelten – als Auslöser („Waschmaschine unter 5 W seit 3 min“) und als Bedingung („Stehlampe ist aus seit 10 min“). Steigt der Wert vorher wieder, passiert nichts. Nach einem Neustart des Gateways zählt die Zeit neu.
- **Kontakte, Bewegung, Wasser** (zigbee2mqtt, deCONZ, Bluetooth) sind Auslöser und Bedingungen in Ketten am Server („Kellertür wird geöffnet“, „Bewegung erkannt“) – zigbee2mqtt seit 1.15.0 auch am Gateway ([zigbee2mqtt am Gateway](#logikketten-z2m)).
- **Andere Kette starten:** Ein Schritt startet eine andere Kette desselben Orts. Sie prüft ihr eigenes „Nur wenn“. Ketten, die sich ohne „Nur wenn“ gegenseitig starten, lassen sich nicht speichern; mit „Nur wenn“ gibt es einen Hinweis. Eine Kette startet sich nicht selbst, und nach vier Ketten hintereinander ist Schluss.
- **Mitteilung senden:** Ein Schritt schickt eine Mitteilung über das Thema **„Logikketten“** (System › Benachrichtigungen) – an alle, die es abonniert haben, oder nur an die angehakten Personen. Den Versand übernimmt der Server: Eine Kette am Gateway schaltet auch ohne Server weiter, ihre Mitteilung kommt dann, sobald das Gateway wieder verbunden ist (bis zu einer Stunde). In der Liste steht dann „+ Mitteilung über Server“.

### Ketten über mehrere Gateways (läuft am Server) {#logikketten-server}

Wählst du im Editor als Ort **„Mehrere Gateways (über Server)“**, kannst du Geräte aller Gateways verbinden – auch deCONZ und Geräte von zigbee2mqtt (Lichter, Steckdosen, Rollläden, Sensoren) sowie Bluetooth-Sensoren. Geräte von zigbee2mqtt eines Gateways gehen seit 1.15.0 auch in Ketten an diesem Gateway ([zigbee2mqtt am Gateway](#logikketten-z2m)); hier verbindest du sie mit Geräten anderer Gateways. Die Box oben wird gelb, die Kette trägt die gelbe Pille **„läuft am Server“**. Solche Ketten laufen nicht offline: Ohne Server oder mit einem getrennten Gateway passiert nichts. Sie reagieren mit 2–3 Sekunden Verzögerung, deCONZ-Geräte mit dem Abfrageintervall. Taster gehen nur in Ketten an ihrem Gateway. Testlauf, Protokoll, Bremse und Schleifenprüfung gelten wie am Gateway. Für die Sonne nimmt der Server den eigenen Standort oder den eines Gateways.

### Von Hand (App): Ketten als Schnellaktion {#logikketten-app}

Der Auslöser **„+ Von Hand (App)“** macht eine Kette zur Schnellaktion „Starten“ in den GateControl-Apps (z. B. „Gute Nacht“). Administratoren dürfen sie immer starten; Personen aus dem Portal nur, wenn du sie im Editor dafür **freigibst**. „Nur wenn“ gilt auch beim Start aus der App. Im Protokoll steht der Lauf als „aus der App“.

## Heizung {#heizung}

Die Heizung findest du unter **Smart Home › Heizung** (Knopf oben auf der Seite). Sie steuert die Heizkörper-Thermostate von zigbee2mqtt, ab 1.14.0 auch von deCONZ (Soll-Temperatur und Modus) und ab 1.17.0 Shelly TRV und Shelly BLU TRV über ein GateControl-Gateway ([Shelly und Tasmota](#shelly-tasmota)).

### Räume

- Ein **Raum** ist der **Bereich** seiner Thermostate (Dialog „Besitzer verwalten“). Ein Thermostat ohne Bereich ist ein Raum für sich.
- Alle Thermostate eines Raums bekommen **ein gemeinsames Soll**. „Ist“ ist der Mittelwert der Thermostate.
- Fensterkontakte mit demselben Bereich gehören zum Raum.
- Die Übersicht zeigt je Raum Ist, was gerade gilt (Farbe des Presets; violett: von Hand; rot: Boost; gelb umrandet: Fenster offen oder Gerät nicht erreichbar) und den heutigen Plan. **„Öffnen“** führt zur Raumseite.

### Presets

- Es gibt vier feste Presets: **Komfort, Eco, Nacht, Frostschutz** (Vorgabe 21 / 18 / 17 / 7 °C).
- Die Temperaturen des Hauses stellst du unter **„Presets“** ein. Ein Plan oder ein Raum kann eigene haben; die des Raums gelten vor denen des Plans.
- **Boost** ist kein Preset, sondern eine Aktion für 15, 30 oder 60 Minuten. Kann das Thermostat selbst Boost (deCONZ mit Preset, Shelly TRV), nutzt GateControl das, sonst stellt es 30 °C (auch beim BLU TRV). Danach gilt wieder, was vorher galt.

### Wochenplan

1. **„Neuer Plan“** öffnet den Editor. Gib einen Namen ein, wähle eine Vorlage und die Räume, für die der Plan gilt. Ein Raum hat genau einen Plan.
2. Jeder Wochentag ist ein Balken aus Abschnitten. Tippe einen Abschnitt an und ändere **Von**, **Bis** und **Preset**. Schaltpunkte rasten auf 15 Minuten. **„Abschnitt teilen“** macht aus einem Abschnitt zwei, **„Tag kopieren nach …“** übernimmt den Tag für andere Tage.
3. Unter **Ausnahmen** stellst du „Fenster offen“ (nach 1, 2 oder 5 Minuten) und „Niemand zu Hause“ ein.
4. **„Plan speichern“** – der Plan schickt sofort, was jetzt gilt.

Der Plan **läuft am Server**: Etwa alle 30 Sekunden prüft er jeden Raum und schickt zu jedem Schaltpunkt das Soll. Ist der Server weg, halten die Thermostate das letzte Soll; ein verpasster Schaltpunkt wird nachgeholt, sobald der Server wieder da ist. Antwortet ein Thermostat nicht, versucht es der Plan nach 5 Minuten erneut; ein schlafendes Batteriegerät bekommt den Wert, sobald es wieder da ist.

Hat ein Thermostat einen **eigenen Wochenplan im Gerät** (Modus „Automatik“, deCONZ-Preset „auto“, Zeitplan an oder der Zeitplan eines Shelly TRV), zeigt der Editor einen Hinweis. Sobald der Plan sendet, stellt GateControl das Gerät auf „manuell“ bzw. „Heizen“. Der Plan im Gerät wird nicht gelöscht.

### Plan am Gateway (ab 1.17.0) {#heizung-gateway}

Sind alle Thermostate eines Raums Shelly TRV oder BLU TRV **desselben Gateways** (höchstens 8 je Raum, 24 Räume je Gateway), läuft der Plan dieses Raums **am Gateway**. Die Raumseite zeigt dann „Plan läuft am Gateway“.

**zigbee2mqtt-Thermostate (ab 1.18.0)** zählen auch dazu – allein oder zusammen mit Shelly TRV / BLU TRV desselben Gateways –, sobald ein Admin für dieses Gateway die zusätzliche Fähigkeit `zigbee2mqtt/#` unter **Gateways › Gateway › Edge-Plugins** bestätigt hat (dieselbe wie für [zigbee2mqtt am Gateway](#logikketten-z2m), ab Gateway 1.46.0). Ohne Bestätigung bleibt der Raum am Server wie bisher; nach der Bestätigung wechselt er spätestens nach einer Minute ans Gateway, ohne dass ein Soll doppelt geschickt wird. Am Gateway gilt: das Soll geht direkt an zigbee2mqtt (das Feld, das das Thermostat anbietet), **Aus** schaltet das Thermostat aus, wo es das kann (sonst Frostschutz), ein eigener Plan im Gerät („Automatik“) wird auf „Heizen“ gestellt, **Boost** stellt 30 °C.

- Das Gateway stellt die Thermostate zu jedem Schaltpunkt selbst – auch wenn der Server nicht erreichbar ist und auch nach einem Neustart des Gateways.
- Für diese Räume schickt **nur das Gateway** Befehle, der Server nie. Was du änderst (Plan, Presets, von Hand, Boost, Betrieb, Urlaub, „Heizung abwesend“), schickt der Server dem Gateway als neuen Plan; das Gateway setzt es sofort um. Kommt der Server nach einem Ausfall zurück, wird nichts doppelt geschickt.
- Eine Änderung von Hand gilt auch am Gateway bis zum nächsten Schaltpunkt, ein Boost bis zu seinem Ende.
- **Fenster offen** meldet der Server (Kontakte aller Quellen). Ist er weg, gilt ein offenes Fenster am Gateway höchstens noch 2 Stunden, danach wieder der Plan.
- Ohne Server kommen keine neuen Änderungen dazu; „Wird übertragen“ zeigt die Raumkarte, bis das Thermostat das neue Soll meldet. Ein Thermostat, das sein Soll nach drei Versuchen nicht meldet, bleibt bis zum nächsten Schaltpunkt in Ruhe – so wird ein Dreh am Gerät nicht überschrieben.
- Räume mit Thermostaten von deCONZ, mit Thermostaten an zwei Gateways oder mit zigbee2mqtt ohne Bestätigung laufen weiter am Server; ein Shelly TRV darin bekommt sein Soll über sein Gateway.

### Raumseite und Betrieb

- **− / +** ändert das Soll in halben Grad, ein **Preset** setzt seine Temperatur. Beides gilt **bis zum nächsten Schaltpunkt**; dann übernimmt wieder der Plan. **„Zurück zum Plan“** beendet es früher.
- **Betrieb:** **Nach Plan**, **Von Hand** (das Soll gilt auf Dauer, ohne Schaltpunkte) oder **Aus** (Modus „Aus“, wo das Thermostat ihn hat, sonst Frostschutz). Den Betrieb ändert nur ein Admin.
- **„Plan heute aussetzen“** hält das jetzige Soll bis Mitternacht.
- Ein Raum **ohne Plan** behält sein Soll; eine Änderung gilt dort auf Dauer.
- Unten stehen die Geräte des Raums mit Ist, Soll, Ventil und Batterie.

Was gilt, von oben nach unten: Aus · Fenster offen · Boost · Änderung von Hand · Urlaub · Von Hand · Plan (mit „Heizung abwesend“) · Soll eines Raums ohne Plan.

### Fenster offen

Ist ein Kontakt im Raum länger offen als im Plan eingestellt (Vorgabe 2 Minuten; ohne Plan immer 2 Minuten), stellt der Plan den Raum auf **Frostschutz**. Nach dem Schließen gilt wieder, was dann dran ist. Die Fenster-Erkennung im Thermostat bleibt an. Die Mitteilung „Fenster lange offen“ heißt dann **„Fenster offen, Heizung heruntergeregelt“**.

### Urlaub und Heizung abwesend

- **„Urlaub planen“:** Beginn, Rückkehr, Preset für alle Räume (Vorgabe Eco) und abweichend je Raum. Der Urlaub hat Vorrang vor den Plänen. **Vorheizen** (Vorgabe 4 Stunden): So lange vor der Rückkehr gelten wieder die Pläne, damit es warm ist. Nach der Rückkehr verschwindet der Urlaub von selbst.
- **„Heizung abwesend“** (Schalter oben, und als Schnellaktion für Admins in der App): Komfort wird in allen Räumen zu Eco, deren Plan „Niemand zu Hause“ erlaubt. Die Familie-Regeln „Alle weg“ / „Erste Person kommt“ können ihn schalten, wenn du die Schnellaktion dort auswählst.

### Wer darf was

- **Admins:** alles – Pläne, Presets des Hauses, Urlaub, Betrieb, Obergrenzen.
- **Zugewiesene Personen** (wem ein Thermostat des Raums zugewiesen ist) sehen den Raum im Portal „Zuhause“ und in der App und ändern dort Soll, Preset und Boost.
- Unter **„Raum einstellen“** legst du eine **Obergrenze** fest (z. B. Kinderzimmer höchstens 22 °C). Sie gilt für zugewiesene Personen im Portal und in der App (der Regler geht nicht höher); Boost gibt es für sie in diesem Raum dann nicht.

### In der App

Jeder Raum ist eine Karte: Ist-Temperatur, Ventil, Fenster, Feuchte und Batterie, darunter der Plan als Text („Komfort · nach Plan bis 08:00, dann Eco 18,0 °C“), das Soll mit − / + in halben Grad, die vier Presets und ein Tagesbalken mit dem heutigen Plan (je Preset eine Farbe, eine Marke für jetzt). Daneben die Knöpfe **Boost 30 min** / **Boost beenden** und **Zurück zum Plan**, wenn es passt. Gilt gerade kein Preset (Boost, von Hand, Fenster offen, Aus), ist keines der vier hervorgehoben; was gilt, steht im Text. Bei offenem Fenster, wenn kein Thermostat antwortet oder der Raum aus ist, bleiben Soll und Presets sichtbar, sind aber gesperrt (grau) – der Grund steht im Text.

## Berechtigungen

- Administratoren richten Quellen und Geräte ein und weisen sie zu.
- Personen bedienen nur Geräte, die ihnen zugewiesen sind. Das prüft der Server bei jedem Schalten erneut.
- Heizung: Zugewiesene Personen ändern in ihren Räumen Soll, Preset und Boost (bis zur Obergrenze des Raums); Pläne, Presets des Hauses, Urlaub und Betrieb nur Admins ([Heizung](#heizung)).
- „Fenster offen“ geht an die Personen, denen der Sensor zugewiesen ist. Alarm, Batterie und Gateway gehen nach der Regel des Themas in den Mitteilungs-Einstellungen von GateControl.

## Häufige Fragen / Fehlersuche

**„Phoscon-Link-Fenster abgelaufen“.**
Drücke in Phoscon noch einmal „App authentifizieren“ und verbinde innerhalb von 60 Sekunden.

**„Noch kein Gateway mit dem Edge-Teil von „Smart Home““.**
Schalte ihn unter Gateways › dein Gateway › Edge-Plugins ein ([Shelly und Tasmota](#shelly-tasmota)).

**„Edge-Dienst fehlt“ oder „Edge-Container läuft nicht“.**
Die Compose-Datei des Gateways ist zu alt oder der Container ist gestoppt. Die Gateway-Seite zeigt, was zu tun ist.

**„MQTT-Broker ist aus“.**
Schalte MQTT unter Gateways › dein Gateway › MQTT ein. Der Edge-Teil verbindet sich danach von selbst.

**Ein Shelly oder Tasmota ist „nicht erreichbar“.**
Das Gerät hat sich abgemeldet oder seit 30 Minuten nichts gemeldet. Strom und WLAN prüfen.

**Ein Shelly H&T zeigt „schläft“.**
Das ist richtig so: Batteriegeräte wachen nur alle paar Stunden auf oder wenn sich der Wert ändert. Die Karte zeigt den letzten Wert und wann er kam. Meldet sich das Gerät länger als 26 Stunden nicht, fragt die Karte „Batterie leer?“. Unter dem Wert der Einstellung „Batterie schwach“ (Standard 15 %) steht ein Hinweis auf der Karte.

**Eine Kette für Shelly oder Tasmota löst nicht aus.**
Steht beim Gateway „nicht verbunden“, kommen Änderungen erst an, wenn es wieder da ist. Ist MQTT auf dem Gateway aus, kann die Kette nicht schalten. Ein Zustand löst nur beim Wechsel aus: Gilt er beim Anlegen schon, wartet die Kette auf das nächste Mal. Der **Testlauf** und das **Protokoll** zeigen, welche Bedingung gerade nicht gilt.

**Eine Kette mit Sonne löst nicht aus.**
Im Editor fehlt der Standort des Gateways (Hinweis unter WENN). Breite und Länge eintragen ([Sonne](#logikketten-stufe-2)).

**Ein Tasmota-Taster löst nichts aus.**
Tasmota meldet Tasten nur mit `SetOption73 1` (siehe [Logikketten](#logikketten-edge)).

**Eine Kette ist „angehalten“.**
Sie lief mehr als 10-mal in einer Minute – meist schaltet eine andere Kette dasselbe Gerät zurück. Prüfe die Ketten, dann „Wieder starten“.

**„Nach Update suchen“ meldet „Suche fehlgeschlagen“.**
Das Gerät schläft (Batteriegerät: einmal betätigen) oder zigbee2mqtt erreicht den Update-Server nicht – das Gateway braucht dafür Internet.

**Das automatische Einrichten scheitert.**
Richte das Gerät „Von Hand …“ ein. Die Anleitung steht im Fenster.

**Eine Kette mit zigbee2mqtt am Gateway läuft nicht („wartet auf Bestätigung“ / „ab Gateway 1.46.0“).**
„Wartet auf Bestätigung“: Ein Admin gibt unter **Gateways › Gateway › Edge-Plugins** die zusätzliche Fähigkeit `zigbee2mqtt/#` frei. „ab Gateway 1.46.0“: das Gateway aktualisieren – zigbee2mqtt in Ketten am Gateway gibt es ab Gateway 1.46.0 ([zigbee2mqtt am Gateway](#logikketten-z2m)).

**Ein Gerät von zigbee2mqtt lässt sich nicht schalten („zigbee2mqtt auf dem Gateway antwortet gerade nicht“).**
Im Reiter „Funk“ des Gateways nachsehen: Läuft zigbee2mqtt, sind Edge und MQTT an? Neue Geräte erscheinen spätestens nach einer halben Minute.

## Neu in 1.18.0

- **zigbee2mqtt-Thermostate im Plan am Gateway:** Hängen alle Thermostate eines Raums am selben Gateway (zigbee2mqtt und/oder Shelly TRV / BLU TRV), läuft sein Wochenplan dort – auch ohne Server ([Plan am Gateway](#heizung-gateway)).
- Für zigbee2mqtt braucht es die Bestätigung von `zigbee2mqtt/#` am Gateway (wie für Logikketten); ohne sie bleibt alles wie bisher am Server. Sonst braucht das Update keine neue Bestätigung.

## Neu in 1.17.0

- **Shelly TRV und Shelly BLU TRV** (über ein Shelly BLU Gateway Gen3) sind Thermostate der Heizung ([Shelly und Tasmota](#shelly-tasmota)).
- **Plan am Gateway:** Hängen alle Thermostate eines Raums an einem Gateway, läuft sein Wochenplan dort – auch ohne Server ([Plan am Gateway](#heizung-gateway)).
- Das Update braucht keine neue Bestätigung am Gateway: Smart Home nutzt dafür `shellies/#`, das schon freigegeben ist.

## Neu in 1.16.0

- **Heizung in der App:** Jede Raumkarte zeigt einen **Tagesbalken** mit dem heutigen Plan.
- Bei offenem Fenster oder wenn kein Thermostat antwortet, sind Soll und Presets **gesperrt** (grau) statt ausgeblendet; der Grund steht auf der Karte.
- Gilt gerade kein Preset (Boost, von Hand), ist keines hervorgehoben – den fünften Knopf („Boost“, „Von Hand“) gibt es nicht mehr.
- Braucht GateControl 1.317.1 und eine aktuelle App. Das Update braucht keine neue Bestätigung am Gateway.

## Neu in 1.15.0

- **zigbee2mqtt in Ketten am Gateway:** Lichter, Steckdosen, Rollläden, Kontakte, Bewegung, Wasser und Fernbedienungen von zigbee2mqtt laufen in Ketten am Gateway – auch ohne Server ([zigbee2mqtt am Gateway](#logikketten-z2m)).
- Dafür bestätigt ein Admin je Gateway die optionale Fähigkeit `zigbee2mqtt/#`; Smart Home fragt beim Speichern danach. Bis dahin laufen nur diese Ketten nicht.
- Das Update braucht keine neue Bestätigung am Gateway: Shelly, Tasmota, die bisherigen Ketten und die Heizung laufen ohne Unterbrechung weiter. Es braucht GateControl 1.317.0.

## Neu in 1.14.0

- **Heizung:** Räume aus den Bereichen der Thermostate, vier Presets, Wochenpläne, Boost, „Fenster offen“, Urlaub mit Vorheizen und „Heizung abwesend“; der Plan läuft am Server ([Heizung](#heizung)).
- **deCONZ-Thermostate** sind jetzt steuerbar (Soll und Modus), nicht nur Temperaturanzeige.
- **In der App** ist jeder Raum eine Karte mit Ist, Soll in halben Grad, Presets, Boost und „Zurück zum Plan“; Admins schalten dort „Heizung abwesend“.
- Die Mitteilung zu einem offenen Fenster heißt „Fenster offen, Heizung heruntergeregelt“, wenn die Heizung den Raum heruntergeregelt hat.
- Das Update braucht keine neue Bestätigung am Gateway.

## Neu in 1.13.0

- **Batteriestand in den Apps:** Batteriegeräte zeigen in Schnellaktionen und Widgets ein Batteriesymbol mit Prozentwert, gelb ab „Batterie schwach“, rot ab 5 %; Sensoren mit Batterie erscheinen als Karte. Der Shelly H&T zeigt den letzten Wert mit seinem Alter. Auf der Seite und im Portal steht ein kleines Batteriesymbol an der Karte; deCONZ-Sensoren liefern ihren Batteriestand jetzt mit.
- **Art je Kanal** auch bei zigbee2mqtt-Geräten mit mehreren Kanälen (Licht, Steckdose, Schalter). Bei Shelly und Tasmota gab es die Art je Ausgang schon.
- **Benutzername am Gerät** für Shelly der ersten Generation und Tasmota gibt es seit 1.10.0 ([Shelly und Tasmota](#shelly-tasmota)) – das Gerätepasswort wird weiterhin nur für den einen Vorgang benutzt und nie gespeichert.
- Das Update braucht keine neue Bestätigung am Gateway.

## Neu in 1.12.0

- **Logikketten, Stufe 2:** Sonnenauf- und -untergang mit Versatz (Standort des Gateways), „seit X min“, Kontakte und Bewegung, Schritte „Andere Kette starten“ und „Mitteilung senden“ ([Stufe 2](#logikketten-stufe-2)).
- **Ketten über mehrere Gateways** – auch mit deCONZ und zigbee2mqtt – laufen am Server, gelb gekennzeichnet ([läuft am Server](#logikketten-server)).
- Das Update braucht keine neue Bestätigung am Gateway: Shelly, Tasmota und die Ketten aus 1.11 laufen ohne Unterbrechung weiter.
- **Von Hand (App):** Ketten als Schnellaktion in den Apps; für Personen aus dem Portal nur nach Freigabe ([Schnellaktion](#logikketten-app)).

## Neu in 1.11.0

- **Logikketten, Stufe 1** (Shelly und Tasmota am GateControl-Gateway): Taster, Uhrzeit, Bedingungen mit UND/ODER, Schritte der Reihe nach mit Wartezeiten, Testlauf, Protokoll, Schutz vor Schleifen. Die Liste zeigt alle Quellen auf einen Blick ([Logikketten](#logikketten-edge)).
- Beim automatischen Einrichten eines Tasmota kannst du die Tasten als Taster melden lassen (`SetOption73`).

## Neu in 1.10.0

- **Logikketten für Shelly und Tasmota:** Auslöser, Bedingungen und Aktionen wie bei deCONZ – sie laufen auf dem GateControl-Gateway ([Logikketten für Shelly und Tasmota](#logikketten-edge)).
- **Shelly H&T und andere Batteriegeräte** zeigen „schläft – letzte Meldung vor …“ statt „nicht erreichbar“, dazu einen Hinweis bei schwacher Batterie.
- **Benutzername am Gerät:** Für Shelly der ersten Generation und Tasmota stellst du einen anderen Namen als `admin` ein ([Shelly und Tasmota](#shelly-tasmota)).
- **zigbee2mqtt:** Schalter mit mehreren Kanälen, Thermostate und Firmware-Updates ([zigbee2mqtt](#zigbee2mqtt)). Dafür braucht es GateControl nach 1.258.4 und ein Gateway nach 1.34.2.
- Dialoge erscheinen jetzt im sichtbaren Bereich, auch wenn du weit unten auf der Seite bist.

## Neu in 1.9.1

- **Weniger Schreibarbeit:** Smart Home speichert Geräte nur noch, wenn sich ihr Zustand geändert hat. „Zuletzt gesehen“ eines Gateways geht auf die Minute genau. Auf einem langsamen Datenträger (NAS mit Festplatten) bleibt GateControl dadurch flüssiger.

## Neu in 1.9.0

- **Zigbee-Geräte von zigbee2mqtt** über ein GateControl-Gateway – geschaltet und zugewiesen wie die anderen Geräte ([zigbee2mqtt](#zigbee2mqtt)).
- Verschlüsselte Bluetooth-Sensoren liefern Werte, sobald ihr Schlüssel in GateControl eingetragen ist.

Zuletzt in 1.8.1: dieses Handbuch im Reiter „Handbuch“; in 1.8.0: Bluetooth-Sensoren über ein GateControl-Gateway.
