# Alltag (gatecontrol-alltag)

Müllabfuhr und Kalender des Haushalts als GateControl-Plugin.

## 1.1.0
- **Erinnerung je Abfuhrplan:** im Dialog „Abfuhrplan hinzufügen/bearbeiten“ gibt es den
  Abschnitt „Erinnerung“: *Keine*, *Am Abholtag*, *1 Tag vorher* (Vorgabe), *2 Tage vorher*
  oder *3 Tage vorher* mit Uhrzeit (Vorgabe: Standard-Uhrzeit aus den Plugin-Einstellungen,
  18:00) und optional „Zusätzlich am Abholtag um …“ (Vorgabe 06:30, aus). Die Zeiten gelten
  in der Zeitzone des Plugins, auch an den Tagen der Zeitumstellung.
- Der Text passt zum Vorlauf: „Heute: …“, „Morgen: …“, „Übermorgen: …“, „Am Do, 15.10.: …“
  (englisch „Today“, „Tomorrow“, „Day after tomorrow“, „On Thu 15 Oct“).
- Jede Erinnerung (Plan, Abholtag, Art) kommt höchstens einmal: eine geänderte Einstellung
  wiederholt keine schon gesendete Erinnerung desselben Tages. Was durch eine Änderung (oder
  einen neuen Plan, neue Termine) schon vorbei ist, wird höchstens für den nächsten Abholtag
  des Plans nachgeholt – keine Flut alter Erinnerungen. Ausfallzeiten werden wie bisher
  nachgeholt, solange die Erinnerung sinnvoll ist (bis zum Beginn des Abholtags, am Abholtag
  bis 12 Uhr).
- Die Karte des Plans zeigt die Einstellung („Erinnerung: 1 Tag vorher, 18:00 · zusätzlich am
  Abholtag 06:30“) statt der allgemeinen Zeile „Erinnerung am Vorabend um …“.
- Bestehende Pläne behalten das Verhalten von 1.0.0 (Vorabend zur Standard-Uhrzeit, auf Wunsch
  am Morgen), bis ihre Erinnerung im Dialog geändert wird (Migration `002_plan_reminder`, leere
  Spalten = Plugin-Einstellungen). Die Plugin-Einstellungen sind jetzt die Vorgaben für neue
  Pläne und für Pläne ohne eigene Einstellung.
- API: `POST/PUT /plans` nehmen `reminder: { lead: 'off' | 0–3, time: 'HH:MM', extra, extra_time }`
  (oder `null` = Plugin-Einstellungen) und prüfen die Werte (`REMINDER_INVALID`).
- Oberfläche: die Seite wiederholt den Kopf von GateControl nicht mehr (kein „Plugin · Alltag“,
  kein großer Titel) und hat keinen eigenen Hintergrund – sie beginnt mit den Reitern
  Müllabfuhr / Kalender.

## 1.0.0
- Erste Version mit zwei Bereichen, die sich in den Plugin-Einstellungen einzeln
  abschalten lassen: **Müllabfuhr** und **Kalender**.
- Müllabfuhr: Abfuhrpläne (mehrere Adressen möglich, z. B. Zuhause und Eltern) aus
  - Online-Abfallkalendern mit geführter Auswahl (Anbieter → Gemeinde/Entsorger → Ort →
    Straße → Hausnummer) und Vorschau: **AbfallNavi** (regio iT, `*.regioit.de`),
    **abfall.io / AbfallPlus** (v3, `api.abfall.io`, `widgets.abfall.io`) und **AWIDO**
    (`awido.cubefour.de`); Abruf höchstens zweimal am Tag, bei Fehlern mit wachsendem
    Abstand (30 Minuten … 12 Stunden), die letzten guten Termine bleiben erhalten;
    letzte Aktualisierung und Fehler auf der Seite;
  - einer hochgeladenen ICS-Datei der Gemeinde (bis 900 KB) oder
  - eigenen Regeln (Tonne, erster Termin, alle N Wochen, optional bis);
  - plus Ausnahmen (Termin entfällt oder wird verschoben) für jede Quelle.
- Tonnen werden nach Stichworten erkannt (Restmüll, Bio, Papier, Gelber Sack/Wertstoff,
  Glas, Sperrmüll, Schadstoffe, Grünschnitt/Weihnachtsbaum, Sonstiges) mit Farbe und
  Symbol; umbenennen, umfärben, Art ändern oder ausblenden pro Plan.
- Kalender: iCal-Abos über eine Internet-Adresse von Google Kalender, iCloud oder Outlook
  (webcal:// wird zu https://; andere Server werden abgelehnt) oder über das Zugriffsziel
  „Kalender (Heimnetz)“ für Nextcloud, Radicale usw. mit optionaler Basic-Anmeldung.
  Die Internet-Adresse und die Anmeldedaten sind verschlüsselte Plugin-Geheimnisse und
  werden nie wieder an den Browser gegeben oder protokolliert. Abruf alle 30 Minuten
  (mit ETag/Last-Modified), bei Fehlern mit wachsendem Abstand (15 Minuten … 6 Stunden).
- Eigener ICS-Leser ohne Abhängigkeiten: Zeilenumbrüche, Maskierung, ganztägige
  Termine, Zeitzonen (IANA, Windows-/Outlook-Namen), UTC und schwebende Zeiten,
  Wiederholungen (täglich/wöchentlich/monatlich/jährlich mit INTERVAL, COUNT, UNTIL,
  BYDAY auch 2TU/-1FR, BYMONTHDAY, BYMONTH, BYSETPOS, WKST) in der Zeitzone des
  Termins (Sommerzeit-sicher), EXDATE, RDATE, geänderte und abgesagte Einzeltermine;
  feste Obergrenzen (5 MB, Anzahl Termine und Wiederholungen).
- Erinnerungen über die Benachrichtigungszentrale (GateControl ab 1.154.0):
  Thema „Müllabfuhr“ am Vorabend (Standard 18:00) und auf Wunsch am Morgen
  (Standard 06:30), an alle Abonnenten des Themas oder nur an die Personen des Plans;
  Thema „Termine“ zu Beginn oder 10/15/30/60 Minuten vorher, ganztägige Termine am
  Morgen (Standard 07:00), nur an die Personen des Kalenders. Ein Neustart wiederholt
  nichts und verliert nichts, was noch sinnvoll ist; eigenes Stundenbudget.
  „Test-Erinnerung senden“ je Bereich.
- Portal „Zuhause“: Abschnitt „Müllabfuhr“ mit den nächsten Abfuhrtagen (auch bei
  Gerätevertrauen) und „Termine“ (heute + 7 Tage, Einzelheiten nur nach Anmeldung,
  sonst nur die Anzahl); Kacheln „Nächste Abfuhr“ und „Heute“ auf der Startseite;
  Portal-Suche über kommende Termine (nur nach Anmeldung).
- Einstellungen: Bereiche ein/aus, Zeitzone (Standard Europe/Berlin), Uhrzeiten der
  Erinnerungen, Sprache der Benachrichtigungen.
- Sicherung: Pläne, Termine und Kalender-Abos liegen in der Plugin-Datenbank, die
  Kalender-Adressen und Anmeldedaten als Plugin-Geheimnisse – beides ist in
  GateControl-Sicherungen enthalten (Geheimnisse verschlüsselt, beim Wiederherstellen neu
  verschlüsselt).
