# Raumklima (gatecontrol-raumklima, bis 1.6.0 gatecontrol-midea)

Klimageräte und Heizungen als GateControl-Plugin: Midea-Klimageräte (früher fest in GateControl
eingebaut, „Klimaanlage“) und seit 1.6.0 Dreo-Heizlüfter und -Klimageräte.

## 2.2.2
- **Der Dreo-Heizlüfter wurde verworfen**: Die Dreo-Cloud lieferte das Gerät, aber seine
  Seriennummer enthielt Zeichen, die das Plugin nicht zuließ (bisher nur Buchstaben, Ziffern,
  „-“ und „_“ bis 64 Zeichen). Jetzt gilt jedes druckbare Zeichen außer Anführungszeichen,
  spitzen Klammern, Backslash und Backtick (Leerzeichen nur innen), bis 100 Zeichen – auch beim
  Hinzufügen von Hand.
- Wird eine Seriennummer doch verworfen, nennt das Protokoll Länge und Zeichenarten (nie die
  Nummer selbst). Nach dem Update wird sofort neu nachgesehen.

## 2.2.1
- **Dreo-Geräte unter jedem Feldnamen**: Die Antworten der Dreo-Cloud werden jetzt vollständig nach
  Geräten durchsucht (Seriennummer + Modell/Name, egal unter welchem Schlüssel – Zuhause, Räume,
  Gerätelisten), nicht nur unter bekannten Feldnamen.
- **Diagnose im Protokoll**: Bleibt das Konto leer, steht je gefragter Quelle eine Zeile im
  Protokoll – mit dem Aufbau der Antwort (nur Feldnamen, Anzahlen und Zahlen, keine Namen oder
  Adressen) und bei Fehlern dem HTTP-Status und der Meldung von Dreo.
- Die Open-API wird genau wie mit Dreos eigener Bibliothek angefragt. Nach dem Update wird sofort
  neu nachgesehen.

## 2.2.0
- **Dreos offizielle Schnittstelle (Open API)**: Manche Dreo-Konten zeigen ihre Geräte der
  App-Schnittstelle nicht (beide Listen leer, in beiden Regionen) – Dreos eigene Open API
  (open-api-eu/us.dreo-tech.com, die auch Dreos offizielle Home-Assistant-Integration nutzt)
  aber schon. Findet das Plugin sonst nichts, fragt es jetzt dort; Geräte von dort werden
  über die Open API gelesen und gesteuert (Ein/Aus, Modus, Heizstufe, Zieltemperatur,
  Schwenken – ohne Live-Verbindung: der Zustand wird alle 2 Minuten gelesen).
- **Neue Netzwerk-Freigaben** `open-api-eu.dreo-tech.com` und `open-api-us.dreo-tech.com` –
  das Update muss ein Admin bestätigen.
- Die Statuszeile nennt die Open API mit („… · Open-API EU: Geräte 0“). Nach dem Update wird
  sofort neu nachgesehen.

## 2.1.1
- **Dreo-Konto „ohne Gerät“, obwohl der Heizlüfter in der Dreo-App ist**: Die Geräte werden
  jetzt auch aus der Räume-Liste der neueren Dreo-App gelesen (Konten mit Zuhause und Räumen
  liefern die alte Geräteliste leer), und ist in der Region des Kontos nichts zu finden, wird
  die andere Region (EU/US) gefragt – nicht jede Anmeldung sagt, wo ein Konto liegt. Findet sich
  dort etwas, wechselt das Konto dorthin.
- Die Statuszeile nennt bei einem leeren Konto, was gefragt wurde („geprüft – EU: Geräteliste 0,
  Räume 0 · US: …“), und den Hinweis auf Apple/Google-Anmeldungen der Dreo-App (dann hat das
  Konto mit E-Mail und Passwort keine Geräte).
- Nach dem Update wird sofort neu nachgesehen (nicht erst nach einer Stunde).

## 2.1.0
- **Dreo-Geräte erscheinen von selbst**: Ist das Dreo-Konto in den Einstellungen verbunden,
  stehen seine Heizlüfter und Klimageräte jetzt automatisch auf der Raumklima-Seite – mit dem
  Namen und Modell aus der Dreo-App. Bisher musste man jedes Gerät erst über „Gerät
  hinzufügen“ → „Dreo“ anlegen, und darauf wies nichts hin. Das passiert direkt beim Speichern
  des Kontos und danach stündlich im Hintergrund (ein später in der Dreo-App hinzugefügtes
  Gerät erscheint so innerhalb einer Stunde; Konten, die schon vor dem Update verbunden waren,
  werden beim ersten Lauf nach dem Update übernommen). Ein hier entferntes Gerät bleibt
  entfernt, bis es wieder von Hand hinzugefügt wird. Sichtbar sind neue Geräte wie bisher für
  Admins; wer sie sonst nutzen darf, legst du unter „Besitzer“ fest.
