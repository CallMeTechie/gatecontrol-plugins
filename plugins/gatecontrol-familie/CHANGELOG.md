# Familie (gatecontrol-familie)

Die Familie in der GateControl-App (eigener Tab), im Portal (eigener Tab „Familie“) und auf
drei Admin-Seiten. Alles bleibt auf dem eigenen Server.

## 1.13.2
- **Rollen auch für GateDrop:** Der Dienst `family_roles` antwortet jetzt auch dem Plugin **GateDrop**
  (`gatecontrol-gatedrop`) – dort dürfen Admins und die Eltern Links für Externe erstellen und Dateien im NAS
  ablegen. Andere Aufrufer bekommen weiterhin `forbidden`.

## 1.13.1
- **Wand-Tablet „Schule heute“: jedes Kind mit Bild und Farbe** – vor dem Namen das Profilbild (sonst die
  Initialen auf der Lieblingsfarbe), die Zeile in der Farbe des Kindes umrandet. So sind Geschwister auf einen
  Blick zu unterscheiden. Farbe und Bild kommen vom Plugin **Schule** ab 1.3.0 (`school_day` liefert je Kind
  `color` `#RRGGBB` und, wenn es ein Profilbild gibt, `avatarUrl`); mit einer älteren Version von Schule die
  Lieblingsfarbe und das Bild des Familienmitglieds. `GET wall` hat dafür in `school.students[]` zusätzlich
  `color`, `avatarUrl` und `initials` (jeweils `null`, wenn unbekannt).

## 1.13.0
- **Früher Schulschluss → Abholen** (mit dem Plugin **Schule** ≥ 1.2.0): endet der Unterricht eines Kindes
  heute oder morgen früher als geplant, ruft Schule den neuen Dienst **`school_day_end`** auf (nur der Aufrufer
  `gatecontrol-schule`, sonst `forbidden`): `{ events: [{ userId, date: 'YYYY-MM-DD', plannedEnd: 'HH:MM',
  newEnd: 'HH:MM', text }] }` (1 … 20, `newEnd` vor `plannedEnd`, sonst `invalid`) → `{ ok: true, notified,
  matched }`. Familie sucht eine **Abholung** (Modul „Abholen & Fahrten“, einzelne Fahrt oder Termin einer
  Serie) dieses Kindes an dem Tag, nicht abgesagt, **± 60 Minuten um das geplante Ende** (die nächstgelegene).
  Gefunden → Mitteilung (Thema **„Abholen & Fahrten“**, hoch) an den Fahrer (wenn ein Mitglied) und die Eltern:
  „Früher Schluss: Lena“ / „Schule endet um 11:30 statt 13:05 – Abholung ist für 13:05 eingetragen.“ (für
  morgen mit „Morgen: “ davor). Mit GateControl ≥ 1.181.0 mit Knöpfen: **„Auf 11:30 verschieben“** (Eltern
  oder der Fahrer; nur solange die Abholung später ist; verschiebt nur diesen Termin, die anderen bekommen
  „Anna hat die Abholung auf 11:30 verschoben“, protokolliert) und **„Wer kann?“** (die bekannte Anfrage des
  Fahrten-Moduls an die Eltern, höchstens alle 5 Minuten; drückt der Fahrer, wird er vorher ausgetragen; bei
  den Eltern nur, solange niemand fährt). Keine Abholung → Mitteilung nur an die Eltern mit dem Text von
  Schule („Lena hat am Di 21.10. schon um 11:30 Schluss (statt 13:05)“), abschaltbar mit der neuen Einstellung
  **„Früher Schulschluss ohne Abholung melden“** (`school_early_end_notify`, Vorgabe an). Je Kind, Tag und
  neuem Ende nur einmal; das Modul „Abholen & Fahrten“ muss an sein, der Urlaubsmodus hält es nicht auf.
  Migration `008_school_end.sql` (Protokoll `school_end_log`, 30 Tage).
- **Wand-Tablet: „Schule heute“** (ab 15:00 „Schule morgen“) – eine Zeile je Kind aus dem Plugin Schule:
  „Lena 07:45–13:05 · 1 Ausfall“, „Max frei“, der Ferienname, ein Hinweis „Arbeit: Mathe“. Nur mit dem
  Plugin Schule (GateControl ≥ 1.178.0, `gc.services.available`) und nur Kinder, die dort „Am Wand-Tablet
  zeigen“ haben. `GET wall` hat dafür `school: { day: 'today' | 'tomorrow', date, students: [{ userId, name,
  start, end, cancelled, changed, holiday, exams: [{ subject, name }], free }] } | null`. Die Antwort des
  Dienstes `school_day` wird je Datum 10 Minuten zwischengespeichert (auch ein Fehler) – das Wand-Tablet
  fragt jede Minute, Dienste zwischen Plugins sind auf 60 Aufrufe pro Stunde begrenzt.
- `permissions.services` zusätzlich `gatecontrol-schule:school_day`; `services.provides` zusätzlich
  `school_day_end`. Mindestversion bleibt GateControl ≥ 1.173.0.

## 1.12.0
- **Neuer Regel-Auslöser „Stunde fällt aus“** (Gruppe „Schule · Stundenplan“) mit dem Plugin **Schule**
  (`gatecontrol-schule` ≥ 1.1.0): welches Kind (oder jedes Kind), welche Änderung (fällt aus, Vertretung,
  Zusatzstunde, findet doch statt) und für welchen Tag die Stunde ist (heute, morgen, jeder Tag – in der
  Zeitzone der Familie, wenn die Änderung kommt). Funktioniert mit allen Bedingungen (Zeitfenster, nach
  Sonnenuntergang, Gerätewert, Termin) und allen Aktionen; braucht nur „Regeln und Erinnerungen“, nicht
  „Anwesenheit“. Beispiel: „Wenn bei Lena morgen die 1. Stunde ausfällt, Wecker eine Stunde später“.
  `{event}` ist der Text der Änderung („Lena: Mathe 3. Std. (09:50) fällt aus“, ohne eigenen Text auch der
  Text der Mitteilung), `{name}` das Kind. Anders als bei Anwesenheitsregeln wird das betroffene Kind
  nicht aus den Empfängern genommen – seine eigene Regel benachrichtigt es selbst (Thema „Regeln &
  Erinnerungen“, eine Mitteilung je Änderung). Jede Änderung löst eine Regel höchstens
  einmal aus, egal wie oft sie gemeldet wird; der Urlaubsmodus pausiert auch diese Hausregeln.
- **Trigger in der API `rules`:**
  `{ type: 'school_change', userId: <GateControl-ID eines Kindes> | null (jedes Kind), kinds: ['cancelled' |
  'changed' | 'extra' | 'restored'] (mind. eins, Vorgabe ['cancelled']), days: 'today' | 'tomorrow' | 'any'
  (Vorgabe 'any') }` – die Antwort zeigt ihn in derselben Form (kinds in dieser Reihenfolge, ohne
  Doppelte), `kind: 'school'`. Fehler: `400 invalid` mit `field` `trigger.userId` (kein Kind der Familie),
  `trigger.kinds`, `trigger.days`. Hausregeln (Eltern): jedes Kind oder `null`; die eigene Regel eines
  Kindes nur für sich selbst (`userId` die eigene oder `null` = sich selbst, sonst `403 forbidden`,
  `field: 'trigger.userId'`); die eigene Regel eines Elternteils jedes Kind.
