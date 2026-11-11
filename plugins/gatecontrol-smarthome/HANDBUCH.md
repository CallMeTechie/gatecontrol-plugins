<!-- version: 1.10.0 -->
# Smart Home

## Was das Plugin kann

- **Phoscon/deCONZ-Gateways** einbinden (z. B. ConBee oder RaspBee): Lichter, Steckdosen, Gruppen, Szenen, Sensoren und Schalter. Ein/Aus, Helligkeit, Farbe, Farbtemperatur, Szenen.
- **Shelly und Tasmota** über ein GateControl-Gateway im Heimnetz (ab 1.7.0): Schalter mit Leistungsmessung, Dimmer, Rollläden, Markisen und Tore, Temperatur- und Feuchtesensoren – ohne Hersteller-Cloud.
- **Bluetooth-Sensoren** über ein GateControl-Gateway (ab 1.8.0): Thermometer und Sensoren, die du in GateControl unter Funk übernommen hast – auch verschlüsselte, wenn ihr Schlüssel dort eingetragen ist.
- **Zigbee-Geräte von zigbee2mqtt** über ein GateControl-Gateway (ab 1.9.0): Lichter, Steckdosen, Rollläden, Sensoren und Taster, die du in GateControl unter Funk mit zigbee2mqtt angelernt hast. Ab 1.10.0 auch Schalter mit mehreren Kanälen, Thermostate und Firmware-Updates.
- **Besitzer und Bereiche:** Du weist Geräte Personen zu. Diese Personen bedienen sie im Portal „Zuhause“ und in der App.
- **Logikketten:** Auslöser, Zeitfenster, Verzögerung – für deCONZ auf dem deCONZ-Gateway, für Shelly und Tasmota (ab 1.10.0) auf dem GateControl-Gateway.
- **Mitteilungen:** Alarm (Wasser, Rauch, CO), Fenster lange offen, Batterie schwach, Gateway nicht erreichbar.
- **Schnellaktionen und Widgets** in den GateControl-Apps für die eigenen Geräte.

## Voraussetzungen

- GateControl **1.228.1** oder neuer.
- Für deCONZ: ein Phoscon/deCONZ-Gateway, das GateControl erreicht (über eine Route, ein VPN-Gerät oder eine Adresse).
- Für Shelly und Tasmota: ein GateControl-Gateway **1.19.0** oder neuer im selben Heimnetz, mit den Diensten `edge` und `mqtt` in seiner Compose-Datei.
- Für Bluetooth-Sensoren: ein GateControl mit Funk (Reiter „Funk“ beim Gateway) und ein Gateway mit Bluetooth.
- Für zigbee2mqtt: ein GateControl, das zigbee2mqtt kennt, und ein Gateway nach 1.30.0 mit „zigbee2mqtt“ im Reiter „Funk“ (dafür sind Edge und MQTT des Gateways an). Für mehrere Kanäle, Thermostate und Firmware-Updates: GateControl nach 1.258.4 und ein Gateway nach 1.34.2.

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

### Bluetooth-Sensoren

1. In GateControl beim Gateway im Reiter **„Funk“** den Sensor anlernen und **übernehmen** (BTHome, Xiaomi mit ATC/pvvx-Firmware, Shelly BLU).
2. Der Sensor erscheint im Plugin unter der Quelle „Funk (GateControl-Gateway)“ mit Temperatur, Feuchte und Batterie. Gibst du ihn in GateControl zurück, verschwindet er hier.
3. Sendet er verschlüsselt (BTHome mit Schlüssel, Xiaomi-Originalfirmware), trägst du seinen Schlüssel in GateControl beim Sensor ein – danach kommen seine Werte auch hier an.

### Zigbee-Geräte von zigbee2mqtt {#zigbee2mqtt}

1. In GateControl beim Gateway im Reiter **„Funk“** als Zigbee-Dienst **„zigbee2mqtt“** wählen und mit **„Anlernen starten“** die Geräte koppeln.
2. Die Geräte erscheinen von selbst im Plugin unter der Quelle „Funk (GateControl-Gateway)“ des Gateways: Lichter mit Helligkeit, Farbe und Farbtemperatur, Steckdosen und Schalter, Rollläden (Auf / Stopp / Zu), Sensoren und Taster.
3. Besitzer, Bereich und Name gibst du wie bei den anderen Geräten. Ein Name, den du hier vergibst, bleibt; sonst gilt der Name aus zigbee2mqtt.
4. Entfernst du ein Gerät in GateControl aus dem Zigbee-Netz, wird es hier ausgeblendet – seine Besitzer bleiben, falls es wiederkommt.
5. **Mehrere Kanäle:** Ein 2- oder 3-fach-Schalter steht als eine Karte je Kanal da („Kanal 1“, „Kanal 2“ …). Jeder Kanal hat eigenen Namen, Bereich und Besitzer und wird einzeln geschaltet.
6. **Thermostate:** Die Karte zeigt Ist- und Soll-Temperatur. Das Soll stellst du mit dem Regler, den Modus (Aus, Heizen, Automatik) mit den Knöpfen darunter. Zugewiesene Personen stellen das Soll im Portal mit − und +.
7. **Firmware-Updates:** Kann ein Gerät Updates über Funk, steht unten auf seiner Karte „Firmware“. **„Nach Update suchen“** fragt zigbee2mqtt; gibt es eines, steht dort „Update verfügbar“ mit dem Knopf **„Aktualisieren“**. Ein Update dauert 10 bis 60 Minuten, die Karte zeigt den Fortschritt. Ein Batteriegerät muss dafür wach sein – betätige es einmal.

