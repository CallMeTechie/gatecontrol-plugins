# Familie (gatecontrol-familie)

Die Familie in der GateControl-App (eigener Tab), im Portal (eigener Tab „Familie“) und auf
drei Admin-Seiten. Alles bleibt auf dem eigenen Server.

## 1.1.1
- **Kiosk-Anmeldung für das Wand-Tablet** (braucht GateControl ≥ 1.165.0, neue Berechtigung
  `permissions.kiosk` – im Installationsdialog „darf Benutzer als Kiosk-Geräte freigeben“): Jedes
  Mitglied mit der Rolle **„Wand-Tablet“** gibt das Plugin in GateControl als Kiosk-Benutzer frei
  (`gc.kiosk.allow`); wechselt die Rolle weg von „Wand-Tablet“ oder wird das Mitglied entfernt,
  nimmt es die Freigabe zurück – jedes gekoppelte Tablet des Kontos ist dann beim nächsten Aufruf
  abgemeldet. Beim Start gleicht das Plugin die Liste ab (`gc.kiosk.list`): freigegeben sind genau
  die aktuellen Wand-Tablets. Administrator-Konten und deaktivierte Konten lehnt GateControl ab –
  ein solches Wand-Tablet bleibt Mitglied, lässt sich aber nicht koppeln (Hinweis auf der Seite
  „Funktionen“, Warnung im Log).
- **Neue Einrichtung:** Konto anlegen (z. B. „Küche“, Rolle Mitglied), unter „Mitglieder & Ortung“
  als „Wand-Tablet“ hinzufügen, in GateControl das Konto öffnen › **„Kiosk-Gerät koppeln“**, auf
  dem Tablet den QR-Code scannen oder `https://<Portal>/portal/kiosk` öffnen und den Code
  eingeben, Kiosk-Browser auf `https://<Portal>/portal`. Die Kopplung hält 90 Tage und verlängert
  sich bei jeder Benutzung, gilt nur für das Portal und lässt sich in GateControl beim Benutzer
  („Kiosk-Geräte“ › „Widerrufen“) oder mit „Abmelden“ auf dem Tablet beenden. Der Rat, dafür
  `GC_SESSION_MAX_AGE` zu erhöhen, entfällt.
- **Wand-Ansicht:** ein gekoppeltes Kiosk-Gerät (`req.user.kiosk`) zählt wie eine echte
  Portal-Anmeldung – es hakt Aufgaben ab und fügt Einkäufe hinzu (weiterhin nur, was das
  Wand-Tablet darf). „Nur lesen“ bleibt für die Erkennung über Geräte-Vertrauen.

## 1.1.0
- **Abholen & Fahrten** (Funktion `rides`, Gruppe Unterwegs, Standard an): eine Fahrt ist eine
  Strecke zu einer Uhrzeit („Tim vom Training abholen“, 16:00, Sporthalle Nord), einmalig oder
  wöchentlich an Wochentagen (Serie bis zu einem Enddatum oder offen, mit Standard-Fahrer: ein
  Mitglied oder ein Freitext wie „Familie Weber“ oder „Bus“). Eine Änderung an einem Termin der
  Serie (übernehmen, absagen, Fahrer, Uhrzeit …) gilt nur für diesen Termin. **„Ich mache es“**
  (Eltern und volljährige Mitglieder), **„Kann nicht“** (Eltern – sagen alle Eltern ab, erfährt
  es, wer gefragt hat: „Niemand kann Tim abholen“), **„Rückgängig“** (der Fahrer), **„Wer kann
  …? fragen“** (jedes Mitglied, höchstens alle 5 Minuten pro Fahrt, an alle Eltern, die nicht
  abgesagt haben). Kinder legen mit **„Bitte abholen“** eine Fahrt für sich selbst an (ohne
  Fahrer, ohne Serie), die Eltern werden gleich gefragt; ihre eigene Anfrage können sie wieder
  absagen. Löschen eines Termins = abgesagt (bleibt sichtbar), `?series=1` entfernt die Serie. Erinnerung an den Fahrer 0–120 Minuten vorher (Standard 20: „Gleich: …“), eine
  noch offene Fahrt 60 Minuten vorher an die Eltern („Noch offen: …“) – je einmal pro Termin.
  Neues Benachrichtigungsthema **„Abholen & Fahrten“** (`rides`). Fahrten bleiben 30 Tage nach
  ihrem Datum.
- **Notfall-Karte** (`emergency`, Kinder & Sicherheit, Standard an): pro Mitglied Blutgruppe,
  Gewicht, Allergien, Medikamente, Erkrankungen (je ≤ 300 Zeichen), Hinweise (≤ 500),
  Krankenkasse mit Versichertennummer und bis zu 10 Kontakte; dazu bis zu 20 wichtige Nummern der
  Familie (Kinderarzt, Giftnotruf … – es werden keine Nummern vorgegeben). Telefonnummern nur mit
  Ziffern, Leerzeichen und `+ / ( ) -`. Alle Mitglieder lesen (im Notfall braucht sie jeder);
  jede Person bearbeitet ihre eigene Karte, Eltern jede Karte und die Nummern der Familie.
  Gesundheitsdaten liegen nur in der Datenbank des Plugins auf dem eigenen Server – nie in
  Mitteilungen, nie im Log. Im Portal-Tab „Familie“ für angemeldete Eltern (nicht auf den
  Admin-Seiten – Administratoren gehören nicht unbedingt zur Familie); über Geräte-Vertrauen
  erkannte Personen und das Wand-Tablet sehen sie nicht. Die App speichert sie verschlüsselt für
  offline und zeigt „Notruf 112“ selbst an.