- **`GET rules/options`:** `triggers` enthält `{ type: 'school_change', group: 'school', available: true }` nur,
  wenn `gc.services.available('gatecontrol-schule', 'school_students')` (GateControl ≥ 1.178.0) und Schule
  geantwortet hat; dann zusätzlich `school: { students: [{ userId, name }] }` – die Kinder der Familie, die
  Schule kennt (ein Kind sieht nur sich). Die Liste wird 5 Minuten zwischengespeichert (Dienstaufrufe sind
  auf 60 pro Stunde begrenzt). `permissions.services` + `gatecontrol-schule:school_students`.
- **Probelauf:** simuliert eine Änderung (das Kind der Regel bzw. das erste Kind, die erste gewählte Art,
  heute bzw. morgen) und prüft die Bedingungen wie jetzt; ohne Schule „löst nicht aus“.
- **Dienst `rule_event`** (`services.provides`, nur für den Aufrufer `gatecontrol-schule`, sonst
  `{ ok: false, code: 'forbidden' }`):
  `{ type: 'school_change', events: [{ userId, kind, date: 'YYYY-MM-DD', start: 'HH:MM', subject, text }] }`
  (0–20 Ereignisse; `userId` Zahl, `kind` wie oben, `subject` ≤ 80, `text` 1–200 Zeichen; sonst
  `{ ok: false, code: 'invalid' }`) → `{ ok: true, fired: <Regelläufe> }`. Je Ereignis und passender aktiver
  Regel (Kind oder jedes Kind, Art, Tag) laufen Bedingungen und Aktionen wie bei einer Anwesenheitsregel;
  Benutzer, die kein Kind der Familie sind, werden übergangen; ist „Regeln und Erinnerungen“ aus, läuft
  nichts (`fired: 0`). Doppelte Ereignisse: Schlüssel `school:<userId>:<date>:<start>:<kind>` je Regel
  (Tabelle `rule_fired`, 14 Tage aufbewahrt) – auch wenn eine Bedingung beim ersten Mal nicht erfüllt war.
  Kein 10-Minuten-Abstand wie bei Anwesenheitsregeln: zwei Stunden, die ausfallen, sind zwei Läufe.
- **Protokoll:** Läufe dieses Auslösers tragen `trigger: 'school_change'`, das Kind (`userId`) und neu
  `event` (der Text der Änderung, sonst `null`) – Seite „Anwesenheit & Smart Home“ und Portal zeigen ihn.
  Die Mitteilung trägt `data.familie.school: { date, start, kind }`.
- **Editor** (Admin-Seite und Portal): der Auslöser „Stunde fällt aus“ mit Kind („Jedes Kind“ oder ein
  Kind), Art(en) und Tag; der Listenfilter „Schule“ erscheint, sobald es eine solche Regel gibt.
- Migration `007_school_trigger.sql` (`presence_rules.trigger_json`, `presence_log.event_text`, `rule_fired`).
  Mindestversion bleibt **GateControl ≥ 1.173.0** – ohne `gc.services.available` (vor 1.178.0) wird der
  Auslöser nicht angeboten.

## 1.11.0
- **Offene Erinnerungen in der App:** `GET rules` liefert unter `open` die heute offenen Erinnerungen mit Person
  (`userId`) und „Später bis …“ – Kinder sehen ihre eigenen, Eltern (und die Admin-Seite) die der ganzen Familie.
  „Erledigt“ und „In 1 Std.“ gehen jetzt auch ohne Mitteilung: `POST rules/open/<Regel>/done | snooze { key }` –
  nur für die eigene Erinnerung, „In 1 Std.“ wie beim Knopf höchstens dreimal am Tag.
- **Urlaubsmodus:** Eltern (App: `PUT rules/vacation { on, until }`) und die Admin-Seite („Anwesenheit & Smart
  Home“ → Karte „Urlaubsmodus“) pausieren alle aktiven Hausregeln auf einmal, optional bis zu einem Datum. Endet
  er – von Hand oder nach dem letzten Tag –, werden genau die Regeln wieder eingeschaltet, die vorher aktiv waren;
  schon pausierte bleiben pausiert, eigene Erinnerungen laufen weiter. `GET rules` zeigt ihn unter `vacation`.

## 1.10.0
- **Ein Regel-Editor für alles:** Die Seite „Regeln & Erinnerungen“ ist wieder weg – alle Regeln der Familie
  stehen auf **„Anwesenheit & Smart Home“** und werden mit dem bekannten Dialog („Wann? · Was soll passieren? ·
  Ablauf“) angelegt. Er kann jetzt zusätzlich:
  - **Zeit · Erinnerungen** als Auslöser: Wochentage und Uhrzeit, einmal am Tag;
  - unter **„Nur wenn …“** einen **Gerätewert** (bis zu 4, mit dem aktuellen Wert) und einen **Termin** heute oder
    morgen (Familie-Termine, Alltag-Kalender, Titel enthält …);
  - in der **Mitteilung** Werte und Termin unter dem Text und bis zu drei **Knöpfe** („In 1 Std.“, „Erledigt“,
    ein Gerät);
  - einen **Probelauf** („Heute würde die Regel auslösen …“, ohne etwas auszulösen).
  Die Liste filtert nach Alle / Erinnerungen / Anwesenheit / Orte; eigene Erinnerungen der Mitglieder stehen mit
  „nur für …“. Ist „Anwesenheit & Smart Home“ aus, bietet der Dialog nur den Zeitplan an.
- **Portal:** Der Abschnitt „Regeln und Erinnerungen“ nutzt denselben Editor – Eltern wählen „Hausregel“ oder
  „Nur für mich“, Kinder (mit „Kinder dürfen eigene Erinnerungen anlegen“) legen eigene Erinnerungen an. Die
  Anwesenheits-Karte zeigt weiter, wer zuhause ist, und für Eltern die Orte.
- Bestehende Regeln und Erinnerungen bleiben unverändert (dieselbe Tabelle, dieselbe API `rules`).

## 1.9.1
- **Erinnerungen:** Ein Gerät heißt im Regel-Editor wie das Gerät („Elroq“), nicht mehr nach der Aktion, an der
  sein Widget hängt („Elroq – Klimatisierung“). Damit stimmen auch Titel und Bedingung („Ladestand Elroq < 50 %“).

