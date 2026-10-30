# Mail (gatecontrol-mail)

Alle E-Mail-Konten an einem Ort – im eigenen Tab der GateControl-Apps und im Portal.

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
