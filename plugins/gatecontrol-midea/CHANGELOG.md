# Klimaanlage (gatecontrol-midea)

Midea-Klimageräte als GateControl-Plugin – bisher fest in GateControl eingebaut („Klimaanlage“).

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
