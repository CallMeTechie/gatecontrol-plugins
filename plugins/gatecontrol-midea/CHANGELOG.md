# Klimaanlage (gatecontrol-midea)

Midea-Klimageräte als GateControl-Plugin – bisher fest in GateControl eingebaut („Klimaanlage“).

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