- **Statuszeile des Dreo-Kontos** in den Einstellungen sagt jetzt, was im Konto ist: „Im
  Konto: Bad (DR-HSH009S) …“, nicht unterstützte Dreo-Geräte (Ventilatoren, Luftreiniger …)
  mit Modell, „Im Dreo-Konto ist kein Gerät“ oder warum die Geräteliste nicht lesbar war.
- **„Gerät hinzufügen“ → „Dreo“** meldete bei einem leeren Konto „Alle … bereits
  hinzugefügt“ – jetzt „Im Dreo-Konto wurde kein Gerät gefunden“.

## 2.0.1
- **Dreo auf der Plugin-Seite**: Die Kachel „Dreo“ blieb bei „Verbinde …“, wenn das Konto
  angemeldet, aber noch kein Dreo-Gerät angelegt war (die Live-Verbindung entsteht erst mit
  einem Gerät). Sie zeigt jetzt „Konto verbunden“, „Live“, „Verbinde …“ (Gerät da, Verbindung
  im Aufbau), „Anmeldung fehlgeschlagen“ oder „Nicht angemeldet“ – und aktualisiert sich
  alle 30 Sekunden.
- **Schnellaktionen der Apps**: Ist der zwischengespeicherte Zustand eines Midea-Cloud-Geräts
  älter als 90 Sekunden, wird er zuerst neu gelesen (höchstens 1 Sekunde). Ein mit der
  Fernbedienung oder der Midea-App ausgeschaltetes Gerät erscheint so beim nächsten Laden als
  aus, nicht erst beim übernächsten.

## 2.0.0
- **Neue Plugin-ID `gatecontrol-raumklima`** – passend zum Namen. Das Plugin ersetzt
  `gatecontrol-midea`: Im Katalog erscheint es als Update des installierten Plugins, und beim
  Aktualisieren übernimmt GateControl alles – Geräte, Besitzer, Konten, Startkacheln, Widgets,
  Schnellaktionen, Regeln, Benachrichtigungs-Einstellungen und die Lizenz (keine neue Lizenz
  nötig). Das alte Plugin wird dabei entfernt. Automatische Updates installieren den Umstieg
  nicht – einmal von Hand auf „Aktualisieren“.
- **Konten in den Einstellungen des Plugins**: Midea-Konto (App, E-Mail, Passwort) und
  Dreo-Konto (E-Mail, Passwort) trägst du jetzt unter Einstellungen › Plugins › Raumklima ›
  Einstellungen ein. Speichern meldet sich gleich an; je Konto zeigt eine Statuszeile, ob die
  Anmeldung geklappt hat („Verbunden als …“, „Anmeldung fehlgeschlagen: …“). Die Dialoge
  „Midea-Konto“ und „Dreo-Konto“ auf der Raumklima-Seite entfallen; dort führt „Konten“ (und
  jeder Hinweis auf ein fehlendes oder abgelaufenes Konto) direkt zu den Einstellungen.
  Bereits verbundene Konten werden übernommen.
- Vom Dreo-Passwort wird weiterhin nur die Prüfsumme (MD5) aufbewahrt: das eingegebene Passwort
  wird beim Speichern durch sie ersetzt.
- **Braucht GateControl 1.185.0** (Einstellungs-Gruppen mit Statuszeilen, Plugin-Ersetzung).

## 1.6.0
- **Neuer Name „Raumklima“** (vorher „Klimaanlage“): Navigation, Seite, Portal-Bereich und
  Katalog heißen jetzt so. Die Plugin-ID bleibt `gatecontrol-midea` – Lizenz, Daten,
  Zuweisungen und Schnellaktionen bleiben, wie sie sind.
