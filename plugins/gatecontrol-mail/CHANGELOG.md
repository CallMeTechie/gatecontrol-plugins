# Mail (gatecontrol-mail)

Alle E-Mail-Konten an einem Ort – im eigenen Tab der GateControl-Apps und im Portal.

## 1.18.0

„Termin“ in der Schnell-Eingabe von Notizen & Aufgaben (gatecontrol-notizen ≥ 1.9.0): Mail nimmt echte Termine an und
meldet die Termine der Kalender an die Übersicht. Keine neuen Dienste, keine neue Berechtigung, keine Migration.

- **Dienste für Notizen & Aufgaben** (`server/services.js`, Aufrufer `gatecontrol-notizen`):
  - `calendar_list` jetzt auch für Notizen – dann **alle** Kalender, die die Person sieht: `{ calendars: [{ id, key,
    name, color, kind: own | shared | family | subscribed | tasks, writable, isDefault, area, account: { label, kind } }],
    defaultId, reminders: { timed, allDay }, timeZone }`; ohne Adressen. Wer die Kalender nicht nutzen kann:
    `{ calendars: [], reason }`. Für Drive unverändert (nur beschreibbare Kalender mit Konto).
  - `calendar_add`: ohne `calendarId` der Standardkalender der Person (nie „Aufgaben“); `endsAt` (ganztägig über
    mehrere Tage, ≤ 7), `location` (≤ 255), `reminder` in Minuten (ohne: Standard des Kalenders – 15 Minuten bzw. am
    Vortag 18 Uhr; `false`: keine), `recurrence` (wie `POST events`), `items: true` → Antwort `{ eventId, calendarId,
    items, replayed? }` mit dem Termin als Einträge für die Übersicht. Ein `key` ohne `calendarId` findet den früher
    angelegten Termin in jedem Kalender (idempotent, auch nach geändertem Standardkalender).
  - `calendar_update`: zusätzlich `location` (null entfernt), `allDay: true` mit `startsAt`/`endsAt`, `reminder`,
    `recurrence` (null beendet die Serie), `items: true`. Wie bisher nur für Termine, die der Aufrufer mit `key`
    angelegt hat. Drive bleibt bei seinen bisherigen Feldern (alles andere `invalid`). Mit `keyKind: 'event'` (auch bei
    `calendar_delete`) nur Termine, die mit einem Schlüssel `event:…` angelegt wurden – nie der Eintrag einer Aufgabe
    im Kalender „Aufgaben“.
- **Termine für die Übersicht** (`server/notizen.js`, Vertrag `docs/notes-sources-contract.md` § 6b): Einträge der Art
  `event` mit `meta.type: 'calendar'`, Gruppe = Kalender (`cal:<id>`), von heute an 30 Tage (höchstens 400 je Person),
  je Vorkommen einer Serie ein Eintrag (`ev:<id>[:<Vorkommen>]`). Termine, die mehrere Personen sehen, tragen die
  Person in der Kennung (`sh:<Person>:<id>…` für geteilte GateControl-Kalender, `ov:<Person>:…` für den
  Familienkalender) – sonst bekäme nur eine Person den Eintrag. Eigene Kalender, mit der Person geteilte GateControl-Kalender (nur was sie lesen
  darf, nie private Termine), der Familienkalender (`overlay:familie`), abonnierte Kalender und „Aufgaben“ (die
  Übersicht blendet die letzten beiden aus, bis die Person sie einschaltet). Nicht: abgesagte Termine, abgelehnte und
  unbeantwortete Einladungen. Auch für Personen ohne Mail-Konto. Nur an einen Hub, der danach fragt
  (`todo_items { accepts: ['calendar'] }` oder `items: true`) – ein älterer Hub bekommt weiterhin nur „Zu tun“ und
  markierte Mails; die Antwort nennt dann `provides: ['calendar']`. Änderungen an Terminen, Kalendern und Einladungen
  gehen nach wenigen Sekunden hinaus. `todo_complete` lehnt einen Termin mit `read_only` ab.
- **Portal:** Direktlink `?open=event/<id>[/<Vorkommen>]` und `?open=calendar/<Datum>` (`ui/pimlogic.js` `openLink`,
  `ui/portal.js`): öffnet den Kalender und den Termin in seinem Dialog – so öffnet Notizen & Aufgaben einen Termin
  (`GC.openPortal`). Neu auch `?open=event/new&title=…&date=…&time=HH:MM[-HH:MM]&loc=…&cal=<id>&rem=<Minuten|none>&rep=<Art>[:<Abstand>][:MO,…]`
  („Mehr Angaben …“ der Schnell-Eingabe dort): das Formular „Neuer Termin“, vorbelegt; gespeichert wird wie immer
  über Mail. Was nicht passt, wird weggelassen (`ui/pimlogic.js` `newEventArgs`, `ui/calendar.js` `newEvent({ prefill })`).
- **Tests:** `test/termine.test.js` (Dienste, Rechte, Standardkalender, Erinnerung, Serie, Schlüssel, Meldung an den
  Hub mit Einladungen, geteilten Kalendern und Familienkalender, älterer Hub), `test/portal.test.js`,
  `test/portal-pim.test.js` (Direktlink, vorbelegtes Formular).

## 1.17.3

Fehlerbehebung (Server-Log): „In Drive speichern“ eines Anhangs mit unbekanntem oder ungewöhnlichem Typ endete mit 500.

- **Ursache** (`server/graph.js` `download`): Microsoft-Anhänge holt Mail mit `gc.media.fetch` und gab dabei Graphs
  `contentType` als erzwungenen Typ mit. GateControl speichert für Mail nur Typen aus `media.types` (plugin.json) und nie
  einen der Sperrliste (HTML, XML, JSON, SVG …) – `message/rfc822`, `text/html`, `application/json`, `unknown/unknown`
  u. a. wurden mit `ERR_MEDIA_TYPE` abgelehnt. Der Code war Mail unbekannt: 500 „internal“ für
  `POST messages/<id>/attachments/<n>/drive/suggest` (und `…/drive/save`, das Öffnen des Anhangs). IMAP-Anhänge waren
  nicht betroffen (GateControl übernimmt dort jeden gültigen Typ).
- **Typ mit Rückfall** (`server/util.js` `storeType`): der eigene Typ (Grundtyp ohne Parameter wie `; name=…`), wenn
  GateControl ihn für Mail annimmt, sonst der Typ der Dateiendung (pdf, docx, jpg, …), sonst
  `application/octet-stream` (ein Download – HTML öffnet nie als Seite). Lehnt GateControl trotzdem ab (eine andere
  Liste), ein zweiter Versuch als `application/octet-stream`.
- **415 statt 500** (`server/index.js`, `server/drive.js`, `server/util.js`, `server/texts.json`): neuer Fehlercode
  `unsupported_type` (415) mit Meldung (de/en) für `ERR_MEDIA_TYPE` von GateControl und für eine Übergabe an Drive, die
  Drive wegen des Typs ablehnt (vorher 409 `drive_unavailable`).
- **Tests** (`test/attachments.test.js`): `storeType` (Parameter, Groß-/Kleinschreibung, Endung, gesperrte Typen);
  Microsoft-Mail mit `.eml`, HTML, `unknown/unknown`, ohne Typ und mit `; name=…` – Vorschlag und Speichern 200,
  geholt mit dem erwarteten Typ; Drive ohne passenden Typ → 415 `unsupported_type` mit Meldung auf Deutsch und Englisch.

## 1.17.2

