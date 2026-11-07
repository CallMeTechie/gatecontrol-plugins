# Smart Home (gatecontrol-smarthome)

Phoscon/deCONZ-Integration als GateControl-Plugin – bisher fest in GateControl eingebaut; seit 1.7.0 auch Shelly und
Tasmota über ein GateControl-Gateway.

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
