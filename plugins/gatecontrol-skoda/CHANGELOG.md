# Fahrzeuge (gatecontrol-skoda)

Škoda-Fahrzeuge (MySkoda) als GateControl-Plugin – bisher fest in GateControl eingebaut.

## 1.4.1
- **Ladestand als Akku oben rechts im Fahrzeug-Widget** (GateControl ≥ 1.175.0): rechts neben
  dem Fahrzeugnamen zeigt ein Akku-Symbol mit der Prozentzahl den Ladestand – leer bis 15 %
  (rot), ein Balken bis 40 %, zwei bis 75 %, darüber drei; während des Ladens ein Akku mit
  Blitz. Ohne bekannten Ladestand (z. B. Verbrenner) entfällt das Symbol.
- Die eigene Zeile „Ladestand“ mit dem großen Wert entfällt; das Widget zeigt darunter nur
  noch die Reichweite. Das zusätzliche Schloss-Symbol neben der Reichweite entfällt ebenfalls –
  den Verriegelungszustand zeigt nur noch der Schloss-Schalter mit seiner Farbe. Auch die
  Farbe des Widgets hängt nicht mehr am Schloss: rot bis 15 % Ladestand, sonst grün, ohne
  bekannten Ladestand neutral – ein entriegeltes Fahrzeug färbt das Widget nicht mehr gelb.
  Die Statuszeile („Lädt“ / „Klimatisierung an“) bleibt; ist weder Ladestand noch Reichweite
  bekannt, zeigt das Widget keinen Strich mehr.
- Die Kachel auf der Startseite (Ladestand, Reichweite, Schloss) bleibt unverändert.
- Ältere GateControl-Versionen (vor 1.175.0) kennen das Akku-Symbol nicht und lassen es weg;
  das Plugin läuft weiter ab GateControl 1.154.0.

## 1.4.0
- **Zielzustand statt Umschalten** (GateControl ≥ 1.173.0): Klimatisierung, Laden,
  Scheibenheizung und das Schloss nennen ihre Befehle („Verriegeln“ / „Entriegeln“,
  „Einschalten“ / „Ausschalten“, „Laden starten“ / „Laden stoppen“, englisch „Lock“ / „Unlock“,
  „Turn on“ / „Turn off“, „Start charging“ / „Stop charging“) und nehmen einen gewünschten
  Zustand an: fragt eine Regel (z. B. der Familie: „alle weg → Auto verriegeln“) oder eine App
  nach „verriegelt“, wird verriegelt – auch wenn das Auto schon verriegelt ist, nie entriegelt.
  Was die Apps bis zur Rückmeldung des Fahrzeugs anzeigen, bleibt wie bisher der Zustand, den
  der Befehl anstrebt.
- Für die Regeln anderer Plugins heißt das Schloss immer „Schloss“ (statt „Verriegelt“ /
  „Entriegelt“); in den Apps bleibt der Titel mit dem Zustand.
- Ohne Zielzustand (Apps, ältere GateControl-Versionen) schalten die Schalter wie bisher um –
  das Plugin läuft weiter ab GateControl 1.154.0.

## 1.3.3
- **Eine abgelehnte S-PIN wird nicht noch einmal gesendet**: lehnt die Škoda-Cloud ein
  Ver- oder Entriegeln ab (HTTP 4xx außer 401/429, z. B. 403 bei falscher S-PIN), merkt sich
  das Plugin die gespeicherte S-PIN als abgelehnt. Bis eine neue S-PIN gespeichert ist, geht
  kein Ver-/Entriegeln mehr an Škoda – App, Portal und Admin-Seite melden sofort „Škoda hat
  die gespeicherte S-PIN abgelehnt – bitte die S-PIN im Konto neu eingeben.“ So sperrt Škoda
  die S-PIN nicht mehr für 24 Stunden, nur weil die App die falsche S-PIN immer wieder
  sendet. Die erste Ablehnung sagt „Škoda hat den Befehl abgelehnt (HTTP 403) – bitte die
  S-PIN im Konto prüfen und neu eingeben.“; der Versuch zählt wie bisher zur Grenze von
  5 Versuchen in 15 Minuten. 401, 429 und Störungen (5xx) markieren nichts.
