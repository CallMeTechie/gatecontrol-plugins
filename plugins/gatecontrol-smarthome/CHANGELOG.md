# Smart Home (gatecontrol-smarthome)

Phoscon/deCONZ-Integration als GateControl-Plugin – bisher fest in GateControl eingebaut.

## 1.0.0
- Erste Version als Plugin, Funktionsumfang der eingebauten Smart-Home-Integration:
  Gateways verbinden (API-Key automatisch holen oder eintragen), testen, synchronisieren;
  Lichter, Steckdosen, Gruppen, Szenen, Sensoren und Schalter; Steuerung (Ein/Aus,
  Helligkeit, Farbe, Farbtemperatur, Szenen); Besitzer je Gerät; Logikketten auf dem
  Gateway (Auslöser, Zeitfenster, Verzögerung mit ignorieren/zurücksetzen/abbrechen);
  Hintergrund-Abfrage (Abfrageintervall einstellbar); Portal-Tab „Zuhause“.
- Mehrere Gateways: je Gateway ein Zugriffsziel (GateControl-Route, VPN-Gerät oder Adresse),
  zugewiesen unter Einstellungen → Plugins → Smart Home → Zugriffsziele.
- deCONZ-API-Keys werden als verschlüsselte Plugin-Geheimnisse gespeichert.
- Übernahme der Daten der eingebauten Integration (Gateways inkl. API-Key und Route,
  Geräte, Besitzer, Regeln) – angeboten von GateControl ab 1.148.0.
