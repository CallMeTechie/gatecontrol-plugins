# Drive (gatecontrol-drive)

Dateien der Familie und des Teams auf dem eigenen Speicher – auf diesem Server, einer NAS oder in S3.

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