### Geräte zuweisen und benennen

- **„Besitzer verwalten“** (Dialog „Besitzer zuweisen“): welche Personen ein Gerät bedienen dürfen, und der **Bereich** (z. B. Wohnzimmer). Seite und Portal gruppieren nach Bereich.
- Im selben Dialog kannst du Lampen und Sensoren umbenennen. deCONZ-Geräte werden dabei direkt in deCONZ umbenannt, Geräte von zigbee2mqtt und Bluetooth-Sensoren hier.
- Bei Shelly und Tasmota legst du unter **„Bearbeiten“** außerdem die Art je Ausgang fest (Licht, Steckdose, Schalter; zwei Ausgänge als Rollladen, Markise oder Tor).

### Einstellungen

Unter **Einstellungen › Plugins › Smart Home › Einstellungen**: Abfrageintervall (Sekunden), „Fenster offen“ nach … Minuten (Standard 15), „Batterie schwach“ unter … % (Standard 15), Sprache der Mitteilungen.

## Benutzen

- **Portal „Zuhause“:** Jede Person sieht dort die Geräte, die ihr zugewiesen sind – schalten, dimmen, Farbe, Szenen, Rollläden mit Auf / Stopp / Zu. Wer keine Geräte hat, sieht den Abschnitt nicht.
- **App:** Schnellaktionen (Startbildschirm, Schnelleinstellungen, Widget) für die eigenen Lampen, Steckdosen, Gruppen und Szenen, Rollläden mit Positionsregler, Leistung im Widget.
- **Logikketten** (Seite „Logikketten“): Wähle oben die Quelle. Regeln eines deCONZ-Gateways laufen auf diesem Gateway. Regeln für Shelly und Tasmota laufen auf dem GateControl-Gateway, an dem die Geräte hängen – siehe [Logikketten für Shelly und Tasmota](#logikketten-edge).
- **Regeln anderer Plugins** (z. B. Familie: „Alle weg → Licht aus“) schalten genau den gewünschten Zustand.

### Logikketten für Shelly und Tasmota {#logikketten-edge}

1. Seite **„Logikketten“** › oben das GateControl-Gateway wählen › **„Neue Regel“**.
2. **WENN:** ein Gerät und was auslöst – ein Ausgang geht **an** oder **aus**, ein Rollladen ist **offen** oder **geschlossen**, die **Leistung** liegt über oder unter einem Wert (Watt), **Temperatur** oder **Feuchte** eines Sensors liegt über oder unter einem Wert.
3. **DANN:** schalten (an, aus), dimmen (Helligkeit) oder einen Rollladen fahren (Auf, Zu, Stopp, Position).
4. Optional: Zeitfenster, Verzögerung in Minuten und was bei erneuter Auslösung passiert (ignorieren, Timer zurücksetzen, abbrechen).

Die Regel feuert, wenn die Bedingungen **eintreten** – nicht, solange sie schon gelten. Bei mehreren Bedingungen müssen alle zugleich erfüllt sein. Beispiel „Wäsche fertig“: Waschmaschine ist an **und** Leistung unter 5 W.

Die Regeln laufen im Edge-Teil auf dem Gateway, auch wenn der Server gerade nicht erreichbar ist. Das Zeitfenster gilt in der Zeitzone des Servers. Unter jeder Regel steht, wann sie zuletzt ausgelöst hat. Je Gateway gehen höchstens 40 Regeln. Auslöser und Aktionen einer Regel müssen am selben Gateway hängen; deCONZ-Geräte und Shelly/Tasmota lassen sich nicht in einer Regel mischen.

## Berechtigungen

- Administratoren richten Quellen und Geräte ein und weisen sie zu.
- Personen bedienen nur Geräte, die ihnen zugewiesen sind. Das prüft der Server bei jedem Schalten erneut.
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

**Eine Regel für Shelly oder Tasmota löst nicht aus.**
Steht bei der Quelle „Gateway nicht verbunden“, kommen Änderungen erst an, wenn es wieder da ist. Ist MQTT auf dem Gateway aus, kann die Regel nicht schalten. Eine Regel feuert nur beim Wechsel: Ist die Bedingung beim Anlegen schon erfüllt, wartet sie auf das nächste Mal.

**„Nach Update suchen“ meldet „Suche fehlgeschlagen“.**
Das Gerät schläft (Batteriegerät: einmal betätigen) oder zigbee2mqtt erreicht den Update-Server nicht – das Gateway braucht dafür Internet.

**Das automatische Einrichten scheitert.**
Richte das Gerät „Von Hand …“ ein. Die Anleitung steht im Fenster.

**Ein Gerät von zigbee2mqtt lässt sich nicht schalten („zigbee2mqtt auf dem Gateway antwortet gerade nicht“).**
Im Reiter „Funk“ des Gateways nachsehen: Läuft zigbee2mqtt, sind Edge und MQTT an? Neue Geräte erscheinen spätestens nach einer halben Minute.

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
