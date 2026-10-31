# Mail (gatecontrol-mail)

Alle E-Mail-Konten an einem Ort – im eigenen Tab der GateControl-Apps und im Portal.

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
