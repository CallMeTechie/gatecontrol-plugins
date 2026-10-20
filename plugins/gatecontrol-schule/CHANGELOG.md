# Schule (gatecontrol-schule)

Stundenplan aus WebUntis für Schüler- und Elternkonten als GateControl-Plugin.

## 1.2.0
- **Hausaufgaben und Arbeiten aus WebUntis:** In jedem Abruf (gleiche Sitzung, gleiche Tage wie der
  Stundenplan) holt das Plugin die Hausaufgaben (`GET /WebUntis/api/homeworks/lessons`, einmal je Konto,
  ab 14 Tage vor dem Stundenplan) und die Arbeiten/Tests (`GET /WebUntis/api/exams`, je Schüler mit Klasse
  und Schüler-ID). Bei Elternkonten gehören Arbeiten über `assignedStudents` (sonst die Klasse) und
  Hausaufgaben über die `records` (sonst – mit mehreren Kindern im Konto – die Fächer des eigenen
  Stundenplans) zum richtigen Kind. Noten werden nie gespeichert. Beides ist **optional**: ein Fehler hält
  den Stundenplan nie auf und behält, was schon da ist; eine Schnittstelle, die mit etwas anderem als einem
  Netzfehler antwortet (z. B. 403, 404), wird 6 Stunden in Ruhe gelassen (die Seite „Schule“ zeigt das am
  Konto). Migration `003_homework_exams.sql`.
- **API `app/timetable`:** jeder Tag hat zusätzlich – nur wenn vorhanden – `homework: [{ subject,
  subjectLong?, text, givenDate?, completed?: true }]` (an dem Tag fällig) und `exams: [{ subject,
  subjectLong?, name, start?, end?, type?, text? }]`. Alle bisherigen Felder bleiben unverändert.
- **Portal-Wochenplan:** Arbeiten als Hinweis oben am Tag, die fälligen Hausaufgaben unter den Stunden.
  **Seite „Schule“:** neuer Abschnitt „Arbeiten und Hausaufgaben“ (die nächsten 14 Tage).
- **Erinnerung am Vorabend** (neue Einstellung „Erinnerung am Vorabend“, Vorgabe 18:00, leer = aus): je
  Kind eine Mitteilung zu den Arbeiten von morgen (neues Thema **„Klassenarbeiten“**, z. B. „Lena: morgen
  Mathematik-Arbeit (3. Std.)“) und eine zu den morgen fälligen, nicht erledigten Hausaufgaben (neues Thema
  **„Hausaufgaben“**, „Lena: 2 Hausaufgaben für morgen“) – an dieselben Personen wie die Änderungen, nie in
  der Ruhezeit, je Kind, Tag und Thema nur einmal (auch nach einem Neustart).
- **Kachel und Widget:** gibt es morgen eine Arbeit, zeigt die Kachel einen Eintrag „Morgen · Arbeit:
  Mathematik“ (höchstens 4 Einträge wie bisher) und das Widget den Messwert `exam` („Arbeit morgen“).
- **Früher Schluss → Abholen (Plugin Familie ≥ 1.13.0):** endet der heutige oder morgige Schultag durch
  eine Änderung früher als vorher (nicht beim ersten Abruf; geplantes Ende = letzte Stunde laut Plan, auch
  wenn sie ausfällt), meldet das Plugin das dem Familie-Dienst `school_day_end` – `{ events: [{ userId,
  date, plannedEnd, newEnd, text }] }`, z. B. „Lena hat am Di 21.10. schon um 11:30 Schluss (statt 13:05)“.
  Je Kind, Tag und neuem Ende einmal, nur Schüler mit zugeordnetem Benutzer, in der Ruhezeit gehalten,
  verfällt, wenn die Stunde doch stattfindet oder das geplante Ende vorbei ist. Familie schaut nach einer
  Abholung um diese Zeit und fragt nach (siehe dort).
- **Dienst `school_day`** (nur für `gatecontrol-familie`, sein Wand-Tablet): `{ date } → { ok, date,
  students: [{ userId, name, start?, end?, cancelled, changed, holiday?, exams: [{ subject, name }], free }] }`
  – die Schüler mit „Am Wand-Tablet zeigen“ und zugeordnetem Benutzer.