- **Dreo-Heizlüfter und -Klimageräte** (z. B. DR-HSH009S, WH…, DR-HAC…): Dreo-Konto unter
  „Dreo-Konto“ verbinden, Geräte im Dialog „Gerät hinzufügen“ → „Dreo“ wählen. Gesteuert wird
  über die Dreo-Cloud mit einer **Live-Verbindung** (WebSocket): Befehle kommen sofort an, und
  was am Gerät oder mit der Fernbedienung geändert wird, erscheint sofort in GateControl.
  - Heizungen: Ein/Aus, Heizen Stufe 1–3 (DR-HSH016S: 1–5), Eco mit Thermostat
    (Zieltemperatur 5–35 °C), Lüften, Schwenken mit Winkel (60/90/120°, je nach Modell),
    Kindersicherung, Tastenton, Fenster-Erkennung (wenn das Gerät sie hat); „heizt gerade“.
  - Klimageräte: Ein/Aus, Kühlen, Entfeuchten, Lüften, Schlafen, Eco, Zieltemperatur
    16–30 °C, Lüfterstufe (Auto/Niedrig/Mittel/Hoch), Schwenken, Luftfeuchte.
  - Portal, Startseiten-Kacheln, Suche, Schnellaktionen und Widgets wie bei Midea – das
    Widget zeigt die Modi, die das Gerät hat. „Gerät nicht erreichbar“ meldet auch Dreo-Geräte.
  - Gespeichert wird vom Dreo-Passwort nur die Prüfsumme (MD5), die Dreo für die Anmeldung
    verlangt, dazu das Zugangstoken – beides als verschlüsselte Plugin-Geheimnisse.
  - Dreo-Heizungen sperren die Fernsteuerung nach 24 Stunden ohne Bedienung; antwortet ein
    Gerät nicht, nennt die Fehlermeldung den Ausweg (einmal die WLAN-Taste am Gerät drücken).
- **Braucht für Dreo GateControl 1.184.0** (WebSocket für Plugins). Auf älteren Versionen
  läuft Midea wie bisher; Dreo zeigt einen Hinweis zum Aktualisieren.
- Neue Berechtigung: die Dreo-Server `app-api-eu/us.dreo-tech.com` und
  `wsb-eu/us.dreo-tech.com` – das Update muss deshalb einmal bestätigt werden.
- Mitteilung „Klimagerät nicht erreichbar“ heißt jetzt „Gerät nicht erreichbar“.

## 1.5.0
- **Zielzustand statt Umschalten** (GateControl ≥ 1.173.0): der Ein/Aus-Schalter jedes
  Klimageräts nennt seine Befehle („Einschalten“ / „Ausschalten“, englisch „Turn on“ /
  „Turn off“) und nimmt einen gewünschten Zustand an: eine Regel (z. B. der Familie) oder eine
  App, die „aus“ verlangt, schaltet aus – ein schon ausgeschaltetes Gerät bleibt aus, ein
  unbekannter Zustand muss dafür nicht erst gelesen werden.
- Ohne Zielzustand (Apps, ältere GateControl-Versionen) wird wie bisher umgeschaltet – das
  Plugin läuft weiter ab GateControl 1.154.0.

## 1.4.1
- **Keine eigene Seitenüberschrift mehr**: GateControl zeigt den Seitentitel im Kopf; die
  Seite „Klimaanlage“ beginnt direkt mit ihren Knöpfen (Geräte entdecken, Midea-Konto,
  Gerät hinzufügen) – Überschrift und Beschreibung oben entfallen.

## 1.4.0
- Geräte: die Schnellaktion jedes Klimageräts gehört zu einem eigenen Gerät (Name und
  Symbol des Klimageräts) – die GateControl-Apps ab 1.38.0 gruppieren danach.
- Widget: der große Wert heißt „Innentemperatur“ (für die Auswahl, was das Widget zeigt),
  dazu die Außentemperatur als Zusatzwert (°C, Thermometer), sobald das Gerät sie meldet.
  Der Schalter bleibt der Ein/Aus-Schalter des Widgets.
- Optional: GateControl ab 1.172.0 gibt die neuen Felder weiter, ältere Versionen lassen
  sie weg – die Mindestversion bleibt unverändert.

## 1.3.0
- Widget für den Start-Tab der GateControl-Apps: jede Schnellaktion eines Klimageräts
  bringt jetzt ein Widget mit – Innentemperatur als großer Wert (°C), die Statuszeile wie
  im Portal (z. B. „Kühlen · Ziel 22 °C“, „Aus“, „Offline“), der Zustand (Ein/Aus, Offline
  als Warnung) sowie zwei Regler: Zieltemperatur (16–30 °C in halben Graden) und Modus
  (Auto, Kühlen, Heizen, Entfeuchten, Lüften). Die Liste nutzt weiterhin nur den
  zwischengespeicherten Zustand (keine Geräteabfrage).
- Regler bedienen: Zieltemperatur und Modus werden direkt am Gerät gesetzt (nur für
  eigene Geräte, die Prüfung läuft wie beim Umschalten); jede Antwort – auch das
  Umschalten – liefert das Widget mit dem neuen Zustand, damit die App ihn sofort zeigt.
  Ein unbekannter Regler oder Wert ändert nichts.
- Optional: GateControl ab 1.171.0 zeigt die Widgets, ältere Versionen lassen das Feld
  weg – die Mindestversion bleibt unverändert.