- Admin-Seite: das Konto zeigt „S-PIN abgelehnt“ mit dem Hinweis, die S-PIN neu einzugeben;
  der Knopf „S-PIN“ ist dann hervorgehoben. Eine neu gespeicherte S-PIN hebt die Sperre auf
  (beim Speichern wird nichts an Škoda gesendet). Die Schnellaktion „Schloss“ bleibt in den
  Apps sichtbar und meldet beim Tippen den Hinweis. Andere Befehle (Klima, Laden, …) sind
  nicht betroffen. Die S-PIN steht nie im Protokoll oder in einer Antwort.
- **Keine eigene Seitenüberschrift mehr**: GateControl zeigt den Seitentitel im Kopf; die
  Seite „Fahrzeuge“ beginnt direkt mit „Škoda-Konten“ (Abrufintervall und „Konto
  hinzufügen“ stehen jetzt neben dieser Überschrift).

## 1.3.2
- **Abgelehnte Befehle sagen jetzt, was los ist**: lehnt die Škoda-Cloud einen Befehl ab
  (z. B. Verriegeln), melden App und Portal „Škoda hat den Befehl abgelehnt (HTTP 403).“
  bzw. bei einer Störung „Störung in der Škoda-Cloud (HTTP 503) …“ statt nur „Aktion
  fehlgeschlagen“. Das Protokoll enthält zusätzlich den HTTP-Status und Škodas Begründung
  (Fehlercode und Text) – nie die S-PIN.
- Abgelaufene Škoda-Anmeldung meldet sich mit dem Hinweis, das Konto zu synchronisieren.

## 1.3.1
- **Schalter folgen dem Befehl sofort**: nach Klimatisierung, Laden, Scheibenheizung oder
  Ver-/Entriegeln zeigen die Apps (Schalter, Schloss mit Titel und Farbe, Verriegelung im
  Widget und auf der Startkachel) gleich den Zustand, den der Befehl anstrebt – bis das
  Fahrzeug ihn meldet, höchstens 3 Minuten; danach wieder der gemeldete Stand. Gilt auch
  für Befehle aus dem Portal. Bisher blieb der alte Zustand bis zur nächsten Abfrage stehen.
- Abfrage nach einem Befehl erst nach etwa 45 Sekunden statt sofort – Škoda braucht
  20–60 Sekunden, bis das Fahrzeug den Befehl umgesetzt hat; vorher las die Abfrage nur den
  alten Stand. Mehrere Befehle kurz hintereinander teilen sich eine Abfrage.
- **Verriegeln/Entriegeln endete in „fehlgeschlagen“**, wenn das Konto gerade abgefragt
  wurde (z. B. direkt nach einem anderen Befehl): GateControl wartet höchstens 10 Sekunden.
  Dauert der Befehl länger als 8 Sekunden, antwortet die App jetzt „Befehl unterwegs – der
  Status folgt“; der Befehl läuft weiter, ein späterer Fehler steht im Protokoll. Fehler
  vorher (S-PIN fehlt, zu viele Versuche, …) melden sich wie bisher.

## 1.3.0
- **Ver- und Entriegeln als ein Schalter**: statt zweier Tasten gibt es pro Fahrzeug einen
  Schalter „Verriegelt“ / „Entriegelt“ (Zustand aus dem zuletzt abgefragten Stand; unbekannt:
  „Schloss“, ohne Zustand). In GateControl-Apps ab 1.38.0 mit eigenem Symbol und eigener
  Farbe je Zustand – verriegelt grünes geschlossenes, entriegelt rotes offenes Schloss – und
  einer Rückfrage nur vor dem Entriegeln; ältere Apps fragen vor jedem Schalten. Auslösen:
  ein verriegeltes Fahrzeug wird entriegelt, ein entriegeltes oder unbekanntes verriegelt.
  Weiterhin nur mit hinterlegter S-PIN, die Grenzen der Befehle gelten unverändert.
  Die bisherige Aktion „Verriegeln“ behält ihre Kennung – angeheftete Verknüpfungen bleiben
  gültig und werden zum Schalter. **„Entriegeln“ gibt es nicht mehr als eigene Aktion: alte
  „Entriegeln“-Verknüpfungen bitte entfernen und den Schalter neu anheften.**
- Geräte: alle Schnellaktionen eines Fahrzeugs gehören zusammen (Name, darunter das Modell,
  wenn es anders heißt) – die Apps zeigen sie als eine Zeile.
