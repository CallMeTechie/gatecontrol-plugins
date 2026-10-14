# Familie (gatecontrol-familie)

Die Familie in der GateControl-App (eigener Tab), im Portal (eigener Tab „Familie“) und auf
drei Admin-Seiten. Alles bleibt auf dem eigenen Server.

## 1.0.0
- Erste Version mit sieben Funktionen, einzeln schaltbar auf der Seite **Funktionen**
  (gruppiert in Alltag / Unterwegs / Kinder & Sicherheit, mit Live-Vorschau des App-Tabs
  „Vorschau als …“): **Einkaufsliste**, **Aufgaben**, **Sterne für Kinder**, **Termine &
  Geburtstage**, **Kinder orten**, **„Bin angekommen“ & SOS**, **Orts-Erinnerungen**. Eine
  ausgeschaltete Funktion antwortet mit `403 module_off`, sendet nichts und behält ihre Daten.
  Die Schalter sind Plugin-Einstellungen (`mod_*`), nur auf dieser Seite (keine zweite
  Quelle in den allgemeinen Plugin-Einstellungen).
- **Mitglieder & Ortung** (Admin-Seite): GateControl-Konten werden Mitglieder als Elternteil
  oder Kind; Geburtsdatum (für Kinder Pflicht – daraus das Alter), Farbe, Sterne-Ziel und
  Ortungsart pro Kind (*Kind bestätigt* / *Automatisch* / *Aus*). Ab dem 18. Geburtstag ist ein
  Kind volljährig: keine Ortung mehr („volljährig – Ortung beendet“, API `409 adult`). Dazu die
  Schalter für Ortung und SOS, der Datenschutz in Kürze und die Ortungen der letzten 7 Tage.
- **Protokoll** (Admin-Seite): Ortungen, „Bin angekommen“, SOS und Orts-Erinnerungen der
  letzten 90 Tage mit Filtern; die letzte beantwortete Position pro Kind auf einer
  OpenStreetMap-Karte (`ui.maps`, Leaflet von GateControl; ohne Leaflet Koordinaten mit Link
  zu OpenStreetMap).
- **Portal-Tab „Familie“** für Mitglieder: Einkaufslisten bearbeiten, Aufgaben der Woche
  abhaken (Eltern legen Aufgaben an und bearbeiten sie), Termine der nächsten 14 Tage,
  Geburtstage, für Eltern „Kinder orten“ mit Countdown und Karte. Nur über Geräte-Vertrauen
  erkannte Personen lesen nur (keine Positionen, kein SOS, keine Orts-Erinnerungen).
- **App-API** (`permissions.app`, `ui.app`; der App-Tab erscheint für Mitglieder, solange
  mindestens eine Funktion an ist – `appVisible`). Pfade relativ zu `/api/`, Antworten
  `{ ok: true, … }` oder `{ ok: false, code, error }`, Zeiten ISO-8601 UTC, Daten `YYYY-MM-DD`:
  - `GET me`, `GET overview`
  - `GET shopping[?since=]`, `POST shopping/ops` (≤ 200 Operationen `list_add`, `list_rename`,
    `list_delete`, `item_add`, `item_edit`, `item_check`, `item_delete`, `clear_checked`;
    idempotent, Client-IDs; Löschungen 30 Tage als Tombstones), `POST shopping/lists/<id>/going`
  - `GET tasks`, `POST tasks`, `GET|PATCH|DELETE tasks/<id>`, `POST tasks/<id>/done`,
    `POST tasks/<id>/snooze`
  - `GET dates?from=&to=` (≤ 400 Tage), `POST dates`, `PATCH|DELETE dates/<id>`
  - `POST locate/<kind>`, `GET locate/requests[?childId=&limit=]`, `GET locate/requests/<id>`,
    `POST locate/requests/<id>/answer|decline|fail`
  - `POST arrival`, `POST sos`, `POST sos/<id>/ack`, `GET sos`, `GET sos/<id>`
  - `GET places`, `POST places`, `PATCH|DELETE places/<id>`, `POST places/<id>/consent`,
    `POST places/<id>/triggered`
  - Fehlercodes: `invalid`, `not_member`, `module_off`, `parents_only`, `login_required`,
    `forbidden`, `read_only`, `not_found`, `adult`, `locate_off`, `not_pending`,
    `too_many_places`, `too_soon` (mit `retryAfter`), `daily_limit`.