## 1.9.0
Braucht weiterhin **GateControl ≥ 1.173.0**. **Gerätewerte** als Bedingung und **Knöpfe** in Mitteilungen
(„In 1 Std.“, „Erledigt“, ein Gerät schalten) brauchen **GateControl ≥ 1.181.0** – Familie erkennt das
selbst; vorher laufen Regeln ohne Gerätewerte wie gewohnt, Mitteilungen kommen ohne Knöpfe, und eine
Bedingung mit Gerätewert gilt als nicht erfüllt (das Protokoll sagt warum). Karten im Chat brauchen den
**Messenger ≥ 1.4.0**, der Einzelchat als Ziel (`direct:<id>`) den nächsten Messenger – vorher geht die
Karte in den Familienchat bzw. kommt als Mitteilung. Neu beim Aktualisieren: die Berechtigung „Dienste
anderer Plugins“ nennt zusätzlich `gatecontrol-alltag: calendar_query, calendar_list`, Familie bietet den
Dienst `family_roles` an, neues Mitteilungsthema „Regeln & Erinnerungen“.
- **Regeln und Erinnerungen** (neues Modul „Regeln und Erinnerungen“, Standard an, Seite „Funktionen“ –
  Regeln hängen nicht mehr am Modul „Anwesenheit“; Anwesenheits- und Orts-Auslöser brauchen es weiterhin):
  - **Zeitplan** als Auslöser: Wochentage und Uhrzeit in der Zeitzone der Familie, einmal pro Tag; war der
    Server aus, wird höchstens 2 Stunden nachgeholt; eine Uhrzeit, die beim Speichern schon vorbei war,
    löst erst beim nächsten Mal aus.
  - **Bedingungen „Nur wenn (alle)“:** Zeitfenster, nach Sonnenuntergang, **Gerätewert** (Wert, Kennzahl
    oder eine Messung aus dem Widget einer Schnellaktion – „Elroq · Ladestand < 50 %“; die Zahl wird aus dem
    Wert gelesen, „32 %“ → 32), **Termin** heute oder morgen (Familie-Termine, auf Wunsch nur bestimmter
    Personen, und die Alltag-Kalender, die die Person sieht; Titel enthält …). Geprüft wird direkt vor den
    Aktionen; nicht erfüllt oder unbekannt ⇒ nichts passiert, das Protokoll nennt den Grund.
  - **Mitteilung** mit Werten und Termin („facts“, unter dem Text) und bis zu drei **Knöpfen**:
    „In 1 Std.“ (nach 60 Minuten wird erneut geprüft und – noch erfüllt – erneut erinnert, höchstens 3× am
    Tag; nicht mehr erfüllt ⇒ erledigt), „Erledigt“ (für diesen Termin) und eine Schnellaktion eines anderen
    Plugins („Laden starten“ – nur für Personen, die sie selbst ausführen dürfen; läuft als diese Person).
    Platzhalter im Text: `{name}`, `{place}`, `{value}` (Gerätewert), `{device}`, `{event}` (Termin).
  - **Hausregeln und eigene Erinnerungen:** Hausregeln legen nur Eltern (und der Admin) an. Eigene
    Erinnerungen jedes Elternteil – Kinder nur mit der neuen Einstellung **„Kinder dürfen eigene
    Erinnerungen anlegen“** (Standard aus). Eine eigene Erinnerung benachrichtigt nur ihre Besitzerin oder
    ihren Besitzer (Mitteilung/Chat an sich selbst) und schaltet nur, was diese Person selbst darf. Kinder
    sehen nur ihre eigenen Regeln; Eltern sehen alle, dürfen die eines Kindes pausieren oder löschen, die
    eines anderen Elternteils nicht ändern.
  - **Neue Seite „Regeln & Erinnerungen“** (Admin, nach dem Entwurf „ReminderServer“): links die Regeln mit
    Filter Alle / Erinnerungen / Anwesenheit / Orte und Schalter zum Pausieren, darunter das Protokoll;
    rechts der Editor in drei Spalten **Wann · Nur wenn · Dann**, Titel und „Gehört zu“, **Probelauf**
    („Heute würde die Regel auslösen …“, ohne etwas auszulösen) und Speichern. Derselbe Editor im
    **Portal-Tab** (Abschnitt „Regeln und Erinnerungen“) für alle, die Regeln anlegen dürfen. Die Seite
    „Anwesenheit & Smart Home“ zeigt weiter ihre Anwesenheits-Regeln.
- **Einkaufen zuweisen:** „<Name> bitten“ fragt eine Person, ob sie einkaufen geht – als **Karte im
  Einzelchat** der beiden („Kannst du einkaufen gehen?“ · „REWE · 3 Artikel · bis heute 18:00“ mit den
  Knöpfen **„Übernehmen“** / **„Heute nicht“**), sonst im Familienchat, sonst als Mitteilung mit denselben
  Knöpfen. Wer gefragt hat, erfährt die Antwort. Vorgabe in der neuen Einstellung **„Einkaufen: wie
  „… bitten“ fragt“** (Einzelchat, Familienchat, nur Mitteilung). Listen tragen jetzt, wer gefragt ist
  und bis wann.
- **„Ich gehe einkaufen“ im Familienchat:** zusätzlich zur Mitteilung eine Karte „<Name> geht jetzt
  einkaufen · <Liste> · n Artikel“ mit „Zur Liste“ (Einstellung **„Einkaufen: „Ich gehe einkaufen“ im
  Familienchat“**, Standard an). Geht die gefragte Person einkaufen, gilt die Anfrage als übernommen.
- **Aufgaben aus dem Chat:** „Aufgabe“ im Anhang-Menü des Messengers legt eine Aufgabe an (für eine Person
  oder „wer zuerst kann“, mit Fälligkeit, auf Wunsch wöchentlich) und postet eine Karte mit **„Erledigt“**
  in die Unterhaltung.
- **Dienst `family_roles`** für den Messenger (Tür-Anfragen „Eltern fragen“).
- **Schnellaktionen von Familie** (`quickActions` / `runQuickAction`): die Knöpfe der Karten –
  `shop-take:<listId>`, `shop-decline:<listId>` (nur für die gefragte Person, solange die Anfrage offen
  ist) und `task-done:<taskId>` (nur für die Personen, deren Aufgabe es ist, solange sie offen ist).