Fehlerbehebungen (Befunde aus PR #246): ältere Mails nach Datum statt UID, Ordnerflag `complete`, deterministischer
Budget-Test.

- **Ältere Mails nach dem Datum** (`server/imap.js` `older`): Jenseits der Aufbewahrung kamen die `count` höchsten UIDs
  vor dem Cursor. In importierten oder befüllten Ordnern folgen UIDs dem Eingang in den Ordner, nicht dem Datum – der
  erste Stapel waren Mails von vor Jahren, die Liste setzte ihren Cursor dorthin, und neuere Mails eines späteren
  Stapels lagen über dem Cursor (nie zu sehen, springende Liste). Jetzt nach dem Date-Kopf, nach dem auch die Liste
  sortiert (`SENTBEFORE`/`SENTSINCE`, UTC-Tagesgrenzen): eine Suche nach allen unbekannten älteren Mails (wie bisher;
  leer → vollständig), bei mehr als `count` Tagesfenster rückwärts, je doppelt so lang, bis sie `count` Mails halten;
  das letzte Fenster wird halbiert, solange es weit mehr hält; dazu ein Tag darunter (Zeitzone des Date-Kopfs). Wenige
  Suchen je Stapel (höchstens `WINDOWS_MAX`), Kopfdaten nur der gewählten Mails – nicht des ganzen Ordners. Holt ein
  Stapel alle übrigen Mails, ist der Ordner sofort vollständig (nicht erst nach einem leeren Stapel).
- **`complete` bleibt stehen** (`server/imap.js` `syncFolder`, `server/graph.js` `syncFolder`): Mit
  Aufbewahrungsgrenze schrieb jede Synchronisierung `complete = 0` – die Liste fragte an ihrem Ende jedes Mal den Server
  und gab `next`, obwohl nichts mehr kam. Jetzt: ohne Grenze wie bisher, mit Grenze der Wert, den `older` gesetzt hat;
  eine neue UIDVALIDITY setzt ihn zurück (auch im Speicher). Die Aufräumung (`server/engine.js` `retention`) setzt
  ihn für die Ordner der entfernten Mails auf 0.
- **Budget-Test „Runde in Häppchen“ deterministisch** (`test/budget.test.js`): Schon die Einrichtung lief mit dem
  Zugbudget von 60 ms; auf einer langsamen Maschine war die erste Runde danach nicht durch, `roundDue` ließ ihren Rest
  stehen, und die geprüfte Runde öffnete nur diesen Rest. Jetzt Einrichtung mit den üblichen Grenzen (geprüft: keine
  Runde offen) und für die geprüfte Runde eine eigene Uhr (`engine.clock`, von `deadline` gelesen), die jedes Öffnen um
  25 ms vorstellt – die Prüfung ist schärfer: genau drei Ordner je Zug, genau vier Läufe. Derselbe Fehler steckte in
  „ein Konto hängt an seinem Server“ (Einrichtung unter `runMs: 300`; unter Last ebenfalls rot): Einrichtung mit den
  üblichen Grenzen, die Uhr des Laufs steht, der Test wartet auf das Ende der Züge statt auf feste 100 ms.
- Tests: `test/list_paging.test.js` (importierter Ordner mit gemischter UID-/Datumsfolge, Flag nach Sync und
  Aufräumung); die Test-Mailwelt kennt `SENTSINCE`/`SENTBEFORE` und ein eigenes `internalDate`.

## 1.17.1

Fehlerbehebungen: „mit Anhang“ in der Unterhaltungsansicht, unveränderte Kontakte, Schreiblast des Virenscans.

- **„mit Anhang“ verschluckte Unterhaltungen** (`server/messages.js` `list`): Eine Seite zählt Unterhaltungen und
  Mails, die den Filter bestehen; jenseits der Aufbewahrung kamen ältere Mails vom Server aber in Stapeln von `limit`
  Mails. Füllte ein Stapel die Seite nicht, endete die Liste (kein `next`), und eine erste Seite ohne Treffer gab gar
  keinen Cursor – eine Unterhaltung, deren Anhang nur in einer älteren Mail jenseits der Aufbewahrung steckt, erschien
  nie. Jetzt lädt eine Seite Stapel um Stapel, bis sie voll ist, der Server nichts mehr hat oder `WAIT_MS` um ist; die
  Liste gibt `next`, solange der Ordner nicht vollständig ist; mit Filter lädt auch eine leere erste Seite. Die Unterhaltung
  steht weiter mit ihrer neuesten passenden Mail in der Liste (1.10.1).
- **Microsoft, ältere Mails** (`server/graph.js` `older`): ab der ältesten Mail hier, nicht ab der letzten Zeile der
  Seite – mit Filter oder Unterhaltungen ist die viel neuer, Microsoft lieferte nur Bekanntes, und der Ordner galt als
  vollständig. **IMAP** (`server/imap.js` `older`): `BEFORE` zählt ganze Tage – der Tag selbst gehört jetzt dazu (die
  bekannten Mails bleiben außen vor).
- **„mit Anhang“ über einen Teilindex** (`migrations/016_attachments.sql` `messages_att`, `INDEXED BY` in `page`): vorher
  las jede Seite die Zeile jeder Mail des Ordners, um `has_att` anzusehen.
- **Kontakte: unverändert = kein Schreiben** (`server/cardstore.js` `storeCard`): Eine neue ETag desselben Inhalts
  (der Server stempelt `REV`/`PRODID`, faltet das Foto anders, ordnet Eigenschaften um), ein Graph-Delta von vorn (nach
  410) oder eine neue `changeKey` schrieben jede Karte neu – Zeile, Adressen, Nummern, Foto, neue Version für
  `GET cards?since=` und das Live-Ereignis `contacts`. Jetzt werden die Felder kanonisch (Schlüssel sortiert), die vCard
  ohne `REV`/`PRODID` mit sortierten Zeilen und das Foto ohne Zeilenumbrüche verglichen: gleich → höchstens ETag,
  `changeKey`, `href` werden nachgeführt, keine Version, kein Ereignis, kein Abgleich der Dubletten (`pimdav.js`,
  `pim.js`). `setPhoto` schreibt dasselbe Bild nicht erneut. Karten mit ausstehender Änderung (`pending`) wie bisher.
- **Virenscan: Ergebnisse gesammelt** (`server/scan.js`, Muster von Drive 1.28.1): Der Hook `mediaScanned` kommt je
  Datei (nächtliche Nachprüfung: Hunderte in Minuten). Jeder Hook las und schrieb für sich; mehr als 32 offene
  Host-Aufrufe → `ERR_BUSY`, und je Datei „scan state failed“. Jetzt: Warteschlange (100 ms sammeln, Stapel bis 200), eine
  Transaktion je Stapel, immer nur ein Stapel, nur geänderte Zeilen (ohne Änderung keine Transaktion, kein Ereignis), eine
  `UPDATE` je Ergebnis für viele Zeilen; `ERR_BUSY`/`SQLITE_BUSY`: derselbe Stapel nach 250 ms, 1 s, 3 s, danach 30 s
  warten (höchstens zehnmal); eine Zeile „scan states deferred (database busy)“ je Lauf, bei anderem Fehler eine Warnung
  je Stapel mit `files`. `keepAttachment` schreibt dasselbe Ergebnis nicht erneut; `stop()` versucht Wartendes einmal.
  Indizes `attachments_media`, `draft_atts_media` (vorher las jedes Ergebnis alle Anhänge).
- Tests: `test/list_paging.test.js`, `test/card_writes.test.js`, `test/scan_writes.test.js` (494 Hooks gleichzeitig unter
  der Grenze von 32 Host-Aufrufen).

## 1.17.0

Nutzerprofil – Vorschlag für Absendername und Signatur (GateControl ≥ 1.280.0, `permissions.profile: ["firstName", "lastName"]`).

- **`GET me` mit `suggest`** (`server/profile.js`): `{ senderName, signature, from: 'profile' | 'account' }` – Vor- und
  Nachname aus `gc.profile.get(person, { viewer: person })` (in der eigenen Anfrage sieht die Person auch „Nur ich“),
  Signatur „Vorname Nachname“. Ohne Namen im Profil oder auf einem älteren GateControl (kein `gc.profile`): der
  Anzeigename, keine Signatur.
- **`POST accounts`** nimmt `signature` (≤ 4000 Zeichen, sonst 400 `invalid` mit `field: 'signature'`).
- **Portal:** Das Formular „Konto hinzufügen“ (Passwort/IMAP) ist mit dem Vorschlag vorbelegt, mit neuem Feld „Signatur“;
  der Kontodialog bietet „Übernehmen“, wenn der Absendername vom Profil abweicht oder die Signatur leer ist – gespeichert
  wird erst mit „Speichern“.
- **Nur ein Vorschlag:** Absendername und Signatur bleiben je Konto; eine Änderung im Profil (Hook `profileChanged`)
  überschreibt nichts – `suggest` wird bei jedem `GET me` frisch gelesen, es gibt nichts zu verwerfen.

## 1.16.0

- **Dienst `contacts_phones` für den Messenger („Neuer Chat“, Abschnitt „Aus deinem Adressbuch“).** Nur Lesen, nur der
  Aufrufer `gatecontrol-messenger`, nur für die Person des Aufrufs (`userId` = GateControls `user`) und nur ihre eigenen
  Kontakte: Kontakte mit mindestens einer Telefonnummer, wie „Kontakte“ sie zeigt (verknüpfte unter ihrem Hauptkontakt,
  nur sichtbare Adressbücher), sortiert wie dort. Je Nummer `key` (Art, die zweite derselben Art `mobile-2` …), `kind`
  (`mobile` | `work` | `home` | `other`, Fax fällt weg), `value` wie gespeichert, `e164` (mit `+` und Landesvorwahl; eine
  nationale 0 gilt als Deutschland) und `landline` (Festnetz nach der Vorwahl: +49 außer 15x/16x/17x, +43 außer 6xx,
  +41 außer 75x–79x; `null` = unbekannt). Mobilnummern zuerst, dann geschäftlich, privat, Festnetz zuletzt. Suche
  (`q`) nach Name, Firma und Ziffern, seitenweise (`limit` ≤ 100, `cursor`), eine Seite bleibt unter den 16 KB einer
  Dienst-Antwort; `ids` (≤ 50) liefert genau diese Kontakte (der angetippte). Verweigerungen: `forbidden`, `invalid`,
  `unavailable { reason }` (`feature_off` – Kontakte abgeschaltet –, `not_allowed`, `not_licensed`, `no_seat`).
  `maxPerHour: 3600` (`server/services.js`, `plugin.json` `services.provides`).
- Tests: `test/services.test.js` (Arten, Schlüssel, +49, Festnetz zuletzt, Suche, Seiten, `ids`, nur eigene Kontakte,
  nur der Messenger, Verweigerungen, 16 KB je Seite).

## 1.15.1

- **Volltextsuche: Die Suche liest die Mails im Index nicht mehr einzeln an.** Bei eingeschalteter Volltextsuche sucht
  `GET search` zusätzlich per `LIKE` in den Mails, die der Index (noch) nicht ganz hält (`m.fts <> 1`: Rest des Aufbaus,
  Ende sehr langer Texte). SQLite nahm für diese Anweisung nicht den Teilindex `messages_fts_todo`, sondern den Weg über
  das Konto (`SEARCH m USING INDEX messages_body_state (account_id=?)`) und las damit bei **jeder** Suche **jede** Mail
  des Kontos aus der Tabelle, nur um `fts` anzusehen – auch wenn der Rest leer ist. Mit 20 000 Mails kostete das so viel
  wie die Suche im Index selbst (gemessen 0,4–0,5 × alle Texte einmal lesen), auf einer langsamen Platte mit kaltem
  Cache entsprechend viele Seitenzugriffe. Jetzt geht die Anweisung fest über den Teilindex (`INDEXED BY`,
  `server/messages.js`): bei fertigem Index 0,01–0,02 × statt 0,4–0,5 ×; die ganze Anfrage ohne Treffer 0,20 × statt
  0,45 × der Suche von 1.13. Ergebnisse unverändert; bei ausgeschalteter Volltextsuche ändert sich nichts.
- Tests: `test/search.test.js` „viele Mails (20 000)“ prüft den Abfrageplan dieser Anweisung (nur über
  `messages_fts_todo`) – die bisherige Prüfung „Teilindex wird benutzt“ war schon durch die Zählung des Aufbau-Rests
  erfüllt und hat das Problem nicht gesehen; nur die Zeitmessung fiel auf (in der CI 0,51 × bei Grenze 0,5). Die
  Zeitmessung misst jetzt gegen das, was die Volltextsuche ersetzt (ein `LIKE`-Durchgang von 1.13 über alle Mails und
  Texte) statt gegen „alle Texte einmal lesen“: Die 32 Nachschläge im Index liegen gegen die alte Einheit
  konstruktionsbedingt bei 0,3–0,5 (unter Last gemessen bis 0,48), gegen die neue bei 0,1–0,2 – Grenze weiter 0,5.

## 1.15.0

- **Kalender „Aufgaben“ für Notizen & Aufgaben** (ab Notizen & Aufgaben 1.3.0): Aufgaben mit Uhrzeit stehen als Termin
  im Kalender der Person. Dafür neue und erweiterte Dienste (`server/services.js`, Migration 015):
  - `calendar_tasks { userId, lang? }` → `{ ok, calendar: { id, name, color, created } }` – findet oder legt je Person
    **einen** Kalender „Aufgaben“ an (`calendars.role = 'tasks'`, in der API als `role` am Kalender). Immer ein
    GateControl-eigener Kalender von Mail, nie einer eines Kontos: Es gibt ihn für jede Person auch ohne Konto, er hängt
    nicht an der Erreichbarkeit, den Grenzen oder der Zustimmung eines Anbieters, und kein Anbieter hängt dem Termin eine
    eigene Erinnerung an (Outlook täte das auf anderen Geräten – dann kämen wieder zwei Meldungen).
  - `calendar_add` jetzt auch für Notizen & Aufgaben und **mit Uhrzeit**: `{ …, allDay: false, start, end }` (Millisekunden,
    höchstens 7 Tage), `reminder: false` (Termin ohne jede Erinnerung), `busy: 'busy' | 'free'`; Titel für Notizen bis 255
    Zeichen. Für Drive ändert sich nichts.
  - `calendar_update { userId, eventId, title?, start?, end?, note?, busy? }` und `calendar_delete { userId, eventId }` –
    nur für Termine, die der Aufrufer selbst mit einem `key` angelegt hat, und nur für die Person des Aufrufs.
  - Budget der vier Dienste: 3600 Aufrufe je Stunde (`maxPerHour`).
- **Behoben:** Wird ein Termin gelöscht, geht sein Dienst-Schlüssel (`service_keys`) mit. SQLite vergibt die Nummer eines
  gelöschten Termins neu – ein liegen gebliebener Schlüssel hätte dann auf einen fremden Termin gezeigt (betraf auch die
  Fristen aus Drive).
- Tests: `test/services.test.js` (Kalender je Person einmal, Termin mit Uhrzeit ohne Erinnerung, Ändern, Löschen, fremde
  und selbst angelegte Termine bleiben unberührt, wiederverwendete Nummer).

## 1.14.0

- **Volltextsuche als Option** (Einstellungen › Karte „Suche“ › Schalter „Volltextsuche“, `settings.search.fulltext`) –
  **aus, bis ein Administrator sie einschaltet.** Neu: `server/search.js`, Migration 014.
  - **Aus (auch nach dem Update):** nichts ändert sich. Keine Tabelle, kein Trigger, kein Index, keine Anweisung im
    Hintergrundlauf, kein Eintrag im Speicher des Plugins; die Suche ist die von 1.13 (LIKE über Felder und Texte, auch
    mit ein oder zwei Zeichen). Die Migration 014 fügt nur die Spalte `messages.fts` hinzu (Standard 0) – SQLite
    schreibt dabei keine Zeile.
  - **Ein:** ein Suchverzeichnis über Betreff, Absender, Empfänger, Anriss und Text statt `LIKE '%…%'` über alle Mails
    und alle Mailtexte. SQLite FTS5 mit dem Tokenizer `trigram`, ohne Kopie der Texte (`content=''`,
    `contentless_delete=1`), in 32 Tabellen (`mail_fts_0` … `_31`, eine Mail in der Tabelle ihrer Nummer modulo 32).
    Geprüft gegen die Plugin-Datenbank des Servers (better-sqlite3, SQLite 3.53, `trusted_schema = OFF`, `sqlGuard`).
    - Gefunden wird wie bisher – die Eingabe als ein Stück Text, an jeder Stelle eines Felds, auch mitten im Wort
      („rechnung“ findet „Stromrechnung“). Besser: Groß/Klein ist auch bei Umlauten egal („ÜBERWEISUNG“ findet
      „Überweisung“; LIKE konnte das nur für a–z).
    - Kein Zeichen der Eingabe ist Suchsyntax (`"`, `*`, `(`, `AND`, `OR`, `NOT`, `:`, `^`, `%`, `_`, `\`).
    - **Verhaltensänderung nur bei eingeschalteter Volltextsuche:** Mit weniger als drei Zeichen (ein Trigramm braucht
      drei) wird in Betreff, Absender, Empfängern und Anriss gesucht, nicht in den Mailtexten.
    - Trigger halten das Verzeichnis (neue Mail, ihr Text, geänderter Betreff/Anriss, gelöschte Mail, verdrängter Text).
    - Die vorhandenen Mails kommen im Hintergrund hinein: neueste zuerst, in Häppchen (5 … 90 Mails, eine kurze
      Transaktion je Häppchen; ein langsames Häppchen halbiert das nächste), höchstens 3 s je Hintergrundlauf.
      `messages.fts` ist der Fortschritt – Abbruch oder Neustart jederzeit. Bis eine Mail im Verzeichnis ist, sucht
      `GET search` dort wie bisher; das Ergebnis ist immer vollständig. Texte über 100 000 Zeichen: der Rest per LIKE.
      Belegt die Datenbank mehr als 3 GB, ruht der Aufbau (Meldung im Protokoll).
    - **Speicher:** Das Verzeichnis belegt etwa so viel wie die Mailtexte selbst (gemessen: 191 Mio. Zeichen Text →
      440 MB).
  - **Wieder aus:** Die Trigger gehen sofort (die Suche ist ab da wieder die von 1.13). Der Hintergrundlauf entfernt
    dann das Verzeichnis Tabelle für Tabelle – jede eine eigene Anweisung, weil GateControl eine Anweisung nach 15 s
    beendet und das Löschen einer Tabelle alle ihre Seiten liest –, danach den Teilindex `messages_fts_todo`, und setzt
    `messages.fts` in Bereichen von 500 Mails auf 0 zurück. Der Platz wird **in der Datenbank** frei (neue Mails
    nutzen ihn); die Datei selbst wird nicht kleiner – das ginge nur mit `VACUUM`, das der Kern Plugins nicht erlaubt.
  - Umschalten mitten im Aufbau oder Abbau und Neustarts in jedem Zustand sind abgedeckt: Der Abbau läuft immer erst
    zu Ende, dann beginnt gegebenenfalls ein neuer Aufbau. Der Zustand (`off` | `on` | `removing`) steht im Speicher
    des Plugins (Schlüssel `search`) und wird nur beim Wechsel geschrieben.
  - Kann die Datenbank kein FTS5 mit `trigram`, legt das Einschalten nichts an; die Einstellungsseite sagt es. Die
    Mindestversion von GateControl bleibt 1.219.0.
  - `GET admin/settings` → `search { state: 'off' | 'building' | 'ready' | 'removing' | 'unavailable', pending, db {
    bytes, freeBytes } }` (Größe der Datenbankdatei und ihr freier Platz aus dem Dateikopf – keine Abfrage, die die
    Datenbank durchläuft; die Größe des Verzeichnisses allein lässt sich so billig nicht bestimmen). `GET search` →
    zusätzlich `index { state, pending }`.
  - Die Suche liest die Spalten der Liste (mit Unterabfragen) nur noch für die Mails der Seite, nicht für jeden Treffer.
- Gemessen mit 50 000 Mails (30 000 mit Text, Datenbank 329 MB, im Arbeitsspeicher), Volltextsuche ein und fertig
  aufgebaut gegen 1.13: ohne Treffer 378 ms → 40 ms, seltener Begriff im Text 181 ms → 58 ms, im Betreff
  173 ms → 25 ms, häufiger Begriff 145 ms → 134 ms. Aufbau: 39 s Arbeitszeit in 12 Läufen. Abbau gegen die echte
  Datenbank-Bibliothek des Servers (440 MB Verzeichnis, schneller Datenträger): 597 Anweisungen, längste 39 ms.
- Tests: `test/search.test.js` (eingeschaltet: Felder, Wortmitte, Umlaute, Sonderzeichen gegen LIKE, Trigger, Aufbau
  mit Abbruch und Neustart, volle Datenbank, sehr lange Texte, kurze Eingaben, Filter und Blättern, Datenbank ohne
  FTS5, Migration, Abfragepläne mit 20 000 Mails) und `test/search-switch.test.js` (Standard aus ohne jede Spur,
  ein → aus mit Abbau Schritt für Schritt, Umschalten mitten im Aufbau und Abbau, Neustarts, die Karte der
  Einstellungsseite DE/EN).

## 1.13.1

- **Der Hintergrundlauf hält sein Zeitbudget.** GateControl beendet einen Lauf nach 120 s („background run failed: plugin
  did not answer in time“ – im Protokoll vom 12./13. 11. 56 Mal in 15 Stunden). Ursachen im Code, nachgestellt in
  `test/budget.test.js`:
  - Ein Microsoft-Konto, dessen Anfragen ohne Antwort blieben, wartete in der Runde durch die Ordner für **jeden**
    Ordner sein eigenes Zeitlimit ab (30 s, je eine Meldung „folder sync failed <Konto> unreachable“) – 12 Ordner
    = 330 s in einem Lauf. Jetzt endet der Zug des Kontos beim ersten Fehlschlag ohne Antwort (ebenso bei 429/503 mit
    `Retry-After`, das eingehalten wird); nur ein Fehler, der einen einzelnen Ordner betrifft, überspringt diesen.
  - Ein Lauf arbeitete ohne Blick auf die Uhr alle Ordner eines Kontos ab (das Budget wurde nur zwischen zwei Konten
    geprüft) und danach Kalender, KI-Sortierung (bis 5 × 20 s), Ablage usw. Jetzt: Die Konten haben ihre Züge
    nebeneinander (vier zugleich, wer am längsten gewartet hat zuerst), ein Zug dauert höchstens 20 s und setzt im
    nächsten Lauf fort – die Runde durch die Ordner merkt sich ihren Platz (kein Ordner zweimal je Runde), eine
    Delta-Runde von Microsoft ihren `nextLink`, Mails ohne Text bleiben in der Warteschlange. Der Mail-Teil hat 40 s,
    der ganze Lauf 60 s; was nicht mehr passt (Kalender, Bilder, KI-Sortierung, Ablage, Aufräumen), kommt 15 s später.
    Erinnerungen und der Postausgang laufen immer.
  - IMAP-Befehle haben ein eigenes Zeitlimit (60 s, Texte und Anhänge 180 s; GateControl wartet 2 … 10 Minuten): Danach
    wird die Sitzung geschlossen, das Konto pausiert. Das Verbinden im Hintergrund wartet 10 s statt 30 s, eine
    Graph-Anfrage des Abgleichs 15 s statt 30 s.
  - Ein Zug, der trotzdem an seinem Server hängt, hält den Lauf nicht auf: Der Lauf antwortet nach seinem Budget, das
    Konto bekommt bis zum Ende seines Zugs keinen neuen. Der ganze Lauf antwortet spätestens nach 100 s; hängt ein Teil,
    steht er einmal im Protokoll („background run takes long part <Teil> <n> s“), daneben startet kein zweiter Lauf.
- **Meldungen mit Konto und Grund:** „account unreachable account 3 (Microsoft) unreachable: ERR_TIMEOUT“ bzw.
  „… (IMAP gmx) ERR_MAIL_NET: <Antwort des Servers>“ – einmal, wenn ein Konto nicht mehr antwortet, und „account
  reachable again“; „folder sync failed account 3 (Microsoft) folder 17 (archive) unreachable:
  ErrorInternalServerError“ für einen einzelnen Ordner (Nummer und Rolle, nie der Name). Vorher: „folder sync failed 1
  unreachable“ – die 1 war die Kontonummer, der Grund fehlte.
- **Weniger Schreibzugriffe:** Ein Ordner ohne Neues schreibt nichts mehr (vorher ein `UPDATE folders … synced_at` je
  Ordner und Runde und je Abgleich des Posteingangs, auf dem langsamen Datenträger je 0,2 … 0,9 s; eine Runde über 40
  Ordner: 39 Schreibzugriffe → 0). „Zuletzt abgeglichen“ steht im Speicher und wird geschrieben, sobald sich sonst
  etwas ändert oder der gespeicherte Wert älter als eine Stunde ist. Eine Delta-Runde von Microsoft ohne Änderung
  behält ihren `deltaLink`. `accounts.synced_at` (nur die Reihenfolge nach einem Neustart) ebenso.
- **KI-Sortierung:** Die Abfrage der unklaren Mails las bei jedem Lauf alle Mails (Protokoll: 1138 ms bei 0 Treffern);
  jetzt über den Teilindex `messages_ai_pending` (Migration 013; 50 000 Mails: 21,8 ms → 0,16 ms, Plan `SCAN m USING
  INDEX messages_date` → `… messages_ai_pending`). Die nächste Mail wird nur gefragt, solange die Antwort noch in den
  Lauf passt.

## 1.13.0

- **Mehrere Mails auf einmal (API für Apps und Portal):**
  - `POST messages/copy { ids, folderId }` (neu): kopiert in einen Ordner **desselben** Kontos (IMAP `UID COPY`, Microsoft
    Graph `copy`). Mails aus mehreren Konten oder ein Ordner eines anderen Kontos → 400 `invalid { field: 'folderId',
    reason: 'account' }`. Der Zielordner wird kurz abgeglichen, die Kopien stehen meist schon in der Antwort.
  - **Rückgängig:** `move`, `copy`, `archive`, `delete` (in den Papierkorb) und `junk` antworten mit `undo { token, kind,
    count, expiresAt, items: [{ id, newId, accountId, fromFolderId, toFolderId }] }`; `POST messages/undo { token }`
    nimmt die Aktion zwei Minuten lang einmal zurück (jede Mail zurück in ihren Ursprungsordner, Kopien werden gelöscht)
    → `{ ok, kind, restored, failed, items }`; zu spät 410 `undo_expired`. Gemerkt wird, wo der Server die Mail hingelegt
    hat: IMAP die neue UID aus MOVE/COPYUID, ohne UIDPLUS UIDNEXT des Ziels vorher und die Message-ID (nur Mails ab dieser
    UID, eine schon vorhandene gleiche Mail bleibt); Microsoft die neue Graph-ID. Neue Tabelle `undo_log`.
  - `threads: true` auf allen Bulk-Aufrufen: die übrigen Mails der Unterhaltung im selben Ordner gehen mit – in der
    Unterhaltungsansicht rückt so nicht die nächstältere Mail nach.
  - `all: true` mit dem Bereich einer Liste (`box` | `folder`, `tab`, `filter { unread, flagged, attachments }`,
    `except: [ids]`): alle Mails des Bereichs in der Server-Kopie, auch nicht geladene, höchstens 2000 (sonst 413
    `too_large { max, count }`). `GET messages/ids` → `{ ids, total, max, truncated }` für „Alle N auswählen“.
  - Antworten der Bulk-Aufrufe zusätzlich mit `count`, `ids` und bei `delete` `purged` (endgültig Gelöschtes, ohne Undo).
- **Wischen mit sieben Aktionen:** `settings.swipe { left, right }` mit `archive | delete | read | flag | move | junk |
  none` und `settings.confirmDelete` (Standard aus). Die alten Felder `swipeLeft` / `swipeRight` zeigen weiter nur die
  vier bisherigen Werte – `flag`, `move`, `junk` erscheinen dort als `none` (ältere Apps lesen unbekannte Werte als
  „Archivieren“); schickt eine ältere App für so eine Seite `none` zurück, bleibt die neue Aktion. `PUT settings` ändert
  nur die genannten Felder. Neue Spalte `prefs.confirm_delete`.
- `features`: `copy`, `swipeV2`, `undo`, `bulkAll`, `threadScope`.
- **Portal:** Kästchen pro Zeile, Umschalt-Klick für einen Bereich, „Alle N auswählen“ und eine Leiste für die
  ausgewählten Mails (Archivieren, Löschen, Verschieben, Kopieren, Gelesen/Ungelesen, Markieren, Spam, Auswahl
  aufheben); Ordnerauswahl mit Suche und „Zuletzt“ für Verschieben und Kopieren (auch für eine geöffnete Mail);
  „Rückgängig“ im Hinweis unten; Löschen fragt bei „Vor dem Löschen fragen“ (mit „Nicht mehr fragen“), im Papierkorb
  immer. Einstellungen: „Wischen / Schnellaktionen“ (links/rechts) und „Vor dem Löschen fragen“. Eine langsame
  Neuladung der Liste ersetzt nicht mehr die Liste eines inzwischen geöffneten Ordners.
- Tests: `bulk.test.js` (Kopieren, Undo bei IMAP mit/ohne neue UIDs und Microsoft, Unterhaltungen, „Alle“, Grenzen,
  Einstellungen mit alten Feldern), `portal-bulk.test.js` (Auswahl, Leiste, Ordnerauswahl, Nachfragen, Einstellungen).

## 1.12.1

- **Weniger Schreibvorgänge beim Kalenderabgleich (Microsoft 365):** ein Termin, eine Serie und ihre Vorkommen werden nur noch geschrieben, wenn sich etwas geändert hat – vorher schrieb jeder Abgleich jedes Vorkommen einer Serie neu (Termin-Zeile und `occurrences`, im Protokoll von GateControl 1.253.5 je ~300 ms auf einem langsamen Datenträger, 500 Mal in der Stunde). Eine Seite des Delta-Abgleichs und eine Seite der Kalenderansicht laufen in **einer** Transaktion; dass ein Abgleich nichts Neues brachte, meldet er jetzt auch so (kein `calendar`-Live-Ereignis, keine neue Kalenderversion).
- Ordnerliste von Microsoft-Konten: ein Ordner wird nur geschrieben, wenn sich Pfad, Name, Rolle oder die Zähler geändert haben; der Zustand von Kalender und Kontakten eines Kontos (`pim_state`) nur, wenn er sich ändert.
- Test: eine Runde ohne Neues schreibt weder Termin noch Vorkommen (`graphpim.test.js`).

## 1.12.0

- **Microsoft To Do für „Notizen & Aufgaben“:** drei neue Dienste, nur für `gatecontrol-notizen`, je `maxPerHour: 600`:
  `ms_accounts` (die Microsoft-Konten der Person mit `tasks`: ob To Do freigegeben ist), `ms_tasks_consent` (die
  Zustimmung zu `Tasks.ReadWrite` als Anmeldung per Gerätecode mit dem zusätzlichen Recht – inkrementelle Zustimmung, die
  Mails des Kontos laufen weiter; ohne `deviceId` der Code, mit ihr eine Abfrage im Takt von Microsofts `interval`) und
  `ms_tasks_token` (ein Zugriffstoken **nur** für `Tasks.ReadWrite`, aus dem Refresh-Token des Kontos geholt und bis kurz
  vor Ablauf behalten – Mails eigenes Token verlässt Mail nie; `consent_required` ohne Freigabe). Ein von Microsoft
  erneuertes Refresh-Token wird gespeichert; Mails eigene Erneuerung und die für To Do laufen nie gleichzeitig
  (`microsoft.js` `locked`).
- Wer sich mit einem Konto neu anmeldet, behält To Do (`Tasks.ReadWrite` wird wieder mit angefragt, wenn es freigegeben war).
- `Account.tasks`; `GET me` → `microsoft.tasksScope`; die Admin-Seite nennt `Tasks.ReadWrite` bei „Eigene Registrierung braucht“.

## 1.11.0

- **„Zu tun“ abhaken:** Ein Punkt aus „Zu tun“ der KI lässt sich jetzt erledigen – im Portal (antippen › „Erledigt“ /
  „Wieder offen“, erledigte sind durchgestrichen) und über `POST ai/<id>/todo/<index> { action: 'done' | 'open' }` →
  `{ todo }`. Jeder Punkt in `GET ai/<id>` trägt dazu `key` (kurze Prüfsumme aus Art und Text) und `done`; eine neue
  KI-Auswertung mit demselben Punkt behält den Haken. Neue Tabelle `todo_done`.
- **„Zu tun“ und markierte Mails in „Notizen & Aufgaben“:** Ist das Plugin „Notizen & Aufgaben“ (`gatecontrol-notizen`)
  installiert, stehen dort die Punkte aus „Zu tun“ (KI-Auswertungen der letzten 30 Tage, mit Datum und Uhrzeit in der
  Zeitzone der Person, Beträge als Chip) und die markierten Mails (die neuesten 200 je Person, nicht aus Papierkorb oder
  Spam) – nur für die Person des Kontos, solange sie Mail nutzen darf. Konten der Art „geschäftlich“ zählen als
  „Arbeit“ (`area: 'work'`), das Konto ist die Gruppe. Abhaken dort ist „Erledigt“ in Mail bzw. entfernt die
  Markierung (auch auf dem Server); Rückgängig markiert die Mail wieder. Antippen öffnet die Mail (`message/<id>`).
  - Mail schickt nur echte Änderungen (`gatecontrol-notizen:todo_changed`, Vertrag v1, Tabelle `todo_sent`):
    höchstens einmal pro Minute im Hintergrund und wenige Sekunden nach einer Änderung (Markierung, „Zu tun“, Mail
    verschoben); viele in einem Aufruf. Neue Indizes für markierte Mails und KI-Ergebnisse.
  - Neue Dienste für den Hub (nur `gatecontrol-notizen`, je 600 Aufrufe pro Stunde): `todo_items` (seitenweise,
    ≤ 16 KB) und `todo_complete`.
  - Ohne den Hub ändert sich nichts: kein Aufruf, keine Einträge.

## 1.10.1

- **Große Postfächer bremsen GateControl nicht mehr.** Der belegte Speicher einer Person (bei jedem Hintergrundlauf
  je Konto, alle 15 Sekunden, und bei jedem Öffnen der App) wurde aus den gespeicherten Mails selbst summiert: SQLite
  las dafür jeden Mailtext mit seinen Überlaufseiten – praktisch die ganze Datenbank, bei 50 000 Mails rund 420 MB je
  Summe (kalt 0,46 s, auf einer Festplatte im NAS Sekunden). Diese Lesungen liefen zwar im Datenbank-Thread des
  Plugins, legten aber die Platte für den ganzen Server lahm. Jetzt kommt die Summe aus dem neuen Index
  `bodies_bytes` (16 ms, nichts von der Platte); ebenso Kalender und Kontaktfotos.
- **Indizes für den Hintergrundlauf und die Listen** (Migration `010_speed.sql`): die Unterhaltung einer neuen Mail
  (In-Reply-To, Microsoft-Unterhaltung – vorher las jede neue Mail alle Mails der Person), Ungelesene je Posteingang
  (GET me, Ordner, Zähler), Mails ohne Text (Nachladen), Anhänge zum Ablegen, Aufbewahrung, „Zum Ablegen“ (auch
  `tofile_count` für Drive). Der erste Start nach dem Update legt die Indizes an; bei einem sehr großen Postfach dauert
  das einmalig bis zu einer Minute.
- **„Mit Anhang“ in der Unterhaltungsansicht** verschluckte Unterhaltungen, deren neueste Mail keinen Anhang hatte
  (ebenso Relevant/Sonstige, wenn die neueste Mail im anderen Reiter lag). Jetzt steht die Unterhaltung mit ihrer
  neuesten Mail, die zum Filter passt.
- Tests mit 30 000 Mails in drei Konten: jede Anweisung von GET me, Ordnern, Listen, „Zum Ablegen“ und zwei
  Hintergrundläufen unter 200 ms; die Pläne nutzen die Indizes.
- Keine neue Berechtigung. Mindestversion bleibt GateControl 1.219.0.

## 1.10.0

- **Arbeitszeit im Portal.** Kalender › Kalender-Einstellungen hat jetzt „Arbeitszeit“: die Arbeitstage (Mo–So) und
  „Von“/„Bis“ (Standard Mo–Fr 8–18 Uhr). „Frei/Gebucht“ zeigt diese Zeit, und „Vorschläge, bei denen alle können“ kommen
  nur aus ihr. Gespeichert wird `CalPrefs.workHours` über das bekannte `PUT calendar/settings { workHours }` (seit
  1.9.0); ohne Tag oder mit „Bis“ vor „Von“ geht nichts hinaus, der Dialog nennt den Grund. 00:00 als „Bis“ heißt
  Mitternacht (24:00). Nur mit dem Feature `freeBusy`. Bisher ließ sich die Arbeitszeit nur über die Schnittstelle
  ändern; die Apps (Android, Windows) bekommen dieselbe Einstellung in ihren Mail-Einstellungen.
- Handbuch: „Arbeitszeit“, Termine in geteilten Kalendern mit „Bearbeiten“ und der Schalter „Auch per E-Mail“ für
  Buchungsanfragen und -antworten (Portal und Apps).
- Keine Migration, keine neue Berechtigung. Mindestversion bleibt GateControl 1.219.0.

## 1.9.1

- Handbuch im Reiter „Handbuch“ (GateControl ≥ 1.241.0): `HANDBUCH.md` / `HANDBOOK.md` im Paket, in `plugin.json` unter `handbook`. Ältere GateControl-Versionen ignorieren es; die Mindestversion bleibt `>=1.219.0`.

## 1.9.0
- **Frei/Gebucht innerhalb von GateControl** (Mockup Planer). Beim Planen eines Termins zeigt Mail je Person und
  Ressource, wann sie frei, gebucht, vorläufig oder unbekannt ist – nie Titel. Termine, die als privat markiert sind,
  gelten immer als „gebucht“. Standardmäßig für alle an; jede Person schaltet es in den Mail-Einstellungen oder unter
  „Kalender teilen“ ab (dann „unbekannt“, außer für Personen, mit denen sie einen Kalender teilt). Kolleginnen in
  Microsoft 365 kommen über Graph `getSchedule` mit dem schon erteilten Recht `Calendars.ReadWrite` dazu; fehlt es,
  heißt es „unbekannt“ statt eines Fehlers. Externe Teilnehmer sind „unbekannt“.
- **Vorschläge, bei denen alle können:** die nächsten freien Zeiten in der eigenen Arbeitszeit (neu in den
  Kalender-Einstellungen, Standard Mo–Fr 8–18 Uhr). Ein Klick übernimmt die Zeit in den Termin.
- **Geteilte Kalender** (Mockup Teilen). Eigene GateControl-Kalender lassen sich mit Personen oder Gruppen teilen: Frei/
  Gebucht, Lesen (Titel, Ort, Zeiten) oder Bearbeiten (Termine anlegen und ändern, ohne Teilnehmer). Private Termine
  bleiben bei jeder Stufe „Gebucht“. Die Empfängerin blendet geteilte Kalender unter „Mit mir geteilt“ ein; die
  Besitzerin sieht „hat angenommen“ oder „Einladung offen“. Kalender eines Microsoft-365-Kontos, die beim Anbieter mit
  der Person geteilt sind, erscheinen dort ebenfalls, soweit der Abgleich sie liefert (`owner` der Graph-Kalender).
- **Ressourcen** (Mockups Ressource, AdminRessourcen, Anfragen). Räume, Fahrzeuge, Geräte und Sonstiges legt der
  Administrator im Server an: eigener Reiter „Ressourcen“ unter Einstellungen › Plugins › Mail direkt nach
  „Einstellungen“ (`ui.settingsPages`, GateControl ≥ 1.225.0). Ältere GateControl-Versionen zeigen ihn als Reiter neben
  „Übersicht“ auf der Seite von Mail. Die Karte „Ressourcen“ in den Einstellungen führt in beiden Fällen hin. Felder:
  Name, Art, Standort, Plätze, Ausstattung, wer buchen darf (Personen und Gruppen), Zusage automatisch oder nach
  Freigabe durch Personen oder Gruppen, Regeln (höchstens eine Dauer, bis zu N Tage im Voraus, buchbare Zeiten). Jede
  Ressource hat ihren eigenen Kalender auf dem Server (ihre Buchungen).
- **Buchen** über „Ressource buchen“ im Kalender oder als Teilnehmerin einer Einladung („Ressource hinzufügen“ im
  Termin). Konflikte und Regeln prüft der Server: belegt → `409 resource_busy`, bei automatischer Zusage Regelverstoß →
  `409 rule_violation`. Ressourcen gehen nur in GateControl-Kalendern und nicht in Serien.
- **Buchungsanfragen:** Bei Freigabe gehen Anfragen als Benachrichtigung (`resource_request`) an alle, die freigeben
  dürfen; ab GateControl 1.225.0 schickt GateControl sie und die Antworten (`resource_booking`) auch per E-Mail an deren
  Kontoadresse (`notifyTopics[].email`, je Person abschaltbar). Mail versendet nichts im Namen der buchenden Person. Die erste Entscheidung erledigt die Anfrage für alle (später:
  `409 already_decided`). Die buchende Person sieht Zusage oder Absage im Termin (Antwort der Ressource) und bekommt eine
  Benachrichtigung (`resource_booking`). Freigebende dürfen trotz Regelverstoß freigeben („Trotzdem freigeben“), das
  steht im Protokoll der Ressource. Eine neue Zeit fragt erneut, ein gelöschter Termin gibt die Ressource frei.
- **Neu im Portal:** Frei/Gebucht mit Vorschlägen im Termin, „Ressource buchen“, „Anfragen“ bzw. „Meine Buchungen“,
  „Teilen“ im Menü eines eigenen Kalenders, „Mit mir geteilt“ im Seitenmenü, der Schalter für Frei/Gebucht in den
  Mail-Einstellungen. Skoda-Verknüpfung und Raumpostfächer aus Microsoft 365 stehen auf der Plugin-Seite als „kommt
  später“.
- **Für die Apps** (README „Free/busy, shared calendars and resources“): Feature-Flags `freeBusy`, `calendarSharing`,
  `resources`, `bookingRequests` in `GET me`; neue Endpunkte `freebusy`, `freebusy/suggest`, `calendars/<id>/shares`,
  `shared`, `principals`, `resources`, `bookings`; Live-Ereignisse `resources` und `calendar { kind: 'shares' }`.
- Migration 009 (Freigaben, Ressourcen, Buchungen, Protokoll). Neue Push-Themen `calendar_share`, `resource_request`,
  `resource_booking` (die beiden letzten auch per E-Mail) – der Administrator bestätigt sie beim Update. Mindestversion
  bleibt GateControl 1.219.0; Reiter und E-Mail-Kanal kommen mit GateControl 1.225.0, ältere Versionen ignorieren beides.
- Werkzeuge: `tools/validate.js` prüft `ui.settingsPages` und `notifyTopics[].email` (GateControl 1.225.0) nach den
  Regeln von `docs/plugins.md`, solange der festgelegte GateControl-Stand sie noch nicht kennt.

## 1.8.0
- **Virenscan von GateControl** (README „Virus scan“). GateControl prüft ab der Version nach 1.222.0 jeden Anhang, den
  es für Mail speichert, direkt nach dem Speichern und übernimmt den Absender für die Quarantäne. Mail übernimmt das
  Ergebnis je Anhang und je Datei eines Entwurfs (Migration 008) und zeigt es als `scan { state, blocked, finding }`.
  Ältere GateControl-Versionen liefern kein `scan`: Dann ändert sich nichts. Die Mindestversion bleibt 1.219.0.
- **Gesperrte Anhänge** lassen sich nicht öffnen, herunterladen oder in Drive ablegen (`423 quarantined | scan_pending |
  scan_blocked`). Automatisches Ablegen, „Zum Ablegen“ und die KI lassen sie aus. Hat GateControl einen Anhang beim
  Abruf sofort gelöscht (`mediaError` bzw. `ERR_MEDIA_INFECTED`), heißt er „Anhang entfernt (Schadsoftware)“
  (`410 attachment_removed`) und wird nicht erneut geladen.
- **Weiterleiten und Antworten:** Ein gesperrter Anhang bleibt im Entwurf markiert, mit Warnung `attachment_blocked`.
  Senden antwortet `409 attachment_blocked`, bis er entfernt ist. Der Postausgang prüft beim Senden erneut. Eine vom
  Gerät hochgeladene Datei in Quarantäne wird nicht angehängt (`422 infected`).
- **Spätere Ergebnisse** (neuer Hook `mediaScanned`) aktualisieren Anhänge und Entwurfsdateien und melden sich mit dem
  Live-Ereignis `mail`. `GET me` nennt das Feature `scan`.
- **Portal:** Kennzeichen „Gesperrt – Schadsoftware (<Fund>)“, „Anhang entfernt (Schadsoftware)“, „Wird geprüft …“,
  „Gesperrt – nicht prüfbar“, „Warnung – Schadsoftware“ und dezent „Nicht prüfbar“. Gesperrte Anhänge haben keine
  Download- und Drive-Knöpfe, bei markierten fragt das Portal vor dem Herunterladen nach. Im Entwurf erscheinen Kennzeichen
  und Warnung.

## 1.7.1
- Das Log nennt bei Warnungen wie „folder sync failed“, „sync failed“ oder „pim step failed“ jetzt den Text eines
  Fehlers ohne eigenen Code (etwa „storage timeout“ von GateControl) statt nur „error“. Sonst unverändert.

## 1.7.0
- **„Zum Ablegen“ in der Drive-Übersicht.** Drive zeigt in seiner neuen Übersicht unter „Zu erledigen“, wie viele
  Mail-Anhänge auf das Ablegen warten (Drive ≥ 1.18.0). Dafür bietet Mail den Dienst `tofile_count { userId }`, den nur
  Drive aufrufen darf. Er liefert die Zahl der Anhänge unter „Zum Ablegen“ und den Ordner, den Drive für den neuesten
  vorgeschlagen hat (z. B. „Familie › Versicherungen“). Nur für die Person des Aufrufs. Wer Mail nicht nutzen kann,
  bekommt `unavailable { reason }`, ein Aufruf vergibt keinen Platz.
- Der Administrator bestätigt die neue Berechtigung beim Update von Drive. Mail selbst braucht keine neue Berechtigung.

## 1.6.0
- **Kalender für Drive.** Drive kann Fristen aus Dokumenten jetzt auch in einen Kalender von Mail eintragen (Drive ≥ 1.17.0).
  Möglich sind Outlook/Microsoft 365, GMX, Web.de, ein eigener CalDAV-Server und die eigenen GateControl-Kalender. Dafür
  bietet Mail zwei Dienste an, die nur Drive aufrufen darf (`services.provides`):
  - `calendar_list { userId }` liefert die Kalender, in die die Person schreiben kann, mit Konto, Farbe und Namen.
    Lesende Kalender und iCal-Abos fehlen. Wer Mail nicht nutzen kann (nicht freigegeben, keine Lizenz, kein Platz,
    Kalender vom Administrator aus), hat keine Kalender. Ein Aufruf von Drive vergibt keinen Platz.
  - `calendar_add { userId, calendarId, title, startsAt, allDay: true, note?, key? }` legt einen ganztägigen Termin an,
    genau wie ein Termin, den die Person selbst anlegt: über Microsoft Graph, CalDAV oder in GateControl. Die Antwort kommt
    erst, wenn der Anbieter den Termin angenommen hat. Es gilt die Erinnerung für ganztägige Termine aus den
    Kalender-Einstellungen. Mit `key` legt derselbe Aufruf den Termin nur einmal an, solange er besteht.
  - Nur für die Person des Aufrufs. Fehler: `forbidden`, `invalid`, `not_found` (kein Kalender der Person, in den sie
    schreiben kann), `unavailable { reason }` (Anmeldung abgelaufen, Zustimmung fehlt, Server nicht erreichbar, kein Platz …).
- Der Administrator bestätigt die neuen Dienste beim Update von Drive. Mail selbst braucht keine neue Berechtigung.

## 1.5.0
- **Speicherorte für Anhänge.** Die Kopien empfangener Anhänge liegen jetzt im Bereich „Anhänge“ (`media.areas`). Wo
  er liegt, legt der Administrator in GateControl fest: unter Einstellungen › Plugins › Mail › Übersicht › Speicherorte,
  auf diesem Server oder auf einem Speicherziel (NAS über SMB oder WebDAV, S3, OneDrive, Google Drive – eingerichtet unter
  Einstellungen › Plugins › Speicher). GateControl verschiebt die Dateien im Hintergrund. Mail hat dafür keine eigene
  Oberfläche und keine eigene Ablage.
- **Auf dem Server bleiben** Mails, Kalender, Kontakte mit ihren Fotos und die Suche (die Datenbank des Plugins),
  Kontobilder, eingebettete Bilder von Mails, die Dateien von Entwürfen und dem Postausgang und die Kopie für „Gesendet“.
- **Anhänge von 1.4** kommen einmal in den Bereich, ein Stapel je Hintergrundlauf (GateControl gibt Dateien ohne Bereich
  keinen von selbst). Danach wandern sie mit dem Bereich.
- **Kein Platz für neue Dateien** (GateControl: `507 server_full`, `503 storage_unavailable`): Der Abgleich läuft
  weiter, das Vorladen von Anhängen pausiert und versucht es später erneut. Wer einen Anhang öffnet, bekommt 409
  `storage_unavailable` bzw. `server_full` mit `retryAfter`. Ist der Bereich voll (sein Kontingent), geht die Kopie
  wieder und es kommt 409 `server_full`. Die Ablage in Drive versucht es später erneut.
- **Postausgang:** Lehnt GateControl die Kopie für „Gesendet“ ab, nachdem der Server die Mail angenommen hat, gilt sie
  als gesendet und geht nie doppelt hinaus. Ein weitergeleiteter Anhang auf einem Speicherziel, das gerade nicht
  erreichbar ist, wartet (409 `storage_unavailable`, in fünf Minuten erneut); das Konto bleibt „verbunden“.
- **Admin-Seite:** In „Speicher“ steht, wo die Anhänge liegen, mit dem Hinweis auf die Speicherorte von GateControl.
- **Portal:** Eine abgelehnte Datei für einen Entwurf zeigt den Grund (Speicher voll, nicht erreichbar, Kontingent).
- Das Kontingent je Person (`quotaGB`, `limits.usedBytes`) zählt die Anhänge wie bisher, egal wo sie liegen.
  `maxBytes` (50 MB, so viel lädt GateControl je Mail) und `quotaDefault` (500 GB) bleiben.

## 1.4.0
- **Ein Kontakt statt Dubletten.** Aus Dubletten wird ein Kontakt in „Meine Kontakte“ (der GC-Kontakt). Die Kontakte der
  Konten (Outlook/Microsoft 365 über Graph, GMX/Web.de/eigener Server über CardDAV) werden mit ihm verknüpft, bleiben beim
  Anbieter und stehen nicht mehr einzeln in der Liste. Beim Anbieter wird beim Zusammenführen nie etwas gelöscht.
- Der GC-Kontakt bekommt die einzigartigen Angaben aller Dubletten:
  - Nummern, Adressen und Anschriften ohne Doppelte. Gleiche Nummern werden nach den Ziffern erkannt (`+49`/`0`).
  - Firma, Position, Geburtstag (volles Datum vor `--MM-TT`) und die verbundenen Notizen.
  - Den Namen: ein Name mit Emoji („Schatzimausi 💞“) gewinnt, ein fehlender Nachname kommt aus einer anderen Dublette,
    sonst gilt der vollständigste Name.
  - Das Bild: das aus „Meine Kontakte“ gewinnt, sonst das größte.
- **Eindeutige Dubletten** (gleiche Nummer oder Adresse und ähnlicher Name) führt der Server selbst zusammen. Das passiert
  einmal nach dem Update im Hintergrund, eine Person je Lauf, mit Protokoll (`GET cards/merges`, Log `contacts merged`).
  Danach passiert es nach jedem Abgleich und jedem vCard-Import. Alte Verknüpfungen mit einem Konto-Kontakt als
  Hauptkontakt werden dabei zu einem GC-Kontakt.
- **Unsichere Fälle** stehen in den Dubletten (`GET cards/duplicates?details=1`). Jede Dublette zeigt ihre Herkunft
  (Adressbuch, Konto) und ihre Felder, darunter steht die Vorschau „So wird der Kontakt“ (`POST cards/merge/preview`).
- **Rückgängig** löst die Verknüpfungen (`POST cards/merges/<id>/undo`, `POST cards/<id>/unmerge`). Ein dabei angelegter
  GC-Kontakt wird entfernt, aufgegangene eigene Kontakte kommen zurück. Die Paare werden nicht wieder vorgeschlagen.
- **Abgleich:** Was ein verknüpfter Kontakt mehr hat, kommt automatisch in den GC-Kontakt. Hat er für dieselbe Art einen
  anderen Wert (eine andere Mobilnummer, eine andere Firma), wird nichts überschrieben. Am Kontakt erscheint dann ein
  Hinweis mit „Übernehmen“ und „Verwerfen“. Verworfenes kommt nicht wieder, solange der Anbieter den Wert nicht ändert,
  auch nicht, wenn Link to Windows es zurückschreibt.
- **Rückschreiben:** Änderungen am GC-Kontakt bleiben in GateControl. Nur einen Wert, der von einem Konto übernommen
  wurde, schreibt der Server beim Ändern oder Löschen in genau diesen Kontakt beim Anbieter zurück (Antwort `writeBack`).
- **Favoriten und Hauptnummer:** `PATCH cards/<id> { favorite, mainPhone }`, `GET/PUT cards/favorites`. Ohne Wahl gilt
  die erste Mobilnummer als Hauptnummer. Beides gibt es nur in GateControl. Die Apps heften Favoriten an Start an, ein
  Tipp ruft die Hauptnummer an.
- **Termin-Widget:** `GET events/upcoming?days=2&limit=8` liefert die nächsten Termine von heute und morgen, kompakt und
  mit Farben, Geburtstagen und Eingeblendetem.
- **Löschen** eines GC-Kontakts lässt die verknüpften Kontakte beim Anbieter stehen (`?linked=delete` löscht sie mit).
- **vCard-Import** ergänzt vorhandene Kontakte nur noch (Listen vereint, leere Felder gefüllt) und überschreibt nichts.
- **Portal:**
  - In der Liste haben Kontakte einen Stern für Favoriten, einen Punkt bei Hinweisen und Punkte für alle Konten.
  - Der Kontakt zeigt Hinweise mit „Übernehmen“, „Zusätzlich“ und „Verwerfen“, die Hauptnummer, die Quellen mit
    „Verknüpfung lösen“ und beim Löschen die Frage, ob auch beim Anbieter gelöscht werden soll.
  - Die Dubletten zeigen Herkunft und Felder je Karte, die Vorschau und „Automatisch zusammengeführt“ mit „Rückgängig“.
- Migration `006_card_master.sql`. Die Apps folgen. Bisherige Pfade und Felder bleiben, siehe README.

## 1.3.6
- **Gelöschte Nummer bleibt gelöscht.** Bei einem verknüpften Kontakt (z. B. ein eigener Kontakt, verknüpft mit dem
  Outlook-Adressbuch und dem Ordner „OnePlus … (contacts synced by Link to Windows)“) zeigt die Ansicht die Nummern,
  Adressen, Anschriften, Firma, Abteilung, Position und den Geburtstag aller verknüpften Karten zusammen. Beim Speichern
  änderte der Server aber nur den Hauptkontakt. Eine Nummer, die auch in einer verknüpften Karte steht, kam deshalb
  sofort wieder, auch nach mehrmaligem Löschen.
- Jetzt merkt sich der Server jeden Wert einer verknüpften Karte, den die Person beim Speichern weglässt
  (Migration `005_card_dismissed.sql`), und die Ansicht lässt ihn weg. Beim Anbieter bleibt die verknüpfte Karte
  unverändert. Ändert sich der Wert dort (eine andere Nummer), erscheint er wieder. Fügt die Person ihn selbst wieder
  hinzu, ist er nicht mehr weggelassen.
- Nicht die Ursache waren der Abgleich (er schreibt nur die Karte des Anbieters) und Microsoft Graph: `businessPhones`
  geht immer mit, leer als `[]`, und Graph leert die Nummern damit.
- Die Apps brauchen nichts Neues. Sie schicken beim Speichern das ganze Formular, das Portal nur die geänderten Felder.
  Beides passt.

## 1.3.5
- **Tiefer verschachtelte Outlook-Ordner.** Microsoft 365 und outlook.com zeigen jetzt Ordner bis zur 10. Ebene (bisher
  4). Die Ordner werden Ebene für Ebene geholt statt rekursiv: Unterordner nur dort, wo `childFolderCount` welche
  meldet, jede Seite über `@odata.nextLink`, nur die nötigen Felder (`$select`). Die Anfragen laufen nacheinander, weil
  der Abgleich eines Kontos nur eine der vier gleichzeitigen Graph-Anfragen pro Postfach nutzt (die übrigen bleiben für
  Mails, Anhänge und Markierungen, die gerade jemand öffnet).
- **Höchstens 1000 Ordner pro Konto** (bisher 300 bei Microsoft, bei IMAP keine Grenze), damit kein Postfach den
  Abgleich aller Ordner sprengt. Die Rollenordner (Posteingang, Gesendet usw.) sind immer dabei.
  - **Microsoft:** Die flachen Ebenen zuerst. Ist die Grenze erreicht, wird keine weitere Seite und kein weiterer
    Unterordner abgefragt. Ordner, die schon da waren, bleiben dann samt ihren Mails stehen, weil sich nicht sagen
    lässt, ob sie bei Microsoft gelöscht wurden oder nur außerhalb der Grenze liegen.
  - **IMAP:** Die Liste des Servers ist vollständig. Zuerst kommen die Rollenordner, dann die schon bekannten, dann die
    flachen. Gelöschte Ordner verschwinden wie bisher. Eine Ebenen-Grenze gibt es bei IMAP nicht, weil `LIST` alle
    Ebenen in einer Antwort liefert.
- Was nicht dabei ist, steht als Hinweis im Log (`folders left out`, Stufe info, mit der Zahl der übrigen Ordner und
  der zu tief liegenden). Das ist kein Fehler: Das Konto gleicht die übrigen Ordner normal ab. Der Hinweis erscheint
  nur, wenn sich etwas ändert, nicht bei jedem Lauf.

## 1.3.4
- **Ordner als Baum im Portal.** Unter einem Konto hängen Unterordner jetzt unter ihrem Elternordner (`parentId`, mit
  1.3.3 richtig geliefert) statt als lange flache Liste. Die Rollenordner (Entwürfe, Gesendet, Archiv, Spam,
  Papierkorb) stehen wie bisher oben, danach die eigenen Ordner nach Namen. Kinder sind je Ebene eingerückt, ab Ebene 4
  nicht weiter.
- **Auf- und zuklappen:** Ein Ordner mit Kindern hat links einen Pfeil („… aufklappen“ / „… zuklappen“, `aria-expanded`).
  Der Pfeil klappt nur auf oder zu, das Menü bleibt offen. Ein Tipp auf den Namen öffnet den Ordner und schließt das Menü
  auf dem Handy wie bisher. Standardmäßig sind Unterordner zu. Die Wahl gilt für die Sitzung. Die Elternordner des
  gezeigten Ordners sind von selbst offen.
- **Ungelesene darunter:** Ein zugeklappter Elternordner zeigt dezent die Summe der Ungelesenen aller Ordner darunter
  (Titel „n ungelesen in Unterordnern“), mit „+“, wenn er selbst Ungelesene hat.
- Die Konto-Zeile steht für den Posteingang. Kinder des Posteingangs stehen deshalb oben. Ein Elternordner, der nicht in
  der Antwort steht, lässt seine Kinder oben stehen, ebenso eine Schleife.
- Die reine Logik steckt in `ui/foldertree.js` (`window.MailFolderTree`) und hat eigene Tests
  (`test/portal-folders.test.js`, auch das Menü im kleinen DOM).

## 1.3.3
- **Ordner mit dem richtigen Elternordner** (`GET folders` → `parentId`), damit die Apps und das Portal die Ordner als
  Baum zeigen können. `name` bleibt der eigene Name des Ordners, nicht der ganze Pfad.
- **IMAP:** Der Elternordner kommt aus dem Pfad, den der Server zu einem Ordner nennt (`parent` von gc.mail, d. h.
  imapflows `parentPath`), sonst aus dem Pfad bis zum letzten Trennzeichen (`delimiter`). `INBOX` gilt ohne Rücksicht
  auf Groß- und Kleinschreibung, auch als Anfang eines Pfads („Inbox/Kunden“ hängt unter dem Posteingang). Ein Server
  ohne Hierarchie (kein Trennzeichen) hat keine Unterordner; ein Ordnername mit „/“ macht dort keinen Elternordner mehr.
  Liegen alle Ordner samt Gesendet, Papierkorb usw. unter `INBOX.` (persönlicher Namensraum wie bei Courier oder älterem
  Dovecot), stehen sie oben und nicht als Kinder des Posteingangs. Ein Elternordner, den der Server nicht oder als
  `\Noselect` listet, fehlt wie bisher; seine Kinder stehen oben.
- **Microsoft 365 und outlook.com:** Der Elternordner kommt aus `parentFolderId`. Bisher wurde er aus dem Pfad der
  Anzeigenamen abgeleitet; ein Ordner mit „/“ im Namen (etwa „Rechnungen 2024/2025“) landete so unter einem falschen
  Elternordner oder seine Unterordner auf oberster Ebene.
- `parent_id` wird nur noch geschrieben, wenn er sich ändert.

## 1.3.2
- **Microsoft ohne eigene App-Registrierung.** `DEFAULT_MS_CLIENT_ID` ist jetzt die Registrierung des Herausgebers
  (`b2f917a9-e0eb-45b9-9e5f-14c283aa51e9`, öffentlicher Client). „GateControl (Standard)“ in Mail › Einstellungen ›
  Microsoft 365 und outlook.com funktioniert damit ohne Eintrag; „Eigene“ mit eigener Client-ID bleibt möglich. Der
  Freigabe-Link für Administratoren nutzt die Client-ID, die gerade gilt.
- **Erinnerung für ganztägige Termine: alter Standard wird korrigiert.** Ein vor 1.3.2 gespeichertes `allDayReminder`
  von 1080 (06:00 am Vortag) war der alte Standard und gilt jetzt als 360 (18:00 am Vortag). Gespeicherte Einstellungen
  tragen ab jetzt die Markierung `v: 2`; ein danach bewusst gewählter Wert bleibt, wie er ist. Termine, die schon mit
  1080 angelegt wurden, behalten ihre Erinnerung.

## 1.3.1
- **Erinnerung für ganztägige Termine: Standard 18:00 am Vortag.** `CalPrefs.allDayReminder` zählt Minuten vor Mitternacht
  des Termintags in der Zone der Person (wie ein VALARM-`TRIGGER` zum `DTSTART` eines Ganztagstermins). Der Standard war
  1080 – das ist 06:00 am Vortag, gemeint war 18:00. Neu ist er 360. Die Erinnerung selbst rechnet unverändert
  Mitternacht des Tages minus Minuten; ein Test prüft 18:00 am Vortag in Europe/Berlin, auch an den Tagen der
  Zeitumstellung.
- **Gespeicherte Einstellungen bleiben, wie sie sind.** Ein gespeichertes `allDayReminder` von 1080 wird nicht
  umgeschrieben: Es lässt sich nicht unterscheiden, ob es der alte Standard ist (beim ersten Öffnen des Kalenders
  speichert der Server die Einstellungen mit; die Apps können 1080 als Standard geschickt haben) oder bewusst gewählt
  wurde. Wer seit 1.2.0 den Kalender geöffnet hat, behält daher 06:00 am Vortag, bis `allDayReminder` geändert wird
  (`PUT calendar/settings { allDayReminder: 360 }`; Portal und Apps haben dafür noch keine eigene Einstellung, je Termin
  lässt sich die Erinnerung wählen). Neue Personen und Einstellungen ohne gespeicherten Wert bekommen 360.

## 1.3.0
- **Kalender und Kontakte im Portal** (Phase 2, Oberfläche; der Server kam mit 1.2.0).
- **Seitenmenü mit neuem Fuß** (Mockup MenueNeu): links die Mail-Einstellungen, rechts Kontakte und Kalender (je nach
  Admin-Schalter), der aktive Bereich hervorgehoben; das „+“ fällt weg – ein Konto kommt über die Einstellungen dazu.
  Der Speicherbalken steht über dem Fuß. Je Bereich zeigt das Menü seinen Inhalt, „Posteingänge“ führt zurück zur Mail.
- **Kalender:** links alle Kalender mit Häkchen und Farbe (GateControl, je Konto, „Eingeblendet · nur ansehen“ mit
  Familie, Alltag und Geburtstagen), Zustand je Kalender, Farbe, Erinnerungen an/aus, Umbenennen und Löschen (eigene),
  „Kalender hinzufügen“ und „iCal-Abo“. Rechts Tag / Woche (mit Arbeitswoche) / Monat / Liste mit „Heute“ und ‹ ›, die
  Chips der eingeblendeten Kalender, Ganztägiges oben, Stunden 0–24 ab 7 Uhr, überlappende Termine nebeneinander, offene
  Einladungen gestrichelt, abgesagte durchgestrichen, Jetzt-Linie; ein Klick in freie Zeit legt dort einen Termin an.
- **Termin:** ansehen (Zeit mit Zeitzone, Wiederholung als Text, Kalender, Ort mit Karte, „Teilnehmen“, Erinnerungen,
  Teilnehmer mit Antwort und Zählung, Beschreibung), Zusagen / Mit Vorbehalt / Absagen mit Kommentar, bearbeiten (Titel,
  Kalender, ganztägig, Beginn/Ende, Zeitzone, Wiederholung täglich / wöchentlich an Tagen / monatlich am Tag oder am n-ten
  Wochentag / jährlich mit Ende, Ort, Online-Link oder Teams, Erinnerungen bis zum Höchstwert des Kalenders, Teilnehmer mit
  Vorschlägen und Gruppen, beschäftigt/frei, privat, Beschreibung). Gesendet wird nur, was sich geändert hat; bei Serien
  „Nur dieser Termin“ / „Alle Termine der Serie“; 409 `conflict` → „Neu laden“ / „Meine Änderung erneut anwenden“.
  Löschen mit Absage an Teilnehmer bzw. Organisator. Die Zeitzone der Person folgt der des Browsers.
- **Einladungskarte in der Mail** (Mockup Einladung): Zeit, Ort, der Tag drumherum mit Konflikten, Zusagen / Mit Vorbehalt /
  Absagen, Kommentar, „Neue Zeit vorschlagen“, „Eintragen in“, Teilnehmer „x von y zugesagt“; Zustände beantwortet
  („Du hast zugesagt · Ändern“), abgesagt („Aus Kalender entfernen“), Antwort erhalten, Gegenvorschlag (Übernehmen /
  Ablehnen), veraltet. Microsoft ohne Kalender-Recht: „Kalender freigeben“. In der Liste das Etikett „Einladung“.
- **Kontakte:** Liste mit Suche (Name, Firma, Adresse, Nummer), Buchstaben mit Schnellleiste, Reiter Kontakte | Gruppen,
  Punkt des Kontos; Kontakt mit Foto, Position · Firma, Mail / Anrufen / Bearbeiten, allen Feldern, Gruppen, Quelle
  (auch verknüpfte), „Letzte Mails“ („Alle Mails“ → Suche) und „Gemeinsame Termine“; nur lesende Quellen mit Hinweis.
  Bearbeiten und neu (Foto als JPEG ≤ 512 px, Namen, Firma, Position, Adressen und Nummern mit Art, Anschriften,
  Geburtstag mit optionalem Jahr, Notiz, Gruppen, Adressbuch) mit `etag` und Konflikt-Dialog. Gruppen mit Mitgliedern,
  „Mail an alle“, Hinzufügen und Entfernen. Dubletten mit Grund, „Zusammenführen“ (Hauptkontakt, Auswahl je Feld,
  Notizen verbinden; verschiedene Adressbücher werden verknüpft) und „Keine Dublette“. vCard-Import und -Export,
  Sortierung und Anzeige der Namen. „Kontakt“ am Absender einer Mail: der Kontakt oder „Als Kontakt speichern“.
- **Microsoft neu anmelden** per Gerätecode wie in Phase 1, wenn einem Konto `missingScopes` fehlen: Band „Kalender und
  Kontakte von <Konto> freigeben“ in Kalender und Kontakten, im Konto-Dialog und an der Einladungskarte; bleiben die
  Rechte aus, der Hinweis „Deine Firma muss die neuen Rechte freigeben“ mit dem Freigabe-Link.
  `POST accounts/microsoft/device { accountId }` meldet ein eigenes Microsoft-Konto neu an, ohne gegen die Höchstzahl der
  Konten zu prüfen (bisher scheiterte das Neu-Anmelden im Portal an der Grenze).
- **Eine Serie verschieben, ohne Termine zu verlieren:** `Event` hat neu `series: { start, end, allDay, startDate?,
  endDate? } | null` – Beginn und Ende der Serie selbst (ihr Master), auch bei `GET events/<id>?occurrence=`. Bei
  `PATCH events/<id>` mit `scope: 'series'` und neuer Zeit (ohne neue Wiederholung) gilt die Zeit als neuer Beginn der
  Serie, gemessen an `series.start`: der Abstand (Tage und Minuten der Wanduhr in der Zone der Serie, also über die
  Zeitumstellung hinweg dieselbe Uhrzeit) verschiebt die Wochentage und Monatstage der Regel, `UNTIL`, gelöschte Termine
  (`EXDATE`) und die Ausnahmen (`RECURRENCE-ID`; eine Ausnahme zur ursprünglichen Zeit wandert mit, eine von Hand
  verschobene behält ihre Zeit). Frühere Termine bleiben. Bisher setzte die Zeit eines Termins den Serienbeginn dorthin,
  frühere Termine fielen weg. Die unveränderte Zeit eines Vorkommens ändert nichts; ein Abstand von einer ganzen Periode
  der Regel oder mehr oder einer, nach dem die Termine nicht mehr die alten um den Abstand verschoben wären, gibt 400
  `invalid { field: 'start', reason: 'series_shift' }` und ändert nichts. Bei Microsoft 365 wird die Regel mitverschoben.
  Das Portal rechnet „Alle Termine der Serie“ von `series.start` aus.
- **Konto-Dialog:** Kalender und Kontakte abgleichen an/aus mit Zustand, bei Gmail die geheime iCal-Adresse, sonst eigene
  CalDAV-/CardDAV-Adressen und ein eigenes Passwort.
- **Admin:** Abschnitte „Kalender“ (an/aus, Konto-Kalender, Firmenkalender GateControl oder Exchange,
  Standard-Erinnerung, interne Einladungen, Einblenden von Familie, Alltag und Geburtstagen) und „Kontakte“ (an/aus,
  Konto-Adressbücher, KI für die Signatur) im Stil der übrigen Schalter; in der Speicher-Tabelle je Person Kalender,
  Termine, Kontakte und deren Anteil am Speicher, in der Übersicht die Zahlen gesamt; bei Microsoft die Rechte, die die
  App-Registrierung zusätzlich braucht (`Calendars.ReadWrite`, `Contacts.ReadWrite`).
- Texte Deutsch und Englisch; Tests für die Logik (Ansichten, Spalten, Wiederholung, Formular → API) und das Portal im
  kleinen DOM (Kalender, Kontakte, Einladung, Neu anmelden, Admin).

## 1.2.0
- **Kalender und Kontakte in Mail** (Phase 2, gehört zur bestehenden Mail-Lizenz). Braucht GateControl 1.219.0
  (`gc.mail.dav` für CalDAV/CardDAV, Einladungen per iMIP, `autoconfig` mit CalDAV/CardDAV, bis 1000 Push je Stunde).
- **Kalender:** eigene GateControl-Kalender („Privat“ als Standard, „Firma“, weitere, ≤ 20), die Kalender der Konten –
  Microsoft 365/outlook.com über Graph (Standardkalender per Delta, weitere per `calendarView`), GMX, WEB.DE und eigene
  Server über CalDAV in beide Richtungen (Discovery, `sync-collection`, sonst `getctag`/ETags, `multiget`), Gmail nur
  lesend über die geheime iCal-Adresse – und iCal-Abos beliebiger `https`-Adressen. Termine mit Wiederholung
  (RRULE/EXDATE/RECURRENCE-ID), „nur dieser Termin“ / „alle“, Zeitzonen (auch Windows-Namen aus Outlook), ganztägig,
  Erinnerungen, Teilnehmer, Ort, Online-Link, Teams in Microsoft-365-Kalendern. Ändern mit `etag` (409 `conflict`);
  ein 412 des Anbieters wird feldweise abgeglichen. Unbekannte Eigenschaften bleiben beim Ändern erhalten.
- **Eingeblendet:** Familie (Dienst `calendar_range`, Familie 1.16.0), Alltag-Kalender (`calendar_list` /
  `calendar_query`, Alltag 1.4.0) und Geburtstage aus den Kontakten mit Alter; je Person aus- und umfärbbar.
- **Einladungen:** die Kalender-Teile einer Mail (IMAP) und die Einladungs-Mails von Microsoft werden zur Karte
  (`Summary.invite`, `Message.invite`): Zusagen / Mit Vorbehalt / Absagen mit Kommentar, „Neue Zeit vorschlagen“,
  Ziel-Kalender, Tagesvorschau mit Konflikten, Zählung der Antworten; neuere `SEQUENCE` macht ältere Karten veraltet,
  Absagen streichen den Termin durch, Antworten auf eigene Termine tragen sich selbst ein, Gegenvorschläge lassen sich
  übernehmen oder ablehnen. Eigene Termine mit Teilnehmern verschicken Einladungen, Änderungen und Absagen über das
  Konto (iMIP); GateControl-Personen mit Mail-Platz bekommen sie direkt (Push „Einladung“), ohne Mail.
- **Erinnerungen** als Push (Thema „Termin-Erinnerung“), je Kalender abschaltbar, auch für die Kalender der Konten
  (Standard an); mehrere in derselben Minute als eine Push.
- **Kontakte:** eigenes Adressbuch „Meine Kontakte“ (vCard), die Adressbücher der Konten (Graph, CardDAV; Gmail über
  den Import einer vCard-Datei), Suche (auch Nummern), Buchstaben, Gruppen als Verteiler (auch beim Schreiben), Fotos,
  Dubletten zusammenführen bzw. über Adressbücher hinweg verknüpfen, vCard-Import und -Export (4.0), Absender-Ansicht
  (`cards/lookup`), „Als Kontakt speichern“ aus einer Mail (Signatur nach Regeln, mit KI wenn erlaubt),
  `?since=` für den Offline-Speicher der Apps.
- **Schreiben:** `GET contacts?q=` schlägt zuerst eigene Kontakte und Gruppen vor (Form unverändert, neue Felder
  `contactId`, `photo`, `groupId`, `members`).
- **Microsoft:** die Anmeldung fragt zusätzlich `Calendars.ReadWrite` und `Contacts.ReadWrite`; der Server merkt sich
  die erteilten Scopes (`accounts.ms_scopes`) und erneuert Tokens nur mit diesen – bestehende Konten laufen weiter,
  `Account.missingScopes` und „Neu anmelden“ holen die neuen Rechte. `GET me` mit `microsoft.adminConsentUrl`.
- `Account` mit `calendar`, `contacts` und `missingScopes`; `PATCH accounts/<id>` mit `calendarSync`, `contactsSync`,
  `caldavUrl`, `carddavUrl`, `davUsername`, `davPassword`, `icsUrl` (sofort geprüft). „Zu tun“ der KI auch in den
  eigenen Kalender (`action: 'calendar'`).
- **Admin:** Abschnitte Kalender (an/aus, Konto-Kalender, Firmenkalender = Exchange, Standard-Erinnerung, interne
  Einladungen, Einblendungen) und Kontakte (an/aus, Konto-Adressbücher, KI); abgeschaltet → 403 `feature_off`.
  Übersicht mit Anzahl Kalender, Termine, Kontakte und Bytes (nie Inhalte). Termine und Kontakte zählen zum Speicher.
- Migration 004 (Kalender, Termine, Vorkommen, Einladungen, Adressbücher, Kontakte, Gruppen). Bibliotheken unverändert
  übernommen: ical.js 2.2.1 (MPL-2.0) und timezones-ical-library 2.3.2 (Apache-2.0) in `server/vendor/`.
- Die Oberfläche im Portal folgt in einem eigenen Schritt (die Admin-Einstellungen sind serverseitig vollständig).

## 1.1.2
- **Eine Mail öffnet sich auch während eines langen Abgleichs.** Bisher lief pro Konto alles nacheinander: Der erste
  Abgleich eines frisch hinzugefügten Kontos (12 Monate, bei Microsoft viele Delta-Seiten) hielt das Öffnen einer Mail,
  Anhänge und Markierungen minutenlang auf – die Apps meldeten nach 25 s „Der Server ist gerade nicht erreichbar“.
  - Der Abgleich läuft in kurzen Schritten (Ordnerliste, eine Graph-Delta-Seite, ein IMAP-Ordnerlauf mit Budget, ein
    Inhalt); was eine Person anstößt, kommt vor die wartenden Schritte.
  - Microsoft: Inhalt, Anhänge, Markierungen, Verschieben und Löschen laufen neben dem Abgleich (Graph ist zustandsloses
    HTTP; höchstens 3 solche Anfragen je Postfach gleichzeitig). Das Zugriffstoken wird für alle nur einmal erneuert –
    wer währenddessen fragt (oder ein 401 bekommt), wartet auf diese eine Erneuerung.
  - IMAP: Inhalt und Anhang kommen bei freiem Konto über dessen Sitzung, während eines Abgleichschritts über eine kurze
    eigene Sitzung, die danach gleich wieder schließt (höchstens 2 je Konto, 8 insgesamt, innerhalb der 100
    Verbindungen); sonst als Erstes nach dem laufenden Schritt.
  - Ein Inhalt oder Anhang, der schon geladen wird, wird nie ein zweites Mal geholt.
- **Antwort spätestens nach etwa 12 s:** `GET messages/<id>` und `GET threads/<id>` antworten dann mit `bodyMissing:
  true` (die Vorschau als Text), das Laden geht weiter und meldet sich mit dem Live-Event `mail` `{ kind: 'changed',
  accountId, folderId, messageId }` (Unterhaltung: `threadId`). `GET messages/<id>/attachments/<aid>` und
  `GET cid/…` antworten statt zu hängen mit 409 `busy { reason: 'loading', retryAfter: 5 }`; erneutes Fragen hängt sich
  an den laufenden Download, sein Ende meldet das Live-Event mit `messageId` und `attachmentId`.
- `busy` hat jetzt den Status 409 (vorher 503 – Clients werteten das als „offline“).
- Erster Abgleich: zuerst die neuesten 50 Mails des Posteingangs (Microsoft: nach Datum, das Delta folgt seitenweise;
  IMAP: die neuesten 50, dann je 300), die Liste ist sofort da und füllt sich während des Abgleichs (Live-Event höchstens
  alle 5 s).
- **Konten mit Bild und Adresse:** Das Profilbild beim Anbieter (Microsoft: Graph `/me/photos/96x96`, sonst
  `/me/photo`; 404 = keins, bei Microsoft 365 häufig) liegt als Media des Plugins vor – geholt beim Anmelden, danach
  höchstens einmal am Tag (unverändertes Bild laut `mediaEtag` wird nicht neu geladen, nach einem Fehler erneut binnen
  einer Stunde). `Account.avatar` = `{ mediaId, mime } | null` (IMAP-Konten: immer `null`); die Apps laden es über
  `media/<mediaId>` (nur die Person des Kontos), das Portal über `GET accounts/<id>/avatar` → `{ mediaId, mime, size, url }`.
  Ein neues oder entferntes Bild schickt das Live-Event `mail` mit `accountId`. Migration 003 (`accounts.avatar_*`).
- Portal: Konten im Menü und in den Einstellungen als kleiner Kreis mit Bild oder Zeichen des Anbieters (Outlook,
  Microsoft 365, Gmail, GMX, WEB.DE, T-Online, sonst @) und der Farbe des Kontos als Punkt, darunter die Adresse.
- Portal: Fehlt der Inhalt noch, steht „Der Inhalt wird noch vom Anbieter geladen“ mit „Erneut versuchen“ da, die Mail
  lädt von selbst neu, sobald er da ist; ein Anhang, der noch geladen wird, startet seinen Download von selbst.

## 1.1.1
- Admin-Einstellungen: die Schalter haben wieder ihre normale Form (feste Größe, unabhängig von den Eingabe-Stilen des Portals).
- Microsoft-Karte: die zweite Zeile heißt „Verbundene Konten“ statt noch einmal „Status“.

## 1.1.0
- **Microsoft-Konten senden Dateien** vom Gerät, aus Mails anderer Konten und aus Drive (Kopie) – mit GateControl
  ≥ 1.217.0: Graph-Entwurf, Dateien unter 3 MB direkt (`contentBytes`, die Bytes setzt GateControl ein), größere über
  eine Upload-Sitzung in Stücken unter 4 MB, dann senden. Das Plugin hält dabei nie die Bytes (`gc.http.fetch` mit
  `bodyMedia`). Ein Entwurf, der nicht rausgeht, wird wieder gelöscht. Beim Weiterleiten einer Microsoft-Mail entfernt
  Mail die Anhänge, die die Person aus dem Entwurf genommen hat (vorher gingen sie trotzdem mit). Drive-Kopien werden
  nur noch über 25 MB zum Link. Auf GateControl 1.216.0 bleibt alles wie in 1.0.0 (Warnung, 409
  `attachments_unsupported`) – Erkennung per `gc.http.MEDIA_BASE64`.
- **SMTP wird beim Anlegen geprüft** (und bei einem neuen Passwort) – mit GateControl ≥ 1.217.0 über
  `gc.mail.smtp.verify`. Eine Ablehnung nennt `server: 'smtp'` mit eigenen Texten („Der Postausgang (SMTP) lehnt die
  Anmeldung ab …“), das IMAP-Probe-Konto wird wieder geschlossen.
- **Lizenz mit Personen wie bei Drive** (Familie / Business / Kombi, 5 Personen inklusive, weitere je Art buchbar; ein
  Lifetime-Plan ohne Stufe zählt niemanden): Wer freigeschaltet ist, bekommt beim ersten Öffnen einen Platz seiner Art
  (Kombi: Familienmitglied → Familie, sonst Business), solange die Lizenz reicht. Ohne Platz antwortet `GET me` mit
  `seat: null`, alles andere mit 403 `no_seat`, ohne gültige Lizenz 403 `not_licensed` (dieselben Codes und Texte wie
  Drive); das Portal zeigt den Hinweis. Ohne gültige Lizenz und für abgeschaltete Personen wird nichts abgeglichen oder
  gesendet. Einstellungen: Karte „Personen und Lizenz“ (Stufe, x von y, überschritten / voll mit Hinweis aufs
  Hinzubuchen, „Lizenz jetzt abrufen“, Art je Person ändern oder abschalten); Admin-API `PUT admin/seats/<userId>`,
  `POST admin/license/refresh`. Migration 002 (`seats`).
- Netz: zusätzlich `outlook.office.com:443` und `outlook.office365.com:443` – dorthin zeigen die Upload-Sitzungen von
  Graph.

## 1.0.0
- **Konten:** GMX, WEB.DE, T-Online (Passwort), Gmail (App-Passwort), Outlook.com und Microsoft 365 (Anmeldung bei
  Microsoft – in den Apps mit PKCE im System-Browser, im Portal per Gerätecode) und jedes IMAP-Konto (Server per
  Autoconfig). Die Anmeldung wird vor dem Speichern geprüft (`auth_failed` mit Hinweis, `imap_disabled`,
  `unreachable`, `tls`). Zugangsdaten und Refresh-Token liegen verschlüsselt als Geheimnisse des Plugins auf dem
  Server – nie in der Datenbank, nie in einer Antwort, nie im Protokoll.
- **Abgleich auf dem Server:** IMAP über GateControls `gc.mail` mit IDLE auf dem Posteingang (neue Mail sofort),
  übrige Ordner alle 15 Minuten und beim Öffnen; Microsoft über Graph mit Delta-Abfrage (Posteingang jede Minute).
  Erster Abgleich: die letzten `retentionMonths`, neueste zuerst; ältere Mails kommen beim Blättern und bei der Suche
  vom Anbieter.
- **Alle Posteingänge** und getrennte Posteingänge, Ordner, Unterhaltungen, Suche (erst die Kopie, dann der Server),
  **Relevant / Sonstige** (Regeln wie List-Id, Precedence, Auto-Submitted, no-reply, bekannte Kontakte; unklare Mails
  sortiert die KI im Hintergrund; jede Korrektur merkt sich der Absender).
- **Lesen:** bereinigtes HTML (GateControls Sanitizer), externe Bilder nur auf Wunsch – einmal oder immer für den
  Absender – über GateControls Bild-Proxy, Zählpixel entfernt und gezählt, Anhänge und eingebettete Bilder.
- **Schreiben:** Antworten, Allen antworten, Weiterleiten (Empfänger, Betreff und Zitat füllt der Server vor, die
  Signatur setzen die Apps), Entwürfe, Anhänge vom Gerät, aus einer Mail und aus Drive (Kopie oder Link), Warnungen (kein Betreff,
  Passwort, zu groß – große Drive-Dateien gehen automatisch als Link), Senden mit 10 s Rückgängig, Senden planen,
  Kontaktvorschläge. IMAP-Konten senden über SMTP mit Kopie in „Gesendet“, Microsoft über Graph.
- **Drive** (≥ 1.15.0): Vorschlag für den Ablageort, „In Drive speichern“ mit Herkunft „Aus Mail von …“, „Immer für
  diesen Absender“, alle Anhänge auf einmal, automatisches Ablegen je Konto (nur sichere Vorschläge, sonst „Zum
  Ablegen“).
- **KI** über GateControls KI-Anbieter: Kurz gesagt, Zu tun (Termine und Fristen in den Familienkalender über Familie
  ≥ 1.15.4), Antwortvorschläge, Sortieren. Erst der Text, Bilder nur ohne Text und nur wenn erlaubt. Ein vorhandenes
  Ergebnis wird ohne neue Anfrage beantwortet, gleichzeitige Läufe teilen sich eine, höchstens 60 je Person und Stunde.
- **Push** (Thema `mail`, je Konto aus / nur Relevante / alle; `mail_failed`) und Live-Ereignis `mail`.
- **Speichergrenze** pro Person (`quotaGB`): darüber gehen erst die am wenigsten genutzten Anhänge, dann die Inhalte
  der ältesten Mails (die Köpfe bleiben).
- **Portal:** Mail-Seite mit Seitenmenü, Liste, Lesen mit KI-Leiste und Anhängen, Schreiben, Konto hinzufügen (auch
  Microsoft per Gerätecode), „Zum Ablegen“, Ausgang. **Admin:** Seite „Einstellungen“ (Freischaltung für alle oder
  Personen und Gruppen, Konten pro Person, Aufbewahrung, Anhänge, Speichergrenze mit Belegung gesamt und pro Person,
  KI-Schalter, Microsoft-App-Registrierung mit Freigabe-Link) und „Übersicht“ – Admins sehen nur Zahlen.
- Braucht GateControl ≥ 1.216.0 (`gc.mail`, `gc.http.fetchImage`). Die Standard-Client-ID für Microsoft
  (`DEFAULT_MS_CLIENT_ID`) folgt; bis dahin eine eigene Client-ID in den Einstellungen eintragen.
- Bekannte Grenzen: Microsoft-Konten senden Dateien vom Gerät noch nicht (Graph braucht die Bytes, das Plugin hält
  sie nie) – Dateien aus Drive gehen dort als Link; die SMTP-Anmeldung wird erst beim ersten Senden geprüft (beides
  behoben in 1.1.0 mit GateControl ≥ 1.217.0).
