# Fahrzeuge (gatecontrol-skoda)

Škoda-Fahrzeuge (MySkoda) als GateControl-Plugin – bisher fest in GateControl eingebaut.

## 1.0.0
- Erste Version als Plugin, Funktionsumfang der eingebauten Fahrzeuge-Integration:
  MySkoda-Konten (Anmeldung über VW-Identity, Passwort ändern, S-PIN), Fahrzeuge aus der
  Garage mit Ladestand, Reichweite, Zustand (Türen, Fenster, Licht, Verriegelung), Laden,
  Klima, Position, Kilometerstand, Warnungen und Inspektion; Fahrzeugbild; Details
  (Modell, Ausstattung, Verbindung, Fahrstil-Score) bei Bedarf; Befehle (Klima, Zieltemperatur,
  Scheibenheizung, Laden, Ladelimit, Ver-/Entriegeln mit S-PIN, Abfahrtstimer); Besitzer je
  Fahrzeug; Hintergrund-Abfrage (Abrufintervall einstellbar) mit Backoff bei Rate-Limits.
- Portal: Abschnitt „Fahrzeuge“ im gemeinsamen Tab „Fahrzeug“ (nur für Personen mit
  zugewiesenem Fahrzeug), Kacheln auf der Startseite (Ladestand, Reichweite) und Treffer
  in der Portal-Suche. Steuern, Standort (mit Adresse) und Abfahrtszeiten nur nach einer
  Anmeldung, nie über Geräte-Vertrauen allein.
- Netzwerk nur zu identity.vwgroup.io, mysmob.api.connect.skoda-auto.cz, den Škoda-Bildservern
  (iprenders.blob.core.windows.net, ip-modcwp.azureedge.net) und nominatim.openstreetmap.org
  (Adresse zur Position), jeweils HTTPS.
- MySkoda-Passwort, S-PIN und Sitzungs-Tokens werden als verschlüsselte Plugin-Geheimnisse
  gespeichert.
- Übernahme der Daten der eingebauten Integration (Konten inkl. Passwort, S-PIN und Sitzung,
  Fahrzeuge inkl. Zustand und Bild, Besitzer) – angeboten von GateControl ab 1.151.0.
