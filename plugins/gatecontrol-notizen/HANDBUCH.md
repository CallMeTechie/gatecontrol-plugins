<!-- version: 1.0.0 -->
# Notizen & Aufgaben

## Neu in 1.0.0

Das Plugin ist neu: eigene Aufgaben und Notizen plus alles, was die anderen Plugins zu erledigen haben, an einer Stelle. Umzug von Microsoft To Do und Synology DS Note, Tresor-Notizbücher, Schnell-Eingabe in normaler Sprache.

## Was das Plugin kann

- **Mein Tag:** Termine heute (z. B. „Gelbe Tonne rausstellen“ am Vorabend, Elternabend), Überfälliges, was heute ansteht, was demnächst kommt (zwei Wochen) und was heute erledigt wurde – aus deinen Listen und aus Familie, Mail, Drive, Schule und Alltag.
- **Wichtig, Geplant, Mir zugewiesen** und deine **Listen** (auch in **Gruppen** und **geteilt**, z. B. „Haus & Garten“ mit dem Partner).
- **Aufgaben** mit Unteraufgaben, Fälligkeit und Uhrzeit, **Erinnerung als Push**, **Wiederholen** (täglich, werktags, jeden Montag, alle 2 Wochen, monatlich, jährlich oder „3 Tage nach Erledigung“), Notiz, Anhängen und einer Person, der die Aufgabe zugewiesen ist.
- **Notizen** in Notizbüchern mit Schlagwörtern, Anheften, Farben, Überschriften, fett und kursiv, Listen, **Checklisten**, Tabellen, Links, Bildern und Anhängen. Eine Zeile einer Checkliste wird mit „→ Aufgabe“ zur Aufgabe.
- **Volltextsuche** über Aufgaben und Notizen – auch in Notizen mit Umlauten („zahnarzt“ findet „Zahnärztin“).
- **Tresor-Notizbücher:** Ende-zu-Ende verschlüsselt. Nur deine Geräte können Titel und Text lesen, der Server nicht.
- **Privat und Arbeit** getrennt: oben im Menü umschalten.

## Voraussetzungen

- GateControl **1.216.0** oder neuer. Damit ein Antippen eines Elements aus einem anderen Plugin dieses im Portal öffnet: GateControl **1.254.0** (sonst sagt das Portal, wo es zu finden ist).
- Damit Familie, Mail, Drive, Schule und Alltag hier erscheinen: ihre Versionen mit „Zu tun für Notizen & Aufgaben“. Fehlt eine Quelle, steht das unter „Quellen“.
- Für den Umzug von Microsoft To Do: das Plugin **Mail 1.11.0** oder neuer mit deinem Microsoft-Konto.
- Für Tresor-Notizbücher im Portal: ein aktueller Browser (Chrome, Edge, Firefox, Safari der letzten Jahre).

## Einrichten

1. Installieren und lizenzieren. Unter **Einstellungen › Plugins › Notizen & Aufgaben › Einstellungen** die **Zeitzone** prüfen (bestimmt „heute“ und die Erinnerungen).
2. Festlegen, mit wem man **teilen** darf: mit allen, nur in der Familie und im Team, oder mit niemandem.
3. Unter **Quellen** die Plugins abwählen, die hier nicht erscheinen sollen. Die Statuszeile oben sagt, welche Quellen verbunden sind.
4. Fertig: Im Portal gibt es den Tab **„Notizen & Aufgaben“**, auf der Startseite die Kachel **„Mein Tag“**.

## Aufgaben

- **Schnell hinzufügen:** oben ins Feld tippen und Enter – oder **Strg N**. Das Plugin versteht z. B. „morgen 9 Uhr Zahnarzt anrufen, wichtig, #gesundheit“: morgen 9:00, Erinnerung 9:00, wichtig, Liste „Gesundheit“. Unter dem Feld steht, was erkannt wurde. Siehe [Schnell-Eingabe](#schnell-eingabe).
- **Abhaken:** der Kreis vorne. Eine wiederholte Aufgabe bekommt gleich die nächste (mit denselben Unteraufgaben, wieder offen).
- **Details:** eine Aufgabe antippen – rechts erscheinen Unteraufgaben, „In Mein Tag“, Fällig, Erinnerung, Wiederholen, Zugewiesen, Liste, Anhänge und Notiz.
- **Listen und Gruppen:** im Menü „Neue Liste oder Gruppe“. Über das Zahnrad einer Liste: Name, Farbe, Gruppe, **Teilen mit** und Löschen. Wer eine geteilte Liste bekommt, sieht sie sofort und erhält eine Mitteilung.
- **Gelöschtes** liegt 30 Tage im Papierkorb und ist danach weg.