- Widget pro Fahrzeug (an der Klimatisierung, die darin eine Taste wie die anderen ist):
  Ladestand als großer Wert (ohne Akku die Reichweite), dazu Reichweite und Verriegelung
  (Schloss offen/zu), „Lädt“ bzw. „Klimatisierung an“ als Statuszeile; Zustand kritisch bei
  höchstens 15 %, Warnung wenn entriegelt.
- Startkachel: zusätzlich einzelne Werte für die Info-Karte der Apps – Ladestand (Akku),
  Reichweite (Route) und Verriegelt/Entriegelt (Schloss); das Portal zeigt weiter den Text.
- Optional: GateControl ab 1.172.0 gibt die neuen Felder weiter, ältere Versionen lassen
  sie weg – die Mindestversion bleibt unverändert.

## 1.2.0
- Schnellaktionen für die GateControl-Apps (Verknüpfungen auf dem Startbildschirm,
  Schnelleinstellungen, Widget) – dieselben Befehle wie im Portal: Klimatisierung,
  Laden (Fahrzeuge mit Akku) und Scheibenheizung als Schalter (Zustand aus dem zuletzt
  abgefragten Stand), Verriegeln und Entriegeln als Tasten, nur wenn für das Konto eine
  S-PIN hinterlegt ist; **Entriegeln fragt in der App vorher nach**. Höchstens 16.
- Nur für die angemeldete Person, der das Fahrzeug zugewiesen ist (wie die Steuerung im
  Portal); die Prüfung läuft beim Auslösen erneut, die Grenzen der Befehle (S-PIN,
  Ver-/Entriegeln höchstens 5 × in 15 Minuten) gelten unverändert.
- Optional: GateControl-Versionen ohne Schnellaktionen rufen sie nie auf –
  die Mindestversion bleibt unverändert.

## 1.1.0
- Benachrichtigungen über die Benachrichtigungszentrale von GateControl (Apps, Portal),
  jeweils als eigenes Thema, das jede Person selbst an- und abschalten kann:
  - **Laden abgeschlossen** (an): Laden am Ladeziel beendet – „Elroq · 80 % · ca. 390 km“.
  - **Akku niedrig** (an): Ladestand unter der Schwelle (Einstellung, Standard 20 %),
    einmal pro Entladung.
  - **Fahrzeug nicht verriegelt** (aus): länger als N Minuten entriegelt (Einstellung,
    Standard 15).
  - **Klimatisierung fertig** (aus): Zieltemperatur erreicht bzw. Klimatisierung beendet.
- Grundlage ist der ohnehin abgefragte Fahrzeugzustand (keine zusätzlichen Abfragen bei
  Škoda). Der zuletzt gesehene Zustand wird gespeichert: kein erneutes Melden nach einem
  Neustart, und beim ersten Lauf wird nichts gemeldet, was schon vorher so war.
- Empfänger: die dem Fahrzeug zugewiesenen Personen; ohne Zuweisung entscheidet die Regel
  des Themas in GateControl (System › Benachrichtigungen). Eigene Obergrenze unter dem
  Limit von GateControl (30/h), Wiederholungen werden unterdrückt.
- Neue Einstellungen: Schwellen für „Akku niedrig“ und „Nicht verriegelt“, Sprache der
  Benachrichtigungen (Deutsch/English).
- Neue Berechtigung **Benachrichtigungen** (`permissions.notify`) – beim Update fragt
  GateControl nach der Zustimmung. Benötigt GateControl ab 1.154.0.

## 1.0.1
- Fahrzeugbilder werden wieder angezeigt (Seite „Fahrzeuge“ und Portal): Bilder bis 4 MB statt
  bisher 700 KB – die hochauflösenden Škoda-Renderbilder wurden bisher beim Abruf und bei der
  Übernahme der eingebauten Daten verworfen. Das Bild wird in der Plugin-Datenbank als Binärwert
  gespeichert und in Teilen (je ca. 600 KB) an Seite und Portal übertragen.
- Škoda-Bildserver wie in der eingebauten Integration: iprenders.blob.core.windows.net sowie alle
  Hosts unter azureedge.net und skoda-auto.cz (HTTPS). Netzwerk-Berechtigung dafür:
  `*.azureedge.net:443` und `*.skoda-auto.cz:443` (statt nur ip-modcwp.azureedge.net). Das
  Zugangs-Token wird weiterhin nie an die Bildserver gesendet.
- Fehlende Bilder (auch die bei der Übernahme verworfenen) werden beim nächsten
  „Synchronisieren“ bzw. beim nächsten automatischen Abruf neu geladen.

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
