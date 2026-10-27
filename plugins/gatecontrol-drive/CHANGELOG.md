# Drive (gatecontrol-drive)

Dateien der Familie und des Teams auf dem eigenen Speicher – auf diesem Server, einer NAS oder in S3.

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
