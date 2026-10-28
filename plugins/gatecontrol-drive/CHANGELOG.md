# Drive (gatecontrol-drive)

Dateien der Familie und des Teams auf dem eigenen Speicher – auf diesem Server, einer NAS oder in S3.

## 1.11.0
- **Tresore nur im Menü (wie bei OneDrive):** Tresor-Ordner liegen immer im Wurzelordner ihres Bereichs und erscheinen
  nicht mehr unter den Dateien. Neues Feature `vaultsApart` in `GET me`.
  - `GET nodes/<id>/children` lässt Tresor-Ordner weg (`total` passt dazu); `vaults=1` listet sie wie bisher, innerhalb
    eines Tresors ist alles wie bisher. Neu `dirs=1`: nur Ordner (ohne Tresore), nach Name, jeder mit `hasDirs` – für
    den Ordnerbaum im Menü.
  - `POST vaults`: `parentId` bestimmt nur den Bereich, der Tresor kommt in dessen Wurzelordner (ältere Apps
    funktionieren weiter). Tresor-Ordner lassen sich nicht mehr verschieben (`400 invalid { field: 'parentId' }`),
    umbenennen und löschen wie bisher; Wiederherstellen aus dem Papierkorb und Zeitreise lassen sie oben.
  - Tresor-Ordner älterer Versionen in Unterordnern ziehen beim Start und im Hintergrund (idempotent) in den
    Wurzelordner ihres Bereichs – mit Verlauf, Änderungsprotokoll (`move`) und Live-Ereignis; die Pfade der Dateien
    folgen. Die Verschlüsselung hängt nicht am Elternordner, Namen und Inhalte bleiben lesbar.
- Portal: **Menü mit Ordnerbaum** (Persönlich / Gemeinsam, aufklappbar, der offene Ordner hervorgehoben), **Tresore**
  nur dort, unten eine Icon-Leiste (Papierkorb, Speicher, Geräte, Geteilte Links, Fristen, Importieren, Vorfälle,
  Einstellungen). „Neu“ mit Neuer Ordner, Hochladen, Ordner hochladen und **Neuer Tresor** („Wer darf ihn öffnen?“:
  Nur ich, Familie, Team-Ordner). **Tresor-Sperre:** öffnen mit „Entsperren“, sperrt nach 1 / 3 / 5 / 15 Minuten ohne
  Nutzung, beim Verlassen und immer beim Schließen des Tabs (Schlüssel und Namen vergessen). **Drive-Einstellungen**
  als eigene Seite (Sicherung, Tresore, KI für Dokumente pro Bereich – aus den Ordner-Werkzeugen hierher –, Ansicht,
  Benachrichtigungen). Gerätebestätigung per WebAuthn gibt es im Portal nicht (der Rahmen hat einen opaken Ursprung).
- Keine neue Berechtigung, keine Datenbank-Migration, weiterhin GateControl ≥ 1.208.0.

## 1.10.0
- **Fotos sind Dateien (wie bei OneDrive):** Bilder und Videos liegen in ihren Ordnern und erscheinen auch in der
  Dateiansicht; „Fotos“ ist nur eine Ansicht über alle Bilder und Videos. Neues Feature `photosFolder` in `GET me`.
  - `GET photos`, `photos/months` und `photos/memories` nehmen `folder=<Knoten-ID>`: nur dieser Ordner und alle
    Ordner darunter (Leserecht nötig, sonst `404`; Tresor `409 encrypted`; Datei, ungültige ID oder Ordner außerhalb
    von `area` `400 invalid { field: 'folder' }`).
  - `camera=1`: dasselbe für die **Kamera-Uploads**, den festen, sprachunabhängigen Ordner `Bilder/Kamera-Uploads` in
    „Meine Dateien“ (die Foto-Sicherung der Apps legt darunter `<Jahr>/<Monat>` ab). Gibt es ihn nicht, sind die
    Antworten leer. `folder` und `camera` zusammen: `400 invalid { field: 'camera' }`; `camera` mit einem anderen
    Bereich als „Meine Dateien“: `400 invalid { field: 'area' }`. `photos/memories` nimmt jetzt auch `area`.
  - Neu: `GET photos/camera` → `{ folder: { id, path, areaId } | null }` und `POST photos/camera` → `{ folder, created }`
    (legt fehlende Ordner an wie `POST nodes`, mit Rechteprüfung, Änderungsprotokoll und Live-Ereignis; eine Datei im
    Weg: `409 exists`).
  - Tresor-Inhalte erscheinen nie, auch nicht über `folder` oder `camera`.
- Portal: Schalter „Nur Kamera-Uploads“ auf der Seite „Fotos“ (nur mit `photosFolder`; gemerkt, solange der Tab offen
  ist). Bilder und Videos bleiben in der Dateiansicht sichtbar.
- Keine neue Berechtigung, keine Migration, weiterhin GateControl ≥ 1.208.0.

