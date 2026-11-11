# Smart Home (gatecontrol-smarthome)

Phoscon/deCONZ-Integration als GateControl-Plugin – bisher fest in GateControl eingebaut; seit 1.7.0 auch Shelly und
Tasmota über ein GateControl-Gateway.

## 1.10.0

- **Logikketten für Shelly und Tasmota:** Die Seite „Logikketten“ kennt neben den deCONZ-Gateways die
  GateControl-Gateways als Quelle. Auslöser: Ausgang an/aus, Rollladen offen/geschlossen, Leistung, Temperatur und
  Feuchte über/unter einem Wert; Aktionen: schalten, dimmen, Rollladen Auf/Zu/Stopp/Position; Zeitfenster, Verzögerung
  und „bei erneuter Auslösung“ wie bisher. Die Regeln laufen im **Edge-Teil auf dem Gateway** (`edge/rules.js`): eine
  MQTT-Meldung des Geräts → Regel → MQTT-Befehl, ohne Umweg über den Server und auch, wenn er nicht erreichbar ist
  (die Liste liegt in `gc.store` des Edge-Teils). Sie feuern, wenn die Bedingungen eintreten (steigende Flanke der
  UND-Verknüpfung); was beim Anlegen, beim Start oder bei der ersten Meldung eines Geräts schon gilt, zählt nicht.
  Der Server-Teil prüft und übersetzt die Definition (`server/edgerules.js`) und schickt sie mit der Geräteliste
  (`gc.edge.configure { devices, rules, tz }`); das Ereignis `fired` trägt „Zuletzt ausgelöst“ ein. Tabelle `rules`:
  neue Spalten `source` (`deconz` | `edge`) und `last_fired_at` (Migration 003). Höchstens 40 Regeln je Gateway.
  deCONZ-Regeln bleiben unverändert.
- **Batteriegeräte (Shelly H&T):** „schläft – letzte Meldung vor …“ statt „nicht erreichbar“, nach mehr als 26 Stunden
  mit der Frage „Batterie leer?“; Hinweis „Batterie schwach“ ab dem Wert der Einstellung (Standard 15 %), auch im
  Portal. Die Kennzahl „Nicht erreichbar“ zählt schlafende Geräte nicht. Ein Shelly ab Gen2 an USB-Strom
  (`devicepower:0.external.present`) gilt als wach.
- **Benutzername am Gerät:** Für Shelly Gen1 (HTTP Basic) und Tasmota ist der Benutzername der Geräte-Weboberfläche je
  Gerät einstellbar (Standard `admin`) – im Schritt „Das Gerät hat ein Passwort“ und unter „Bearbeiten“ › Verbindung.
  Gespeichert wird nur der Name; das Gerätepasswort wird wie bisher für den einen Vorgang benutzt und nie gespeichert.
  „Neues MQTT-Passwort setzen“ nimmt jetzt wahlweise das Gerätepasswort an und trägt das Konto dann auch in ein
  geschütztes Gerät ein. Shelly ab Gen2 kennen nur `admin`.
- **zigbee2mqtt** (mit GateControl nach 1.258.4 und einem Gateway nach 1.34.2; ältere liefern die Felder nicht, dann
  bleibt alles wie bisher): **Mehrkanal-Geräte** – eine Ressource je Kanal (`caps.channels`, `values.ch`), geschaltet
  mit `{ on, channel }`; die bisherige Ressource des Geräts wird Kanal 1 und behält Name, Bereich und Besitzer.
  **Thermostate** – neue Art `thermostat` mit Ist-/Soll-Temperatur und Modus, Karte auf der Seite, Kachel im Portal
  (− / +, Modus), Soll innerhalb der Grenzen des Geräts. **OTA-Updates** – „Update verfügbar“, „Aktualisieren“,
  Fortschritt und „Nach Update suchen“ auf der Karte (`POST /resources/:id/ota`, `gc.radio.command(id, { ota })`).
- Geräte von zigbee2mqtt lassen sich im Dialog „Besitzer verwalten“ umbenennen (der Server konnte es schon, das Feld
  fehlte).
- Dialoge und Rückfragen holen den Anfang des Rahmens in den sichtbaren Bereich – über ein nicht fixiertes Element;
  für die fixierte Dialogfläche scrollt Chromium die umgebende Seite nicht.
- Regel-Editor: Gerät, Felder und × stehen in einer Zeile, solange Platz ist.
- Tests: Regel-Engine und Edge-Teil gegen simulierte MQTT-Meldungen (Shelly Gen1/Gen2, Tasmota), Server-Teil der
  Edge-Regeln, schlafende Geräte, Benutzername, zigbee2mqtt-Kanäle/Thermostate/OTA.

