# Smart Home (gatecontrol-smarthome)

Phoscon/deCONZ-Integration als GateControl-Plugin – bisher fest in GateControl eingebaut.

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