## 1.9.0
- **Tresor-Ordner (Ende-zu-Ende verschlüsselt):** Inhalte und Namen verschlüsseln die Geräte, der Server bekommt nur
  Chiffretext, Größen, Zeitpunkte, öffentliche Schlüssel und verpackte Schlüssel. Neue Tabellen `vaults`,
  `vault_devices`, `vault_wraps` und die Spalten `vault_id`, `name_cipher`, `key_version` an `nodes` (Migration 009).
  - API: `POST|GET vaults`, `GET vaults/<id>`, `GET vaults/<id>/keys?deviceId=` (nur eigene Geräte),
    `GET|PUT vaults/<id>/recovery`, `GET|POST vaults/<id>/devices` (Freigabe-Anfrage, Push-Thema `vault`),
    `POST vaults/<id>/devices/<deviceId>/approve`, `DELETE vaults/<id>/devices/<deviceId>`, `POST vaults/<id>/rotate`.
  - Knoten im Tresor: `encrypted`, `vaultId`, `nameCipher`, `keyVersion`; der Klarname ist opak (32 Hexzeichen, auch
    auf der NAS). `POST nodes`, `uploads/commit` und `PATCH nodes/<id>` nehmen `encrypted`, `nameCipher`,
    `keyVersion`; ein veralteter Schlüssel ergibt `409 stale_key`.
  - Kryptografie: X25519-Geräteschlüssel, Tresor-Schlüssel per HPKE (RFC 9180, DHKEM(X25519), HKDF-SHA256,
    AES-256-GCM) je Gerät verpackt, Namen und Inhalte mit AES-256-GCM (1-MiB-Blöcke, Header `GCDV`),
    Wiederherstellungsschlüssel im Format des Vault-Plugins (56 Zeichen Crockford-Base32 mit Prüfbytes); wer sich damit
    selbst freischaltet, weist ihn mit `recoveryAuth` nach (der Server kennt nur dessen SHA-256).
    Sicherheitszahl zum Vergleichen beim Freigeben. Genaue Beschreibung im README, feste Testvektoren in
    `test/vault-vectors.json`.
  - Wer den Bereich verliert, dessen Geräte werden widerrufen und der Tresor verlangt einen neuen Schlüssel
    (`needsRotation`). Neue Dateien bekommen ihn, ältere bleiben für die Übrigen lesbar.
  - Kein Tresor-Inhalt in Vorschau, Textsuche, Suche, öffentlichen Links (`409 encrypted`; ein Ordner-Link auf einen
    Ordner, in dem ein Tresor entsteht, endet mit `endedWhy: 'vault'`), Alben, Fotorahmen und Office.
  - Die KI für Dokumente (1.8.0) liest keine Tresor-Datei: Sie kommt nicht in die Warteschlange, `GET nodes/<id>/insight`
    liefert `status: 'off'`, `POST nodes/<id>/insight` und `…/insight/apply` antworten `409 encrypted`. Fristen gibt
    es dort keine, sie erscheinen nicht in `GET deadlines` und nehmen keine Erinnerung (`409 encrypted`).
  - Der Import (1.8.0) schreibt nie in einen Tresor: Ein Ziel im Tresor ergibt `409 encrypted`, ein laufender Job mit
    einem solchen Ziel endet mit `failed` / `encrypted`. Der Erpressungsschutz filtert dort nicht nach Entropie. Papierkorb, Versionen und Zeitreise (auch der
    verschlüsselte Name) funktionieren weiter.
  - Portal (braucht GateControl ≥ 1.211.0 für `GC.keys` und `GC.mediaBytes`): „Tresor-Ordner“ anlegen
    (Wiederherstellungsschlüssel einmal anzeigen, kopieren oder als Textdatei speichern), öffnen, Dateien
    verschlüsselt hochladen und entschlüsselt herunterladen, umbenennen, Freigabe anfragen, mit dem
    Wiederherstellungsschlüssel öffnen, andere Geräte freigeben, den Schlüssel erneuern. Der Geräteschlüssel ist nicht
    exportierbar.
- **Office im Browser (WOPI-Host für Collabora Online und OnlyOffice):** neue Einstellung `office_url`, neues
  Zugriffsziel „Office-Server“ für die Discovery. „Im Browser bearbeiten“ im Portal (`POST nodes/<id>/office`,
  neuer Tab über `GC.openTab`).
  - CheckFileInfo, GetFile, PutFile (neue Version), Lock, Unlock, RefreshLock, GetLock (Tabelle `office_locks`).
  - Prüfung der Proof Keys, wenn die Discovery welche liefert.
  - Das `access_token` gilt 4 Stunden für eine Datei, eine Person und ein Recht; bei jedem Aufruf werden die Rechte
    erneut geprüft.
  - Braucht GateControl ≥ 1.211.0 (`permissions.publicEndpoints`). `me.features` enthält `office` nur, wenn alles
    eingerichtet ist.