- **Einkaufsliste:** mehrere Listen, offline nutzbar (die App schickt ihre Änderungen als
  Operationen nach; dieselbe ID zweimal legt nichts doppelt an, die zuletzt angekommene
  Änderung gewinnt), „Erledigte entfernen“, **„Ich gehe einkaufen“** an alle anderen
  Mitglieder (höchstens alle 15 Minuten pro Liste und Person).
- **Aufgaben:** einmalig, täglich, wöchentlich an Wochentagen, monatlich; *fest* (jede Person
  hakt selbst ab), *reihum* (wer dran ist, rückt beim Erledigen weiter) oder *wer zuerst*
  (die Erinnerung der anderen wird durch „erledigt“ ersetzt). Erinnerung, sobald fällig
  (Uhrzeit, ohne Uhrzeit 08:00), einmal pro Termin und Person, mit „In 1 Std“ (Snooze 15–240
  Minuten) noch einmal. Sterne (0–10) für Kinder, Wochenstand ab Montag 00:00.
- **Termine & Geburtstage:** Termine mit Uhrzeit oder ganztägig, mehrtägig, jährlich;
  Geburtstage der Mitglieder kommen automatisch dazu (29. Februar → 28. Februar in anderen
  Jahren). Erinnerung 0–14 Tage vorher um 08:00; Geburtstage der Mitglieder am Tag an alle
  anderen.
- **Kinder orten:** nur auf Anfrage der Eltern; das Kind sieht jede Abfrage. *Automatisch*:
  das Kinder-Handy sendet den Standort und zeigt die Mitteilung; *Kind bestätigt*: das Kind
  sendet oder lehnt ab. Eine offene Anfrage pro Kind, mindestens 60 s Abstand, höchstens 30
  pro Kind und Tag; nach 10 Minuten ohne Antwort „Keine Antwort von …s Handy“. Koordinaten
  werden 7 Tage nach der Antwort gelöscht, das Protokoll (wer, wann, Ergebnis) nach 90 Tagen.
- **„Bin angekommen“** (mit Ort, z. B. Schule) an die Eltern; **SOS** als dringende Mitteilung
  (Priorität *critical*, Thema `sos` mit `allowCritical` – auch in der Ruhezeit) an alle
  Eltern, mit Position, wenn bekannt; eine Wiederholung innerhalb von 30 s ist dasselbe SOS;
  Eltern bestätigen mit „Gesehen“ (Mitteilung an das Kind). SOS läuft nie in das eigene
  Stundenbudget des Plugins.
- **Orts-Erinnerungen** (Geofencing auf dem Handy): beim Ankommen oder Verlassen eine Notiz,
  eine Einkaufsliste oder „Familie benachrichtigen“; für andere Personen erst nach deren
  Zustimmung (jede Änderung fragt erneut); höchstens 50 aktive pro Person; jedes Auslösen
  steht 90 Tage im Protokoll (ohne Koordinaten).
- Benachrichtigungsthemen: Einkaufsliste, Aufgaben, Termine & Geburtstage, Kinder orten,
  „Bin angekommen“, SOS (Notfall), Orts-Erinnerungen – immer an genannte Personen, mit
  `data.familie = { type, … }` für die App. Eigenes Budget unter `permissions.notify.perHour`
  (120).
- Zeitzone: Plugin-Einstellung `timezone` (leer = Zeitzone des Servers); Sprache der
  Benachrichtigungen: `notify_lang`.
- Braucht GateControl 1.164.0 (`permissions.app`, `ui.app`, `ui.maps`, `notify.perHour`,
  `allowCritical`, Client-API `/api/v1/client/plugins`).