## 1.9.1

- **Weniger Schreibvorgänge:** der Abgleich mit Phoscon/deCONZ (alle 30 s) schreibt eine Leuchte, Gruppe, Szene oder einen Sensor nur noch, wenn sich etwas geändert hat, und alle Änderungen eines Abgleichs in **einer** Transaktion – vorher jede Ressource bei jedem Abgleich (im Protokoll von GateControl 1.253.5: `UPDATE resources …` 935 Mal in der Stunde, je ~300 ms auf einem langsamen Datenträger). Eine fehlende Ressource wird einmal abgeschaltet, nicht bei jedem Abgleich wieder.
- „Zuletzt gesehen“ eines Gateways (`gateways.last_seen_at`) höchstens einmal je Minute.
- Bluetooth-Sensoren, zigbee2mqtt-Geräte und Shelly/Tasmota-Kanäle: dieselben Werte noch einmal werden nicht geschrieben.
- Test: eine Stunde Abgleich ohne Änderung schreibt nichts, zwei geänderte Ressourcen sind ein Commit (`writes.test.js`).

## 1.9.0

- **Zigbee-Geräte von zigbee2mqtt über ein GateControl-Gateway:** Mit einem GateControl, das zigbee2mqtt kennt
  (`gc.radio.zigbee` / `gc.radio.command`; ein Gateway nach 1.30.0 mit „zigbee2mqtt“ unter Gateway › Funk),
  erscheinen die dort angelernten Geräte – Lichter (Helligkeit, Farbe, Farbtemperatur), Steckdosen/Schalter,
  Rollläden, Sensoren und Taster – unter der Quelle „Funk (GateControl-Gateway)“ des Gateways, zusammen mit den
  Bluetooth-Sensoren. Schalten, Besitzer, Bereiche, Umbenennen, Portal „Zuhause“ und „In Smart Home benennen“ wie bei
  den anderen Quellen; geschaltet wird über das Gateway (`zigbee2mqtt/<Name>/set`), der echte Zustand kommt mit dem
  nächsten Bericht. Ein Gerät, das zigbee2mqtt nicht mehr kennt (oder ein Gateway zurück auf deCONZ), wird hier
  ausgeschaltet – Besitzer bleiben. Keine neue Berechtigung (`permissions.radio`), keine neue Edge-Fähigkeit; ohne
  `gc.radio.zigbee` (älteres GateControl) bleibt alles wie bisher.
- Verschlüsselte Bluetooth-Sensoren (BTHome mit Schlüssel, Xiaomi-Originalfirmware mit Bindkey) liefern Werte, sobald
  der Schlüssel in GateControl eingetragen ist – im Plugin ändert sich dafür nichts.

## 1.8.1

- Handbuch im Reiter „Handbuch“ (GateControl ≥ 1.241.0): `HANDBUCH.md` / `HANDBOOK.md` im Paket, in `plugin.json` unter `handbook`. Ältere GateControl-Versionen ignorieren es; die Mindestversion bleibt `>=1.228.1`.

## 1.8.0
- **Bluetooth-Sensoren über ein GateControl-Gateway:** Mit einem GateControl, das Funk kennt (`gc.radio`, Phase 3c
  Schritt 2), erscheinen die Bluetooth-Thermometer und -Sensoren, die du in GateControl unter Gateway › Funk
  „Übernommen“ hast (BTHome, Xiaomi mit ATC/pvvx-Firmware, Shelly BLU), als Sensoren im Plugin – eigene Quelle
  „Bluetooth-Sensoren (GateControl-Gateway)“ je Gateway, mit Temperatur bzw. Feuchte, Batterie, Bereich und Besitzern
  wie jeder andere Sensor, auch im Portal „Zuhause“. Gibt man einen Sensor in GateControl zurück, verschwindet er hier.
  Neue Berechtigung `permissions.radio` (ältere GateControl-Versionen ignorieren sie – dann bleibt alles wie bisher).
- **„In Smart Home benennen“:** Lampen und Sensoren lassen sich im Dialog „Zuweisen“ umbenennen – deCONZ-Geräte direkt
  in deCONZ (alle Teile eines Zigbee-Geräts zugleich, wie in Phoscon), Bluetooth-Sensoren im Plugin (der Name bleibt).
  GateControls Link `/plugins/gatecontrol-smarthome?focus=zigbee:<MAC>` bzw. `ble:<MAC>` (Reiter „Funk“ nach dem
  Anlernen) öffnet die richtige Quelle, zeigt das Gerät und öffnet den Dialog (`GET /find`). Der Link braucht ein
  GateControl, das `?focus=` an die Seite weitergibt; ältere zeigen die Seite ohne Sprung.