- `permissions.services` zusätzlich `gatecontrol-familie:school_day_end`. Mindestversion bleibt
  GateControl ≥ 1.172.0 (die Dienste zwischen Plugins nur ab 1.178.0).

## 1.1.0
- **Regeln der Familie („Stunde fällt aus“):** Mit dem Plugin **Familie** (≥ 1.12.0) lösen Änderungen im
  Stundenplan dessen Regeln aus. Nach jedem Abruf gehen die Änderungen, die auch per Push gemeldet werden
  (nicht der erste Abruf, Stunde noch nicht vorbei, innerhalb von „Push für die nächsten Tage“, nur Schüler
  mit zugeordnetem GateControl-Benutzer), in **einem** Aufruf des Familie-Dienstes `rule_event` an Familie –
  höchstens die 20 neuesten, `{ type: 'school_change', events: [{ userId, kind, date, start, subject, text }] }`,
  der Text wie die Push-Zeile in der Sprache der Mitteilungen („Lena: Englisch 3. Std. (09:50) fällt aus“).
  Ruhezeit wie bei den Mitteilungen: gehaltene Änderungen gehen mit ihnen am Ende der Ruhezeit. Jede Änderung
  wird höchstens einmal gemeldet (`changes.rule_at`, Migration `002_rule_events.sql`) – auch wenn Familie
  fehlt oder der Aufruf scheitert; ein Fehler hält den Abruf nie auf. Die Seite „Schule“ zeigt das letzte
  Ergebnis (wann, wie viele Änderungen, ausgelöste Regeln oder der Fehler).
- **Dienst `school_students`** (`services.provides`, nur für `gatecontrol-familie`): `{ ok: true, students:
  [{ userId, name }] }` – die eingeschalteten Schüler mit zugeordnetem Benutzer; der Regel-Editor von Familie
  bietet damit die Kinder an.
- `permissions.services: ["gatecontrol-familie:rule_event"]`. Mindestversion bleibt **GateControl ≥ 1.172.0**:
  gemeldet wird nur, wenn `gc.services.available` (ab GateControl 1.178.0) Familie bestätigt – auf einem
  älteren GateControl bleibt alles wie in 1.0.0.

## 1.0.0
- **WebUntis-Konten** auf der Seite „Schule“: hinzufügen per **Link des QR-Codes** aus WebUntis
  (Profil › Freigaben › Zugriff über Untis Mobile – empfohlen, ohne Passwort: das Plugin meldet sich
  mit einem Einmal-Code (TOTP, RFC 6238) aus dem Schlüssel im Link an), mit den Daten unter dem
  QR-Code einzeln oder mit Benutzername und Passwort. Nur Server unter `*.webuntis.com`. Beim
  Hinzufügen meldet sich das Plugin einmal an und findet die Schüler: ein Schülerkonto ist der
  Schüler selbst, ein Elternkonto liefert seine Kinder. Fehler werden verständlich angezeigt
  (Anmeldung abgelehnt, keine Berechtigung, nicht erreichbar, unerwartete Antwort); ein Konto ohne
  Schüler (Lehrkraft) wird nicht angelegt. „Zugang ändern“ prüft die neuen Daten mit einer Anmeldung
  und behält sonst die alten; „Entfernen“ löscht Zugang, Schüler, Stundenplan und Protokoll.
- **Zugangsdaten verschlüsselt**: Schlüssel bzw. Passwort sind Plugin-Geheimnisse
  (`gc.settings.setSecret('acct.<id>.secret' | 'acct.<id>.password')` – mit dem Server-Schlüssel
  verschlüsselt wie eine `secret`-Einstellung, nie im Browser, nie in der Datenbank, nie im Protokoll).
- **Schüler**: einschalten/ausschalten, Anzeigename, Zuordnung zum GateControl-Benutzer des Kindes,
  weitere Empfänger (z. B. die Eltern), „Am Wand-Tablet zeigen“. Sehen dürfen das Kind, die
  Empfänger und Admins; Kiosk-Geräte nur Kinder mit „Am Wand-Tablet zeigen“; ein Portal-Besucher, der
  nur per Geräte-Vertrauen erkannt ist, sieht nichts.