- **Neue Berechtigungen – der Admin muss beim Update zustimmen:**
  - `permissions.publicEndpoints`: Der Office-Server erreicht die WOPI-Endpunkte ohne Portal-Sitzung, nur mit einem
    kurzlebigen Token pro Datei und Person; Bodies bis 512 MB werden als Medien gespeichert.
  - Das Heimnetz-Zugriffsziel `office`: Darüber wird die Discovery gelesen. Der Admin weist es nach dem Update unter
    Plugins › Drive › Zugriffsziele zu.
  GateControl zeigt beide Berechtigungen beim Update an. Ohne Zuweisung des Zugriffsziels und ohne `office_url` fehlt
  nur das Feature `office`, alles andere läuft.
- `me.features`: `vault`, `office`.
## 1.8.0
- **KI für Dokumente** (Feature `docAi`): Für neue Dokumente schlägt die KI Art, Titel, Datum, Absender, Betrag, einen
  Zielordner des Bereichs, einen Dateinamen und Fristen vor. Nichts passiert automatisch – übernommen wird per Klick.
  - Nutzt den KI-Dienst von GateControl ≥ 1.214.0 (`gc.ai`, neue Berechtigung `ai` mit Text und Bildern). Ohne ihn, wenn der Admin
    das Plugin dort sperrt oder die neue Einstellung `doc_ai` aus ist, fehlt `docAi` in `GET me` `features`, Knoten haben
    kein `insight` und `GET nodes/<id>/insight` antwortet `status: 'off'`.
  - Datensparsam: gesendet wird der erkannte Text (`uploads/commit { text }`), nie die Datei. Bilder ohne Text (nur JPEG,
    PNG, WebP, GIF) nur, wenn GateControl „Bilder an KI senden“ erlaubt – automatisch nur mit der neuen Einstellung
    `doc_ai_images` (Standard aus), sonst auf Wunsch (`POST nodes/<id>/insight`). HEIC- und PDF-Scans nur als Text.
  - Kosten: höchstens eine Erkennung je Fassung (`rev`), keine Wiederholung ohne Anlass (neue Fassung oder `POST …/insight`),
    die Warteschlange arbeitet der Hintergrund ab – höchstens drei Erkennungen je Lauf.
  - `GET nodes/<id>/insight` → `{ status, kind, title, date, sender, amount, currency, suggestion { folderId, folderPath,
    name } | null, deadlines, error, at }`; `POST nodes/<id>/insight`; `POST nodes/<id>/insight/apply { name?, folder? }`
    → `{ node, insight }` (ein belegter Name wird zu „… (2)“). Jeder Dateiknoten trägt `insight { status, kind }`.
  - Pro Bereich an oder aus: `PATCH areas/<id> { docAi }`, `GET me`/`GET areas` liefern `docAi` je Bereich. Standard: aus
    in Kinderordnern, sonst an.
  - Rechte: Lesen genügt zum Ansehen und für eigene Erinnerungen; Erkennen, Übernehmen und Umschalten brauchen Schreibrecht.
- **Fristen:** `GET deadlines?from=&to=`, `POST deadlines/<id>/remind { daysBefore }`, `DELETE deadlines/<id>/remind`.
  Erinnert wird über Drives eigene Mitteilung (neues Thema `deadline`) am Tag minus N Tage, je Person. Das Familie-Plugin
  bietet keinen Erinnerungsdienst, den ein anderes Plugin aufrufen darf – deshalb erinnert Drive selbst.
- **Import aus Google Drive und OneDrive** (Feature `cloudImport`): neue Portal-Seite „Importieren“ – Konto verbinden,
  durchsuchen, Dateien oder ganze Ordner wählen, Zielordner wählen.
  - Nutzt die Cloud-Konten von GateControl ≥ 1.213.0 (`gc.cloud`, neue Berechtigung `cloudImport`) und die neue
    Einstellung `cloud_import`. Das Portal öffnet die Anmeldung mit `GC.openUrl` und wertet die Rückkehr aus
    (`cloud=connected` bzw. `cloud=error&cloudError=…`); danach laufen wartende Importe weiter. Eine abgelaufene
    Verbindung (`error: 'auth'`) zeigt „Neu verbinden“.
  - Aufträge laufen im Hintergrund als die Person, setzen nach einem Abbruch dort fort, wo sie waren, und zeigen ihren
    Fortschritt (Live-Ereignis `import`).
  - Ordnerstruktur und Änderungsdatum (`mtime`) bleiben erhalten. Ein vorhandener Name wird zur neuen Version, gleiche
    Bytes werden übersprungen, ein gleichnamiger Ordner wird weiterverwendet.
  - API: `GET import/sources`, `POST import/connect`, `DELETE import/connections/<id>`, `GET import/browse`,
    `POST|GET import/jobs`, `GET import/jobs/<id>`, `POST import/jobs/<id>/resume`, `DELETE import/jobs/<id>`.
- Der Hintergrund läuft jetzt jede Minute (`permissions.background.intervalSeconds: 60`); das Aufräumen bleibt bei alle
  5 Minuten.
- Neue Fehlercodes: `feature_off` (403), `unsupported` (422), `cloud_auth` (409), `cloud_error` (502), `rate_limit` (429),
  `too_large` (413), `job_limit` (409).
- Migration `008_insights_imports.sql`.
- **Hinweis:** Die neuen Berechtigungen `ai` und `cloudImport` verhindern das automatische Update – der Admin muss 1.8.0
  bestätigen.

