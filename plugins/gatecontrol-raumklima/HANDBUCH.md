<!-- version: 2.2.3 -->
# Raumklima

## Was das Plugin kann

- **Midea-Klimageräte** steuern – über die Midea-Cloud (Konto der App MSmartHome oder NetHome Plus) oder direkt im Heimnetz (Protokoll V2 und V3): Ein/Aus, Zieltemperatur, Modus, Lüfterstufe, Turbo, Eco; Innen- und Außentemperatur.
- **Dreo-Heizlüfter und -Klimageräte** über die Dreo-Cloud, mit Live-Verbindung: Befehle kommen sofort an, Änderungen am Gerät erscheinen sofort.
- **Besitzer:** Du weist Geräte Personen zu. Diese Personen steuern sie im Portal „Zuhause“ und in der App.
- **Mitteilungen:** Gerät nicht erreichbar, Filter reinigen, Störung am Klimagerät.
- **GateControl-Apps:** Schnellaktionen und ein Widget je Gerät (Innentemperatur, Zieltemperatur, Modus).

Bis 1.6.0 hieß das Plugin `gatecontrol-midea` („Klimaanlage“). Version 2.0.0 hat es ersetzt und alles übernommen.

## Voraussetzungen

- GateControl **1.185.0** oder neuer.
- Für die Midea-Cloud: dein Konto der Midea-App (MSmartHome oder NetHome Plus).
- Für Midea im Heimnetz: das Gerät muss für GateControl erreichbar sein (Adresse im Heimnetz über ein Zugriffsziel). Geräte mit Protokoll V3 brauchen zusätzlich das Midea-Konto für ihren Schlüssel.
- Für Dreo: dein Dreo-Konto mit **E-Mail und Passwort**. Wer sich in der Dreo-App mit Apple oder Google anmeldet, hat unter E-Mail und Passwort keine Geräte.

## Einrichten

### Schritt 1: Konten eintragen

**Einstellungen › Plugins › Raumklima › Einstellungen** (oder auf der Raumklima-Seite „Konten“):

- **Midea:** App, E-Mail, Passwort.
- **Dreo:** E-Mail, Passwort. Gespeichert wird vom Dreo-Passwort nur seine Prüfsumme.

Beim Speichern meldet sich das Plugin gleich an. Je Konto zeigt eine Statuszeile „Verbunden als …“ oder den Fehler.

### Schritt 2: Geräte hinzufügen

- **Dreo:** Die Heizlüfter und Klimageräte des Kontos erscheinen von selbst auf der Raumklima-Seite – gleich nach dem Speichern und danach stündlich. Von Hand geht es über „Gerät hinzufügen“ › „Dreo“.
- **Midea-Cloud:** **„Gerät hinzufügen“** › „Midea-Cloud“ › die Klimageräte des Kontos wählen.
- **Midea im Heimnetz:**
  1. **„Geräte entdecken“** sucht Klimageräte im Heimnetz.
  2. Die Adresse des Geräts unter **Einstellungen › Plugins › Raumklima › Zugriffsziele** dem Ziel „Klimagerät (Heimnetz)“ zuweisen.
  3. **„Gerät hinzufügen“** › „Heimnetz“ › Zugriffsziel, Name und – bei V3-Geräten – das passende Cloud-Gerät für den Schlüssel wählen.

### Schritt 3: Besitzer festlegen

Bei jedem Gerät **„Besitzer verwalten“**: Wer hier steht, sieht und steuert das Gerät im Portal und in der App. Neue Geräte sehen zuerst nur Administratoren.

## Benutzen

- **Portal „Zuhause“, Abschnitt „Raumklima“:** die eigenen Geräte mit Temperatur und Zustand. Steuern geht nach der Anmeldung.
- **App:** je eigenem Gerät ein Ein/Aus-Schalter mit Widget – Innentemperatur, Außentemperatur, Regler für Zieltemperatur und Modus. Regeln anderer Plugins (z. B. Familie) schalten genau den gewünschten Zustand.
- **Raumklima-Seite (Admin):** alle Geräte, Konten-Status, Geräte entdecken, hinzufügen, bearbeiten (Name, Zugriffsziel, aktiv).

**Dreo-Heizungen** können je nach Modell Heizstufen, Eco mit Thermostat (5–35 °C), Lüften, Schwenken, Kindersicherung, Tastenton und Fenster-Erkennung; **Dreo-Klimageräte** Kühlen, Entfeuchten, Lüften, Schlafen, Eco, Zieltemperatur 16–30 °C, Lüfterstufe und Schwenken.

## Berechtigungen

- Administratoren richten Konten und Geräte ein und legen Besitzer fest.
- Personen steuern nur Geräte, deren Besitzer sie sind. Das prüft der Server bei jedem Befehl erneut.
- Mitteilungen gehen an die Besitzer eines Geräts; ohne Besitzer entscheidet die Regel des Themas in den Mitteilungs-Einstellungen von GateControl.

## Häufige Fragen / Fehlersuche

**Das Dreo-Konto zeigt „Im Dreo-Konto ist kein Gerät“.**
Ist das Gerät in der Dreo-App mit genau diesem Konto verbunden? Bei Anmeldung per Apple oder Google hat das E-Mail-Konto keine Geräte. Das Protokoll des Plugins zeigt, was gefragt wurde.

**Ein Dreo-Heizlüfter antwortet nicht.**
Dreo-Heizungen sperren die Fernsteuerung nach 24 Stunden ohne Bedienung. Drück einmal die WLAN-Taste am Gerät.

**„Das Midea-Konto braucht eine erneute Bestätigung“.**
In der Midea-App bestätigen und die Einstellungen des Plugins erneut speichern.

**Ein gefundenes Midea-Gerät ist nicht erreichbar.**
Seine Adresse muss unter Zugriffsziele als „Klimagerät (Heimnetz)“ zugewiesen sein.

**Cloud-Geräte melden keine Störung.**
Mitteilungen kommen nur von Geräten im Heimnetz, die das Plugin laufend abfragt (und von Dreo-Geräten bei „nicht erreichbar“).

## Neu in 2.2.3

- Dieses Handbuch im Reiter „Handbuch“ (GateControl ≥ 1.241.0).

Zuletzt in 2.2.2: Dreo-Geräte mit Sonderzeichen in der Seriennummer werden nicht mehr verworfen.
