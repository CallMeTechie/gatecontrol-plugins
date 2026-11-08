<!-- version: 1.5.1 -->
# Alltag

## Was das Plugin kann

- **Müllabfuhr:** Abfuhrpläne für eine oder mehrere Adressen (z. B. Zuhause und Eltern) aus Online-Abfallkalendern (AbfallNavi, abfall.io / AbfallPlus, AWIDO), aus einer ICS-Datei deiner Gemeinde oder aus eigenen Regeln. Tonnen mit Farbe und Symbol, Ausnahmen für verschobene Termine.
- **Kalender:** iCal-Abos von Google Kalender, iCloud und Outlook oder aus dem Heimnetz (Nextcloud, Radicale …).
- **Erinnerungen** in der GateControl-App: „Morgen: Gelber Sack“, Termine zu Beginn oder einige Minuten vorher.
- **Portal „Zuhause“:** die nächsten Abfuhrtage und die Termine von heute und den nächsten 7 Tagen, Kacheln auf der Startseite.
- **Für andere Plugins:** Familie nutzt die Kalender für Regeln mit „Termin heute/morgen“, Mail blendet sie in seinen Kalender ein (nur lesend).
- **„Notizen & Aufgaben“:** mit dem Plugin „Notizen & Aufgaben“ stehen die Abfuhrtermine am Vorabend in „Mein Tag“ („Gelber Sack rausstellen“).

## Voraussetzungen

- GateControl **1.216.0** oder neuer.
- Für einen Online-Abfallkalender: deine Gemeinde nutzt AbfallNavi, abfall.io oder AWIDO. Sonst eine ICS-Datei der Gemeinde oder eigene Regeln.
- Für Kalender: die geheime iCal-Adresse deines Kalenders oder ein Kalender-Server im Heimnetz.

## Einrichten

### Müllabfuhr

1. Im Plugin › Reiter **„Müllabfuhr“** › **„Abfuhrplan hinzufügen“**.
2. **Quelle der Termine** wählen:
   - **Online-Abfallkalender:** Anbieter → Gemeinde/Entsorger → Ort → Straße → Hausnummer, mit Vorschau. Das Plugin holt die Termine höchstens zweimal am Tag.
   - **ICS-Datei** der Gemeinde hochladen (bis 900 KB).
   - **Eigene Regeln:** Tonne, erster Termin, alle N Wochen, optional bis wann.
3. **Personen:** alle Personen oder nur ausgewählte. Sie sehen den Plan im Portal und bekommen seine Erinnerungen.
4. **Erinnerung:** keine, am Abholtag, 1 Tag vorher (Standard), 2 oder 3 Tage vorher, mit Uhrzeit; optional zusätzlich am Abholtag.
5. Tonnen umbenennen, umfärben, ihre Art ändern oder ausblenden, und **Ausnahmen** eintragen (Termin entfällt oder wird verschoben).

### Kalender

1. Im Plugin › Reiter **„Kalender“** › **„Kalender abonnieren“**.
2. **Internet-Adresse (iCal):** die geheime iCal-Adresse des Kalenders. So findest du sie:
   - **Google:** Einstellungen → dein Kalender → „Privatadresse im iCal-Format“.
   - **iCloud:** Kalender freigeben → „Öffentlicher Kalender“.
   - **Outlook:** „Kalender veröffentlichen“ → ICS.
   `webcal://` geht auch. Andere Internet-Dienste ruft das Plugin aus Sicherheitsgründen nicht ab.
3. **Kalender im Heimnetz** (Nextcloud, Radicale …): unter **Einstellungen › Plugins › Alltag › Zugriffsziele** dem Ziel „Kalender (Heimnetz)“ den Server zuweisen, dann im Dialog den Pfad der Export-Adresse und, falls nötig, Benutzer und Passwort eintragen.
4. **Personen:** Kalender sind persönlich – nur die gewählten Personen sehen ihn und bekommen seine Erinnerungen.

Die Adresse und die Anmeldedaten werden verschlüsselt gespeichert und nie wieder angezeigt. Das Plugin holt die Kalender alle 30 Minuten.

### Einstellungen

**Einstellungen › Plugins › Alltag › Einstellungen:** Bereiche „Müllabfuhr“ und „Kalender“ einzeln ein/aus, Zeitzone (Standard Europe/Berlin), Standard-Uhrzeiten der Erinnerungen (Vorabend 18:00, am Abholtag 06:30, ganztägige Termine 07:00), Sprache der Mitteilungen.

## Benutzen

- **Portal „Zuhause“:** Abschnitt „Müllabfuhr“ mit den nächsten Abfuhrtagen und Abschnitt „Termine“ (heute und die nächsten 7 Tage). Einzelheiten der Termine gibt es nur nach der Anmeldung, sonst nur die Anzahl. Kacheln „Nächste Abfuhr“ und „Heute“ auf der Startseite.
- **App:** Erinnerungen der Themen „Müllabfuhr“ und „Termine“; die Familie-App zeigt die Termine mit der Kalenderfarbe.
- **„Test-Erinnerung senden“** je Bereich schickt dir eine Probe.
- **„Notizen & Aufgaben“** (wenn installiert): die Abfuhrtermine der nächsten 14 Tage, je Tonne eine Zeile, am Abend vor der Abholung in „Mein Tag“. Wer sie sieht, bestimmt der Plan (seine Personen). Abhaken geht dort nicht; die Termine verschwinden nach dem Abholtag von selbst.

## Berechtigungen

- Administratoren legen Abfuhrpläne und Kalender an und sehen alle.
- Personen sehen die Abfuhrpläne, für die sie gewählt sind, und die Kalender, die ihnen zugeordnet sind – im Portal, in der App und in anderen Plugins (Familie, Mail).
- Die Adresse eines Kalenders verlässt das Plugin nie.

## Häufige Fragen / Fehlersuche

**Meine Gemeinde ist bei keinem Anbieter.**
Lade die ICS-Datei von der Seite deiner Gemeinde hoch oder lege eigene Regeln an.

**Ein Kalender lässt sich nicht abonnieren.**
Erlaubt sind nur Google, iCloud und Outlook. Für eigene Server nimm das Zugriffsziel „Kalender (Heimnetz)“.

**Termine sind veraltet.**
Bei Fehlern fragt das Plugin seltener (Kalender bis alle 6 Stunden, Abfallkalender bis alle 12 Stunden). Die letzten guten Termine bleiben stehen; der Fehler steht auf der Seite.

**Keine Erinnerung gekommen.**
Hast du das Thema „Müllabfuhr“ bzw. „Termine“ in den Mitteilungs-Einstellungen abgeschaltet? Bist du beim Plan bzw. Kalender als Person gewählt? „Test-Erinnerung senden“ zeigt, ob Mitteilungen ankommen.

## Neu in 1.5.1

- **Weniger Schreibarbeit:** die Erinnerungen speichern ihren Stand nur noch, wenn sich etwas getan hat. Auf einem langsamen Datenträger (NAS mit Festplatten) bleibt GateControl dadurch flüssiger.

## Neu in 1.5.0

- **Müllabfuhr in „Notizen & Aufgaben“:** Mit dem Plugin „Notizen & Aufgaben“ stehen die Abfuhrtermine am Vorabend in „Mein Tag“ – „Gelber Sack rausstellen“, für die Personen des Plans. Ohne das Plugin ändert sich nichts.

## Neu in 1.4.1

- Dieses Handbuch im Reiter „Handbuch“ (GateControl ≥ 1.241.0).

Zuletzt in 1.4.0: Kalender in Mail – Mail blendet die Alltag-Kalender einer Person in seinen Kalender ein.