## 1.7.0
- **Zeitreise:** Ein Ordner lässt sich mit allem darin auf einen Zeitpunkt zurücksetzen.
  - `GET nodes/<id>/timetravel?at=` zeigt vorher, was passiert: `restore`, `revert`, `move`, `trash`, Beispiele,
    `limited`, `historySince`, zusätzlich `lost`, `ops` und `max`. `POST nodes/<id>/timetravel { at }` führt es aus
    und antwortet mit `restored`, `reverted`, `moved`, `trashed`, `failed`, `lost` und `before`.
  - Gelöschtes kommt aus dem Papierkorb, Dateien bekommen die Fassung von damals, Namen und Ordner werden wie damals,
    seitdem Neues kommt in den Papierkorb. Endgültig gelöscht wird nichts.
  - „Rückgängig“ ist eine Zeitreise auf `before`.
  - Dafür ist Schreibrecht auf den Ordner nötig. Der Schutz vor Erpressungstrojanern beobachtet die Zeitreise nicht.
  - Ab 1.7.0 merkt sich Drive vor jeder Umbenennung, Verschiebung und Wiederherstellung den alten Stand (Tabelle
    `node_log`). Ältere Umbenennungen kann die Zeitreise nicht zurückdrehen (`limited`).
  - Fassungen, die älter sind als die Versionsaufbewahrung (`versions_days`, `versions_max`), sind weg. Die Vorschau
    zählt sie als `lost`.
  - Fassungen, die eine Zeitreise anlegt, behält Drive für ihr Rückgängig mindestens so lange wie den Papierkorb –
    egal was `versions_max` und `versions_days` sagen.
- **Aufnahmedatum:** `uploads/commit { takenAt }` (ISO-8601 oder Millisekunden). Ein falsches Format ergibt `400`
  mit `field: 'takenAt'`. Mehr als einen Tag in der Zukunft oder vor 1900 wird ignoriert.
  - Jeder Knoten hat `takenAt`: das gesendete Datum, sonst `mtime`, sonst den Zeitpunkt des Hochladens. Bei Ordnern
    ist es `null`.
  - Das Portal liest beim Hochladen das EXIF-Aufnahmedatum aus JPEGs, sonst nimmt es das Dateidatum.
- **Fotos** (`GET photos`, `photos/months`, `photos/memories`) und **Alben** (`GET|POST albums`,
  `GET|PATCH|DELETE albums/<id>`, `POST|DELETE albums/<id>/items`).
  - Im Portal gibt es die neuen Seiten „Fotos“ (Zeitleiste nach Monaten, „Vor einem Jahr“, Mehrfachauswahl) und
    „Alben“ (Titelbild, Umbenennen, Herausnehmen, Löschen).
  - Ein Album gehört zu einem Bereich. Wer den Bereich lesen kann, sieht das Album; wer dort schreiben darf, darf es
    ändern.
- **Fotorahmen am Wandtablet:** Alben mit `frame: true` laufen als Diashow im neuen Portal-Abschnitt „Fotorahmen“
  (Tab „Zuhause“) – nur auf Kiosk-Geräten.
  - Kiosk-Geräte erreichen nur `GET frame`, alles andere von Drive ist für sie gesperrt.
  - Sie bekommen nur Vorschaubilder in Anzeigegröße, ohne Namen. Das braucht **GateControl ≥ 1.210.0** (Adressen nur
    für das Vorschaubild), davor zeigt der Rahmen einen Hinweis.
  - Den Rahmen darf einschalten, wer im Bereich des Albums schreiben darf – nie ein Kind, im Familienbereich nur
    Eltern und Admins.
  - Neue Einstellungen: `frame_on`, `frame_seconds`, `frame_order`, `frame_accounts`.
- **Speicher:** `GET storage[?all=1]` liefert die Belegung je Bereich (bei Admins mit „alle“ auch je Person), die
  größten Dateien und Duplikate. `POST storage/versions/prune` räumt alte Versionen auf (nur Admins und Verwalter).
  - Im Portal gibt es die Seite „Speicher“ mit Duplikaten zum Behalten oder Löschen (in den Papierkorb).
  - Die Admin-Übersicht zeigt eine kurze Speicher-Zusammenfassung.
- Behoben: Ordner mit mehr als etwa 100 Einträgen ließen sich nicht in den Papierkorb legen oder endgültig löschen.
  GateControl nimmt höchstens 100 Parameter je Datenbankbefehl, Drive teilt die Listen jetzt auf.
- `features` in `GET me` enthält zusätzlich `timeTravel`, `takenAt`, `photos`, `albums`, `frame` und `storage`.
- Migration `007`. Keine neuen Rechte, das Update kommt automatisch.