- **API** (Pfade relativ zu `/api/v1/client/plugins/gatecontrol-familie/api/`; Fehler wie bisher
  `{ ok: false, code, error, field? }`):
  - `GET rules` → `{ rules: [Regel], log: [Lauf], can: { house, personal }, open: [{ ruleId, title, key, state, since, actionIds }] }`
    (`open`: heute offene Erinnerungen der Person – z. B. für einen Hinweis am Widget des Geräts in `actionIds`)
  - `POST rules` (Regel ohne `id`; `scope` Standard `house` für Eltern, `personal` für Kinder) → `{ rule }`;
    `PATCH rules/<id>` (Teilmenge, z. B. `{ active: false }`; `scope` ist fest) → `{ rule }`; `DELETE rules/<id>` → `{}`
  - `POST rules/<id>/test` und `POST rules/test` (ungespeicherte Regel) → `{ wouldFire, details: [{ kind, ok, text }] }`
    (`kind`: `trigger` | `time` | `sunset` | `device` | `calendar` | `action`; `ok` true | false | null)
  - `GET rules/options` → `{ triggers: [{ type, group, available }], devices: [{ actionId, label, icon, fields: [{ id, label, unit, current }] }],
    actions: [{ actionId, plugin, id, pluginName, title, subtitle, icon, kind, state, verbs, device }], actionsAvailable,
    calendars: [{ source, label }], places: [{ id, name, radius }], people: [{ userId, name, role, avatarUrl, color, colorHex, initials, placesShared }],
    messenger: { available, group }, can, features: { deviceValues, buttons, alltag }, location }`
  - Regel: `{ id, title, scope: 'house' | 'personal', active, kind: 'reminder' | 'presence' | 'place',
    trigger: { type: 'schedule', weekdays: [1–7, Mo = 1], time: 'HH:MM' } | { type: 'all_away', graceMinutes } |
    { type: 'first_home' } | { type: 'child_home_alone' } | { type: 'person_home' | 'person_away', userId } |
    { type: 'place_enter' | 'place_exit', placeId, placeName, userId | null },
    conditions: { time: { from, to } | null, afterSunset, device: [{ actionId: '<plugin>/<id>', field: 'value' | 'badge' | 'reading:<id>',
    op: '<' | '<=' | '>' | '>=' | '=', value, label, unit }] (≤ 4), calendar: { dayOffset: 0 | 1, sources: ['familie' | 'alltag' | 'alltag:<subId>'],
    match, memberIds } | null },
    actions: [{ type: 'quick_action', actionId, plugin, id, title, state, kind, verb, available, needsTarget } |
    { type: 'notify', to: 'parents' | 'all' | [userId], text, facts, buttons: ['quick_action:<plugin>/<id>', 'snooze_1h', 'done'] } |
    { type: 'messenger', to: 'family' | [userId], text }] (1–10), lastRunAt, lastResult: { at, ok, skipped } | null,
    ownerId, ownerName, editable, pausable, createdAt, updatedAt }` – beim Senden ist `to: 'me'` die eigene Person,
    eine Schnellaktion `{ actionId }` oder `{ plugin, id }` (+ `state` bei einem Schalter).
  - Codes: `parents_only` (Hausregel als Kind), `forbidden` (eigene Regeln ohne Erlaubnis, eine eigene Regel an
    andere, eine Schnellaktion, die die Person nicht hat, fremde Regeln), `module_off` (Modul aus, oder ein
    Anwesenheits-Auslöser ohne Modul „Anwesenheit“, `field: 'trigger'`), `too_many` (50 Hausregeln, 20 eigene pro Person).
  - `POST shopping/lists/<id>/assign { userId | null, dueAt?: ISO | null, notify?: 'direct' | 'family' | 'push' }`
    → `{ list, notified: { via: 'direct' | 'family' | 'push' | null, ok, code } | null }`; Listen (in `GET shopping`
    und `overview.shopping.lists`) tragen `assignee: { userId, by, at, state: 'open' | 'taken' | 'declined', notify } | null`
    und `dueAt`.
  - `POST shopping/lists/<id>/going` antwortet zusätzlich `chat: { ok, code } | null`.
  - `POST tasks/quick { title, assigneeId | null, due: ISO | 'YYYY-MM-DD' | null, repeat?: 'none' | 'weekly:<1–7>', conversationId? }`
    → `{ task, card: { ok, conversation: 'group:<id>' | 'direct:<uid>', code } | null }`; Aufgaben tragen `source` (`'chat'` | null)
    und `conversationId`.
  - Mitteilungen: Erinnerungen (Auslöser Zeitplan) kommen mit Thema `reminders`, `data.familie = { type: 'rule_reminder',
    ruleId, trigger, userId, key, qa? }`, Anwesenheits-Regeln weiter mit `presence` / `presence_rule`; `data.facts`
    `[{ label, value }]`; Knöpfe `data.actions: [{ type: 'callback', id: 'snooze_1h' | 'done' | 'qa<n>', label }]`
    (GateControl ≥ 1.181.0, zurück über den Hook `notifyAction`). Einkaufen: `shopping_assigned` (mit
    `quick_action`-Knöpfen), `shopping_taken`, `shopping_declined`.
  - Dienst `family_roles {}` → `{ ok, parents: [userId], children: [userId] }` (nur `gatecontrol-messenger`).
  - Admin: `GET|POST admin/rules`, `PATCH|DELETE admin/rules/<id>`, `POST admin/rules/<id>/test`, `POST admin/rules/test`,
    `GET admin/rules/options`; `GET admin/status` → `settings.childrenOwnRules`, `shoppingNotify`, `shoppingChat`.
  - Die bisherige API `presence/rules` bleibt: sie zeigt und ändert nur Hausregeln mit Anwesenheits- oder Orts-Auslöser
    und behält, was sie nicht kennt (Titel, Gerätewert-/Termin-Bedingungen, Werte und Knöpfe einer Mitteilung).
- Migration `006_rules_reminders` (Titel, Bereich und Zeitplan der Regeln, Stand der Erinnerungen, Zuweisung der
  Einkaufslisten, Aufgaben aus dem Chat).

## 1.8.0
Braucht weiterhin **GateControl ≥ 1.173.0** (Messenger-Funktionen ≥ 1.177.0). Am besten zusammen mit
dem **Messenger 1.4.0** – mit einem älteren Messenger läuft alles wie in 1.7.0. Neu beim Aktualisieren:
Familie **bietet Dienste an** (`services.provides`, im Installationsdialog sichtbar), und die
Berechtigung „Dienste anderer Plugins“ nennt zusätzlich `gatecontrol-messenger: set_place_status`.
- **Aus dem Chat auf die Einkaufsliste** (Dienst `list_add`): Der Messenger setzt Dinge aus einer
  Nachricht auf eine Einkaufsliste – für ein Familienmitglied (Eltern oder Kind, kein Wand-Tablet), nur
  mit eingeschalteter Einkaufsliste. „Die Einkaufsliste“ ist die erste Liste; gibt es keine, legt Familie
  „Einkaufsliste“ an. Was dort schon offen steht (gleicher Text, Groß-/Kleinschreibung egal), kommt nicht
  doppelt dazu.
- **Termine aus dem Chat:** „Termin anlegen“ im Messenger (Dienst `calendar_add`) legt einen normalen
  Termin dieser Person für die ganze Familie an. Ereignisse im Familien-Chat mit „In den Familienkalender“
  hält der Messenger aktuell (`calendar_upsert` / `calendar_remove`, wiederholbar ohne Doppel) – diese
  Termine sind in Familie schreibgeschützt (geändert und gelöscht wird im Chat). Beide tragen im Portal
  den Hinweis **„aus dem Familien-Chat“**. Zeiten werden in die Zeitzone des Plugins umgerechnet.
- **Ort und Endzeit für jeden Termin:** Termine haben jetzt optional einen **Ort** (nur der Name, ≤ 80
  Zeichen – nie Koordinaten) und eine **Endzeit**; das Portal zeigt „17:00–18:30 · Cinemaxx“. Ändert
  jemand die Startzeit, fällt die Endzeit weg.
- **Orte der Familie für den Messenger** (Dienst `places`): Zuhause (Breiten-/Längengrad aus den
  Einstellungen, 150 m) und – mit eingeschalteter Anwesenheit – die Orte für Regeln, für die Ortsauswahl
  bei Ereignissen und Live-Ankunft. Nur für Familienmitglieder.
- **Ort im Messenger-Status** (Dienst des Messengers `set_place_status`): Kommt jemand heim, verlässt
  das Zuhause, kommt an einem Ort für Regeln an oder verlässt ihn, sagt Familie dem Messenger den
  **Namen** des Ortes („Zuhause“, „Schule“) oder „kein Ort“ – nie eine Position, und nur für Personen,
  die der Anwesenheit (Zuhause/unterwegs) bzw. den Orten selbst zugestimmt haben; wer die Zustimmung
  zurückzieht, verschwindet aus dem Status. Ob und wem der Ort angezeigt wird, entscheidet der Messenger
  (Status „Automatisch: Ort“, eigene Privatsphäre-Einstellung). Gesendet wird nur eine Änderung; ist der
  Messenger nicht da (mit GateControl ≥ 1.178.0 vorher kostenlos gefragt) oder das Stundenbudget
  erschöpft, versucht Familie es alle 5 Minuten wieder – mit dem jeweils neuesten Ort.
- **API:** Termin-Objekte tragen zusätzlich `place` (string | null), `endTime` („HH:MM“ | null) und
  `origin` (`'chat'` | null); `POST dates` / `PATCH dates/<id>` nehmen `place` und `endTime`. Ein Termin
  des Messengers antwortet bei `PATCH`/`DELETE` mit 403 `read_only`. Dienste (nur für
  `gatecontrol-messenger`, sonst `forbidden`; Fehler als `{ ok: false, code }`):
  - `list_add { userId, list: 'shopping' | <listId>, items: [string] (1–50, je ≤ 120) }` →
    `{ ok, listId, listName, added, skipped, itemIds }` (Codes `invalid`, `not_member`, `module_off`, `not_found`)
  - `calendar_add { userId, title (≤ 80), startsAt, endsAt?, allDay?, place? }` → `{ ok, eventId }`
  - `calendar_upsert { sourceRef ('<wort>:<id>', z. B. 'messenger:123'), title, startsAt, endsAt?, allDay?, place?, userIds? }`
    → `{ ok, eventId, created }`; `calendar_remove { sourceRef }` → `{ ok, removed }`
  - `places { userId }` → `[{ id ('home' | 'place:<id>'), name, lat, lon, radiusM }]` (kein Mitglied: `[]`)
  - `startsAt`/`endsAt`: ISO-8601 mit Uhrzeit oder ein Datum `YYYY-MM-DD` (ganztägig); `place`: ein Text
    oder `{ label }`.

