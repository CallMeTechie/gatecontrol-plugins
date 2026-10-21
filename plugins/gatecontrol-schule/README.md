# Schule / School (`gatecontrol-schule`)

*English: see [below](#english). API for the GateControl apps: [API](#api).*

Der Stundenplan aus **WebUntis** in GateControl – für Schüler- und Elternkonten: Ausfälle,
Vertretungen und Zusatzstunden als Push-Mitteilung, Arbeiten und Hausaufgaben mit Erinnerung am
Vorabend, Nachrichten der Schule und Fehlzeiten (1.4.0), der Wochenplan je Kind in seiner Farbe (Seite „Schule“, Portal, Wand-Tablet, App), eine
Startkachel und ein Widget je Kind. Konten kommen per **QR-Code-Scan** in die Einstellungen; jede Person
kann ihr eigenes Schülerkonto in ihrem **GateControl-Profil** verknüpfen.

Braucht **GateControl ≥ 1.172.0**. Ab GateControl **1.188.0** stehen „Konten & Kinder“ direkt in den
Einstellungen des Plugins, die Kamera darf den QR-Code lesen und das Profil hat den Abschnitt
„WebUntis“; auf älteren Versionen ist „Konten & Kinder“ ein zweiter Reiter der Seite „Schule“, und statt
der Kamera geht ein Bild des QR-Codes oder die Eingabe von Hand. Lizenzpflichtiges Plugin.

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
* **Seite und Portal-Tab „Schule“** (1.3.0: nur noch die Informationen): oben je Kind eine Karte mit
  Bild bzw. Initialen in seiner Farbe, heute von–bis, Ausfällen und der nächsten Arbeit; darunter für
  das gewählte Kind die Wochenansicht Mo–Fr (Sa, wenn Unterricht ist), diese und nächste Woche (auf dem
  Handy Tag für Tag), und die Listen **Änderungen**, **Klassenarbeiten** und **Hausaufgaben**. Ohne
  Konto ein klarer Hinweis mit „Einstellungen öffnen“. Ausfälle rot durchgestrichen, Vertretungen orange mit durchgestrichener
  ursprünglicher Lehrkraft bzw. ursprünglichem Raum, Zusatzstunden hervorgehoben, Info- und
  Vertretungstexte, Stundennummern aus dem Zeitraster der Schule, „Ferien“.
* **Startkachel „Schule · <Name>“** je Kind: „2 Ausfälle“, „1 Vertretung“, „Planmäßig“, „Frei“ oder
  „Ferien“, in der App mit bis zu 4 Einträgen für die Änderungen von heute und morgen.
* **Widget je Kind** (Schnellaktion `student:<id>`, nur Anzeige): großer Wert = Ausfälle heute,
  Statuszeile = die nächste Änderung oder „Planmäßig“, Messwert „Morgen“ = Ausfälle morgen.
  Regeln der Familie können das als Gerätebedingung nutzen: Aktion
  `gatecontrol-schule/student:<id>`, Feld `value` (heute) oder `reading:tomorrow` (morgen) – z. B.
  „wenn morgen etwas ausfällt, abends erinnern“. Antippen fragt einen baldigen Abruf an.
* **Änderungsprotokoll und Diagnose** in den Einstellungen („Konten & Kinder“ › Diagnose).
* **Farbe je Kind** (1.3.0): Geschwister sind überall an ihrer Farbe zu erkennen – siehe unten.
* **Regeln der Familie** (ab 1.1.0, mit dem Plugin „Familie“ ≥ 1.12.0): Auslöser **„Stunde fällt aus“** –
  z. B. „wenn bei Lena morgen eine Stunde ausfällt, Wecker später stellen“ (siehe unten).
* **Arbeiten und Hausaufgaben** (ab 1.2.0): im Wochenplan (Arbeit oben am Tag, fällige Hausaufgaben unter
  den Stunden), auf der Seite „Schule“, in der App-API und als **Erinnerung am Vorabend** (siehe unten).
  Gibt es morgen eine Arbeit, zeigt die Kachel „Morgen · Arbeit: Mathematik“ und das Widget den
  Messwert „Arbeit morgen“.
* **Früher Schluss → Abholen** (ab 1.2.0, mit „Familie“ ≥ 1.13.0): endet der Schultag heute oder morgen
  früher, fragt Familie bei einer eingetragenen Abholung nach (siehe unten).
* **Schule am Wand-Tablet der Familie** (ab 1.2.0, mit „Familie“ ≥ 1.13.0): „Schule heute“ (ab 15 Uhr
  „Schule morgen“) mit einer Zeile je Kind – „Lena 07:45–13:05 · 1 Ausfall“, „Max frei“, Ferien, Arbeiten.

### Regeln der Familie („Stunde fällt aus“)

Ist das Plugin **Familie** (≥ 1.12.0) installiert, bietet sein Regel-Editor den Auslöser „Stunde fällt
aus“ an (welches Kind oder jedes Kind, Ausfall / Vertretung / Zusatzstunde / findet doch statt, heute /
morgen / jeder Tag). Nach jedem Abruf meldet Schule die Änderungen, **die auch per Push gemeldet
werden** – nicht der erste Abruf, nur Stunden, die noch nicht vorbei sind, innerhalb von „Push für die
nächsten Tage“, nur Schüler mit zugeordnetem GateControl-Benutzer – in **einem** Aufruf an Familie
(höchstens die 20 neuesten), mit dem Text wie in der Mitteilung („Lena: Englisch 3. Std. (09:50) fällt
aus“, Sprache der Mitteilungen). In der **Ruhezeit** gehaltene Änderungen gehen mit den Mitteilungen an
ihrem Ende. Jede Änderung wird nur einmal gemeldet; ein Fehler (Familie nicht erreichbar, Limit von 60
Aufrufen pro Stunde) hält den Abruf nie auf – die Diagnose in den Einstellungen zeigt das letzte Ergebnis. Braucht
GateControl ≥ 1.178.0 (`gc.services.available`); auf einem älteren GateControl wird nichts gemeldet.

### Arbeiten und Hausaufgaben (1.2.0)

In jedem Abruf holt das Plugin – mit derselben Anmeldung – die **Hausaufgaben** (einmal je Konto, ab 14
Tage vor dem Stundenplan) und die **Arbeiten/Tests** (je Kind) aus WebUntis. Bei einem Elternkonto mit
mehreren Kindern gehört eine Arbeit dem Kind, dem sie WebUntis zuordnet (sonst seiner Klasse), eine
Hausaufgabe dem Kind, das WebUntis nennt (sonst nur Fächer aus dem Stundenplan des Kindes). Noten werden
nie gespeichert. Liefert die Schule das nicht (z. B. „keine Berechtigung“), läuft der Stundenplan wie
bisher. 1.3.0: Arbeiten werden zuerst so abgefragt wie in der Bibliothek *webuntis* (Klasse des Kindes,
ohne Schüler-ID, ohne Noten), dann mit Schüler-ID, dann für die eigene Klasse des Kontos – manche Schulen
verweigern Elternkonten die Abfrage mit Schüler-ID (HTTP 403). Eine Ablehnung dieser optionalen Daten ist
**kein Anmeldefehler**: Die Einstellungen sagen ruhig „Klassenarbeiten sind für dieses Konto in WebUntis
nicht freigegeben“, und das Plugin schaut **einmal am Tag** wieder nach (andere Fehler nach 6 Stunden).

**Erinnerung am Vorabend** (Einstellung „Erinnerung am Vorabend“, Vorgabe 18:00, leer = aus): ab dieser
Uhrzeit bis Mitternacht je Kind **eine** Mitteilung zu den Arbeiten von morgen – Thema **„Klassenarbeiten“**,
z. B. „Lena: morgen Mathematik-Arbeit (3. Std.)“ – und eine zu den morgen fälligen, noch nicht erledigten
Hausaufgaben – Thema **„Hausaufgaben“**, „Lena: 2 Hausaufgaben für morgen“ mit einer Zeile je Aufgabe.
Empfänger wie bei den Änderungen; nie in der Ruhezeit (liegt die Uhrzeit darin, kommt sie an deren Ende,
nur am selben Abend); je Kind, Tag und Thema nur einmal, auch nach einem Neustart. Beide Themen lassen
sich wie jedes Thema im Portal oder in der App abschalten.

### Nachrichten der Schule und Fehlzeiten (1.4.0)

Im selben Abruf und mit derselben Anmeldung liest das Plugin – **nur lesend**, nichts wird in WebUntis
als gelesen markiert oder geändert:

* die **Nachrichten** des Kontos (der WebUntis-Posteingang: beim Elternkonto die Post an die Eltern, beim
  Schülerkonto die an das Kind) – höchstens alle 15 Minuten je Konto. Dafür holt es mit der Sitzung ein
  Token (`api/token/new`) und fragt den Posteingang mit `Authorization: Bearer …`. Gespeichert werden
  Betreff, Absender, Zeit, die Vorschau und – nur wenn die Liste ihn mitliefert – der Text, jeweils als
  reiner Text (HTML entfernt); Anhänge werden nicht geladen. 90 Tage aufbewahrt.
* die **Fehlzeiten** je Kind aus dem Klassenbuch (`api/classreg/absences/students`) – höchstens stündlich
  je Kind, für das Schuljahr (ab 1. August) bis 14 Tage voraus: Datum (ggf. bis), Uhrzeit, Grund, Text und
  ob **entschuldigt**, **nicht entschuldigt** oder **offen**. Was WebUntis nicht mehr nennt, verschwindet.
  Aufbewahrt für das Schuljahr, mindestens 180 Tage.

Der **erste** gute Abruf je Konto (Nachrichten) bzw. Kind (Fehlzeiten) ist die Ausgangslage – keine
Mitteilungen. Danach:

* Thema **„Nachrichten der Schule“**: je neuer Nachricht ein Push „Schule: <Betreff>“ mit Absender und
  Vorschau, höchstens 3 je Konto und Abruf, weitere in einer Sammelmitteilung („Schule: 2 weitere
  Nachrichten“) – an die Empfänger der Kinder des Kontos, beim eigenen Schülerkonto an das Kind selbst.
* Thema **„Fehlzeiten“**: neue oder geänderte Fehlzeiten (eingetragen, entschuldigt, nicht entschuldigt,
  andere Zeit/Grund) – eine Mitteilung je Kind und Abruf an die Empfänger; an das Kind selbst nur mit der
  Einstellung **„Fehlzeiten auch dem Kind melden“** (Vorgabe aus).
* Beide halten die Ruhezeit ein (gesendet an ihrem Ende) und kommen nie doppelt, auch nach einem Neustart.

Auf der Seite „Schule“ und im Portal hat jedes Kind die Abschnitte **„Nachrichten“** (antippen öffnet den
Text) und **„Fehlzeiten“** (Datum, Uhrzeit, entschuldigt / nicht entschuldigt / offen, Grund); die
Startkachel nennt „1 neue Nachricht“. Gibt WebUntis das für ein Konto nicht frei (401/403) oder kennt es
das nicht (404), läuft alles andere weiter, und die Einstellungen sagen es je Konto in Worten
(„Nachrichten der Schule sind für dieses Konto in WebUntis nicht freigegeben. GateControl schaut einmal am
Tag wieder nach.“); sonst steht dort, wann zuletzt gelesen wurde und wie viele gespeichert sind.

### Nachrichten ohne WebUntis (1.5.0, GateControl ≥ 1.190.0)

Nachrichten der Schule werden komplett in GateControl gelesen – WebUntis braucht dafür niemand mehr:

* **Volltext und Anhänge.** Für jede Nachricht fragt das Plugin einmal die Einzelansicht
  (`api/rest/view/v1/messages/<id>`) – im selben Abruf, höchstens 10 je Abruf, neueste zuerst; klappt es
  nicht, nach 1, 2, 4 … Stunden noch einmal (5 Versuche). Gespeichert werden der ganze Text (reiner Text,
  HTML entfernt, ≤ 20 000 Zeichen) und die Liste der Anhänge. Die Einzelansicht kann die Nachricht in
  WebUntis als gelesen markieren.
* Die **Anhänge** neuer Nachrichten holt GateControl im Abruf in seinen Medienspeicher (`gc.media.fetch`:
  WebUntis nennt mit `…/<anhangId>/attachmentstorageurl` einen kurzlebigen Link zum Speicher (Amazon S3) und
  die nötigen Kopfzeilen; verschlüsselt abgelegt, ≤ 25 MB je Datei, höchstens 3 je Abruf), ältere beim
  ersten Öffnen. Lesen dürfen sie nur die, die den Posteingang lesen dürfen (Hook `mediaAccess`);
  sie verschwinden mit ihrer Nachricht nach 90 Tagen. Hochladen durch Personen gibt es nicht
  (`media.uploads: false`).
* **„Neu“ je Person.** Eine Nachricht ist für eine Person neu, bis sie sie öffnet (App, Seite „Schule“,
  Portal) – höchstens 14 Tage, nie für die Ausgangslage. Die Startkachel zählt nur ungelesene.
* **Lesebestätigung.** Bittet die Schule darum (die Nachricht steht in WebUntis' Liste
  `readConfirmationMessages`), zeigen App und Seiten „Die Schule bittet um eine Lesebestätigung“ und einen
  Knopf **„Lesen bestätigen“**. Erst nach einer Rückfrage geht die Bestätigung an die Schule (`POST
  …/<id>/read-confirmation`) – das ist der einzige Schreibzugriff auf WebUntis, nie automatisch. Danach steht
  dort, wann und von wem; in WebUntis selbst Bestätigtes erkennt das Plugin beim nächsten Abruf.

### Früher Schluss → Abholen (1.2.0, mit Familie ≥ 1.13.0)

Das Plugin kennt je Kind und Schultag das **geplante Ende** (Ende der letzten Stunde laut Plan, auch wenn
sie ausfällt) und das **tatsächliche Ende** (letzte Stunde, die stattfindet). Rückt das Ende von heute oder
morgen durch eine Änderung **nach vorne** (nicht beim ersten Abruf), meldet es das Familie (Dienst
`school_day_end`): „Lena hat am Di 21.10. schon um 11:30 Schluss (statt 13:05)“. Familie sucht eine
Abholung (Modul „Abholen & Fahrten“) des Kindes um das geplante Ende (± 60 Minuten) und benachrichtigt
Fahrer und Eltern mit den Knöpfen „Auf 11:30 verschieben“ und „Wer kann?“ – ohne Abholung nur die Eltern
(abschaltbar in Familie). Je Kind, Tag und neuem Ende nur einmal, nur Kinder mit zugeordnetem
GateControl-Benutzer, in der Ruhezeit gehalten; findet die Stunde doch statt oder ist das geplante Ende
vorbei, entfällt die Meldung.

### Einrichtung

Alles Einrichten steht in den **Einstellungen**: Einstellungen › Plugins › Schule › Einstellungen
(GateControl ≥ 1.188.0; davor der Reiter „Konten & Kinder“ der Seite „Schule“). Die Seite „Schule“ zeigt
nur noch die Informationen.

1. **Den QR-Code finden:** WebUntis im Browser öffnen, mit dem Konto des Kindes oder dem Elternkonto
   anmelden, meist unten links auf das **Profil** (Name) › Reiter **„Freigaben“** › bei **„Zugriff über
   Untis Mobile“** auf **„Anzeigen“** (je nach Schule und Version kann das etwas anders heißen). WebUntis
   zeigt einen QR-Code – darin steht ein Link `untis://setschool?url=…&school=…&user=…&key=…`.
2. **„WebUntis-Konto hinzufügen“** und eine der drei Arten wählen:
   * **„QR-Code scannen“** – die Kamera dieses Geräts liest den QR-Code direkt vom Bildschirm (der
     Browser fragt einmal nach der Kamera; braucht GateControl ≥ 1.188.0 und HTTPS);
   * **„QR-Bild hochladen“** – ein Screenshot oder Foto des QR-Codes; gelesen wird im Browser, das Bild
     verlässt ihn nicht;
   * **„Manuell eingeben“** – Server (z. B. `xyz.webuntis.com`), Schule, Benutzer und den **Schlüssel**
     unter dem QR-Code oder das **Passwort** des Kontos.
   Klein darunter geht auch „den untis://-Link einfügen“. Das Plugin meldet sich einmal an und zeigt die
   gefundenen Schüler: ein **Schülerkonto** ist der Schüler selbst, ein **Elternkonto** liefert seine
   Kinder. Den Zugang kann man in WebUntis jederzeit wieder entziehen.
3. Jedes Konto ist eine Karte mit Status, letztem und nächstem Abruf, einem Fehler in Worten und den
   Knöpfen „Jetzt abrufen“, „Zugang ändern“ (z. B. nach einem neuen QR-Code) und „Entfernen“.
4. Unter **„Kinder“** je Kind **„Bearbeiten“**: Anzeigename (z. B. „Lena“), **GateControl-Benutzer des
   Kindes** (optional, mit Bild), **Farbe**, **weitere Empfänger** (z. B. die Eltern), **„Am Wand-Tablet
   zeigen“** und an/aus (aus = kein Abruf, nirgends sichtbar).
5. Darunter das Formular von GateControl: **Abruf** (Zeitzone der Schule, Abrufintervall, Vorgabe 15
   min), **Benachrichtigungen und Ruhezeit** (Sprache, Push für die nächsten Tage, Ruhezeit, Erinnerung am
   Vorabend) und **Verknüpfen im Profil** („Benutzer dürfen ihr WebUntis-Konto selbst verknüpfen“,
   Vorgabe an). Statuszeilen oben fassen zusammen („1 WebUntis-Konto verbunden · 2 Kinder“) und nennen
   Konten mit Problemen.

### Farben und Verknüpfen im Profil (1.3.0)

* **Farbe je Kind:** Ist ein Kind einem GateControl-Benutzer zugeordnet, zeigt Schule dessen
  **Lieblingsfarbe** und **Profilbild** (sonst die Initialen auf der Farbe). Sonst bekommt jedes Kind
  automatisch eine eigene Farbe aus der GateControl-Palette (die erste, die noch kein anderes Kind hat);
  in den Einstellungen lässt sie sich ändern. Die Farbe steht auf der Seite „Schule“, im Portal, in der
  Diagnose, am Wand-Tablet der Familie (ab Familie 1.13.1) und in der App-API (`color`, `avatarUrl`).
* **„WebUntis verknüpfen“ im eigenen Profil** (GateControl ≥ 1.188.0): Im Portal unter **„Meine
  Geräte“** steht unter Profilbild und Lieblingsfarbe der Abschnitt **„WebUntis“**. Dort verknüpft z. B.
  Noah sein **eigenes Schülerkonto** – QR-Code scannen, Bild hochladen oder eingeben. Das Konto wird ihm
  zugeordnet: sein Stundenplan im Portal und in der App, Push an ihn, seine Farbe und sein Bild. Regeln:
  nur angemeldet (kein Wand-Tablet, kein reines Geräte-Vertrauen), nur für sich selbst, nur
  **Schülerkonten** (Elternkonten richtet ein Administrator ein), ein schon eingerichtetes Konto wird
  nicht übernommen, höchstens 5 Versuche in 15 Minuten. Kennt Schule das Kind schon über das Elternkonto,
  entsteht kein zweites Konto – das vorhandene Kind wird ihm zugeordnet. „Verknüpfung lösen“ löscht ein
  selbst verbundenes Konto mit allem; eine Zuordnung des Administrators kann nur dieser ändern. Der
  Schalter „Benutzer dürfen ihr WebUntis-Konto selbst verknüpfen“ (Vorgabe an) stellt das ab;
  Administratoren dürfen immer.

Der **erste Abruf** eines Schülers legt nur den Stand fest – es kommt keine Mitteilung über das, was
schon vorher ausfiel. Wer wann welche Mitteilung bekommt, steuert GateControl zusätzlich über
System › Benachrichtigungen; jede Person kann das Thema im Portal oder in der App abschalten.

### Wer sieht was

* **Admins** sehen alle Schüler (Push nur, wenn sie als Empfänger eingetragen sind).
* Das **zugeordnete Kind** und die **Empfänger** sehen „ihre“ Schüler – im Portal, in der Kachel,
  im Widget und über die App-API. Wer sein Schülerkonto im Profil verknüpft, ist das zugeordnete Kind.
* **Kiosk-Geräte** (Wand-Tablet) sehen genau die Schüler mit „Am Wand-Tablet zeigen“.
* Andere Personen sehen nichts; ein Portal-Besucher, der nur per Geräte-Vertrauen erkannt ist
  (ohne Anmeldung), auch nicht – ein Stundenplan verrät, wo ein Kind ist.
* **Nachrichten** (1.4.0) eines Kontos lesen Admins, die Empfänger der Kinder des Kontos und – beim eigenen
  Schülerkonto – das Kind selbst. Ein Kind liest die Post an seine Eltern **nicht**, auch wenn es dem
  Kind im Elternkonto zugeordnet ist.
* **Fehlzeiten** (1.4.0) sehen Admins, die Empfänger des Kindes und das Kind selbst. Kiosk-Geräte sehen
  weder Nachrichten noch Fehlzeiten.

### Abruf

Im Hintergrund je Konto Mo–Sa 05:30–20:00 alle 15 Minuten (einstellbar 5–120), sonst stündlich.
Pro Konto und Durchlauf genau **eine Anmeldung**, danach **Abmeldung**. Abgerufen wird Montag dieser
bis Sonntag nächster Woche (immer mindestens heute + 7 Tage), Zeitraster und Ferien einmal täglich.
Bei Fehlern wird seltener versucht: Netz/unerwartete Antwort nach 5, 10, 20 … bis 120 Minuten,
abgelehnte Anmeldung oder fehlende Berechtigung nach 1, 2, 4 … bis 24 Stunden (wiederholte
Fehlanmeldungen könnten das WebUntis-Konto sperren). Die Einstellungen zeigen je Konto den letzten
erfolgreichen Abruf, den letzten Fehler in Worten (nie als Code) und den nächsten Abruf, je Kind den
letzten Abruf und Fehler.

### Datenschutz

* Alle Daten bleiben auf deinem GateControl-Server. Das Plugin kontaktiert **nur den WebUntis-Server
  der Schule** (`*.webuntis.com`, Port 443) – keinen anderen Dienst.
* Schlüssel bzw. Passwort werden als **Plugin-Geheimnis verschlüsselt** gespeichert
  (`gc.settings.setSecret('acct.<id>.secret' | 'acct.<id>.password')`: mit dem Server-Schlüssel
  verschlüsselt wie eine `secret`-Einstellung, von Backups mit umgeschlüsselt). Sie stehen nie in
  der Datenbank, nie im Protokoll und werden nie an den Browser geschickt. Auch Einmal-Codes und
  Sitzungs-IDs werden nie protokolliert.
* Gespeichert werden der Stundenplan (14 Tage zurück bis Ende nächster Woche), die Hausaufgaben und
  Arbeiten (bis 14 Tage nach ihrem Datum, ohne Noten), das Änderungsprotokoll (30 Tage), die Nachrichten
  der Schule (90 Tage, ohne Anhänge) und die Fehlzeiten (Schuljahr, mindestens 180 Tage). Das Token für
  den Posteingang lebt nur während eines Abrufs im Speicher. „Entfernen“ löscht Zugang, Schüler, Stundenplan und Protokoll des
  Kontos.

## API

Für die GateControl-Apps (`permissions.app`, ohne eigenen App-Tab):
`/api/v1/client/plugins/gatecontrol-schule/api/<pfad>` mit dem Geräte-Token. Alle Routen antworten
nur mit dem, was die Person sehen darf (wie im Portal, siehe „Wer sieht was“), und nur Aufrufen aus der
App (`403 FORBIDDEN` sonst). Zeiten sind Ortszeit der Schule (Einstellung Zeitzone); `sentAt` ist UTC.

```
GET app/timetable?from=YYYY-MM-DD&to=YYYY-MM-DD      höchstens 14 Tage, Vorgabe heute … heute + 6
  200 { ok: true, updatedAt: <ms | null>,               letzter Abruf der Schüler
        students: [{ id, name, userId, klasse,
          color: '#RRGGBB',                             1.3.0: Farbe des Kindes (die Lieblingsfarbe des
                                                        zugeordneten Benutzers, sonst die eigene)
          avatarUrl?: '/avatars/….webp',                1.3.0: Profilbild des zugeordneten Benutzers
                                                        (fehlt ohne Bild; relativ zum GateControl-Server)
          days: [{ date, holiday?: 'Brückentag',        jeder Tag des Zeitraums, auch ohne Unterricht
            lessons: [{ start: 'HH:MM', end: 'HH:MM', period?: 3, periodEnd?: 4,
                        subject: 'M', subjectLong: 'Mathematik', subjectOld?: 'D',
                        teacher: 'SCH', teacherOld?: 'MUE', room: '104', roomOld?: '201',
                        state: 'normal' | 'cancelled' | 'changed' | 'extra',
                        info?: '…', substText?: '…', text?: '…' }],
            homework?: [{ subject: 'M', subjectLong?: 'Mathematik',   1.2.0: an diesem Tag fällig
                          text: 'S. 42 Nr. 3', givenDate?: 'YYYY-MM-DD',
                          completed?: true }],                   fehlt = nicht erledigt
            exams?: [{ subject: 'M', subjectLong?: 'Mathematik',      1.2.0: Arbeiten/Tests des Tages
                       name: 'Klassenarbeit 2', start?: 'HH:MM', end?: 'HH:MM',
                       type?: 'Klassenarbeit', text?: 'Bruchrechnung' }] }] }] }
  400 { ok: false, code: 'INVALID' }                    Datum ungültig, to < from, mehr als 14 Tage

GET app/changes?days=7                                  1 … 30 Tage, Vorgabe 7
  200 { ok: true, changes: [{ id, studentId, student, date, start, end, period?,
          kind: 'cancelled' | 'changed' | 'extra' | 'restored', subject, subjectLong?, subjectOld?,
          teacher?, teacherOld?, room?, roomOld?, substText?, info?,
          detectedAt: <ms>, pushed: <boolean> }] }      neueste zuerst, höchstens 200

GET app/messages?days=30                                1.4.0: 1 … 90 Tage, Vorgabe 30
  200 { ok: true, messages: [{
          id: '<kontoId>-<webuntisId>',                 Zeichenkette
          accountId: 3,                                 das WebUntis-Konto (Posteingang)
          studentIds: [12],                             die Kinder dieses Kontos, die die Person sieht
                                                        (sieht sie keines: alle Kinder des Kontos)
          subject: 'Elternabend', preview: 'Am Donnerstag …',   reiner Text (HTML entfernt)
          body?: '…',                                   reiner Text – nur, wenn WebUntis ihn in der Liste
                                                        liefert (fehlt sonst: dann nur die Vorschau)
          sender: 'Frau Schmidt',
          sentAt: '2026-10-20T06:10:00.000Z',           ISO (UTC); ohne Zeit von WebUntis: wann gefunden
          hasAttachments: <boolean>,
          isNew: <boolean>,                             1.5.0: von dieser Person noch nicht geöffnet, in den
                                                        letzten 14 Tagen gefunden, nicht Ausgangslage
          fullText: <boolean>,                          1.5.0: body ist der ganze Text
          attachments: [{ id, name, size, mime }],      1.5.0: size/mime null, wenn unbekannt
          read: <boolean>,                              1.5.0: diese Person hat sie geöffnet
          confirmation: null | { confirmedAt: ISO | null, by: 'Eva' | null } }] }
                                                        1.5.0: Lesebestätigung erbeten (gesendet wann/von wem)
                                                        neueste zuerst, höchstens 100
POST app/messages/<id>/read                             1.5.0: geöffnet → { ok, message }
POST app/messages/<id>/confirm                          1.5.0: Lesebestätigung an die Schule → { ok, message }
  409 SCHULE_CONFIRM_NOT_REQUIRED · 502 SCHULE_CONFIRM_FAILED · 503 SCHULE_UNTIS_UNAVAILABLE
POST app/messages/<id>/attachments/<anhangId>           1.5.0: → { ok, file: { mediaId, name, mime, bytes } };
                                                        die Datei: GET /api/v1/client/plugins/gatecontrol-schule/media/<mediaId>
  404 SCHULE_ATTACHMENT_NOT_FOUND · 413 SCHULE_ATTACHMENT_TOO_LARGE (> 25 MB) · 415 SCHULE_ATTACHMENT_TYPE
  502 SCHULE_ATTACHMENT_FAILED · 503 SCHULE_UNTIS_UNAVAILABLE · 404 SCHULE_MESSAGE_NOT_FOUND (alle drei)
GET app/absences?days=60                                1.4.0: 1 … 180 Tage, Vorgabe 60
  200 { ok: true, absences: [{
          id: '<schülerId>-<webuntisId>', studentId: 12,
          date: 'YYYY-MM-DD', start: 'HH:MM' | null, end: 'HH:MM' | null,   null = ohne Uhrzeit (ganztägig)
          endDate?: 'YYYY-MM-DD',                       nur, wenn sie an einem anderen Tag endet
          reason?: 'Krankheit',
          excused: true | false | null,                 entschuldigt / nicht entschuldigt / offen
          text?: '…' }] }                               beginnt (oder endet) in den letzten `days` Tagen
                                                        oder später; neueste zuerst, höchstens 200
  400 { ok: false, code: 'INVALID' }                    days ungültig
```

`state`: `cancelled` = fällt aus (auch eine Stunde, die an einem Schultag aus WebUntis verschwand),
`changed` = Vertretung/Änderung (WebUntis `irregular`, eine ursprüngliche Lehrkraft/Raum/Fach oder ein
Vertretungstext), `extra` = nach dem ersten Abruf hinzugekommen. `period` / `periodEnd` aus dem
Zeitraster (Doppelstunde 3.–4.). Die Felder mit `?` fehlen, wenn sie leer sind – auch `homework` und
`exams` (1.2.0) fehlen an Tagen ohne Hausaufgaben bzw. Arbeiten; alle anderen Felder sind gegenüber 1.1.0
unverändert. `subject` von Hausaufgaben und Arbeiten ist das Kürzel aus dem Stundenplan, wenn WebUntis das
Fach dort kennt (sonst der Name, den die Hausaufgaben-/Prüfungsliste nennt); `subjectLong` nur, wenn es
sich unterscheidet. `givenDate` = an dem Tag aufgegeben. Noten liefert die API nie. `color` und
`avatarUrl` (1.3.0) kamen hinzu, sonst ist alles wie in 1.2.0. 1.4.0: `app/messages` und `app/absences`
sind neu; die Mitteilungen tragen `data.schule` = `{ messageId, studentId? }` (Nachricht; `studentId` nur,
wenn das Konto genau ein Kind hat) bzw. `{ studentId, date }` (Fehlzeit). `portal/overview` und `overview`
haben je Kind zusätzlich `messages` und `absences` – nur, wenn die Person sie sehen darf (sonst fehlen sie).
1.5.0: dieselben drei Aktionen gibt es als `portal/messages/<id>/…` und `messages/<id>/…` (Seite „Schule“);
dort tragen geladene Anhänge zusätzlich `url` (ein `/plugin-media/`-Link, 1 Stunde gültig).

### Dienste zwischen Plugins (1.1.0)

`services.provides` – nur für den Aufrufer `gatecontrol-familie` (jeder andere: `{ ok: false, code: 'forbidden' }`):

```
school_students   {} → { ok: true, students: [{ userId, name }] }
                  die eingeschalteten Schüler mit zugeordnetem GateControl-Benutzer (Anzeigename)
school_day        { date: 'YYYY-MM-DD' }                       1.2.0, Wand-Tablet der Familie
                  → { ok: true, date, students: [{ userId, name, color: '#RRGGBB', avatarUrl?,   (1.3.0)
                        start?: 'HH:MM', end?: 'HH:MM',
                        cancelled: n, changed: n, holiday?: 'Herbstferien',
                        exams: [{ subject, name }], free: boolean }] }
                  nur Schüler mit „Am Wand-Tablet zeigen“ und zugeordnetem Benutzer, deren letzter Abruf
                  den Tag umfasst; start / end = erste / letzte Stunde, die stattfindet; free = keine.
                  date: gestern … heute + 13, sonst { ok: false, code: 'invalid' }
```

`permissions.services: ["gatecontrol-familie:rule_event", "gatecontrol-familie:school_day_end"]` – nach jedem
Abruf, nur wenn `gc.services.available('gatecontrol-familie', …)`:

```
rule_event        { type: 'school_change',
                    events: [{ userId, kind: 'cancelled' | 'changed' | 'extra' | 'restored',
                               date: 'YYYY-MM-DD', start: 'HH:MM', subject, text }] }   1 … 20
                  → { ok: true, fired }   (Familie führt die passenden Regeln aus)
school_day_end    { events: [{ userId, date: 'YYYY-MM-DD', plannedEnd: 'HH:MM', newEnd: 'HH:MM',
                               text: 'Lena hat am Di 21.10. schon um 11:30 Schluss (statt 13:05)' }] }   1 … 20
                  → { ok: true, notified, matched }   (1.2.0, Familie fragt bei der Abholung nach)
```

Alle Aufrufe zählen zum Limit von 60 Aufrufen pro Stunde und Plugin; Schule ruft höchstens einmal je
Abruf-Durchlauf und Dienst auf, und nur, wenn es etwas zu melden gibt.

## English

The timetable of **WebUntis** student and parent accounts in GateControl: cancellations,
substitutions and extra lessons as push notifications, a week view in the portal (also on wall
tablets), a Start tile and a widget per child, every child in its own colour. Needs **GateControl ≥
1.172.0**; from **1.188.0** “Accounts & children” sit right in the plugin's settings, the camera may read
the QR code and the portal profile has the section “WebUntis” (older hosts: a second tab of the page
“School”, upload a picture of the QR code or type it in instead of the camera).

**Unofficial interface, no warranty:** WebUntis has no public API for this. The plugin uses the
interface of the WebUntis web app as documented by the MIT-licensed `webuntis` npm project; it may
change or stop working at any time. Not affiliated with Untis GmbH.

**Setup (1.3.0):** everything is set up in the **settings** (Settings › Plugins › School › Settings); the
page “School” only shows the information (per child a card in its colour, the week, changes, exams,
homework; without an account a pointer to the settings). In WebUntis (browser) the QR code is usually
under the profile › “Sharing” › “Access via Untis Mobile” › “Display” (names vary by school). “Add WebUntis
account” offers **“Scan QR code”** (this device's camera), **“Upload QR picture”** (a screenshot or photo,
decoded in the browser) and **“Enter manually”** (server, school, user and key or password); pasting the
`untis://` link is a small fallback. The plugin signs in once (a TOTP from the key, no password) and lists
the students – the student itself, or a parent's children. Each account is a card (status, last/next
fetch, a readable error, fetch now, renew access, remove); per child set a display name, the child's
GateControl user, a **colour**, further recipients, “Show on the wall tablet” and on/off. Below, GateControl's
form: fetching, notifications and quiet hours, and “Users may link their own WebUntis account”.