- **Wand-Tablet** (`wall`, Zuhause, Standard aus): ein Dashboard im Portal für ein festes Tablet
  (Vorlage 10" quer): Uhr und Datum, die Familie, „Heute“ (Termine heute und morgen, Fahrten von
  heute, Geburtstage der nächsten 7 Tage), die Aufgaben von heute mit einem großen Knopf pro
  Person (*reihum*: wer dran ist, *fest*: jede Person, *wer zuerst*: jede Person) und die offenen
  Einträge einer Einkaufsliste (antippen = gekauft, Feld = hinzufügen). Lädt jede Minute neu,
  von 21 bis 6 Uhr (Server-Zeit) dunkel, verschiebt sich alle paar Minuten um wenige Pixel gegen
  Einbrennen, ohne Scrollen.
  - **Zugang:** ein eigenes GateControl-Konto (z. B. „Küche“) mit der neuen Rolle
    **„Wand-Tablet“** (Mitglieder & Ortung). Sein Portal-Tab „Familie“ *ist* die Wand-Ansicht
    (`/portal#plg-gatecontrol-familie`). Ein Wand-Tablet gehört nicht zur Familie: nirgends
    aufgeführt, keine Mitteilungen, kein App-Tab (`appVisible` false), keine Ortung, kein SOS,
    keine Notfall-Karte, kein Bearbeiten von Aufgaben, Terminen oder Fahrten (`403 forbidden`).
    Es darf Aufgaben für die zuständige Person abhaken, Einkäufe hinzufügen und abhaken, Termine
    und Fahrten lesen. Welche Liste es zeigt, steht auf der Seite **Funktionen** (Standard: die
    erste).
  - **Anmeldung – empfohlene Einrichtung:** das Tablet als eigenes VPN-Gerät (WireGuard-Peer)
    dem Konto „Küche“ zuordnen; mit „Geräte-Besitzer automatisch erkennen“ erkennt das Portal es
    dauerhaft ohne Anmeldung – dann **nur lesen**. Zum Abhaken braucht das Portal eine echte
    Anmeldung: dem Konto „Mein Bereich“ erlauben und auf dem Tablet einmal mit Benutzername und
    Passwort anmelden. Eine Web-Anmeldung hält so lange wie `GC_SESSION_MAX_AGE` (Standard
    24 Stunden ab der Anmeldung, Benutzung verlängert sie nicht), eine Anmeldung über den Link der
    App oder die Portal-PIN höchstens 8 Stunden; danach liest die Wand weiter und zeigt „Nur lesen“.
    Wochenlang angemeldet bleibt sie nur mit einem höheren `GC_SESSION_MAX_AGE` am Server (gilt für
    alle Web-Anmeldungen). Kiosk-Browser (z. B. Fully Kiosk Browser) mit der Start-Adresse
    `https://<Portal>/portal#plg-gatecontrol-familie`, Bildschirm an, Cookies behalten.
- **Kinder ab 14:** auf „Mitglieder & Ortung“ und „Funktionen“ steht bei Kindern ab 14 mit
  *Automatisch* der Hinweis „Ab 14 empfehlen wir „<Name> bestätigt““; neue Kinder ab 14 beginnen
  mit *Kind bestätigt*. Am 14. Geburtstag (ab 09:00) bekommen die Eltern einmal die Mitteilung
  „Lena ist heute 14 – Ortung auf „Lena bestätigt“ umstellen?“ (Thema `locate`). Die Ortungsart
  wird nie von selbst umgestellt.
- **Funktionen:** gruppiert wie die Vorlage (Alltag / Unterwegs / Kinder & Sicherheit / Zuhause),
  neue Schalter `mod_rides`, `mod_emergency`, `mod_wall`; Karte „Wand-Tablet“ mit der Liste und
  der Einrichtungsanleitung. **Portal:** Fahrten der nächsten 7 Tage (übernehmen, absagen,
  fragen, rückgängig), Notfall-Karte für Eltern.
- **App-API** (zusätzlich zu 1.0.0):
  - `GET me` → `modules` mit `rides`, `emergency`, `wall`; `me.role` kann `wall` sein
  - `GET overview` → `rides: { next: [Fahrt …] (nächste 24 h, höchstens 5), open: n (offen in den
    nächsten 7 Tagen) } | null`
  - `GET rides?from=&to=` (Standard heute + 7 Tage, höchstens 62), `GET rides/<id>`, `POST rides`,
    `PATCH|DELETE rides/<id>[?series=1]`, `POST rides/<id>/take|release|decline|driver|ask` —
    Ids sind Zeichenketten: `"<id>"` (einmalig) oder `"<Serien-Id>:<Datum>"`
  - `GET emergency`, `PUT emergency/members/<userId>`, `PUT emergency/contacts`
  - `GET wall` (Wand-Tablet)
  - neue Fehlercodes `already_taken` (409, mit `driver`), `cancelled` (409); `invalid` nennt bei
    der Notfall-Karte das Feld (`field`, z. B. `contacts.0.phone`); `forbidden` für das
    Wand-Tablet
  - Mitteilungen mit `data.familie.type` `ride_ask`, `ride_taken`, `ride_released`,
    `ride_unassigned`, `ride_reminder`, `ride_open` (`rideId`, `date`) und `locate_age_hint`
    (`childId`)
- Datenbank: Migration `002_rides_emergency.sql` (Fahrten, Ausnahmen einzelner Termine,
  Notfall-Karte, einmalige Mitteilungen). Beim Entfernen eines Mitglieds geht seine Notfall-Karte
  mit.
- Braucht weiterhin GateControl 1.164.0.

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
