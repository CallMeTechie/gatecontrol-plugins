# Changelog

## 1.5.0

„Aufgaben und Erinnerungen“, Stufe 3 – eine Aufgabe am Ort.

- **Ort an der Aufgabe** (`server/places.js`, `migrations/007_places.sql`): Feld `place` an jeder Aufgabe – ein Ort
  (`mode: 'place'`: einer von „Meine Orte“, ein Ort der Familie, ein Treffer der Ortssuche, ein Punkt auf der Karte)
  oder jeder Ort einer Art (`mode: 'any'`, „Jeder Lidl“), dazu `trigger` (`enter` beim Ankommen, `exit` beim
  Verlassen) und `key` (die Art oder der Name, für den der Ort gewählt wurde). Gesetzt mit `place` in `POST tasks` /
  `PATCH tasks/<id>`. Erinnert wird **auf dem Handy** (Geofence); der Server hält die Orte, sagt jedem Handy, welche
  es überwachen soll, und erfährt nie, wo jemand ist. Portal und Windows zeigen den Ort.
- **Ort aus dem getippten Text – ohne Änderung am Parser:** `POST parse` liefert neben `parsed` und `attach` neu
  `place { via, word, query, key, label, title, certain, trigger, place, uses, options, search }` (`server/placewords.js`):
  einen eigenen Ort oder einen der Familie am Namen („bei Oma“, „zu Hause“), eine Adresse („Ringstraße 21“), eine Art
  von Ort über eine feste Worttabelle (39 Arten, Deutsch und Englisch: Baumarkt, Bäcker, Apotheke, Tankstelle,
  Supermarkt …), sonst das Wort nach bei / beim / im / in der / an der / am / zu als Name („bei Lidl“). `POST tasks
  { text, place: 'auto' }` nimmt den Ort, wenn er feststeht (eigener Ort, gemerkter Ort der Art); der Titel verliert
  die Worte des Orts („beim Baumarkt Schrauben kaufen“ → „Schrauben kaufen“). **`ui/quickparse.js` und
  `test/vectors/quickparse.json` sind unverändert** (ein Test hält ihre Prüfsummen fest).
- **Meine Orte und gemerkte Orte:** `GET | POST places`, `PATCH | DELETE places/<id>`, `PUT places/favs`. Jede Wahl
  eines Orts für eine Art oder einen Namen wird gezählt; der gemerkte („mein Baumarkt“) steht beim nächsten Mal ohne
  Suche da, früher gewählte stehen in der Auswahl zuerst. „Zuhause“ und die Regel-Orte kommen aus dem Familien-Plugin
  (ab 1.22.0).