## Aus anderen Plugins

Was Familie (Aufgaben, Einkaufslisten), Mail („Zu tun“, markierte Mails), Drive (Fristen aus Rechnungen und Bescheiden), Schule (Hausaufgaben, Arbeiten, Elternabende) und Alltag (Müllabfuhr am Vorabend) zu erledigen haben, steht in „Mein Tag“ und unter „Aus anderen Plugins“.

- **Das Original bleibt im Plugin.** Abhaken hier hakt dort ab; antippen zeigt „Aus Mail … öffnen“.
- Brauchst du eigene **Unteraufgaben, eine Notiz oder eine Erinnerung** dazu: „Unteraufgaben, Notiz, Erinnerung …“ – dann wird daraus eine Aufgabe hier. Erledigt hier = dort erledigt.
- **Quellen** (im Menü unten): je Quelle an/aus, „Aufgaben der Kinder zeigen“ (alle / nur mir zugewiesene / keine), „Einkaufslisten in Mein Tag“, „Markierte Mails als Aufgabe“, „Erinnern um“ für die Müllabfuhr am Vorabend. Mail-Konten und Kinder lassen sich einem Bereich zuordnen („Arbeit (Microsoft 365) → Arbeit“) oder ausblenden. „Jetzt abgleichen“ holt den Stand sofort.
- Fahrzeuge, NAS und Proxmox kommen in Schritt 2.

> **Hinweis:** Die Plugins schicken ihre Änderungen selbst; einen ganzen Abgleich macht Notizen & Aufgaben etwa alle 12 Stunden. Eine Änderung in einer Quelle erscheint daher meist in Sekunden, spätestens nach dem nächsten Abgleich.

## Notizen

- **Neue Notiz** im Notizbuch oben rechts. „Bearbeiten“ öffnet den Text mit Werkzeugleiste: Überschrift, fett, kursiv, Liste, nummerierte Liste, Checkliste, Tabelle, Link, Bild oder Datei. **Strg S** speichert und schließt; beim Tippen wird zwischendurch gespeichert.
- **#wort** im Text wird ein Schlagwort; im Menü stehen die häufigsten.
- **Anheften** und **Farbe** unter der Notiz.
- In einer Checkliste: abhaken direkt in der Notiz; **„→ Aufgabe“** neben einer Zeile macht eine Aufgabe daraus (die Zeile zeigt dann „Aufgabe · Mi.“).
- **Pinnwand und Packlisten von Familie** sind Notizbücher hier (mit „(Familie)“ im Namen) und werden in Familie gezeigt – was du hier änderst, sieht die Familie dort.

## Tresor-Notizbücher

Ein Tresor ist ein Notizbuch, das nur deine Geräte lesen können.

1. **Neues Notizbuch › Tresor**, Name eingeben.
2. Der **Wiederherstellungsschlüssel** erscheint einmal (56 Zeichen). Aufschreiben oder als Datei sichern – ohne ihn und ohne ein freigegebenes Gerät sind die Notizen verloren.
3. Ein **neues Gerät** (anderer Browser, die App) fragt „Zugang anfragen“ und zeigt eine **Sicherheitsnummer**. Auf einem Gerät mit Zugang erscheint „Geräte möchten in den Tresor“ – nur freigeben, wenn die Nummer auf beiden gleich ist. Oder auf dem neuen Gerät „Mit Wiederherstellungsschlüssel“.
4. Teilen geht auch: Wer aus dem Tresor genommen wird, verliert seine Schlüssel; der Tresor bittet dann um einen **neuen Schlüssel**.

Im Tresor gibt es keine Suche, keine Schlagwörter und kein „→ Aufgabe“ – der Server kennt den Text nicht. Das Portal sperrt den Tresor nach 15 Minuten ohne Nutzung und beim Verlassen der Seite.

