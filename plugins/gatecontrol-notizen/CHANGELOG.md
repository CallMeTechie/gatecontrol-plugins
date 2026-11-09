# Changelog

## 1.1.0

- **Offline anlegen und ändern in den Apps:** Aufgaben, Unteraufgaben, Listen, Listengruppen, Notizbücher und Notizen (auch im Tresor) nehmen beim Anlegen eine **`clientId`** des Geräts (eine UUID). Kommt dasselbe Anlegen noch einmal (die Antwort ging verloren, die Warteschlange sendet erneut), antwortet das Plugin mit dem schon angelegten Objekt (`replayed: true`) statt ein zweites anzulegen – auch wenn beide gleichzeitig ankommen. Die Zuordnung gilt je Person (Tabelle `client_ids`, Migration `002_client_ids.sql`, 180 Tage aufgehoben): die `clientId` einer anderen Person findet nie deren Objekt. Ist das Objekt inzwischen weg, kommt `410 gone`.
- **Eltern, die selbst offline entstanden sind:** `listClientId` und `parentClientId` bei `POST tasks`, `notebookClientId` bei `POST notes` benennen Liste, Aufgabe oder Notizbuch über ihre `clientId`. Ist es noch nicht angelegt (eine Unteraufgabe vor ihrer Aufgabe), kommt sauber `409 unknown_client_id { field }` und nichts wird angelegt.
- **Ändern ohne Verlust:** `PATCH tasks/<id>`, `PATCH lists/<id>` und `PATCH notebooks/<id>` nehmen **`base`** – die Werte, die das Gerät vor der Änderung gesehen hat. Hat jemand anderes ein Feld inzwischen auf etwas anderes geändert, kommt `409 conflict { fields, task | list | notebook }`; andere Felder stören sich nicht. Ohne `base` gewinnt die Änderung wie bisher („Meine behalten“). Notizen bleiben bei `rev`.
- **Doppelt gesendet schadet nicht:** Ein Feld, das schon den gesendeten Wert hat, wird nicht geschrieben – eine zweimal gesendete Erinnerung erinnert nicht zweimal, eine zweimal gesendete Zuweisung schickt nur einen Push. `PATCH notes` mit veraltetem `rev` antwortet `200`, wenn die Notiz schon genau so aussieht. Ein zweites Löschen antwortet `{ ok, gone: true }` (für wen es sehen darf; sonst `404` wie bisher).
- **Pushes führen zur Seite:** `data.notizen` trägt jetzt `kind` (`reminder`, `assigned`, `shared_list`, `shared_notebook`, `vault_request`), `area` und die Ids `taskId`, `listId`, `notebookId`, `vaultId`, `deviceId` – die Schlüssel von 1.0 (`task`, `list`, `notebook`, `vault`) bleiben.
- `GET me` meldet die Fähigkeiten **`offlineEdits`** und **`pushTargets`**; Apps legen nur damit offline an.

## 1.0.1

- Korrektur: Der Umzug von Microsoft To Do braucht **Mail 1.12.0** (Dienste `ms_accounts`, `ms_tasks_token`, `ms_tasks_consent`), nicht 1.11.0 – in Handbuch, README, Einstellungshilfe und Hinweistext.

## 1.0.0

Das neue Plugin **Notizen & Aufgaben** – die Zentrale für eigene Aufgaben und Notizen und alles „Zu tun“ aus den anderen Plugins.

- **Aufgaben:** Listen und Listengruppen, intelligente Listen „Mein Tag“, „Wichtig“, „Geplant“, „Mir zugewiesen“; Unteraufgaben, Fälligkeit mit Uhrzeit, Erinnerung als Push (Thema „Erinnerungen an Aufgaben“), Wiederholen (täglich, an Wochentagen, alle N Tage/Wochen/Monate/Jahre, N Tage nach Erledigung – `ui/repeat.js`), Notiz und Anhänge an Aufgaben, geteilte Listen, Zuweisen an Mitglieder (Push „Geteilt und zugewiesen“).
- **Aus anderen Plugins:** Familie, Mail, Drive, Schule und Alltag liefern ihr „Zu tun“ nach `docs/notes-sources-contract.md` (Push `todo_changed` mit eigener Grenze von 3600 Aufrufen pro Stunde, Abgleich `todo_items` etwa alle 12 Stunden, `todo_complete`). Abhaken hier hakt dort ab, das Original bleibt im Plugin. Eine Aufgabe kann ein solches Element „tragen“ (eigene Unteraufgaben, Notiz, Erinnerung). Müllabfuhr am Vorabend, Aufgaben der Kinder, Einkaufslisten, markierte Mails, Konten und Kinder als Gruppen – je Person unter „Quellen“ einstellbar.
- **Notizen:** Notizbücher, Schlagwörter (#wort im Text), Anheften, Farben, Markdown mit Überschriften, fett/kursiv, Listen, Checklisten, Tabellen, Links, Bildern und Anhängen (`ui/notemd.js`); eine Zeile wird zur Aufgabe; Volltextsuche (FTS5, ohne Umlaut-Unterschied, auch erkannter Text von Bildern, den ein Gerät schickt).
- **Tresor-Notizbücher:** Ende-zu-Ende verschlüsselt im Format der Drive-Tresore mit dem Präfix `gcnotes-v1` (README „Tresor-Notizbücher – Kryptografie“, Testvektoren `test/vault-vectors.json`), Geräte freigeben mit Sicherheitsnummer, Wiederherstellungsschlüssel, neuer Schlüssel, wenn jemand den Tresor verlässt.
- **Pinnwand und Packlisten von Familie** leben hier und werden in Familie angezeigt (Dienste `notes_bind`, `notes_list`, `note_save`, `note_check`, `note_delete`, `notes_import`; Rückmeldung `notes_changed`).
- **Schnell-Eingabe in normaler Sprache** ohne KI: „morgen 9 Uhr“, „Freitag“, „in 2 Wochen“, „jeden Montag“, „@Name“, „#liste“, „wichtig“ (`ui/quickparse.js`, Testvektoren `test/vectors/quickparse.json` für Android und Windows).
- **Umzug von Microsoft To Do** über das Microsoft-Konto aus Mail (braucht Mail 1.12.0: Token nur für `Tasks.ReadWrite`, Zustimmung per Gerätecode), Listen der Arbeit in den Bereich Arbeit, Anhänge, erledigte der letzten Tage; auf Wunsch Abgleich in beide Richtungen für eine Übergangszeit.
- **Umzug von Synology DS Note** aus dem .nsx-Export (wird auf dem Gerät gelesen, Anhänge einzeln hochgeladen); geschützte Notizen werden mit Passwort ein Tresor-Notizbuch oder übersprungen.
- **Portal:** Tab „Notizen & Aufgaben“ mit Menü, Liste und Details (Mockup „Windows“), Kachel „Mein Tag“ auf der Startseite, Treffer in der Portal-Suche. Bereiche Privat und Arbeit getrennt.
- **Einstellungen (Admin):** Zeitzone, Sprache der Erinnerungen, Teilen mit (alle / Familie und Team / niemand), Tresore erlauben, Quellen einzeln, Umzug, größte Datei, Platz je Person; Statuszeilen zu den Quellen.
- Schnell: jede Abfrage auf einem Index, `test/speed.test.js` mit 50 000 Aufgaben und 50 000 Notizen hält jede Anweisung unter 200 ms.