## 1.7.0
Braucht weiterhin **GateControl ≥ 1.173.0** (Messenger-Funktionen ≥ 1.177.0). Am besten zusammen mit
dem **Messenger 1.1.0** – mit Messenger 1.0.x läuft alles wie in 1.6.0. Neu beim Aktualisieren: die
Berechtigung „Dienste anderer Plugins“ nennt zusätzlich `gatecontrol-messenger: release_group`.
- **Schalter „Gruppe „Familie“ im Messenger“ aus = Gruppe wird freigegeben:** Familie gibt die Gruppe
  an den Messenger zurück – sie wird eine **normale Gruppe**: der Verlauf bleibt, jeder kann austreten,
  Namen und Bild ändern, die **Eltern sind Admins**. Wird der Schalter wieder eingeschaltet, legt
  Familie eine neue Gruppe an. Mit einem Messenger vor 1.1.0 (ihm fehlt dieser Dienst) bleibt die Gruppe
  wie bisher so, wie sie ist; die Karte „Messenger“ sagt „wird freigegeben, sobald der Messenger (ab
  1.1.0) verfügbar ist“, und Familie fragt alle 6 Stunden wieder nach (das kostet nichts).
- **Regel-Nachricht an mehrere Personen in einem Aufruf:** Eine Messenger-Nachricht an einzelne Personen
  braucht jetzt nur noch einen Dienst-Aufruf statt einen pro Person (GateControl erlaubt 60 pro Stunde).
  Ein Messenger vor 1.1.0 lehnt das ab – dann schickt Familie wie bisher einzeln und versucht es nach
  6 Stunden wieder. Im Regel-Protokoll zählt `sent` die Personen, die die Nachricht bekommen haben.
- **Verfügbarkeit ohne Probe-Nachricht:** Ab GateControl 1.178.0 fragt Familie bei ausgeschalteter
  Gruppe mit `gc.services.available` nach, ob der Messenger da ist – kostenlos, ohne die leere
  Nachricht, die im Protokoll des Messengers als abgelehnt auftauchte, und deshalb alle 5 Minuten. Auf
  älteren GateControl-Versionen bleibt es bei der bisherigen Prüfung.
- **API:** `GET admin/messenger` / `admin/status` / `presence/rules` tragen in `messenger` zusätzlich
  `release: { at, ok, error, conversationId } | null`; `PUT admin/messenger { group: false }` gibt die
  Gruppe sofort frei.

## 1.6.0
Zusammenarbeit mit dem **Messenger-Plugin** (gatecontrol-messenger ≥ 1.0.0). Die Messenger-Funktionen
brauchen **GateControl ≥ 1.177.0** (Dienste zwischen Plugins); Familie selbst läuft weiterhin ab
GateControl 1.173.0 – ohne Messenger oder auf älterem GateControl ändert sich nichts, die neuen Teile
bleiben einfach ausgeblendet. Neu beim Aktualisieren: die Berechtigung „Dienste anderer Plugins“
(`gatecontrol-messenger: sync_group, send_message`).
- **Gruppe „Familie“ im Messenger:** Familie legt im Messenger eine Gruppe mit allen
  Familienmitgliedern an (Eltern und Kinder, keine Wand-Tablets) und hält sie aktuell – wer auf der
  Seite „Mitglieder“ dazukommt, ist sofort drin, wer entfernt wird oder Wand-Tablet wird, ist
  draußen; ein deaktiviertes Konto fällt beim nächsten Abgleich heraus. Im Messenger kann niemand
  die Mitglieder ändern oder austreten, stummschalten geht. Abgeglichen wird nach jeder Änderung,
  einmal nach jedem Start und sonst alle 6 Stunden; der Abgleich ist wiederholbar, ohne etwas
  doppelt anzulegen. Der Gruppenname folgt der Sprache der Benachrichtigungen („Familie“ / „Family“).
- **Schalter auf der Seite „Funktionen“** (Karte „Messenger“, Standard: an): zeigt, ob der Messenger
  verfügbar ist, wann zuletzt abgeglichen wurde, und hat „Jetzt abgleichen“. Ausgeschaltet gleicht
  Familie die Gruppe nicht mehr ab; eine schon angelegte Gruppe bleibt im Messenger so, wie sie ist.
- **Regel-Aktion „Messenger-Nachricht senden“** (Regel-Fenster → „Was soll passieren?“ → Tab
  „Messenger“): eine Nachricht von „GateControl“ in die Gruppe „Familie“ oder an einzelne Personen
  (dieselben Personen-Chips wie bei der Mitteilung; jede Person bekommt sie in ihrem eigenen Chat
  „Familie“). Text mit denselben Platzhaltern wie die Mitteilung – `{name}` die Person, `{place}` der
  Ort –, leer = Standardtext. Wer die Regel auslöst, bekommt die Nachricht an einzelne Personen nicht.
- **Ohne Messenger:** Der Tab erscheint nur, solange der Messenger läuft. Verschwindet er (deinstalliert,
  gestoppt), läuft die Regel trotzdem – nur diese Aktion wird übersprungen, im Regel-Protokoll steht
  „Messenger nicht verfügbar“, im Plugin-Log eine Warnung; die Regel behält die Aktion. Familie schaut
  alle 5 Minuten nach, ob er wieder da ist (das kostet nichts: GateControl zählt solche Aufrufe nicht).
- GateControl erlaubt 60 Dienst-Aufrufe pro Stunde: der Abgleich braucht nur wenige am Tag; eine
  Regel-Aktion einen pro Lauf (Gruppe) bzw. einen pro Person. Ist die Gruppe ausgeschaltet, prüft
  Familie die Verfügbarkeit mit einer leeren Nachricht, die der Messenger ablehnt (Eintrag
  `service_refused` in dessen Protokoll) – nur solange unbekannt, dann alle 6 Stunden.
- **API:** Regel-Aktion `{ type: 'messenger', to: 'family' | [userId] (1–20 Mitglieder), text? (≤ 500) }`;
  im Regel-Protokoll `{ type: 'messenger', to, ok, sent, error }` mit `error` `unavailable` |
  `group_off` | `not_found` | `forbidden` | `invalid` | `rate_limit` | `timeout` | `failed` |
  `no_recipients`. `GET presence/rules` und `GET admin/presence` tragen `messenger: { api, available,
  reason, group, title, sync, checkedAt }` (der Editor bietet die Aktion nur bei `available: true`).
- Admin-API: `GET admin/messenger`, `PUT admin/messenger { group }`, `POST admin/messenger/sync`;
  `GET admin/status` trägt `messenger`.

## 1.5.2
- **Mitteilung an einzelne Personen:** Im Regel-Fenster („Was soll passieren?“ → Mitteilung) lassen
  sich neben „Eltern“ und „alle“ jetzt auch einzelne Personen wählen – eine oder mehrere, z. B. nur
  Anna: „Wenn Marc bei Arbeit ankommt → Mitteilung an Anna“. Wer die Regel auslöst, bekommt die
  Mitteilung nicht selbst. (Der Server konnte das schon; es fehlte nur die Auswahl.)

