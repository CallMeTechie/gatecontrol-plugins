<!-- version: 1.6.2 -->
# Fahrzeuge

## Was das Plugin kann

- **Škoda-Fahrzeuge** aus deinem MySkoda-Konto einbinden: Ladestand, Reichweite, Zustand (Türen, Fenster, Licht, Verriegelung), Laden, Klima, Position mit Adresse, Kilometerstand, Warnungen und Inspektion.
- **Steuern:** Klimatisierung und Zieltemperatur, Scheibenheizung, Laden und Ladelimit, Ver- und Entriegeln (mit S-PIN), Abfahrtstimer.
- **Fahrtenbuch:** Fahrten werden nach dem Parken automatisch eingetragen – mit Zweck (Privat, Geschäftlich, Arbeitsweg), Karte und Export als PDF oder CSV.
- **Besitzer:** Du weist Fahrzeuge Personen zu. Sie sehen und steuern sie im Portal (Tab „Fahrzeug“) und in der App.
- **Mitteilungen:** Laden abgeschlossen, Akku niedrig, Fahrzeug nicht verriegelt, Klimatisierung fertig, Fahrt erfasst.
- **GateControl-Apps:** Schnellaktionen und Widgets je Fahrzeug, ein Widget „Fahrtenbuch“ und – in der Android-App ab 1.56 – eine eigene Fahrtenbuch-Seite.

## Voraussetzungen

- GateControl **1.186.0** oder neuer.
- Ein **MySkoda-Konto** mit deinen Fahrzeugen in der Garage.
- Für Ver- und Entriegeln: die **S-PIN** deines Kontos.

## Einrichten

1. Im Plugin › Seite **„Fahrzeuge“** › **„Konto hinzufügen“**: E-Mail und Passwort deines MySkoda-Kontos. Die Fahrzeuge der Garage erscheinen nach der Anmeldung; **„Synchronisieren“** holt sie sofort.
2. Für Ver- und Entriegeln die **S-PIN** eintragen. Lehnt Škoda die S-PIN ab, sperrt das Plugin Ver- und Entriegeln, bis du die richtige eingibst – sonst würde Škoda das Konto sperren.
3. Bei jedem Fahrzeug **Besitzer zuordnen**: Diese Personen sehen das Fahrzeug im Portal und können es nach der Anmeldung steuern.
4. **Einstellungen › Plugins › Fahrzeuge › Einstellungen:** Abrufintervall (Minuten), „Akku niedrig“ unter … %, „Nicht verriegelt“ nach … Minuten, Zweck neuer Fahrten im Fahrtenbuch (fester Zweck = keine Nachfrage nach jeder Fahrt), Sprache der Mitteilungen.

Passwort, S-PIN und Sitzung werden verschlüsselt gespeichert und nur für die Anmeldung bei Škoda verwendet.

## Benutzen

### Portal und App

- **Portal, Tab „Fahrzeug“:** die eigenen Fahrzeuge mit Ladestand, Reichweite und Zustand. Steuern, Standort und Abfahrtszeiten gibt es nur nach einer Anmeldung, nie über Geräte-Vertrauen allein.
- **App:** Schnellaktionen und Widgets für Klima, Laden und Verriegeln der eigenen Fahrzeuge.

### Fahrtenbuch

- Meldet das Fahrzeug nach einer Fahrt eine neue Parkposition und einen höheren Kilometerstand, trägt das Plugin die Fahrt ein: Datum, Abfahrt und Ankunft, Start- und Zieladresse, Kilometerstand und Strecke. Die Abfahrtszeit ist so genau wie das Abrufintervall.
- Nach jeder Fahrt bekommen die Besitzer eine Mitteilung mit den Knöpfen Privat / Geschäftlich / Arbeitsweg. Anlass, Geschäftspartner und Fahrer trägst du im Fahrtenbuch nach; Start und Ziel lassen sich korrigieren.
- **Karte:** Jede Fahrt erscheint auf einer OpenStreetMap-Karte. Škoda meldet nur, wo das Auto parkt – den Straßenweg berechnet das Plugin einmal je Fahrt über den Routendienst von OpenStreetMap. Findet der keinen passenden Weg, zeigt die Karte die Luftlinie (gestrichelt).
- **Admin-Seite „Fahrtenbuch“:** alle Fahrzeuge Monat für Monat mit Summen je Zweck, Bearbeiten, Löschen, Fahrten von Hand (z. B. ohne Netz).
- **Export** als PDF oder CSV für einen Monat oder bis zu 24 Monate.
- Im Portal (Bereich „Fahrtenbuch“) und in der Android-App ordnen die Besitzer ihre Fahrten selbst ein.

## Berechtigungen

- Administratoren fügen Konten hinzu, ordnen Besitzer zu und sehen alle Fahrtenbücher.
- Besitzer sehen ihr Fahrzeug im Portal und in der App, steuern es nach der Anmeldung und ordnen ihre Fahrten ein.
- Wer nicht Besitzer ist, sieht das Fahrzeug nicht. Der Server prüft das bei jedem Befehl erneut.

## Häufige Fragen / Fehlersuche

**„Anmeldung fehlgeschlagen“.**
Meist stimmen E-Mail oder Passwort nicht. Prüfe die Anmeldung in der MySkoda-App und trag über „Passwort ändern“ am Konto das richtige Passwort ein.

**„Rate-Limit — nächster Versuch: …“.**
Škoda bremst zu viele Abfragen. Das Plugin wartet von selbst; ein größeres Abrufintervall hilft.

**„S-PIN abgelehnt“.**
Gib über „S-PIN“ die richtige S-PIN ein. Bis dahin ist Ver- und Entriegeln gesperrt.

**Eine Fahrt fehlt im Fahrtenbuch.**
Ohne Parkposition erkennt das Plugin keine Fahrt. Meldet Škoda die Position, aber noch keinen höheren Kilometerstand, steht „Geparkt an einem neuen Ort – die Fahrt wird eingetragen, sobald …“. Fehlende Fahrten trägst du von Hand ein.

**Die Karte zeigt nur eine gestrichelte Linie.**
Der Kilometerstand passt nicht zum berechneten Weg (Umweg, Zwischenstopps), oder der Routendienst hat keinen Weg gefunden.

## Neu in 1.6.2

- **Weniger Schreibarbeit** beim Abgleich mit Škoda. Auf einem langsamen Datenträger (NAS mit Festplatten) bleibt GateControl dadurch flüssiger.

## Neu in 1.6.1

- Dieses Handbuch im Reiter „Handbuch“ (GateControl ≥ 1.241.0).

Zuletzt in 1.6.0: Fahrtenbuch mit Karte (Seite, Portal und Android-App) und das Widget „Fahrtenbuch“ öffnet das Fahrtenbuch in der App.