## 1.7.2
- **Verständlichere Protokollzeile, wenn MQTT aus ist:** Statt „the MQTT broker of this gateway is off – retrying
  every minute“ sagt der Edge-Teil jetzt, dass MQTT auf dem Gateway noch nicht eingeschaltet ist, wo man es
  einschaltet (GateControl: Gateways › Gateway › MQTT) und dass er sich danach von selbst verbindet. GateControl
  zeigt dazu beim Plugin und im Protokoll einen Hinweis mit dem Knopf „MQTT einschalten“ (de/en).

## 1.7.1
- **Warum ein Gateway „nicht verbunden“ ist:** Mit einem GateControl, das den Grund kennt (`gc.edge.gateways()` mit
  `reason`), zeigen „Quelle hinzufügen“, die Quellenauswahl und eine gescheiterte Einrichtung („Gerät erreicht“,
  „MQTT eintragen“) statt „Das Gateway ist gerade nicht verbunden.“ den Grund: Gateway offline, Edge-Dienst fehlt in
  der Compose-Datei, Edge-Container läuft nicht, Netzgrenze fehlt (Synology: `xt_owner`) oder der Edge-Container
  erreicht GateControl nicht – jeweils mit dem Weg zur Gateway-Seite. Ältere GateControl-Versionen: Text wie bisher.

## 1.7.0
- **Shelly und Tasmota über ein GateControl-Gateway** (GateControl ≥ 1.228.1, Gateway ≥ 1.19.0): neben
  Phoscon/deCONZ-Gateways gibt es Quellen vom Typ „GateControl-Gateway“ – je Gateway, auf dem der neue
  **Edge-Teil** von „Smart Home“ eingeschaltet ist (GateControl: Gateways › Gateway › Edge-Plugins) und der lokale
  MQTT-Broker läuft. „Quelle hinzufügen“ zeigt je Gateway, ob der Edge-Teil läuft, noch aus ist oder das Gateway zu
  alt ist; „Phoscon verbinden“ steht im selben Dialog.
- **Edge-Teil** (`edge/`, 32 MB, Fähigkeiten: mDNS `_shelly._tcp`/`_http._tcp`, HTTP im Heimnetz, MQTT `shellies/#`
  und `tasmota/#`): findet Shelly- und Tasmota-Geräte im Heimnetz, liest ihre Meldungen am Broker des Gateways und
  meldet sie gebündelt (alle 2 s, nur Änderungen) an den Server, schaltet, dimmt und fährt Rollläden per MQTT und
  fragt die Geräte alle 10 Minuten nach ihrem Stand.
- **Unterstützt:** Shelly Gen2/3/4 (Schalter mit Leistungsmessung, Rollladen/Cover, Licht/Dimmer, Plug S, H&T),
  Shelly Gen1 (Relais, Roller, Dimmer, H&T), Tasmota (POWER/POWERn, Dimmer, Shutter, ENERGY mit Leistung und
  „Heute“, Temperatur/Feuchte aus SENSOR); online/offline über LWT bzw. `online`. Unbekannte Meldungen werden
  ignoriert.
- **Gerät hinzufügen:** gefundene Geräte automatisch einrichten – eigenes MQTT-Konto je Gerät (nur seine Topics
  `shellies/<name>/#` bzw. `tasmota/<name>/#`), Gerät erreicht, Gerätepasswort (nur für diesen Vorgang, nie
  gespeichert oder protokolliert; Shelly Gen2+ mit Digest), MQTT im Gerät eintragen und neu starten, warten bis
  es sich meldet – als Schrittliste live. Oder **von Hand**: die Daten zum Kopieren (das Passwort nur in diesem
  Fenster) mit Anleitung je Gerätetyp und „Warte auf das Gerät …“.
- **Gerät bearbeiten:** Name, Bereich, Art je Ausgang (Licht, Steckdose, Schalter; Paar als Rollladen, Markise oder
  Tor), wer es bedienen darf, neues MQTT-Passwort (trägt es im Gerät ein, sonst zum Abtippen), Entfernen (löscht
  auch das MQTT-Konto).
- **Seite:** Quellenauswahl getrennt nach deCONZ und „über Gateway“, Hinweis „n neue Geräte gefunden“, Kennzahlen
  Geräte / eingeschaltet / Leistung jetzt / nicht erreichbar, Karten für Rollläden, Strommessung, Dimmer, Sensoren
  und nicht erreichbare Geräte (LWT offline oder 30 Minuten ohne Meldung, Batteriesensoren 26 Stunden).