## 1.6.0
- **Direktlinks ins Portal:** `GET me` liefert `links: { node, drive }` – absolute Adressen des Drive-Tabs im Portal,
  `node` mit dem Platzhalter `{id}` (z. B. `https://gc.example.de/portal?drive={id}#plg-gatecontrol-drive`). Apps
  ersetzen nur `{id}`. Ohne bekannte Adresse ist `links` `null`.
  - Die Adresse kommt aus der neuen Einstellung „Adresse von GateControl für Direktlinks“ (`portal_url`) oder aus der
    öffentlichen Adresse, auf der GateControl seine Links baut. Drive lernt sie aus der Adresse eines geteilten Links
    (beim Anlegen, sonst höchstens einmal pro Stunde über `gc.publicLinks.list`).
  - Das Portal öffnet beim Laden den Knoten aus `drive=<id>` seiner Frame-Adresse: ein Ordner öffnet sich, bei einer
    Datei ihr Ordner, die Datei wird markiert und angezeigt. **GateControl 1.208.0 reicht den Parameter noch nicht an
    den Frame weiter** – bis dahin öffnet der Link den Drive-Tab.
  - Neu im Aktionsmenü: „Direktlink kopieren“.
  - Mitteilungen (`link_upload`, `child_view`, `guard`) tragen `data.link` und den Knopf „Öffnen“ (`open_portal`).
- **Ordner hochladen im Portal:** „Ordner hochladen“ (`<input webkitdirectory>`) neben dem Ziehen ganzer Ordner. Die
  Unterordner entstehen, auch leere, dazu der Gesamtfortschritt. Leere Dateien gehen wie bisher per `size: 0`.
- **Schutz vor Erpressungstrojanern** (Einstellung „Schutz vor Erpressungstrojanern aktiv“, Standard an):
  - Drive beobachtet je Gerät, was eine App ändert: neue Dateien, neue Fassungen, Umbenennen und Verschieben, Löschen
    (auch das verzögerte Löschen der Sicherung, `?after=`).
  - Verdächtig ist, wenn ein Gerät im Zeitfenster (`guard_minutes`, 10 Minuten) viele bestehende Dateien überschreibt,
    umbenennt oder löscht (`guard_files`, 50, oder `guard_percent`, 20 % eines Bereichs mit mindestens 20 Dateien) und
    mindestens die Hälfte davon ein Merkmal zeigt. Neue Dateien zählen nie – viele Fotos hochladen ist kein Angriff.
  - Merkmale: bekannte Endungen von Erpressungstrojanern oder eine neue, zufällige Endung; der Hinweis des Geräts, dass
    der Inhalt zufällig aussieht (`uploads/commit { entropy }`, 0–8); Originale, die kurz nach einer gleichnamigen Datei
    mit anderer Endung gelöscht werden.
  - Dann wird das Gerät gesperrt. Schreibende Anfragen antworten mit `423 { code: 'device_locked', error:
    'device_locked', incident }`, Lesen geht weiter. Die Person und die Admins bekommen eine Mitteilung mit Direktlink,
    dazu kommt das Live-Ereignis `guard { incident }`.
  - `GET me` nennt `guard { on, locked, incident }` für das fragende Gerät und `incidents` (offene Vorfälle der Person).
  - `POST guard/incidents/<id>/undo` setzt jede Datei auf den Stand vor dem Vorfall zurück und gibt das Gerät frei:
    Fassung, Name und Ordner kommen zurück, Gelöschtes kommt aus dem Papierkorb, Löschmarkierungen enden, neu
    Angelegtes kommt in den Papierkorb.
    `POST …/release` gibt das Gerät nur frei. Beides dürfen die Person und Admins, beides ist idempotent.
  - Im Portal erscheint ein auffälliges Banner mit Beispielen, „Rückgängig machen“, „War ich – freigeben“ und „Alle
    Änderungen“. Admins sehen die Seite „Vorfälle“, die Admin-Übersicht zeigt gestoppte Geräte ganz oben.
- `features` in `GET me` enthält zusätzlich `links` und `guard`.
- Migration `006`. Keine neuen Rechte, das Update kommt automatisch. Neu sind fünf Einstellungen und das
  Mitteilungsthema `guard`.

## 1.5.0
- **Geräte:** PCs und Handys, die Ordner mit Drive sichern oder abgleichen, melden sich jetzt an.
  - `PUT devices/<id> { name, platform?, version? }` meldet ein Gerät an oder aktualisiert es (zuletzt gesehen). Die
    `id` vergibt das Gerät selbst und behält sie. Sie gilt je Person.
  - Gerätenamen sind je Person eindeutig, ohne auf Groß- und Kleinschreibung zu achten. Ein zweiter „PC“ heißt
    „PC (2)“. So teilen sich zwei PCs mit gleichem Hostnamen nicht mehr denselben Ordner.
  - Jedes Gerät bekommt seinen Ordner „Meine Dateien › Geräte › <Name>“. Die Antwort enthält ihn als
    `folder { id, name, path, where }`. Ein vorhandener Ordner mit diesem Namen, den kein anderes Gerät nutzt, wird
    übernommen (das hat eine ältere App angelegt). Wird ein Gerät umbenannt, zieht sein Ordner mit.
  - `GET devices` liefert meine Geräte mit Ordnern und letzter Sicherung. `PUT devices/<id>/folders` speichert die
    Ordnerliste (`localPath`, `mode: 'backup' | 'sync'`, `nodeId`, `lastBackup`). `DELETE devices/<id>` vergisst ein
    Gerät, seine Dateien bleiben.
  - Im Portal gibt es die neue Seite „Geräte“ mit den Ordnern, der letzten Sicherung und „Gerät vergessen“.