## 1.5.1
- **Karten wieder sichtbar** (Orte, Protokoll): OpenStreetMap lehnte die Kacheln mit „403 Access
  blocked“ ab, weil die abgeschottete Plugin-Seite keinen Referer mitsendet. Ab GateControl 1.176
  holt GateControl die Kacheln selbst (mit Zwischenspeicher) und reicht sie an die Karte weiter
  (`GC.tiles`); auf älteren GateControl-Versionen bleibt es beim direkten Abruf.

## 1.5.0
Braucht weiterhin **GateControl ≥ 1.173.0** (keine Änderung am Kern) und die GateControl-App
1.41.0 für „Orte für Regeln teilen“.
- **Orte als Auslöser für Regeln:** zwei neue Auslöser **„Kommt an einem Ort an“** und
  **„Verlässt einen Ort“** – „Wenn Marc bei Schule ankommt …“, „Wenn jemand Arbeit Anna
  verlässt …“, und mit einem großen Radius um Zuhause (z. B. 500 m) „kurz vor Zuhause“. Je Regel
  eine Person oder **„Jemand“** (jede Person, die Orte teilt) und ein Ort. Das Geofencing läuft
  auf dem Handy der Person (wie bei den Orts-Erinnerungen); der Server erfährt nur „Person X hat
  Ort Y betreten / verlassen“ – **nie eine Position**. Eine Regel greift wie die anderen
  höchstens alle 10 Minuten und nur, wenn Zeitfenster und „nach Sonnenuntergang“ passen.
- **Eigene Zustimmung „Orte für Regeln teilen“** (in der App, unter „Anwesenheit teilen“) –
  unabhängig vom Teilen von zuhause/unterwegs. Ausgeschaltet beobachtet das Handy keinen Ort
  mehr; die gespeicherten Meldungen bleiben für das Protokoll.
- **Verspätete Meldungen lösen nichts aus:** eine Meldung, die mehr als 10 Minuten nach dem
  Betreten / Verlassen ankommt (das Handy war offline), wird gespeichert, führt aber keine Regel
  aus – eine Ankunft, die eine Stunde später gemeldet wird, öffnet keine Tür und schaltet kein
  Licht. Dieselbe Meldung innerhalb von 60 Sekunden zählt nur einmal.
- **Abschnitt „Orte“** auf der Seite „Anwesenheit & Smart Home“ und im Portal-Tab (Eltern):
  Karten mit Name, Radius und wie viele Regeln den Ort nutzen; Bearbeiten, Löschen (gesperrt,
  solange eine Regel den Ort nutzt). Der Editor zeigt die OpenStreetMap-Karte: tippen oder den
  Punkt ziehen, Radius 50 m – 5 km als Kreis, **„Zuhause übernehmen“** (Standort aus den
  Plugin-Einstellungen), Breiten- und Längengrad zum Nachtragen (ohne Karte der einzige Weg,
  mit Link „Position auf Karte wählen“). Höchstens 20 Orte, Namen eindeutig.
- **Regel-Dialog:** In „Wann?“ stehen die Auslöser in zwei Gruppen (Zuhause · Heim-WLAN, Orte ·
  Standort des Handys); bei einem Orts-Auslöser „Wer?“ mit „Jemand“, der Ort mit „Orte
  verwalten“ (öffnet die Orte über dem Dialog) und der Hinweis, wer „Orte für Regeln teilen“
  eingeschaltet hat – mit Warnung, wenn die gewählte Person es nicht hat. „Ablauf“ zeigt die
  Regel als Satz mit Radius („Wenn jemand Zuhause (500 m) verlässt …“). Mitteilungen kennen
  `{place}`; Standardtexte „Marc ist bei Schule angekommen“ / „Marc hat Schule verlassen“.
- **Anwesenheit / Protokoll:** „Orte geteilt“ an den Personen, die es eingeschaltet haben; das
  Protokoll der Regeln zeigt den Ort („Marc · kommt an: Schule“, mit dem Namen von damals).
- **App-API** (zusätzlich zu 1.4.0, alles in der Funktion `presence`, aus → `403 module_off`):
  - `PUT presence/consent { share?, places? }` – je optional, mindestens eins (sonst `400
    invalid`); `{ share }` wie bisher. Antwort zusätzlich `consent: { share, places }`.
  - `GET presence` → `me: { share, places }`, jedes Mitglied `placesShared`, dazu `watchVersion`;
    auch `POST presence` antwortet mit `watchVersion`.
  - `GET presence/watch` (jedes Mitglied) → `{ places: [{ id, name, lat, lon, radius,
    transitions: ['enter'] | ['exit'] | ['enter', 'exit'] }], version }` – die Orte der aktiven
    Orts-Regeln für „Jemand“ oder den Aufrufer, die Übergänge vereinigt, nach `id`; ohne
    Zustimmung `places: []` (nie ein Fehler). `version` = die ersten 12 Hex-Zeichen von sha1 über
    das JSON von `places` – gleich, solange sich nichts ändert.
  - `POST presence/places/<id>/event { transition: 'enter' | 'exit', at? }` → `{ fired, late,
    repeated }`; `at` (ISO, Zeit am Handy) nicht in der Zukunft, Standard jetzt. `409
    no_consent`, `404 not_found`, `400 invalid` (`field`).
  - Eltern: `GET presence/places` → `{ places: [{ id, name, lat, lon, radius, rules, createdAt,
    updatedAt }], home: { lat, lon } | null }`, `POST presence/places { name, lat, lon,
    radius? }`, `PATCH presence/places/<id>` (beliebige Teile) → `{ place }`, `DELETE
    presence/places/<id>` (`409 in_use` mit `rules: [Name …]`, solange eine Regel ihn nutzt).
    Name 1–40 Zeichen, eindeutig ohne Groß-/Kleinschreibung (`409 name_taken`), `radius` ganze
    Meter 50–5000 (Standard 200), höchstens 20 (`409 too_many`).
  - Regeln: `trigger` `place_enter` | `place_exit` mit `placeId` (Pflicht, sonst `400 invalid`
    `field: 'placeId'`) und `userId` (ein Mitglied oder `null` = jemand); jede Regel trägt
    `placeId` und `placeName` (sonst `null`). Ein geänderter Ort beginnt neu wie ein geänderter
    Auslöser. Protokoll-Zeilen: `placeId`, `placeName`. Mitteilungen einer Orts-Regel:
    `data.familie.placeId` (Typ weiterhin `presence_rule`).
  - neue Fehlercodes `name_taken` (409), `in_use` (409, mit `rules`)
- Admin-API: `GET admin/presence` zusätzlich `places` und `home`; `GET|POST
  admin/presence/places`, `PATCH|DELETE admin/presence/places/<id>`.
- Datenbank: Migration `004_place_rules.sql` (`rule_places`, `presence_consent.places`,
  `presence_rules.place_id`, `presence_log.place_id` / `place_name`, `place_rule_events` –
  Meldungen ohne Position, 90 Tage).

## 1.4.0
Braucht **GateControl ≥ 1.173.0** (Zielzustände für Schalter).
- **Schalter bekommen einen festen Zustand:** In einer Regel wählt man bei jedem Schalter
  einer Schnellaktion, welchen Zustand er bekommen soll – mit den Worten des Plugins
  („Verriegeln“ / „Entriegeln“, „Einschalten“ / „Ausschalten“, …). „Alle weg → Auto
  verriegeln“ entriegelt ein schon verriegeltes Auto nicht mehr, ein ausgeschaltetes Licht
  bleibt aus. Tasten (Szenen, Tür öffnen) werden wie bisher ausgeführt.