**Colours and linking in the profile (1.3.0):** a child mapped to a GateControl user shows that user's
favourite colour and profile picture; others get a distinct palette colour automatically (changeable).
Used on the School page, in the portal, the diagnostics, Familie's wall tablet (Familie ≥ 1.13.1) and the
app API (`color`, `avatarUrl`). In the portal under **“My devices”** (GateControl ≥ 1.188.0) a person links
their **own student account** (scan, upload or type) – only signed in, only for themselves, student
accounts only, an account already set up is not taken over, at most 5 tries in 15 minutes; a child already
known through the parents' account is mapped instead of adding a second account. “Unlink” removes an
account they connected; an administrator's mapping only the administrator changes.

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
never stop a fetch, the diagnostics in the settings show the last result. Needs GateControl ≥ 1.178.0
(`gc.services.available`). The service `school_students` (caller `gatecontrol-familie` only) answers
`{ ok: true, students: [{ userId, name }] }`.

**Exams and homework (1.2.0):** each cycle also fetches the homework (once per account, from 14 days
before the timetable) and the exams (per student) from WebUntis' web interface with the same session —
optional: errors never stop the timetable. 1.3.0: exams are asked like the *webuntis* library (the
child's class, no student id, no grades), then with the student id, then for the account's own class – some
schools refuse parent accounts the student-id request (HTTP 403). Such a refusal is not a login error: the
settings calmly say “Exams are not shared with this account in WebUntis” and the plugin checks again once a
day (other errors after 6 hours). Shown in the week view (exam badge, homework due that day), on the page
“School”, in `app/timetable` (`homework` / `exams` per day, only when there are any) and as an **evening
reminder** (setting “Reminder the evening before”, default 18:00, empty = off): per child one notification
about tomorrow's exams (topic **“Exams”**, “Lena: Mathematik exam tomorrow (lesson 3)”) and one about
homework due tomorrow that is not done (topic **“Homework”**), to the change recipients, never during quiet
hours, once per child, day and topic. The tile shows “Tomorrow · exam: Mathematik”, the widget the reading
`exam`. Grades are never stored.

**Early end → pick-up (1.2.0, Familie ≥ 1.13.0):** when a change moves today's or tomorrow's end of school
earlier (not on the baseline; planned end = the plan's last lesson, cancelled or not), the plugin calls
Familie's `school_day_end` once per child, date and new end (held during quiet hours, dropped when no longer
true); Familie looks for a pick-up around the planned end and asks the driver and the parents. The service
`school_day` (caller `gatecontrol-familie` only) feeds Familie's wall tablet („Schule heute“).

**School messages and absences (1.4.0):** each cycle also reads – **read only**, nothing is ever marked as
read or changed in WebUntis – the account's **inbox** (at most every 15 minutes per account: a token from
`api/token/new`, then the inbox with `Authorization: Bearer …`; subject, sender, time, the preview and –
only when the list carries it – the text, all as plain text with HTML stripped; no attachments; kept 90 days)
and each child's **absences** from the class register (at most hourly, the school year from 1 August up to
14 days ahead: date, time, reason, text and excused / not excused / open; kept for the school year, at least
180 days). The first good fetch is the baseline. Then topic **“School messages”**: one push per new message
(“School: <subject>”, sender and preview), at most 3 per account and cycle plus one summary, to the
recipients of the account's children (on a child's own student account: the child); topic **“Absences”**:
new or changed absences, one push per child and cycle to the recipients – to the child itself only with the
setting **“Tell the child about absences too”** (default off). Quiet hours hold both; never twice. **Who:**
messages – admins, the recipients of the account's children and, on the child's own student account, the
child; a child never reads its parents' inbox. Absences – admins, the child's recipients and the child.
Kiosk devices neither. The page “School” and the portal show per child “Messages” (tap to read) and
“Absences” (excused / not excused / open badge); the Start tile says “1 new message”. When WebUntis does not
share it (401/403) or lacks it (404), everything else goes on and the settings say so per account in words
(otherwise when it was last read and how many are stored). API: `app/messages?days=30` (1…90, ≤ 100) and
`app/absences?days=60` (1…180, ≤ 200), see [API](#api).

**Messages without WebUntis (1.5.0, GateControl ≥ 1.190.0):** the full text and the attachments of every
message (WebUntis' detail call, once per message); the attachments of new messages are fetched in the cycle
into GateControl's encrypted media store (`gc.media.fetch`, ≤ 25 MB each), older ones on first open — only
people who may read the inbox may read them. "New" is per person (until opened, at most 14 days). A read
confirmation the school asks for is sent only when a person taps "Confirm reading" (and confirms the
question) — the only write to WebUntis. API: `fullText`, `attachments`, `read`, `confirmation` and `POST
app/messages/<id>/read | confirm | attachments/<attId>` (see [API](#api)).

**API:** see [API](#api) above.
