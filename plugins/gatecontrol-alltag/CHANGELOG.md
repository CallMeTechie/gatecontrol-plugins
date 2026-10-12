# Alltag (gatecontrol-alltag)

Müllabfuhr und Kalender des Haushalts als GateControl-Plugin.

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