- **Bereich** für alle Geräte – auch deCONZ (im Dialog „Besitzer verwalten“): die Seite und das Portal „Zuhause“
  gruppieren danach, Geräte ohne Bereich stehen wie bisher.
- **Portal und Apps** wie bei deCONZ: eigene Shelly-/Tasmota-Geräte schalten und dimmen (Zielzustand an/aus),
  Rollläden als Tasten Auf / Stopp / Zu mit Position als Widget (Regler), Leistung als Wert im Widget von Steckdosen
  und Schaltern, „Heute“ als Zusatzwert. An den Apps ist nichts Neues nötig.
- Logikketten bleiben bei deCONZ-Gateways.
- Mindestversion GateControl 1.228.1 (`gc.edge`, `gc.mqtt.accounts`). Ohne diese Schnittstellen läuft deCONZ
  unverändert weiter und die Seite zeigt einen Hinweis statt Shelly/Tasmota.

## 1.6.1
- **Batterie-Hinweis ohne Wiederholungen**: Ein Gerät mit mehreren Sensoren (z. B. ein
  Bewegungsmelder mit Bewegung, Helligkeit und Temperatur) stand bisher mit jedem Sensor
  einzeln in „Batterie schwach“ – jetzt einmal pro Gerät, mit dem niedrigsten Wert.

## 1.6.0
- **Zielzustand statt Umschalten** (GateControl ≥ 1.173.0): Lampen, Steckdosen und Gruppen
  nennen ihre Befehle („Einschalten“ / „Ausschalten“, englisch „Turn on“ / „Turn off“) und
  nehmen einen gewünschten Zustand an: eine Regel (z. B. der Familie: „alle weg → Licht aus“)
  oder eine App, die „aus“ verlangt, schaltet aus – ein schon ausgeschaltetes Licht bleibt
  aus. Szenen bleiben Tasten.
- Ohne Zielzustand (Apps, ältere GateControl-Versionen) wird wie bisher umgeschaltet – das
  Plugin läuft weiter ab GateControl 1.154.0.

## 1.5.1
- **Keine eigene Seitenüberschrift mehr**: GateControl zeigt den Seitentitel im Kopf; die
  Seiten „Smart Home“ und „Logikketten“ beginnen direkt mit ihrer Knopfleiste (Gateway-Auswahl,
  Verbindung testen, … bzw. Zurück, Neue Regel) – Überschrift und Beschreibung oben entfallen.

## 1.5.0
- Geräte: jede Lampe, Steckdose und Gruppe ist ein eigenes Gerät (Name und Symbol); die
  Szenen einer Gruppe gehören zum Gerät der Gruppe, wenn die Person diese Gruppe hat, sonst
  sind sie ein eigenes Gerät – die GateControl-Apps ab 1.38.0 zeigen so z. B. „Wohnzimmer“
  mit Schalter, Helligkeit und den Szenen als eine Zeile.
- Widget: der große Wert heißt „Helligkeit“ (für die Auswahl, was das Widget zeigt).
- Optional: GateControl ab 1.172.0 gibt die neuen Felder weiter, ältere Versionen lassen
  sie weg – die Mindestversion bleibt unverändert.

## 1.4.0
- Widget für den Start-Tab der GateControl-Apps: dimmbare Lampen und Gruppen bringen
  bei ihrer Schnellaktion jetzt ein Widget mit – eingeschaltet die Helligkeit in Prozent
  als großer Wert, ausgeschaltet „Aus“; darunter die Art (Licht/Gruppe, ggf. „nicht
  erreichbar“) und ein Helligkeitsregler (1–100 %). Steckdosen, Schalter-Lampen ohne
  Dimmung und Szenen bleiben einfache Schaltflächen.
- Helligkeitsregler bedienen: die Helligkeit wird am Gateway gesetzt und die Lampe bzw.
  Gruppe dabei eingeschaltet (nur für eigene Geräte, Prüfung wie beim Schalten); jede
  Antwort – auch das Umschalten – liefert das Widget mit dem neuen Zustand. Ein
  unbekannter Regler oder Wert ändert nichts.
- Neuer Text „Helligkeit“/„Brightness“ (Beschriftung des Reglers).
- Optional: GateControl ab 1.171.0 zeigt die Widgets, ältere Versionen lassen das Feld
  weg – die Mindestversion bleibt unverändert.

## 1.3.0
- Schnellaktionen für die GateControl-Apps (Verknüpfungen auf dem Startbildschirm,
  Schnelleinstellungen, Widget): je ein Schalter für die eigenen Lampen, Steckdosen und
  Gruppen (an/aus, Zustand aus dem zuletzt abgefragten Stand) und je eine Taste für die
  Szenen eigener Gruppen; höchstens 16, Schalter vor Szenen.
