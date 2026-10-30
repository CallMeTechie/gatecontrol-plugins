# Mail (gatecontrol-mail)

Alle E-Mail-Konten an einem Ort – im eigenen Tab der GateControl-Apps und im Portal.

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