- **Ortssuche über den eigenen Server** (`server/placesearch.js`, `POST places/search`): **ausgeschaltet, bis der
  Administrator einen Dienst wählt** (Einstellungen › Plugins › Notizen & Aufgaben › Orte: Aus / Öffentlicher Dienst von
  OpenStreetMap / Eigener Dienst); jede Person kann sie für sich abschalten. Das Handy fragt nie selbst einen
  Kartendienst. Hinaus gehen das Suchwort und ein Kasten um die **vom Server auf zwei Nachkommastellen gerundete**
  Position (etwa 1 km) – kein Name, kein Gerät, keine Kennung; in Datenbank und Protokoll steht davon nichts, der
  Zwischenspeicher liegt im Arbeitsspeicher. Treffer: die nächsten zuerst, mit Entfernung und einer aus der Entfernung
  geschätzten Fahrzeit (Luftlinie × 1,3 bei 30 km/h – kein Routing-Dienst).
  - Öffentlicher Dienst: `nominatim.openstreetmap.org`. Es gelten dessen
    [Nutzungsbedingungen](https://operations.osmfoundation.org/policies/nominatim/) – höchstens eine Anfrage pro
    Sekunde für die ganze Installation, Kennung im User-Agent, Zwischenspeicher, nur von Personen ausgelöste Suchen,
    kein Vervollständigen beim Tippen, kein Massenabruf, keine Zusage. Das Plugin hält sich daran: eine Anfrage nach
    der anderen mit 1,1 s Abstand, Zwischenspeicher (7 Tage), höchstens 30 echte Suchen je Person und Stunde, 60 s Ruhe
    nach einem Fehler, Suche nur auf Knopfdruck.
  - Eigener Dienst: ein selbst betriebenes Nominatim hinter dem Zugriffsziel „Ortssuche“.
- **Was ein Handy überwacht** (`POST places/watch`): die Orte der eigenen offenen Aufgaben, die dringendste zuerst, je
  Ort ein Geofence, begrenzt auf das, was das Handy frei hat. Android erlaubt einer App 100 überwachte Orte; die
  Orts-Erinnerungen und Regel-Orte des Familien-Plugins zählen mit (dessen neuer Dienst `geofences` nennt die Zahl):
  100 − 10 Reserve − Familie, höchstens 60, ohne Auskunft 30, und nie mehr als das `budget` des Handys. Mit Position
  und Ortssuche kommen je Aufgabe bis zu fünf weitere Orte derselben Art dazu.
- **„In der Nähe“:** Kommt das Handy an einem anderen passenden Ort vorbei, meldet sich die Aufgabe dort („Baumarkt am
  Ring ist gleich hier · geplant war Baumarkt Nord“) mit „Erledigt“, „Nicht hier“ (`POST tasks/<id>/place/skip`),
  „Später“ (`POST tasks/<id>/place/later`). `POST places/fired` sorgt dafür, dass zwei Geräte nicht beide melden:
  einmal je Ort in drei Stunden, unterwegs einmal je Aufgabe in drei Stunden und nicht in der Ruhezeit
  (21:00–07:00, einstellbar). Bei eigenen Orten gibt es den Hinweis nicht.
- **Ort für jemand anderen nur mit Zustimmung:** Das Handy der Person, der die Aufgabe gehört, überwacht einen von
  jemand anderem gesetzten Ort erst nach „Annehmen“ (Meldung mit Knöpfen, `POST tasks/<id>/place/consent`); ein neuer
  Ort fragt neu.
- **Aufgabe mit Ort und Liste:** Die Erinnerung am Ort nennt die Liste und trägt „Liste öffnen“. **„Gestern offen
  geblieben“** nennt bei Aufgaben mit Ort den Ort statt der Liste.
- **Portal:** Zeile „Ort“ in der Aufgabe mit dem Dialog „Welcher Baumarkt?“ (Treffer mit Minuten und Entfernung,
  „Jeder …“, Meine Orte, Punkt auf der Karte, Beim Ankommen / Beim Verlassen, „Als meinen Ort merken“), Baustein in
  der Schnell-Eingabe, „Einstellungen“ › Orte (Ortssuche, Hinweis „in der Nähe“, Ruhezeit, Meine Orte). Das Portal hat
  keinen eigenen Standort: gesucht wird in der Nähe eines eigenen Orts.
- `GET me` → `features` mit `places`, `placeSearch`; `places { search { state, enabled, mine, service, … }, nearby,
  quiet, perTask, radius, family }`; `prefs.places { search, nearby, quiet }`; Ereignis `changed { what: ['places'] }`.
- Neue Rechte: Internet `nominatim.openstreetmap.org:443` (nur mit eingeschalteter Ortssuche genutzt), Zugriffsziel
  „Ortssuche“, Karten (`ui.maps`), Dienste `gatecontrol-familie:places` und `gatecontrol-familie:geofences`.
- Tests: `test/places.test.js` (Erkennung, Suche mit gefälschtem Nominatim, Grenzen, Schalter, Budget, Meldungen,
  Zustimmung), `test/portal.test.js` (Dialog, Baustein, Einstellungen).

## 1.4.0

„Aufgaben und Erinnerungen“, Stufe 2 – Einkaufslisten im Hub, eine Liste an der Aufgabe.

- **Einkaufslisten** (`server/shopping.js`, `migrations/006_shopping_lists.sql`): Listen zum Abhaken mit Punkten (Text,
  Menge). Eine Einkaufsliste ist eine gewöhnliche Liste (Besitzer, Mitglieder mit den Rollen Bearbeiten / Ansehen,
  Symbol, Einkaufstag, Papierkorb mit „Rückgängig“) von der Art `shopping`; ihre Punkte sind **keine Aufgaben**, sondern
  eigene, leichte Zeilen mit Kennungen, die das Gerät vergibt. Begründung: Das Offline-Protokoll des Familien-Plugins
  (Operationen in Reihenfolge, gefahrlos wiederholbar, Grabsteine 30 Tage) lebt von Kennungen, die für alle gelten –
  die `clientId` der Aufgaben gilt je Person; und Punkte wie „Milch“ sollen nicht in „Geplant“, in der Suche, im
  Kalender oder bei Microsoft To Do landen. Alles, was Listen können, gilt trotzdem. Orte (Stufe 3) hängen an der
  Aufgabe, Familien-Aufgaben (Stufe 4) sind Aufgaben in geteilten Listen – beides setzt darauf auf.
  - `GET shopping[?since=]`, `POST shopping/ops` (≤ 200 Operationen: `list_add`, `list_rename`, `list_delete`,
    `item_add`, `item_edit`, `item_check`, `item_delete`, `clear_checked`; abgewiesene mit `index` und `code`).
  - Eine Einkaufsliste hat zwei Kennungen: `id` (Text, vom Gerät – dieselbe wie im Familien-Plugin) und `listId`
    (Zahl – für `PATCH lists/<n>`, `PUT lists/<n>/members`, `DELETE lists/<n>`, das Anhängen).
  - Einkaufslisten stehen **nicht** in `GET lists` / `nav.lists` (ältere Apps sähen leere Aufgabenlisten), sondern in
    `GET shopping` und `nav.shopping`. Eine Aufgabe lässt sich nicht in eine Einkaufsliste legen.
- **Liste an der Aufgabe:** Feld `attachedList { id, uid, name, icon, open, total, done, family }` an jeder Aufgabe,
  gesetzt mit `attachedListId` (oder `attachedListUid`) in `POST tasks` / `PATCH tasks/<id>` (auch in `base`). Anzeige
  „Einkauf 0/8“. Anhängen lassen sich Einkaufslisten, in denen die Person Mitglied ist. Eine Wiederholung gibt die
  Liste an die nächste Aufgabe weiter.
- **Vorschlag aus dem Text – ohne Änderung am Parser:** `POST parse` liefert neben `parsed` neu `attach { via, word?,
  list, lists }`: ein festes Wort (einkaufen, Einkauf, Einkäufe, besorgen, Besorgung(en), shopping, groceries, grocery),
  der Name einer Einkaufsliste als Wort im Text, oder `#liste`. `POST tasks { text, attach: 'auto' }` hängt die Liste
  an, wenn genau eine passt – ohne `attach: 'auto'` hängt der Server nie von selbst etwas an. **`ui/quickparse.js` und
  `test/vectors/quickparse.json` sind unverändert** (ein Test hält ihre Prüfsummen fest).
- **„Alles abgehakt“:** Hakt jemand den letzten offenen Punkt ab, werden die offenen Aufgaben erledigt, an denen die
  Liste hängt – gleich, wer abhakt und wo (App, Portal, Familien-Plugin, Wandtablet). `POST shopping/ops` nennt sie in
  `completed`; „Rückgängig“ ist `POST tasks/<id>/complete { done: false }`. Die Liste bleibt. Umgekehrt bleiben offene
  Punkte stehen, wenn die Aufgabe von Hand erledigt wird.
- **Erinnerung mit Liste:** Die Fälligkeits-Meldung einer Aufgabe mit Liste nennt die ersten Punkte („Einkauf ·
  8 Punkte: Milch, Brot, Äpfel, Butter …“), trägt `data.notizen.attachedList` und die Knöpfe „Liste öffnen“
  (`open_app_route`), „Erledigt“, „In 1 Std.“; `GET reminders` genauso. Vorbereitet für „beim Ankommen“ (Stufe 3).
- **Familie** (Familien-Plugin ab 1.21.0, nach dem Umzug dort): Dienste `shopping_bind`, `shopping_put`,
  `shopping_list` für das Familien-Plugin; Familien-Listen (`family: true`) sind mit Eltern und Kindern geteilt, Eltern
  dürfen sie verwalten. `PUT shopping/lists/<id>/family`, `POST shopping/lists/<id>/going` und `…/assign` („Ich gehe
  einkaufen“, „Kannst du einkaufen gehen?“ – das Familien-Plugin führt sie aus, mit seinen Karten und Meldungen).
  Änderungen im Hub erfährt das Familien-Plugin über `shopping_changed`.
- **Portal:** Abschnitt „Einkaufslisten“ im Menü, die Liste mit Punkten zum Abhaken (Menge, Ändern, Löschen,
  „Abgehakte entfernen“), Kopfzeile „gehört zu ‚…‘ · 3 von 8“, Hinweis „Alles abgehakt. ‚…‘ ist erledigt.“ mit
  „Rückgängig“, die Zeile „Angehängte Liste“ an der Aufgabe, der Baustein „Liste: Einkauf · 8 offen“ in der
  Schnell-Eingabe (zum Wegnehmen), „Einkauf 0/8“ an der Aufgabe, der Einkaufstag mit den ersten Punkten.
- **API** (Merkmale `shoppingLists`, `taskList`, `familyShopping` in `GET me`; README „1.4.0“): `me.shopping`,
  `nav.shopping`, Ereignis `changed { what: ['shopping'] }`; `listdays[]` einer Einkaufsliste mit `shopping { id }` und
  `points`. `GET reminders` trägt je Zeile `attachedList` (sonst `null`).
- Tests: `test/shopping.test.js`, `test/tasklist.test.js`, Portal 1.4.0 in `test/portal.test.js`.

## 1.3.0

„Aufgaben und Erinnerungen“, Stufe 1 – Erinnerungen mit Knöpfen, nichts geht mehr still verloren, Termin im Kalender von Mail.

- **Knöpfe an der Fälligkeits-Meldung:** „Erledigt“, „In 1 Std.“ und „Heute Abend“ (ab einer Stunde vor der eigenen
  Abend-Zeit „Morgen früh“) als Callback-Knöpfe (`data.actions`, Hook `notifyAction`, `server/remind.js`). Der Server
  prüft die Rechte der Person erneut; ein zweiter Druck (zweites Gerät, Meldung und lokaler Alarm) ändert nichts – jede
  Erinnerung hat eine Kennung `tag` = `task:<id>:<Zeitpunkt>`, „Später“ wirkt nur, solange die Aufgabe genau diese
  Erinnerung noch hat. Text der Meldung: „Fällig heute 09:00 · Liste“.
- **Erinnerungen gehen nicht mehr still verloren:** War der Server zur Zeit aus, wird die Meldung bis **24 Stunden**
  nachgeholt („War fällig um 09:00“, `late: true`) – vorher wurde sie nach 6 Stunden wortlos verworfen. Noch älter:
  keine Meldung, die Aufgabe trägt `missedReminder` und steht unter „Gestern offen geblieben“, bis sie entschieden ist.
- **„Gestern offen geblieben“** (`server/yesterday.js`): Karte über „Heute“ in „Mein Tag“ (Portal, `yesterday` in
  `GET views/myday`, `GET yesterday`) und **eine** Meldung am Morgen (Vorgabe 07:30, je Person einstellbar, eigener
  Schalter; nur wenn etwas offen ist; Thema `reminders`). Je Aufgabe „Erledigt“, „Heute“, „Verschieben“ (Morgen, Am
  Wochenende, anderes Datum: `POST tasks/<id>/move`), für alle `POST yesterday` („Alle heute“). An der Meldung: bei einer
  Aufgabe „Erledigt“ und „Heute“ als Callback, bei mehreren öffnet „Erledigt“ die App (sie fragt einmal nach);
  „Verschieben“ öffnet die App. Dabei sind: gestern fällige eigene Aufgaben (zugewiesen, sonst selbst angelegt),
  gestern in „Mein Tag“ gelegte, und Aufgaben mit verlorener Erinnerung. Eine Aufgabe nur mit Datum bekommt weiterhin
  keine Einzel-Erinnerung, erscheint aber hier.
- **Termin im Kalender von Mail** (`server/calsync.js`, Mail ab 1.15.0): Aufgaben mit Datum und Uhrzeit stehen als Termin
  von 30 Minuten im Kalender „Aufgaben“ der Person, der die Aufgabe gehört – **ohne** Termin-Erinnerung. Titel, Zeit,
  Person, Verschieben, Erledigen („✓ …“, Zeit frei), Löschen, die nächste einer Wiederholung und gelöschte Listen ziehen
  nach. Fehlt Mail, antwortet es nicht oder wird es später installiert, warten die Aufgaben und werden nachgetragen; hat
  eine Person keinen Platz in Mail, wird einmal am Tag wieder gefragt. Schalter: Plugin-Einstellungen › Kalender
  „Aufgaben mit Uhrzeit in den Kalender eintragen“ (Standard an) und je Person unter „Einstellungen“.
- **API** (Merkmale `reminderActions`, `yesterdayOpen`, `taskCalendar` in `GET me`; README „1.3.0“): Aufgabe mit
  `reminder { tag, at, atMs, mine, snoozed }`, `snoozed`, `missedReminder`, `calendar { state, eventId, calendarId, mine }`;
  `POST tasks/<id>/snooze`, `POST tasks/<id>/move`, `GET/POST yesterday`, `GET reminders` (die eigenen Erinnerungen der
  nächsten 30 Tage mit Kennung, Text und Knöpfen – für einen lokalen Alarm der Apps als Sicherung); `me.calendar`,
  `me.yesterday`; `prefs.notify.yesterday`, `prefs.yesterdayAt`, `prefs.calendar.tasks`.
- **Portal:** Karte „Gestern offen geblieben“, Zeichen „Erinnerung“ / „Später: …“ und „im Kalender“ an der Aufgabe,
  Baustein „Kalender: Aufgaben“ in der Schnell-Eingabe, neue Schalter unter „Einstellungen“.
- **Behoben:** Die nächste Aufgabe einer Wiederholung behält ihre Erinnerungs-Uhrzeit auch über die Zeitumstellung.
  Zwei Schalter unter „Einstellungen“ kurz nacheinander: der zweite überschrieb den ersten nicht mehr (`PUT prefs` je
  Person nacheinander). Löschen einer Aufgabe las alle Aufgaben (`id = ? OR parent_id = ?`) – jetzt zwei Anweisungen über
  Indizes. Im Portal fehlte beim ersten Laden der Listenname an den Zeilen, wenn die Ansicht vor dem Menü ankam.
- Der Parser der Schnell-Eingabe und `test/vectors/quickparse.json` sind unverändert.
- Migration `005_reminders_calendar.sql`; Tests `test/reminders.test.js`, `test/yesterday.test.js`,
  `test/calendar.test.js` (auch gegen das echte Mail-Plugin), `test/portal.test.js`, `test/speed.test.js`.

## 1.2.1

Weniger Lese- und Schreibarbeit auf einem langsamen Datenträger (Anlass: „slow plugin database statements“ im Protokoll
von GateControl). An der Oberfläche und an der API ändert sich nichts.

- **Aufräumen des Papierkorbs:** Die Frage „ist dieses gelöschte Notizbuch / diese gelöschte Liste leer?“ läuft jetzt über Indizes. Vorher las sie dafür jede Notiz samt Text bzw. jede Aufgabe (Test mit 50 000 Notizen und 50 000 Aufgaben, 91 MB: 43 MB gelesen → 0,04 MB). Migration `004_trash_indexes.sql`: `idx_notes_gone` (Notizen im Papierkorb) und `idx_tasks_rest` (Aufgaben im Papierkorb und Unteraufgaben) – beide enthalten nur diese Zeilen; eine Notiz oder Aufgabe, die geschrieben oder abgehakt wird, berührt sie nicht. Das Anlegen liest beide Tabellen einmal (Test: 30 ms).
- **„Hat das Plugin benutzt“** (`prefs.updated_at`, für den Abgleich der Quellen der letzten 30 Tage) wird höchstens alle 12 Stunden geschrieben statt jede Stunde.
- **`PUT prefs` mit denselben Angaben** (das Portal schickt den Bereich bei jedem Wechsel) schreibt nichts mehr.
- Tests: `test/writes.test.js` (Abfrageplan, dasselbe Ergebnis wie 1.2.0 auf denselben Daten, Schreibzugriffe, Migration mit Altdaten); `test/speed.test.js` lässt das Lesen ganzer Tabellen beim Aufräumen nicht mehr zu.

## 1.2.0

- **Neues Menü im Portal wie in Drive:** links immer sichtbar, unter 760 px hinter dem Knopf ☰. Mein Tag, Wichtig, Geplant, Mir zugewiesen, „Aufgaben“ (Standardliste); „Meine Listen“ mit „+“ und Gruppen als aufklappbare Ordner (Zahl = offene Aufgaben darin); „Aus anderen Plugins“; „Notizbücher“ mit „+“; ⋯ an jeder Liste, Gruppe und jedem Notizbuch; das Zahnrad „Einstellungen“ unten links. Kennzeichen: Personen-Symbol = ich habe geteilt, kleines Bild = mit mir geteilt.
- **Rollen beim Teilen:** Mitglieder von Listen und Notizbüchern sind `write` (Bearbeiten, Standard) oder `read` (Ansehen). `PUT lists|notebooks/<id>/members` nimmt Ids (wie 1.1: neue schreiben, vorhandene behalten ihre Rolle) oder `{ id, role }`. Der Server erzwingt Leserechte: `403 forbidden { reason: 'read_only' }` für Anlegen, Ändern (außer dem eigenen „Mein Tag“), Löschen, Anhänge und Abhaken nicht zugewiesener Aufgaben; Besitzer-Aktionen durch Mitglieder `403 { reason: 'owner' }`. Aufgaben tragen `canEdit`/`canComplete`, Listen und Notizbücher `canEdit`, Mitglieder `role` und `since`. Teilen-Fenster mit Suche (GET people), Rolle ändern, Entfernen.
- **Listen-Tage / Einkaufstag:** Listen haben `icon` (list, cart, home, tool, gift, plane, heart, work), `days` (Wochentage in „Mein Tag“, setzt der Besitzer), `remind` (Nachricht am Morgen, Standard aus) und je Mitglied `mydayOff`. `GET views/myday` liefert `listdays` (Karte „Heute ist Einkaufstag“ mit offenen, mir zugewiesenen und den ersten Einträgen); die Startseite zeigt dazu eine Kachel. Neues Push-Thema **„Einkaufstag am Morgen“** (`listday`, `data.notizen.kind = 'listday'`).
- **Löschen mit Behalten und Rückgängig:** `GET lists|notebooks/<id>/usage` für die Rückfrage, `DELETE lists/<id>?tasks=move|delete` (offene Aufgaben in „Aufgaben“, erledigte in den Papierkorb), `DELETE notebooks/<id>?notes=move|delete` (Tresor nur löschen, vorher Namen eintippen), `POST …/restore` innerhalb von 30 Tagen (Mitglieder, Rollen, Gruppen, Aufgaben/Notizen). Ohne Parameter wie 1.1 (alles in den Papierkorb). Standardliste und Standard-Notizbuch: umbenennen ja, löschen nein.
- **Gruppen:** „Neue Liste oder Gruppe“ mit Liste|Gruppe, `POST groups { lists }` legt Listen gleich hinein; ⋯: Neue Liste in dieser Gruppe, Umbenennen, Gruppe auflösen (Listen bleiben).
- **Zuweisen in geteilten Listen:** Bild der Person an der Aufgabe (Klick wählt aus den Mitgliedern, auch nur-ansehen), Filter Alle / Mir zugewiesen / je Person / Niemandem, „@Name“ in der Schnell-Eingabe.
- **Einstellungen statt „Quellen“:** Aufgaben aus anderen Plugins, Mein Tag (Karte an/aus, Erledigte von heute, Bereich beim Öffnen), Uhrzeiten der Schnell-Eingabe, Benachrichtigungen (je Art, zusätzlich zu GateControl), Umziehen. `prefs` hat dafür `myday`, `startArea`, `notify`. Die Admin-Einstellungsgruppe „Quellen“ heißt jetzt „Aus anderen Plugins“.
- `GET me` meldet `listDays`, `shareRoles`, `groupEdit`, `deleteKeep`, `listIcons` und `listIcons: [...]`. Migration `003_list_days_roles.sql`.

## 1.1.0

- **Offline anlegen und ändern in den Apps:** Aufgaben, Unteraufgaben, Listen, Listengruppen, Notizbücher und Notizen (auch im Tresor) nehmen beim Anlegen eine **`clientId`** des Geräts (eine UUID). Kommt dasselbe Anlegen noch einmal (die Antwort ging verloren, die Warteschlange sendet erneut), antwortet das Plugin mit dem schon angelegten Objekt (`replayed: true`) statt ein zweites anzulegen – auch wenn beide gleichzeitig ankommen. Die Zuordnung gilt je Person (Tabelle `client_ids`, Migration `002_client_ids.sql`, 180 Tage aufgehoben): die `clientId` einer anderen Person findet nie deren Objekt. Ist das Objekt inzwischen weg, kommt `410 gone`.
- **Eltern, die selbst offline entstanden sind:** `listClientId` und `parentClientId` bei `POST tasks`, `notebookClientId` bei `POST notes` benennen Liste, Aufgabe oder Notizbuch über ihre `clientId`. Ist es noch nicht angelegt (eine Unteraufgabe vor ihrer Aufgabe), kommt sauber `409 unknown_client_id { field }` und nichts wird angelegt.
- **Ändern ohne Verlust:** `PATCH tasks/<id>`, `PATCH lists/<id>` und `PATCH notebooks/<id>` nehmen **`base`** – die Werte, die das Gerät vor der Änderung gesehen hat. Hat jemand anderes ein Feld inzwischen auf etwas anderes geändert, kommt `409 conflict { fields, task | list | notebook }`; andere Felder stören sich nicht. Ohne `base` gewinnt die Änderung wie bisher („Meine behalten“). Notizen bleiben bei `rev`.
- **Doppelt gesendet schadet nicht:** Ein Feld, das schon den gesendeten Wert hat, wird nicht geschrieben – eine zweimal gesendete Erinnerung erinnert nicht zweimal, eine zweimal gesendete Zuweisung schickt nur einen Push. `PATCH notes` mit veraltetem `rev` antwortet `200`, wenn die Notiz schon genau so aussieht. Ein zweites Löschen antwortet `{ ok, gone: true }` (für wen es sehen darf; sonst `404` wie bisher).
- **Pushes führen zur Seite:** `data.notizen` trägt jetzt `kind` (`reminder`, `assigned`, `shared_list`, `shared_notebook`, `vault_request`), `area` und die Ids `taskId`, `listId`, `notebookId`, `vaultId`, `deviceId` – die Schlüssel von 1.0 (`task`, `list`, `notebook`, `vault`) bleiben.
- `GET me` meldet die Fähigkeiten **`offlineEdits`** und **`pushTargets`**; Apps legen nur damit offline an.

## 1.0.1

- Korrektur: Der Umzug von Microsoft To Do braucht **Mail 1.12.0** (Dienste `ms_accounts`, `ms_tasks_token`, `ms_tasks_consent`), nicht 1.11.0 – in Handbuch, README, Einstellungshilfe und Hinweistext.

## 1.0.0

Das neue Plugin **Notizen & Aufgaben** – die Zentrale für eigene Aufgaben und Notizen und alles „Zu tun“ aus den anderen Plugins.

- **Aufgaben:** Listen und Listengruppen, intelligente Listen „Mein Tag“, „Wichtig“, „Geplant“, „Mir zugewiesen“; Unteraufgaben, Fälligkeit mit Uhrzeit, Erinnerung als Push (Thema „Erinnerungen an Aufgaben“), Wiederholen (täglich, an Wochentagen, alle N Tage/Wochen/Monate/Jahre, N Tage nach Erledigung – `ui/repeat.js`), Notiz und Anhänge an Aufgaben, geteilte Listen, Zuweisen an Mitglieder (Push „Geteilt und zugewiesen“).
- **Aus anderen Plugins:** Familie, Mail, Drive, Schule und Alltag liefern ihr „Zu tun“ nach `docs/notes-sources-contract.md` (Push `todo_changed` mit eigener Grenze von 3600 Aufrufen pro Stunde, Abgleich `todo_items` etwa alle 12 Stunden, `todo_complete`). Abhaken hier hakt dort ab, das Original bleibt im Plugin. Eine Aufgabe kann ein solches Element „tragen“ (eigene Unteraufgaben, Notiz, Erinnerung). Müllabfuhr am Vorabend, Aufgaben der Kinder, Einkaufslisten, markierte Mails, Konten und Kinder als Gruppen – je Person unter „Quellen“ einstellbar.
- **Notizen:** Notizbücher, Schlagwörter (#wort im Text), Anheften, Farben, Markdown mit Überschriften, fett/kursiv, Listen, Checklisten, Tabellen, Links, Bildern und Anhängen (`ui/notemd.js`); eine Zeile wird zur Aufgabe; Volltextsuche (FTS5, ohne Umlaut-Unterschied, auch erkannter Text von Bildern, den ein Gerät schickt).
- **Tresor-Notizbücher:** Ende-zu-Ende verschlüsselt im Format der Drive-Tresore mit dem Präfix `gcnotes-v1` (README „Tresor-Notizbücher – Kryptografie“, Testvektoren `test/vault-vectors.json`), Geräte freigeben mit Sicherheitsnummer, Wiederherstellungsschlüssel, neuer Schlüssel, wenn jemand den Tresor verlässt.
- **Pinnwand und Packlisten von Familie** leben hier und werden in Familie angezeigt (Dienste `notes_bind`, `notes_list`, `note_save`, `note_check`, `note_delete`, `notes_import`; Rückmeldung `notes_changed`).
- **Schnell-Eingabe in normaler Sprache** ohne KI: „morgen 9 Uhr“, „Freitag“, „in 2 Wochen“, „jeden Montag“, „@Name“, „#liste“, „wichtig“ (`ui/quickparse.js`, Testvektoren `test/vectors/quickparse.json` für Android und Windows).
- **Umzug von Microsoft To Do** über das Microsoft-Konto aus Mail (braucht Mail 1.12.0: Token nur für `Tasks.ReadWrite`, Zustimmung per Gerätecode), Listen der Arbeit in den Bereich Arbeit, Anhänge, erledigte der letzten Tage; auf Wunsch Abgleich in beide Richtungen für eine Übergangszeit.
- **Umzug von Synology DS Note** aus dem .nsx-Export (wird auf dem Gerät gelesen, Anhänge einzeln hochgeladen); geschützte Notizen werden mit Passwort ein Tresor-Notizbuch oder übersprungen.
- **Portal:** Tab „Notizen & Aufgaben“ mit Menü, Liste und Details (Mockup „Windows“), Kachel „Mein Tag“ auf der Startseite, Treffer in der Portal-Suche. Bereiche Privat und Arbeit getrennt.
- **Einstellungen (Admin):** Zeitzone, Sprache der Erinnerungen, Teilen mit (alle / Familie und Team / niemand), Tresore erlauben, Quellen einzeln, Umzug, größte Datei, Platz je Person; Statuszeilen zu den Quellen.
- Schnell: jede Abfrage auf einem Index, `test/speed.test.js` mit 50 000 Aufgaben und 50 000 Notizen hält jede Anweisung unter 200 ms.
