# Changelog

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
