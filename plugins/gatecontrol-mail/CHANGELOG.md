# Mail (gatecontrol-mail)

Alle E-Mail-Konten an einem Ort – im eigenen Tab der GateControl-Apps und im Portal.

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