- **Verzögertes Löschen:** `DELETE nodes/<id>?after=<Sekunden>` (höchstens 365 Tage) legt die Datei oder den Ordner
  erst später in den Papierkorb. `PATCH nodes/<id> { deleteAt }` setzt den Zeitpunkt genau, `deleteAt: null` hebt ihn
  auf.
  - Bis dahin bleibt alles normal sichtbar. Der Knoten trägt `deleteAt`, `deletedOnDevice` (Name des Geräts) und
    `deleteMarkedBy`. Das Änderungsprotokoll schreibt dafür `mark` und `unmark`.
  - Eine neue Fassung, eine zurückgeholte Version, Umbenennen, Verschieben oder etwas Neues im markierten Ordner hebt
    die Markierung auf.
  - Der Hintergrundlauf legt fällige Knoten in den Papierkorb, im Namen der Person, die markiert hat.
  - Das Portal zeigt dezent „wird am … gelöscht“ und bietet „Behalten“ an.
- **Leere Dateien:** GateControl nimmt beim Hochladen keine 0 Byte an. `uploads/commit { parentId, name, size: 0 }`
  ohne `mediaId` legt deshalb eine leere Datei ohne Medienobjekt an (`mediaId: null`, `size: 0`, SHA-256 der leeren
  Datei).
  - `GET nodes/<id>/content` liefert dafür `empty: true` und eine leere `data:`-Adresse.
  - Versionen gehen in beide Richtungen. `uploads/check` erkennt zwei leere Dateien als gleich.
  - Das Portal lädt leere Dateien jetzt auch hoch.
- `GET me` nennt in `features` die Fähigkeiten dieses Drive (`devices`, `deleteAfter`, `emptyFiles` …). So prüft eine
  App vorher, ob sie die neuen Wege nutzen kann.
- Bestehende Apps arbeiten unverändert weiter: Ohne `after` löscht `DELETE` sofort wie bisher, und die neuen Felder
  erscheinen nur, wenn sie gesetzt sind.
- Migration `005`. Keine neuen Rechte, das Update kommt automatisch.

## 1.4.0
- **Dienst `save_file` für einen gewählten Ordner:** Andere Plugins (Messenger, GateDrop, Schule) können jetzt statt
  `area` + `path` auch `folderId` + `name` übergeben. Das ist ein Ordner, den die Person in einer App gewählt hat.
  Er muss ihr gehören oder für sie beschreibbar sein, sonst lautet die Antwort `forbidden` oder `not_found`.
- Jede Antwort von `save_file` enthält jetzt `where` mit dem Ablageort in Lesbar, zum Beispiel
  „Meine Dateien › Messenger › Foto.jpg“. Damit kann das aufrufende Plugin melden, wo die Datei gelandet ist.
- Keine neuen Rechte, das Update kommt automatisch.

## 1.3.0
- **Scans durchsuchbar:** Die App erkennt den Text eines Scans auf dem Handy und schickt ihn mit dem Hochladen mit
  (`uploads/commit { text }`, höchstens 100.000 Zeichen).
  - `GET search` findet Dateien jetzt auch über diesen Text. Treffer im Namen kommen zuerst. Jeder Treffer hat `match`
    (`name` oder `text`), Treffer im Text zusätzlich `snippet` mit etwa 120 Zeichen rund um die Fundstelle.
  - Eine neue Fassung ohne Text, das Zurückholen einer älteren Fassung und das endgültige Löschen entfernen den
    gespeicherten Text.
- **Neue Einstellung „Scans speichern als“:** PDF (Standard) oder Bild. Die App nimmt das als Vorgabe beim Scannen,
  ändern lässt es sich pro Scan. `GET me` liefert es als `settings.scanFormat` mit.
- Braucht weiterhin GateControl 1.208.0. Es kommen keine neuen Rechte dazu, darum installiert GateControl das Update
  automatisch, wenn automatische Updates an sind.