- **Ältere Regeln:** Ein Schalter, der in einer Regel von vor 1.4.0 steht, hat noch keinen
  Zielzustand – er wird nicht mehr ausgeführt (Protokoll: „Zielzustand fehlt – Regel
  bearbeiten“), die Regelliste zeigt ihn mit „Zielzustand fehlt – Regel bearbeiten“. Regel
  öffnen, den Zustand wählen, speichern. Die übrigen Aktionen der Regel laufen weiter.
- **Neuer Regel-Dialog** („Neue Regel“ / „Regel bearbeiten“) auf der Seite „Anwesenheit &
  Smart Home“ und im Portal-Tab – ein breiter Dialog in drei Spalten: **Wann?** (Auslöser als
  Karten, Person, Wartezeit, Zeitfenster, nach Sonnenuntergang) · **Was soll passieren?**
  (die Schnellaktionen in Tabs je Plugin mit Zähler, nach Gerät gruppiert; Schalter mit zwei
  Zielknöpfen, Tasten mit „Ausführen“; Suche über alle Plugins; die Mitteilung als eigener
  Tab) · **Ablauf** (die Regel als Satz, die nummerierten Schritte zum Entfernen, der Hinweis,
  dass Schalter einen festen Zustand setzen). Auf schmalen Bildschirmen (≤ 760 px) stehen die
  Spalten untereinander; per Tastatur bedienbar (Escape schließt, Tab bleibt im Dialog).
- Regelliste und Protokoll zeigen den Zielzustand („Elroq – Schloss: Verriegeln“), das
  Protokoll außerdem „war schon so“, wenn das Plugin den Zustand schon hatte.
- **API:** Eine Schnellaktion einer Regel trägt `state` (`'on'` | `'off'` für Schalter, `null`
  für Tasten); beim Speichern wird gegen die Schnellaktionen der Person geprüft (Schalter ohne
  Zustand → 400 `state_required`, Zustand bei einer Taste → 400 `invalid`). In den Regeln
  zusätzlich `kind`, `verb` und `needsTarget`; `presence/actions` liefert je Aktion `device`,
  `verbs`, `targets` und `state`; Ergebnisse im Protokoll tragen `state`, `verb` und
  `unchanged`, neue Fehler `needs_target`, `state_unknown`, `invalid_state`.

## 1.3.1
- **Portal ohne doppelte Überschrift**: das Portal zeigt über dem Tab schon „Familie“ – die
  eigene Überschrift „Familie“ im Tab entfällt; Datum, Personen, offene Aufgaben und die
  Familien-Chips bleiben oben stehen.

## 1.3.0
Braucht **GateControl ≥ 1.168.0** (Profilbilder und Lieblingsfarben der Konten).
- **Profilbild und Lieblingsfarbe:** Profilbild und Lieblingsfarbe ändert jede Person in der
  GateControl-App (Einstellungen → Profil) oder der Admin im Benutzerprofil. Die Familie zeigt
  überall das Bild des GateControl-Kontos – ohne Bild die Initialen weiß auf der Lieblingsfarbe.
  Die eigene Mitgliedsfarbe der Admin-Seite „Mitglieder & Ortung“ entfällt (ein `color` im
  Admin-API wird ignoriert); die Farbe der Kinder auf der Karte im Protokoll ist jetzt ihre
  Lieblingsfarbe.
- **Anwesenheit am Ring:** Um jedes Bild liegt ein Ring – **zu Hause** in der Lieblingsfarbe der
  Person, **unterwegs** rot (`#E5484D`), unbekannt / nicht geteilt / Funktion aus: nur ein dünner
  neutraler Rand. Tooltip und Screenreader: „Anna – zu Hause“ / „Anna – unterwegs“. Ein
  gemeinsamer Baustein (`ui/common.js` `avatar()`) auf der Seite „Mitglieder & Ortung“, der Seite
  „Anwesenheit & Smart Home“, im Portal-Tab (neu: die Familie als Chips im Kopf, jede Minute
  aktualisiert, solange die Anwesenheit an ist) und auf dem Wand-Tablet – dort ersetzt der Ring
  die bisherige Markierung (Rahmen / blasser) und folgt dem Abruf jede Minute. Ein Bild, das
  nicht geladen werden kann, lässt die Initialen stehen.
- **API für App und Seiten:** Jedes Mitglieds-Objekt – `me` und `members` von `GET me`,
  `GET presence`, `overview.presence.members` (neu, wie `GET presence`), die `members` von
  `GET wall`, die Admin-Seiten (`admin/status`, `admin/presence`, `admin/log`), dazu die
  Aufgaben-Chips der Wand und die Wunschlisten – trägt `avatarUrl` (`/avatars/<id>.<ext>` oder
  `null`), `color` (Schlüssel der Lieblingsfarbe, z. B. `pink` – **vorher ein Hex-Wert**),
  `colorHex` und `initials`; die Personen-Objekte zusätzlich `presence`: `home` | `away` |
  `unknown` | `null` (nicht geteilt, Funktion aus oder nur Geräte-Vertrauen im Portal). Ältere
  Apps, die `color` als Hex lesen, fallen auf ihre Standardfarbe zurück.

## 1.2.1
- **Funktionen:** Die Karte „Taschengeld“ zeigt einen Hinweis, solange noch kein Kind
  Mitglied ist („Noch kein Kind angelegt – füge unter „Mitglieder & Ortung“ ein Kind hinzu,
  dann erscheint das Taschengeld in der App.“). Ohne Kind blendet die App die Taschengeld-Karte
  aus; der Hinweis erklärt das schon beim Einschalten.

## 1.2.0
Braucht **GateControl ≥ 1.166.0** und die neue Berechtigung `permissions.actions` (im
Installationsdialog „darf Schnellaktionen anderer Plugins auslösen (z. B. Smart-Home-Szenen)“).
Geld ist überall **nur Buchhaltung**: ganze Cent (EUR), es wird nie etwas bezahlt, abgebucht
oder überwiesen.
- **Taschengeld** (Funktion `allowance`, Gruppe Geld, Standard aus): ein Konto pro Kind
  (Guthaben = Summe der Buchungen), Regel pro Kind (Betrag, wöchentlich an einem Wochentag oder
  monatlich an einem Tag 1–28, an/aus) und optional ein Kurs für Sterne („10 Sterne = 1 €“).
  Am Auszahltag ab 07:00 bucht das Plugin den Betrag – genau einmal pro Zeitraum (auch bei
  Neustarts; ein verpasster Zeitraum wird einmal nachgeholt, nie einer vor dem Einschalten oder
  Umstellen der Regel) – und das Kind bekommt „Dein Taschengeld ist da: 5,00 €“. Eltern buchen
  Gutschriften/Korrekturen und Ausgaben („Kino mit Mia − 8,50 €“, ins Minus nur durch Eltern)
  und löschen eigene Buchungen. **Sterne umwandeln:** das Kind fragt („Umwandeln“, in Schritten
  des Kurses), die Eltern bekommen eine Mitteilung mit „Annehmen“/„Ablehnen“; angenommen = Buchung
  `stars`. Umwandelbar sind die verdienten Sterne minus bereits umgewandelte minus offene
  Anfragen – der Wochenzähler der Aufgaben bleibt unverändert (Sterne aus Aufgaben-Einträgen, die
  nach 400 Tagen gelöscht werden, bleiben umwandelbar). Neues Mitteilungsthema **„Taschengeld“**
  (`allowance`).
- **Wunschlisten** (`wishes`, Geld, Standard an): eine Liste pro Mitglied (Titel, https-Link,
  ca. Preis, Anlass Geburtstag/Weihnachten/Sonstiges, Notiz). Bearbeiten: die Person selbst,
  Eltern auch die Listen der Kinder. Alle anderen tippen **„Ich besorge das“** / „Freigeben“ –
  **wer etwas besorgt, sieht der Beschenkte nie** (in keiner Antwort der API). Nach dem Anlass
  „Bekommen“ blendet den Wunsch aus.