- Sichtbar und auslösbar ist genau das, was die Person im Portal „Zuhause“ schalten darf
  (Zuweisung durch einen Administrator); die Prüfung läuft beim Auslösen erneut.
- Optional: GateControl-Versionen ohne Schnellaktionen rufen sie nie auf –
  die Mindestversion bleibt unverändert.

## 1.2.0
- Farben ändern geht wieder: Die Farbvorgaben schickten Farbton/Sättigung, Farblampen
  mit „xy“-Farbraum (die meisten, z. B. „Extended color light“) bekamen dadurch keine
  Farbe. Die Vorgaben werden für diese Lampen jetzt in xy umgerechnet.
- Lampen mit Farbe **und** Farbtemperatur zeigen beide Regler (Seite und Portal).
- Portal „Zuhause“: Farbauswahl und Farbtemperatur für zugewiesene Lampen
  (nach Anmeldung), zusätzlich zu Schalter und Helligkeit.

## 1.1.0
- Benachrichtigungen über die Benachrichtigungszentrale von GateControl (Apps, Portal),
  jeweils als eigenes Thema, das jede Person selbst an- und abschalten kann:
  - **Alarm (Wasser, Rauch, CO)** (an, Priorität hoch): Wasser-, Rauch-/Feuer-, CO- oder
    Alarmsensor löst aus; endet der Alarm, ersetzt eine Entwarnung die Meldung.
  - **Fenster lange offen** (aus): Kontakt länger als N Minuten offen (Einstellung,
    Standard 15) – auf Gateways mit Thermostaten nur, während geheizt wird.
  - **Batterie schwach** (an): Sensorbatterie unter der Schwelle (Einstellung, Standard
    15 %) oder „Batterie schwach“ gemeldet; höchstens einmal pro Gerät und Tag, alle
    Geräte eines Gateways in einer Meldung.
  - **Gateway nicht erreichbar** (an, Priorität hoch): Gateway antwortet 5 Minuten lang
    nicht; ist es wieder da, ersetzt „wieder erreichbar“ die Meldung.
- Grundlage ist die ohnehin laufende Hintergrund-Abfrage (keine zusätzlichen Anfragen an
  die Gateways). Der zuletzt gesehene Zustand wird gespeichert: kein erneutes Melden nach
  einem Neustart, und beim ersten Lauf wird nichts gemeldet, was schon vorher so war.
- Empfänger: Alarm, Batterie und Gateway nach der Regel des Themas in GateControl
  (System › Benachrichtigungen); „Fenster offen“ an die dem Sensor zugewiesenen Personen,
  sonst ebenfalls nach der Regel. Eigene Obergrenze unter dem Limit von GateControl
  (30/h), Alarme haben Vorrang.
- Neue Einstellungen: Minuten für „Fenster offen“, Schwelle für „Batterie schwach“,
  Sprache der Benachrichtigungen (Deutsch/English).
- Neue Berechtigung **Benachrichtigungen** (`permissions.notify`) – beim Update fragt
  GateControl nach der Zustimmung. Benötigt GateControl ab 1.154.0.

## 1.0.0
- Erste Version als Plugin, Funktionsumfang der eingebauten Smart-Home-Integration:
  Gateways verbinden (API-Key automatisch holen oder eintragen), testen, synchronisieren;
  Lichter, Steckdosen, Gruppen, Szenen, Sensoren und Schalter; Steuerung (Ein/Aus,
  Helligkeit, Farbe, Farbtemperatur, Szenen); Besitzer je Gerät; Logikketten auf dem
  Gateway (Auslöser, Zeitfenster, Verzögerung mit ignorieren/zurücksetzen/abbrechen);
  Hintergrund-Abfrage (Abfrageintervall einstellbar).
- Portal: Abschnitt „Smart Home“ im gemeinsamen Tab „Zuhause“ (nur für Personen mit
  zugewiesenen Geräten), Kacheln auf der Startseite (Geräte und Sensorwerte) und
  Treffer in der Portal-Suche.
- Mehrere Gateways: je Gateway ein Zugriffsziel (GateControl-Route, VPN-Gerät oder Adresse),
  zugewiesen unter Einstellungen → Plugins → Smart Home → Zugriffsziele.
- deCONZ-API-Keys werden als verschlüsselte Plugin-Geheimnisse gespeichert.
- Übernahme der Daten der eingebauten Integration (Gateways inkl. API-Key und Route,
  Geräte, Besitzer, Regeln) – angeboten von GateControl ab 1.149.0.