## Schnell-Eingabe

| Du schreibst | Ergebnis |
|---|---|
| heute, morgen, übermorgen | das Datum |
| Montag … Sonntag, Mo. … So., „Fr 10 Uhr“ | der nächste solche Tag |
| in 3 Tagen, in einer Woche, in 2 Wochen, in einem Monat | das Datum |
| 13.11., 13.11.2026, 13. November | das Datum |
| 9 Uhr, 9:30, um 9, halb 10, 14h | die Uhrzeit (und eine Erinnerung) |
| früh, mittags, nachmittags, abends, heute Abend, morgen früh | 9:00, 12:00, 15:00, 19:00 |
| jeden Tag, täglich, werktags, jeden Montag, jeden Mo, Mi und Fr, alle 2 Wochen, monatlich, jährlich, 3 Tage nach Erledigung | eine Wiederholung |
| @Jenny | Jenny zuweisen (wenn sie in der Liste ist) |
| #gesundheit | in die Liste „Gesundheit“ (gibt es sie nicht: „Neue Liste …“) |
| wichtig, dringend, ! | wichtig |

Englisch geht auch: „tomorrow 5 pm“, „every monday“, „in 2 weeks“.

## Umziehen

### Von Microsoft To Do

1. **Umziehen › Microsoft To Do:** dein Microsoft-Konto aus Mail wählen.
2. Beim ersten Mal **„Bei Microsoft zustimmen“**: auf microsoft.com/devicelogin den angezeigten Code eingeben. Microsoft fragt, ob GateControl deine Aufgaben lesen und ändern darf.
3. Die Listen erscheinen mit der Zahl der offenen Aufgaben; Listen der Arbeit stehen schon auf „Arbeit“. Wählen, ob **erledigte Aufgaben** mitkommen (z. B. letzte 90 Tage) und ob in einer **Übergangszeit in beide Richtungen** abgeglichen wird.
4. **„… Aufgaben übernehmen“.** Der Umzug läuft im Hintergrund weiter, auch wenn du die Seite schließt.

Nichts wird in To Do gelöscht. Den Abgleich beendest du unter **Umziehen › Im Abgleich mit To Do › Abgleich beenden** – die Liste bleibt hier.

### Von Synology DS Note

1. In DS Note: **Einstellungen › Importieren/Exportieren › Exportieren** – du bekommst eine .nsx-Datei.
2. **Umziehen › Synology DS Note › Export-Datei (.nsx) wählen.** Der Browser liest die Datei selbst; nur Bilder und Anhänge werden einzeln hochgeladen.
3. **Geschützte Notizen:** Mit dem Passwort werden sie ein **Tresor-Notizbuch** (der Wiederherstellungsschlüssel erscheint vorher). Lässt sich eine Notiz nicht öffnen, wird sie übersprungen – dann in DS Note den Schutz aufheben und neu exportieren.
4. **„… Notizen übernehmen“.** Ein zweiter Umzug derselben Datei legt nichts doppelt an.

Direkt von der NAS holen geht noch nicht.

## Einstellungen

| Einstellung | Bedeutung |
|---|---|
| Zeitzone | bestimmt „heute“, Fälligkeiten und Erinnerungen |
| Sprache der Erinnerungen | Deutsch oder Englisch |
| Listen und Notizbücher teilen mit | Allen, Familie und Team, Niemandem |
| Tresor-Notizbücher erlauben | an/aus |
| Quellen | Familie, Mail, Drive, Schule, Alltag einzeln |
| Umzug | Microsoft To Do, Abgleich in beide Richtungen, DS Note |
| Größte Datei, Platz je Person | für Bilder und Anhänge |

## Fragen

**Warum steht eine Aufgabe aus Mail nicht da?** Unter „Quellen“ prüfen, ob Mail verbunden und eingeschaltet ist und ob das Konto ausgeblendet ist. „Jetzt abgleichen“ holt den Stand.

**Wer sieht meine Notizen?** Nur du – außer in geteilten Notizbüchern. Tresor-Notizbücher kann auch der Server nicht lesen.

**Findet die Suche Text in Bildern?** Wenn die App den Text eines Bildes erkannt hat, ja. Das Portal erkennt keinen Text in Bildern.