## 1.2.0
- **Löschen auf allen Geräten:** Beim Löschen kann die App fragen: nur auf diesem Gerät, auch auf dem Server oder auf
  allen Geräten.
  - `DELETE nodes/<id>?everywhere=1` legt die Datei oder den Ordner wie bisher in den Papierkorb. Dazu merkt sich der
    Server einen Löschauftrag für alle Geräte der Person, die gelöscht hat. Jedes dieser Geräte entfernt seine eigene
    Kopie, sobald es das nächste Mal online ist, etwa das Foto, das die Foto-Sicherung in der Galerie gelassen hat.
  - Ein Auftrag hat einen Eintrag je Datei (bei einem Ordner jede Datei darin, höchstens 5000) mit `nodeId`, `name`,
    `sha256`, `size` und `mime`. Die Antwort enthält zusätzlich `wipe: { id, devices, files }`.
  - `GET wipes` liefert die offenen Einträge des fragenden Geräts. Mit `POST wipes/done { ids }` meldet das Gerät sie
    als erledigt. Hat jedes Gerät einen Eintrag erledigt, verschwindet er.
  - `GET me` hat jetzt `wipes` (offene Einträge dieses Geräts) und `devices` (wie viele Geräte ein neuer Auftrag
    erreicht). Die Apps bekommen sofort das Live-Ereignis `wipes`.
  - Gemeint sind die Geräte, die Drive in den letzten 180 Tagen gesehen hat.
  - Wer die Datei aus dem Papierkorb zurückholt, beendet den Auftrag. Geräte, die schon gelöscht haben, bleiben ohne
    Kopie.
  - Aufträge enden spätestens nach 90 Tagen. Auf Geräte, die GateControl nicht mehr kennt, wartet Drive nicht weiter.
- **Portal:** „In den Papierkorb“ bietet „Auch auf allen meinen Geräten löschen“ an, sobald Drive Geräte der Person
  kennt.
- **Neues Recht `permissions.devices`:** Erst damit nennt GateControl Drive das fragende Gerät (`user.device`).
  Dadurch ist auch `device` im Änderungsprotokoll (`changes`) bei App-Änderungen gefüllt. Weil das Update ein neues
  Recht verlangt, installiert GateControl es nicht automatisch; ein Admin muss es bestätigen.
- Braucht weiterhin GateControl 1.208.0.

## 1.1.0
- **Vorschaubilder in allen Listen** (GateControls Vorschaubilder, `media.previews`):
  - Jede Datei in den Antworten der App- und Portal-API hat jetzt `preview: { url, largeUrl }` oder `null`. Das gilt für
    `nodes/<id>`, `children`, `by-path`, `search`, `changes`, `versions` (`current`), `uploads/check` und `uploads/commit`.
  - Die App bekommt GateControls App-Adresse `/api/v1/client/plugins/gatecontrol-drive/media/<mediaId>/preview`. Sie wird
    mit dem Geräte-Token abgerufen, mit denselben Rechten wie die Datei, und darf dauerhaft im Cache bleiben.
  - Das Portal bekommt eine signierte Adresse für die Seite.
  - `?size=large` liefert die große Fassung (1280 px statt 320 px).
- **Fotos, Bilder, HEIC und Videos:**
  - Für JPEG, PNG, WebP, GIF und AVIF macht GateControl die Vorschaubilder selbst.
  - Für HEIC-Fotos und Videos schickt die hochladende App ein eigenes Vorschaubild
    (`PUT …/media/<mediaId>/preview`, JPEG/WebP/PNG bis 512 KB), am besten gleich nach dem Upload und vor
    `uploads/commit`.
- **Portal:**
  - Kacheln und Liste zeigen die Vorschaubilder statt der Symbole, auch für HEIC und Videos mit Vorschaubild.
  - Die Vorschau eines HEIC-Fotos zeigt das große Vorschaubild, weil der Browser HEIC nicht anzeigen kann.
- Kein Vorschaubild (`null`) haben Dokumente und Dateien im Papierkorb. Ordner haben das Feld nicht.
- Braucht GateControl 1.208.0.

## 1.0.0
- **Erste Veröffentlichung im Plugin-Katalog.** Drive ist ein eigenes Abo und nicht in GateControl Lifetime enthalten:
  - **Familie:** nur Familienmitglieder.
  - **Business:** nur Team.
  - **Kombi:** beides.
  - Fünf Personen sind enthalten, weitere werden im Kundenkonto auf callmetechie.de hinzugebucht. Danach holt
    „Lizenz jetzt abrufen“ die neue Zahl sofort.
- Katalog-Eintrag mit Beschreibung, Rechten und Vorschau (Symbol „cloud“).
- Die Apps (Android, Windows) folgen; bis dahin wird Drive im Portal benutzt.

## 0.3.0
- **Admin-Seiten** unter Einstellungen › Plugins › Drive (nach dem Mockup):
  - **Übersicht:**
    - Lizenz mit Stufe und Personen („3 von 5 Personen“, Familie/Business getrennt, Hinweis bei Überschreitung).
    - „Lizenz jetzt abrufen“ nach dem Hinzubuchen.
    - Alle Bereiche mit Speicherort, Belegung, Dateien, Verschlüsselung und Zustand.
  - **Personen:** jedes Konto mit Auswahl „nicht freigeschaltet“, „Familie“ oder „Business“, so wie die Lizenz es
    erlaubt.
  - **Team-Ordner:**
    - Anlegen, bearbeiten, archivieren und entfernen (nur leere).
    - Mitglieder sind Personen oder ganze Gruppen, ausgewählt mit GateControls eigener Auswahl, und haben die Rechte
      Lesen, Schreiben oder Verwalten.
    - Platz pro Team-Ordner.