## 1.2.0
- Schnellaktionen für die GateControl-Apps (Verknüpfungen auf dem Startbildschirm,
  Schnelleinstellungen, Widget): je ein Ein/Aus-Schalter pro eigenem Klimagerät, mit
  Modus und Zieltemperatur als Untertitel (aus dem zwischengespeicherten Zustand, ohne
  Geräteabfrage); höchstens 16, deaktivierte Geräte nicht.
- Sichtbar und auslösbar ist genau das, was die Person im Portal „Zuhause“ steuern darf
  (Zuweisung durch einen Administrator); die Prüfung läuft beim Auslösen erneut. Ist der
  Zustand noch unbekannt, wird er vor dem Umschalten vom Gerät gelesen.
- Optional: GateControl-Versionen ohne Schnellaktionen rufen sie nie auf –
  die Mindestversion bleibt unverändert.

## 1.1.0
- Benachrichtigungen über die Benachrichtigungszentrale von GateControl (Apps, Portal),
  jeweils als eigenes Thema, das jede Person selbst an- und abschalten kann:
  - **Klimagerät nicht erreichbar** (an): ein Gerät im Heimnetz antwortet 10 Minuten lang
    nicht; ist es wieder da, ersetzt „wieder erreichbar“ die Meldung.
  - **Filter reinigen** (an): das Gerät meldet, dass der Filter gereinigt werden sollte.
  - **Störung am Klimagerät** (an, Priorität hoch): das Gerät meldet eine Störung (mit
    Fehlercode, wenn es einen liefert); „Störung behoben“ ersetzt die Meldung.
- Grundlage ist die ohnehin laufende Abfrage der Geräte im Heimnetz (keine zusätzlichen
  Anfragen). Reine Cloud-Geräte werden weiterhin nicht rund um die Uhr abgefragt und
  melden daher nichts. Der Gerätezustand liefert jetzt auch Filter- und Störungsstatus.
- Der zuletzt gesehene Zustand wird gespeichert: kein erneutes Melden nach einem Neustart,
  und beim ersten Lauf wird nichts gemeldet, was schon vorher so war.
- Empfänger: die dem Gerät zugewiesenen Personen; ohne Zuweisung entscheidet die Regel des
  Themas in GateControl (System › Benachrichtigungen). Eigene Obergrenze unter dem Limit
  von GateControl (30/h), Störungen haben Vorrang.
- Neue Einstellung: Sprache der Benachrichtigungen (Deutsch/English).
- Neue Berechtigung **Benachrichtigungen** (`permissions.notify`) – beim Update fragt
  GateControl nach der Zustimmung. Benötigt GateControl ab 1.154.0.

## 1.0.0
- Erste Version als Plugin, Funktionsumfang der eingebauten Klimaanlage:
  Midea-Konto verbinden (MSmartHome oder NetHome Plus), Klimageräte des Kontos
  als Cloud-Geräte hinzufügen; Geräte im Heimnetz (Protokoll V2 und V3, V3-Schlüssel
  aus dem Konto) über ein Zugriffsziel; lokale Suche nach Geräten; Steuerung
  (Ein/Aus, Zieltemperatur, Modus, Lüfterstufe/Auto, Turbo, Eco), Innen- und
  Außentemperatur, Verbindungstest; Besitzer je Gerät; Hintergrund-Abfrage der
  Heimnetz-Geräte alle 30 Sekunden (Cloud-Geräte wie bisher nur bei Bedarf, mit
  90 Sekunden Zwischenspeicher).
- Neu: Gerät bearbeiten (Name, Zugriffsziel, aktiv).
- Portal: Abschnitt „Klimaanlage“ im gemeinsamen Tab „Zuhause“ (nur für Personen mit
  zugewiesenen Geräten; Steuern nach Anmeldung), Kacheln auf der Startseite und
  Treffer in der Portal-Suche.
- Netzwerk: Internet nur zu den Midea-Cloud-Servern (mp-prod.appsmb.com,
  mapp.appsmb.com); Geräte im Heimnetz nur über zugewiesene Zugriffsziele
  „Klimagerät (Heimnetz)“ (TCP 6444, UDP 6445/20086); lokale Suche (UDP 6445, 20086)
  nur, wenn ein Administrator sie erlaubt.
- Passwort und Sitzung des Midea-Kontos sowie die V3-Schlüssel werden als
  verschlüsselte Plugin-Geheimnisse gespeichert.
- Übernahme der Daten der eingebauten Klimaanlage (Midea-Konto inkl. Passwort und
  Sitzung, Geräte inkl. V3-Schlüssel – die IP-Adresse eines Heimnetz-Geräts wird zum
  Zugriffsziel –, Besitzer) – angeboten von GateControl ab 1.150.0.