- **Abruf** im Hintergrund (Tick alle 60 s): je Konto Mo–Sa 05:30–20:00 alle `poll_minutes`
  (Vorgabe 15), sonst stündlich; eine Anmeldung pro Konto und Durchlauf, danach Abmeldung (auch nach
  einem Fehler); Back-off bei Fehlern (Netz 5 … 120 min, Anmeldung/Berechtigung 1 … 24 h). Abgerufen
  wird Montag dieser bis Sonntag nächster Woche (immer mindestens heute + 7 Tage), Zeitraster und
  Ferien einmal am Tag.
- **Änderungen und Push** (Thema „Stundenplan-Änderungen“): neue Ausfälle (auch Stunden, die an einem
  Schultag aus WebUntis verschwinden), Vertretungen (andere Lehrkraft / anderer Raum / anderes Fach,
  `irregular`, Vertretungstext), Zusatzstunden und „findet doch statt“ (nur nach einem gemeldeten
  Ausfall) – für Stunden in den nächsten `notify_days` Tagen (Vorgabe 2: heute und morgen), die noch
  nicht vorbei sind. Eine Mitteilung pro Kind und Durchlauf („Lena: Englisch fällt aus“, „Lena:
  3 Änderungen“), an das Kind und die Empfänger, Collapse-Key pro Kind und Tag. Der erste Abruf legt
  nur den Stand fest. In der Ruhezeit (Vorgabe 21:00–06:00) erkannte Änderungen kommen an ihrem Ende –
  nur, wenn die Stunde dann noch nicht vorbei und die Änderung noch gültig ist. Ein Tag, dessen
  Stunden fast alle auf einmal ausgetauscht wurden (neuer Stundenplan), gilt als neuer Stand.
  Änderungsprotokoll der letzten 30 Tage.
- **Portal-Tab „Schule“**: Wochenansicht (diese/nächste Woche) je Kind mit Stundennummern aus dem
  Zeitraster, Ausfälle rot durchgestrichen, Vertretungen orange mit durchgestrichener ursprünglicher
  Lehrkraft / ursprünglichem Raum, Info- und Vertretungstexte, Ferien.
- **Startkachel** „Schule · <Name>“ je Kind („2 Ausfälle“, „Planmäßig“, „Frei“, „Ferien“) mit bis zu
  4 Einträgen für die Änderungen von heute und morgen.
- **Schnellaktion mit Widget** je Kind (`student:<id>`, nur Anzeige): Wert = Ausfälle heute, Status =
  nächste Änderung oder „Planmäßig“, Messwert `tomorrow` = Ausfälle morgen – so kann die Familie in
  Regeln `gatecontrol-schule/student:<id>` mit `value` oder `reading:tomorrow` prüfen. Antippen fragt
  einen baldigen Abruf an (höchstens alle 5 Minuten je Konto, nicht bei Automationen).
- **App-API** (`permissions.app`, ohne eigenen App-Tab): `GET app/timetable?from=&to=` (≤ 14 Tage) und
  `GET app/changes?days=7` – siehe README.
- **Diagnose** auf der Seite: je Konto letzter erfolgreicher Abruf, letzter Fehler mit Text, nächster
  Abruf; je Kind gespeicherte Stunden, letzter Abruf, letzte erkannte Änderung.
- Einstellungen: Zeitzone, Sprache der Mitteilungen, Abrufintervall, Push-Tage, Ruhezeit.
- **Braucht GateControl 1.172.0**: Widgets mit `label` und `readings` sowie `device` der
  Schnellaktionen (1.172.0), `items` der Startkacheln für die Apps (1.172.0), Kiosk-Geräte
  (`user.kiosk`, 1.165.0), App-API (`permissions.app`, 1.164.0), `notifyTopics` (1.154.0) und
  `gc.settings.setSecret` für eigene Schlüssel. Das Kalender-Symbol neben dem Widget-Wert (`icon`,
  GateControl 1.187) ignoriert ein älteres GateControl einfach; Regeln der Familie mit
  Gerätewerten brauchen dort GateControl 1.181.0 (`gc.actions.get … withWidget`).
- WebUntis hat für das keine öffentliche Schnittstelle: das Plugin spricht das Protokoll der
  WebUntis-Web-App (JSON-RPC `jsonrpc.do`, `jsonrpc_intern.do`, `api/app/config`) selbst über
  `gc.http.fetch`, ohne npm-Abhängigkeit. Kein Angebot von Untis.