- **Haushaltsbuch** (`expenses`, Geld, Standard aus, nur Eltern): Ausgaben mit Betrag,
  Kategorie (Lebensmittel, Kinder, Haushalt, Freizeit, Mobilität, Sonstiges), wer bezahlt hat,
  Datum, Notiz, gemeinsam ja/nein. Monatsansicht mit Summe, Kategorien und **Ausgleich**: die
  gemeinsamen Ausgaben werden gleich unter den Eltern geteilt („Marc → Anna 48,20 €“); bei drei
  oder mehr Eltern die wenigsten nötigen Zahlungen. **„Erledigt“** hält nur fest, dass ausgeglichen
  wurde; eine Änderung an einer Ausgabe öffnet den Monat wieder. Die App kann nach „Ich gehe
  einkaufen“ „Einkauf erfassen“ anbieten.
- **Pinnwand & Packlisten** (`board`, Alltag, Standard an): Notizen in fünf Farben, anheften,
  optional mit Ablaufdatum (danach verschwinden sie); alle schreiben, löschen dürfen die
  Verfasserin und Eltern. Checklisten (z. B. „Urlaub“, „Schwimmbad“) aus einer Vorlage oder neu,
  Einträge abhaken/hinzufügen/löschen, „Alles wieder offen“, „Als Vorlage“ speichern.
- **Essensplan** (`meals`, Alltag, Standard aus): Mittag und Abend pro Tag, Woche für Woche
  (ISO-Woche), mit Koch und Zutaten; **„Zutaten auf die Liste“** setzt die Zutaten auf eine
  Einkaufsliste – ohne Doppelte (Groß-/Kleinschreibung egal, nur offene Einträge zählen). Das
  heutige Essen steht in der Übersicht und auf dem Wand-Tablet („Essen: Pfannkuchen“).
- **Anwesenheit & Smart Home** (`presence`, Zuhause, Standard aus, neue Admin-Seite
  **„Anwesenheit & Smart Home“** und Abschnitt im Portal): Die App erkennt am Heim-WLAN, ob
  jemand zuhause ist (kein GPS) – nur für Personen, die selbst zugestimmt haben („Anwesenheit
  teilen“, jederzeit abschaltbar; ohne Zustimmung „nicht freigegeben“). **Regeln** (Eltern):
  *Wenn alle weg sind* (alle, die teilen, seit 0–120 Minuten, Standard 10), *wenn der Erste
  heimkommt*, *wenn ein Kind allein heimkommt*, *wenn <Person> heimkommt/geht*; optional nur in
  einem Zeitfenster (auch über Mitternacht) und/oder nach Sonnenuntergang (Standort in den neuen
  Plugin-Einstellungen **Breitengrad/Längengrad**, sonst ignoriert). Aktionen: **Schnellaktionen
  anderer Plugins** (z. B. Szenen des Smart-Home-Plugins, über `gc.actions.run` als die Person,
  die die Aktion in die Regel gesetzt hat – auf der Admin-Seite der Administrator) und
  **Mitteilungen** an Eltern, alle oder bestimmte Personen (`{name}` = die Person). Eine Regel
  greift einmal pro Wechsel und höchstens alle 10 Minuten („alle weg“ wird nachgeholt, solange
  alle weg bleiben). Jeder Lauf steht mit dem Ergebnis jeder Aktion im Protokoll der Regeln
  (die letzten 50); eine Schnellaktion, die das Plugin nicht mehr anbietet, zeigt **„Aktion nicht
  mehr verfügbar“**. Das Wand-Tablet zeigt an den Avataren zuhause/unterwegs. Über
  Geräte-Vertrauen erkannte Personen sehen keine Anwesenheit. Neues Mitteilungsthema
  **„Anwesenheit & Smart Home“** (`presence`).
- **Funktionen:** gruppiert wie die Vorlage – Alltag (+ Pinnwand, Essensplan), Unterwegs,
  Kinder & Sicherheit, **Geld** (Taschengeld, Wunschlisten, Haushaltsbuch), Zuhause
  (+ Anwesenheit); neue Schalter `mod_allowance`, `mod_wishes`, `mod_expenses`, `mod_board`,
  `mod_meals`, `mod_presence`. **Portal:** Pinnwand, Essensplan, Wunschlisten (alle),
  Taschengeld (Eltern alles, Kinder ihr Konto), Haushaltsbuch (Eltern), Anwesenheit (eigene
  Zustimmung, wer zuhause ist; Eltern: Regeln).
- **App-API** (zusätzlich zu 1.1.x; Beträge in Cent):
  - `GET me` → `modules` mit `allowance`, `wishes`, `expenses`, `board`, `meals`, `presence`
  - `GET overview` → `allowance` (Kind: `{ balanceCents, nextPayout, amountCents,
    convertibleStars, pendingRequests }`, Eltern: `{ sumCents, children: [{ childId,
    balanceCents }], pendingRequests }`), `wishes: { mine, reservedByMe }`, `expenses` (Eltern:
    `{ month, totalCents, sharedCents, settlement, settled }`), `board: { pinned, notes,
    openChecklists }`, `meals: { date, lunch, dinner }`, `presence: { home: [{ userId, since }],
    share }` – jeweils `null`, wenn aus
  - `GET allowance`, `POST allowance/<childId>/bookings`, `DELETE
    allowance/<childId>/bookings/<id>`, `PUT allowance/<childId>/rule`, `POST
    allowance/<childId>/convert`, `POST allowance/requests/<id>/approve|decline`
  - `GET|POST wishes`, `PATCH|DELETE wishes/<id>`, `POST wishes/<id>/reserve|unreserve`
  - `GET expenses?month=`, `POST expenses`, `PATCH|DELETE expenses/<id>`, `POST
    expenses/settle|unsettle`
  - `GET board`, `board/notes[/<id>]`, `board/checklists[/<id>]`,
    `board/checklists/<id>/items[/<itemId>]`, `POST board/checklists/<id>/reset`,
    `board/templates[/<id>]`
  - `GET meals?week=YYYY-Www`, `PUT|DELETE meals/<date>/<lunch|dinner>`, `POST
    meals/<date>/<slot>/to-shopping`
  - `GET|POST presence`, `PUT presence/consent`, `GET presence/actions`, `GET presence/log`,
    `GET|POST presence/rules`, `PATCH|DELETE presence/rules/<id>`
  - `GET wall` → `meals`, `modules.meals`, `modules.presence`, `members[].presence`
    (`home`/`away`/`null`)
  - neue Fehlercodes `not_enough_stars` (409, mit `available`), `no_star_rate` (409),
    `no_consent` (409), `too_many` (409)
  - Mitteilungen mit `data.familie.type` `allowance_paid` (`childId`, `bookingId`, `cents`),
    `allowance_convert` (`requestId`, `childId`, `stars`, `cents`), `allowance_decided`
    (`requestId`, `childId`, `status`, `cents`), `presence_rule` (`ruleId`, `trigger`, `userId`)
- Admin-API: `GET admin/presence`, `GET admin/presence/actions`, `POST admin/presence/rules`,
  `PATCH|DELETE admin/presence/rules/<id>`; `GET admin/status` → `settings.location`.
- Datenbank: Migration `003_money_board_meals_presence.sql`. Beim Entfernen eines Mitglieds
  gehen seine Zustimmung, sein Anwesenheitsstand und seine Taschengeld-Regel; Buchungen,
  Wünsche und Ausgaben bleiben.

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
