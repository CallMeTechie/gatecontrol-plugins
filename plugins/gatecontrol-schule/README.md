# Schule / School (`gatecontrol-schule`)

*English: see [below](#english). API for the GateControl apps: [API](#api).*

Der Stundenplan aus **WebUntis** in GateControl – für Schüler- und Elternkonten: Ausfälle,
Vertretungen und Zusatzstunden als Push-Mitteilung, der Wochenplan im Portal (auch am
Wand-Tablet), eine Startkachel und ein Widget je Kind.

Braucht **GateControl ≥ 1.172.0**. Lizenzpflichtiges Plugin.

> **Inoffizielle Schnittstelle, ohne Gewähr.** WebUntis bietet für das keine öffentliche
> Schnittstelle an. Das Plugin verwendet die Schnittstelle der WebUntis-Web-App (JSON-RPC) so, wie
> sie das MIT-lizenzierte Open-Source-Projekt [webuntis](https://github.com/SchoolUtils/WebUntis)
> dokumentiert. Untis unterstützt das nicht; es kann sich jederzeit ändern oder wegfallen, und die
> Schule kann Zugriffe einschränken. Das Plugin ist kein Angebot der Untis GmbH und steht in keiner
> Verbindung zu ihr.

## Deutsch

### Was es macht

* **Push bei Änderungen** (Thema „Stundenplan-Änderungen“): neue Ausfälle, Vertretungen (andere
  Lehrkraft, anderer Raum, anderes Fach, Vertretungstext), Zusatzstunden und „findet doch statt“ –
  für Stunden von heute und morgen (einstellbar 1–7 Tage), die noch nicht vorbei sind. Eine
  Mitteilung pro Kind und Abruf, z. B. „Lena: Englisch fällt aus“ / „Di 20.10. · 3. Std. 09:50“
  oder „Lena: 3 Änderungen“ mit je einer Zeile. Empfänger: das zugeordnete Kind und die
  eingetragenen Empfänger (z. B. die Eltern). In der **Ruhezeit** (Vorgabe 21:00–06:00) erkannte
  Änderungen kommen an deren Ende – nur, wenn die Stunde dann noch bevorsteht.
* **Portal-Tab „Schule“**: Wochenansicht Mo–Fr (Sa, wenn Unterricht ist), diese und nächste Woche,
  je Kind umschaltbar. Ausfälle rot durchgestrichen, Vertretungen orange mit durchgestrichener
  ursprünglicher Lehrkraft bzw. ursprünglichem Raum, Zusatzstunden hervorgehoben, Info- und
  Vertretungstexte, Stundennummern aus dem Zeitraster der Schule, „Ferien“.
* **Startkachel „Schule · <Name>“** je Kind: „2 Ausfälle“, „1 Vertretung“, „Planmäßig“, „Frei“ oder
  „Ferien“, in der App mit bis zu 4 Einträgen für die Änderungen von heute und morgen.
* **Widget je Kind** (Schnellaktion `student:<id>`, nur Anzeige): großer Wert = Ausfälle heute,
  Statuszeile = die nächste Änderung oder „Planmäßig“, Messwert „Morgen“ = Ausfälle morgen.
  Regeln der Familie können das als Gerätebedingung nutzen: Aktion
  `gatecontrol-schule/student:<id>`, Feld `value` (heute) oder `reading:tomorrow` (morgen) – z. B.
  „wenn morgen etwas ausfällt, abends erinnern“. Antippen fragt einen baldigen Abruf an.
* **Änderungsprotokoll und Diagnose** auf der Seite „Schule“.
* **Regeln der Familie** (ab 1.1.0, mit dem Plugin „Familie“ ≥ 1.12.0): Auslöser **„Stunde fällt aus“** –
  z. B. „wenn bei Lena morgen eine Stunde ausfällt, Wecker später stellen“ (siehe unten).

### Regeln der Familie („Stunde fällt aus“)

Ist das Plugin **Familie** (≥ 1.12.0) installiert, bietet sein Regel-Editor den Auslöser „Stunde fällt
aus“ an (welches Kind oder jedes Kind, Ausfall / Vertretung / Zusatzstunde / findet doch statt, heute /
morgen / jeder Tag). Nach jedem Abruf meldet Schule die Änderungen, **die auch per Push gemeldet
werden** – nicht der erste Abruf, nur Stunden, die noch nicht vorbei sind, innerhalb von „Push für die
nächsten Tage“, nur Schüler mit zugeordnetem GateControl-Benutzer – in **einem** Aufruf an Familie
(höchstens die 20 neuesten), mit dem Text wie in der Mitteilung („Lena: Englisch 3. Std. (09:50) fällt
aus“, Sprache der Mitteilungen). In der **Ruhezeit** gehaltene Änderungen gehen mit den Mitteilungen an
ihrem Ende. Jede Änderung wird nur einmal gemeldet; ein Fehler (Familie nicht erreichbar, Limit von 60
Aufrufen pro Stunde) hält den Abruf nie auf – die Seite „Schule“ zeigt das letzte Ergebnis. Braucht
GateControl ≥ 1.178.0 (`gc.services.available`); auf einem älteren GateControl wird nichts gemeldet.

### Einrichtung

1. **QR-Code-Link holen (empfohlen, ohne Passwort):** WebUntis im Browser öffnen, mit dem Konto des
   Kindes oder dem Elternkonto anmelden, unten links auf das **Profil** (Name) › Reiter
   **„Freigaben“** › bei **„Zugriff über Untis Mobile“** auf **„Anzeigen“**. WebUntis zeigt einen
   QR-Code (je nach Version heißt es „Datenzugriff“ oder ähnlich). Den QR-Code mit der Handy-Kamera
   oder einer QR-App scannen und den Link kopieren – er sieht so aus:
   `untis://setschool?url=xyz.webuntis.com&school=…&user=…&key=…&schoolNumber=…`.
   Alternativ stehen unter dem QR-Code Server, Schule, Benutzer und Schlüssel zum Abtippen.
2. In GateControl die Seite **„Schule“** öffnen › **„WebUntis-Konto hinzufügen“** › den Link
   einfügen (oder die Daten einzeln) › „Anmelden und Schüler suchen“. Das Plugin meldet sich einmal
   an und zeigt die gefundenen Schüler: ein **Schülerkonto** ist der Schüler selbst, ein
   **Elternkonto** liefert seine Kinder. Den Zugang kann man in WebUntis jederzeit wieder entziehen.
   Gibt es keinen QR-Code, geht es auch mit **Benutzername und Passwort** (Server z. B.
   `xyz.webuntis.com`, der Schulname wie bei der WebUntis-Anmeldung).
3. Je Schüler **„Bearbeiten“**: Anzeigename (z. B. „Lena“), den **GateControl-Benutzer des Kindes**
   (optional), **weitere Empfänger** (z. B. die Eltern) und **„Am Wand-Tablet zeigen“**. Ein Schüler
   lässt sich ausschalten (kein Abruf, nirgends sichtbar).
4. **Einstellungen** (Plugins › Schule › Einstellungen): Zeitzone der Schule (Europe/Berlin),
   Sprache der Mitteilungen, Abrufintervall (Vorgabe 15 min), Push für die nächsten Tage (Vorgabe 2),
   Ruhezeit (beide Felder leer = keine).

Der **erste Abruf** eines Schülers legt nur den Stand fest – es kommt keine Mitteilung über das, was
schon vorher ausfiel. Wer wann welche Mitteilung bekommt, steuert GateControl zusätzlich über
System › Benachrichtigungen; jede Person kann das Thema im Portal oder in der App abschalten.

### Wer sieht was

* **Admins** sehen alle Schüler (Push nur, wenn sie als Empfänger eingetragen sind).
* Das **zugeordnete Kind** und die **Empfänger** sehen „ihre“ Schüler – im Portal, in der Kachel,
  im Widget und über die App-API.
* **Kiosk-Geräte** (Wand-Tablet) sehen genau die Schüler mit „Am Wand-Tablet zeigen“.
* Andere Personen sehen nichts; ein Portal-Besucher, der nur per Geräte-Vertrauen erkannt ist
  (ohne Anmeldung), auch nicht – ein Stundenplan verrät, wo ein Kind ist.

### Abruf

Im Hintergrund je Konto Mo–Sa 05:30–20:00 alle 15 Minuten (einstellbar 5–120), sonst stündlich.
Pro Konto und Durchlauf genau **eine Anmeldung**, danach **Abmeldung**. Abgerufen wird Montag dieser
bis Sonntag nächster Woche (immer mindestens heute + 7 Tage), Zeitraster und Ferien einmal täglich.
Bei Fehlern wird seltener versucht: Netz/unerwartete Antwort nach 5, 10, 20 … bis 120 Minuten,
abgelehnte Anmeldung oder fehlende Berechtigung nach 1, 2, 4 … bis 24 Stunden (wiederholte
Fehlanmeldungen könnten das WebUntis-Konto sperren). Die Seite zeigt je Konto den letzten
erfolgreichen Abruf, den letzten Fehler (`auth`, `no_right`, `network`, `failed`) mit Text und den
nächsten Abruf, je Kind die gespeicherten Stunden und die letzte erkannte Änderung.

### Datenschutz

* Alle Daten bleiben auf deinem GateControl-Server. Das Plugin kontaktiert **nur den WebUntis-Server
  der Schule** (`*.webuntis.com`, Port 443) – keinen anderen Dienst.
* Schlüssel bzw. Passwort werden als **Plugin-Geheimnis verschlüsselt** gespeichert
  (`gc.settings.setSecret('acct.<id>.secret' | 'acct.<id>.password')`: mit dem Server-Schlüssel
  verschlüsselt wie eine `secret`-Einstellung, von Backups mit umgeschlüsselt). Sie stehen nie in
  der Datenbank, nie im Protokoll und werden nie an den Browser geschickt. Auch Einmal-Codes und
  Sitzungs-IDs werden nie protokolliert.
* Gespeichert werden der Stundenplan (14 Tage zurück bis Ende nächster Woche) und das
  Änderungsprotokoll (30 Tage). „Entfernen“ löscht Zugang, Schüler, Stundenplan und Protokoll des
  Kontos.

## API

Für die GateControl-Apps (`permissions.app`, ohne eigenen App-Tab):
`/api/v1/client/plugins/gatecontrol-schule/api/<pfad>` mit dem Geräte-Token. Beide Routen antworten
nur mit den Schülern, die die Person sehen darf (wie im Portal), und nur Aufrufen aus der App
(`403 FORBIDDEN` sonst). Zeiten sind Ortszeit der Schule (Einstellung Zeitzone).

```
GET app/timetable?from=YYYY-MM-DD&to=YYYY-MM-DD      höchstens 14 Tage, Vorgabe heute … heute + 6
  200 { ok: true, updatedAt: <ms | null>,               letzter Abruf der Schüler
        students: [{ id, name, userId, klasse,
          days: [{ date, holiday?: 'Brückentag',        jeder Tag des Zeitraums, auch ohne Unterricht
            lessons: [{ start: 'HH:MM', end: 'HH:MM', period?: 3, periodEnd?: 4,
                        subject: 'M', subjectLong: 'Mathematik', subjectOld?: 'D',
                        teacher: 'SCH', teacherOld?: 'MUE', room: '104', roomOld?: '201',
                        state: 'normal' | 'cancelled' | 'changed' | 'extra',
                        info?: '…', substText?: '…', text?: '…' }] }] }] }
  400 { ok: false, code: 'INVALID' }                    Datum ungültig, to < from, mehr als 14 Tage

GET app/changes?days=7                                  1 … 30 Tage, Vorgabe 7
  200 { ok: true, changes: [{ id, studentId, student, date, start, end, period?,
          kind: 'cancelled' | 'changed' | 'extra' | 'restored', subject, subjectLong?, subjectOld?,
          teacher?, teacherOld?, room?, roomOld?, substText?, info?,
          detectedAt: <ms>, pushed: <boolean> }] }      neueste zuerst, höchstens 200
```

`state`: `cancelled` = fällt aus (auch eine Stunde, die an einem Schultag aus WebUntis verschwand),
`changed` = Vertretung/Änderung (WebUntis `irregular`, eine ursprüngliche Lehrkraft/Raum/Fach oder ein
Vertretungstext), `extra` = nach dem ersten Abruf hinzugekommen. `period` / `periodEnd` aus dem
Zeitraster (Doppelstunde 3.–4.). Die Felder mit `?` fehlen, wenn sie leer sind.

### Dienste zwischen Plugins (1.1.0)

`services.provides` – nur für den Aufrufer `gatecontrol-familie` (jeder andere: `{ ok: false, code: 'forbidden' }`):

```
school_students   {} → { ok: true, students: [{ userId, name }] }
                  die eingeschalteten Schüler mit zugeordnetem GateControl-Benutzer (Anzeigename)
```

`permissions.services: ["gatecontrol-familie:rule_event"]` – nach jedem Abruf, nur wenn
`gc.services.available('gatecontrol-familie', 'rule_event')`:

```
rule_event        { type: 'school_change',
                    events: [{ userId, kind: 'cancelled' | 'changed' | 'extra' | 'restored',
                               date: 'YYYY-MM-DD', start: 'HH:MM', subject, text }] }   1 … 20
                  → { ok: true, fired }   (Familie führt die passenden Regeln aus)
```

## English

The timetable of **WebUntis** student and parent accounts in GateControl: cancellations,
substitutions and extra lessons as push notifications, a week view in the portal (also on wall
tablets), a Start tile and a widget per child. Needs **GateControl ≥ 1.172.0**.

**Unofficial interface, no warranty:** WebUntis has no public API for this. The plugin uses the
interface of the WebUntis web app as documented by the MIT-licensed `webuntis` npm project; it may
change or stop working at any time. Not affiliated with Untis GmbH.

**Setup:** in WebUntis (browser) open the profile › “Sharing” › “Access via Untis Mobile” ›
“Display”, scan the QR code and copy its link (`untis://setschool?url=…&school=…&user=…&key=…`) –
or use server, school, user and key shown below it, or user name and password. On the page
“School” add the account: the plugin signs in once (a TOTP from the key, no password) and lists the
students – the student itself, or a parent's children. Per student set a display name, the child's
GateControl user, further recipients and “Show on the wall tablet”.

**Who sees what:** admins all students; the mapped child and the recipients their students; kiosk
devices the students marked for the wall tablet; nobody else (a device-trust-only portal viewer
neither).

**Fetching:** per account every 15 minutes Mon–Sat 05:30–20:00 (5–120 configurable), otherwise
hourly; one login and a logout per cycle; back-off on errors. **Pushes** for changes of today and
tomorrow (1–7 days) whose lesson is not over, one per child and cycle; the first fetch only sets the
baseline; quiet hours (default 21:00–06:00) hold pushes until they end.

**Privacy:** all data stays on your server; only the school's WebUntis server (`*.webuntis.com`) is
contacted. The key or password is a plugin secret encrypted by GateControl, never in the database,
the log or the browser. Removing an account deletes its access, students, timetable and change log.

**Family rules (1.1.0):** with the plugin **Familie** (≥ 1.12.0) its rule editor offers the trigger
“Lesson cancelled” (a child or any child; cancelled / substitution / extra lesson / takes place after
all; today / tomorrow / any day). After each fetch the plugin hands Familie the changes it pushes (not
the baseline, lessons not over, within “Push for the next days”, students mapped to a user) in **one**
`rule_event` call (at most the 20 newest), with the push line as text (“Lena: Englisch lesson 3
(09:50) cancelled”); quiet hours hold them like the pushes. Each change is handed over once; errors
never stop a fetch, the page “School” shows the last result. Needs GateControl ≥ 1.178.0
(`gc.services.available`). The service `school_students` (caller `gatecontrol-familie` only) answers
`{ ok: true, students: [{ userId, name }] }`.

**API:** see [API](#api) above.