- **Hinweis „Das GateControl-Backup sichert keine Drive-Dateien“:**
  - Auffällig, solange ein Bereich nur auf diesem Server, in einem Ordner oder auf einer NAS liegt. Admins bekommen
    dann einmal pro Woche eine Mitteilung (Thema `backup_hint`).
  - Dezent, wenn alles in S3 liegt.
  - Abschaltbar mit „Ausblenden“ oder in den Einstellungen.
- **Dienste für andere Plugins** (für „In Drive speichern“ in Messenger, GateDrop, Schule):
  - `list_areas`: wohin eine Person speichern darf.
  - `save_file`: eine übergebene Datei unter einem Pfad ablegen; fehlende Ordner entstehen dabei, bei gleichem Namen
    gibt es einen freien Namen oder eine neue Version.
  - Es gelten die Rechte der Person: Freischaltung und Schreibrecht im Bereich.

## 0.2.0
- **Portal-Tab „Drive“** nach dem Mockup:
  - Bereiche links (auf dem Handy als Reihe oben), Kacheln mit Vorschaubildern oder Liste, Pfad, Sortieren, Suche.
  - Hochladen über den Knopf oder durch Hineinziehen von Dateien und ganzen Ordnern. Gibt es den Namen schon, fragt
    Drive: als neue Version, beide behalten oder überspringen, auf Wunsch für alle weiteren Dateien.
  - Vorschau für Bilder, Videos und Ton; andere Dateien werden heruntergeladen.
  - Neuer Ordner, Umbenennen, Verschieben (auch in einen anderen Bereich), ältere Versionen (ansehen,
    wiederherstellen, löschen), Papierkorb (wiederherstellen, endgültig löschen).
  - Live: Ändert ein anderes Gerät etwas im angezeigten Bereich, lädt der Ordner neu.
  - Eltern sehen im Ordner eines Kindes den Hinweis, dass das Kind davon erfährt.
- **Teilen mit Menschen ohne Konto** (Links v2 von GateControl):
  - Datei oder Ordner: „Ansehen“, „Ansehen + Laden“ oder bei Ordnern „Hochladen“.
  - Gültig 1, 7 oder 30 Tage oder ohne Ablauf (nur wenn der Admin das erlaubt), auf Wunsch mit PIN.
  - Seite „Geteilte Links“ mit Zustand, Öffnungen, Downloads, Protokoll und „Beenden“.
  - Über einen Upload-Link hochgeladene Dateien landen sofort im Ordner. Wer den Link erstellt hat, bekommt eine
    Mitteilung („… ist über deinen Link angekommen“, Thema `link_upload`).
  - Wird ein geteilter Ordner umbenannt, verschoben oder gelöscht, beendet Drive seine Links. So zeigt ein alter Link
    nie einen neuen Ordner gleichen Namens. Eine Datei im Papierkorb beendet ihre Links ebenso.
- App-/Portal-API: `POST links`, `GET links`, `GET links/<token>/events`, `DELETE links/<token>`;
  `GET nodes/<id>/children?thumbs=1` liefert Vorschaubilder; `GET me` nennt die Namen der Personen.
- Braucht weiterhin GateControl 1.207.0. Der Admin muss Links unter Einstellungen › Plugins › Drive › Berechtigungen
  erlauben.

## 0.1.0
- **Erste Fassung (noch nicht veröffentlicht):** der Kern des Plugins ohne Oberfläche – die App-/Portal-API, auf
  der Portal, Android und Windows aufbauen.
- **Bereiche:** *Meine Dateien* für jede Person, *Familie* für die Mitglieder einer GateControl-Familiengruppe,
  *Kinder · Name* für jedes Kind (die Eltern dürfen hineinsehen, solange die Einstellung an ist; das Kind erfährt
  einmal am Tag, wer hineingesehen hat) und *Team-Ordner*, die ein Admin für Personen und Gruppen mit den Rechten
  Lesen, Schreiben oder Verwalten anlegt. Jeder Bereich hat einen eigenen Speicherort, den der Admin in GateControl
  festlegt (Server, NAS, S3).
- **Personen und Lizenz:** Ein Admin schaltet Personen als Familie oder Business frei; gezählt wird gegen die Lizenz
  (Familie, Business oder Kombi mit Zusatzpersonen). Familien-Bereiche brauchen eine Familien-Person, Team-Ordner eine
  Business-Person. Eine Lizenz ohne Stufe (z. B. Lifetime) hat keine Grenze.
- **Dateien:** Ordner anlegen, umbenennen, verschieben – auch zwischen Bereichen –, Hochladen über GateControls
  fortsetzbaren Upload, Konflikte erkennen (`baseRev`), Versionen mit Wiederherstellen, Papierkorb mit
  Wiederherstellen und endgültigem Löschen, Suche.
- **Lesbar auf der NAS:** Die Dateien liegen auf einer NAS unter ihrem Pfad; Änderungen, die dort direkt gemacht
  werden, übernimmt Drive (Abgleich über GateControls Journal).
- **Abgleich mit Geräten:** Änderungsprotokoll (`GET changes?since=`) und ein Live-Ereignis `changed` an alle, die
  den Bereich lesen.
- Braucht GateControl 1.207.0.
