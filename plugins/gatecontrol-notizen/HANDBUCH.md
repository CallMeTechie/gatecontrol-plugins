<!-- version: 1.5.0 -->
# Notizen & Aufgaben

## Neu in 1.5.0

- **Aufgabe am Ort:** Eine Aufgabe kann an einem Ort hängen – „beim Baumarkt Schrauben kaufen“, „bei Lidl Pfand wegbringen“, „bei Oma Leiter zurückgeben“. Dein Handy erinnert, wenn du dort **ankommst** oder den Ort **verlässt**. In jeder Aufgabe gibt es dafür die Zeile **„Ort“**; die Schnell-Eingabe erkennt den Ort im Text und zeigt ihn als Baustein.
- **Meine Orte:** Orte, die du benennst („Oma“, „Büro“), werden ohne Suche erkannt. „Zuhause“ und die Regel-Orte kommen aus dem Familien-Plugin (ab 1.22.0). Mit **„Als meinen Ort merken“** wird ein Ort dein üblicher Baumarkt, Bäcker oder Lidl und steht beim nächsten Mal sofort da.
- **Ortssuche – abschaltbar und zunächst aus:** „Welcher Baumarkt ist in der Nähe?“ beantwortet dein eigener Server. Der Administrator schaltet die Suche unter **Einstellungen › Plugins › Notizen & Aufgaben › Orte** ein; jede Person kann sie für sich wieder ausschalten. Siehe [Orte](#orte).
- **„In der Nähe“:** Kommst du an einem anderen passenden Ort vorbei, meldet sich die Aufgabe auch dort – mit „Erledigt“, „Nicht hier“ und „Später“.
- **Gestern offen geblieben** nennt bei Aufgaben mit Ort den Ort („Schrauben kaufen · Baumarkt Nord“).
- **Apps:** Erinnert wird am Ort nur vom Handy. Die Android-App bekommt die Orte mit einer der nächsten Versionen; bis dahin kannst du Orte im Portal setzen, sie melden sich aber noch nicht. Die Orts-Erinnerungen des Familien-Plugins arbeiten unverändert weiter.

## Neu in 1.4.0

- **Einkaufslisten:** Im Menü gibt es den Abschnitt **„Einkaufslisten“**. Eine Einkaufsliste hat Punkte mit Menge zum Abhaken, lässt sich teilen (Bearbeiten oder Ansehen) und kann einen Einkaufstag haben. Abgehaktes bleibt unten stehen, bis du „Abgehakte entfernen“ drückst.
- **Liste an der Aufgabe:** In jeder Aufgabe gibt es die Zeile **„Angehängte Liste“**. Die Aufgabe zeigt dann z. B. „Einkauf 0/8“; ein Klick darauf öffnet die Liste. Schreibst du „bei Lidl einkaufen“, schlägt die Schnell-Eingabe die passende Liste als Baustein vor – er lässt sich wegnehmen.
- **Alles abgehakt:** Sind alle Punkte der angehängten Liste abgehakt, ist die Aufgabe erledigt. Unten erscheint kurz **„Rückgängig“**. Die Liste bleibt bestehen. Umgekehrt bleiben offene Punkte stehen, wenn du die Aufgabe von Hand abhakst.
- **Erinnerung mit Liste:** Die Meldung einer Aufgabe mit Liste nennt die ersten Punkte und hat den Knopf **„Liste öffnen“**.
- **Familie:** Mit dem Familien-Plugin (ab 1.21.0) können dessen Einkaufslisten hierher umziehen – der Knopf dafür steht in den Einstellungen des Familien-Plugins. Danach sind die Listen hier mit der ganzen Familie geteilt, und „Ich gehe einkaufen“ sowie „Jemanden bitten …“ stehen über der Liste.
- **Apps:** Die Android- und Windows-App zeigen die Einkaufslisten unter „Aufgaben“ mit einer der nächsten Versionen. Bis dahin nutzen sie die Einkaufsliste weiter über das Familien-Plugin; beides bleibt abgeglichen.

## Neu in 1.3.0

- **Knöpfe an der Erinnerung:** Die Meldung zur Fälligkeit hat jetzt **„Erledigt“**, **„In 1 Std.“** und **„Heute Abend“** (abends stattdessen „Morgen früh“). „Erledigt“ hakt ab, ohne die App zu öffnen; die beiden anderen verschieben die Erinnerung.
- **Keine Erinnerung geht mehr still verloren:** War der Server zur Uhrzeit aus, kommt die Meldung bis zu 24 Stunden später nach – mit dem Hinweis „War fällig um …“. Ist es noch länger her, steht die Aufgabe am nächsten Morgen unter „Gestern offen geblieben“.
- **„Gestern offen geblieben“:** Was gestern fällig war oder in „Mein Tag“ lag und nicht abgehakt wurde, steht als Karte oben in „Mein Tag“ und kommt morgens in **einer** Nachricht (Vorgabe 07:30). Je Aufgabe: **Erledigt**, **Heute** oder **Verschieben** (Morgen, Am Wochenende, anderes Datum); bei mehreren auch „Alle heute“.
- **Im Kalender:** Mit dem Plugin Mail (ab 1.15.0) steht jede Aufgabe mit Datum und Uhrzeit als Termin von 30 Minuten im Kalender „Aufgaben“ – ohne eigene Termin-Erinnerung, damit nicht zwei Meldungen kommen. An der Aufgabe zeigt das Zeichen „im Kalender“ das an.
- **Schalter:** Administratoren finden „Aufgaben mit Uhrzeit in den Kalender eintragen“ in den Plugin-Einstellungen; jede Person schaltet Kalender und Morgen-Hinweis unter „Einstellungen“ (Zahnrad unten links) für sich.
- **Apps:** Die neuen Knöpfe an der Meldung funktionieren mit den aktuellen GateControl-Apps sofort. Die Karte „Gestern offen geblieben“ und die zusätzliche Sicherung auf dem Handy kommen mit einer der nächsten App-Versionen; bis dahin öffnet „Verschieben“ das Portal.

## Neu in 1.2.1

- **Schneller auf langsamen Datenträgern:** Das stündliche Aufräumen des Papierkorbs liest nicht mehr alle Notizen und Aufgaben durch, und das Plugin schreibt seltener in seine Datenbank. Das entlastet Server, deren Datenträger langsam ist.
- **Für dich ändert sich nichts:** Aussehen und Bedienung bleiben gleich; der Papierkorb leert sich wie bisher nach 30 Tagen.

## Neu in 1.2.0

- **Neues Menü wie in Drive:** links immer sichtbar, am Handy hinter dem Knopf ☰. Oben Mein Tag, Wichtig, Geplant, Mir zugewiesen und „Aufgaben“, darunter **„Meine Listen“** mit **Gruppen als aufklappbare Ordner**, „Aus anderen Plugins“ und die **Notizbücher**. Neue Listen, Gruppen und Notizbücher legst du mit dem **„+“** an der Überschrift an.
- **⋯ an jeder Liste, Gruppe und jedem Notizbuch:** Bearbeiten (Name, Farbe, Symbol, Gruppe), Teilen, In Gruppe verschieben, Einkaufstag, Löschen.
- **Einkaufstag:** Eine Liste kann an bestimmten Wochentagen oben in „Mein Tag“ stehen – „Heute ist Einkaufstag“ mit den ersten Einträgen zum Abhaken. Das gilt für alle, mit denen die Liste geteilt ist. Auf Wunsch kommt morgens eine Nachricht aufs Handy.
- **Teilen mit Rechten:** Jede Person bekommt **Bearbeiten** oder **Ansehen**. Wer nur ansehen darf, kann nichts hinzufügen oder ändern – nur abhaken, was ihm zugewiesen ist.
- **Zuweisen sichtbar:** In geteilten Listen steht das kleine Bild der Person an der Aufgabe; oben filterst du nach „Alle“, „Mir zugewiesen“, einer Person oder „Niemandem“. In der Schnell-Eingabe geht auch „@Name“.
- **Löschen mit Rückfrage:** Beim Löschen einer Liste oder eines Notizbuchs steht da, wie viel betroffen ist und wer es danach nicht mehr sieht. Offene Aufgaben können nach „Aufgaben“, Notizen nach „Notizen“ wandern. Danach gibt es ein paar Sekunden **„Rückgängig“**.
- **Einstellungen** (Zahnrad unten links) statt „Quellen“: Aufgaben aus anderen Plugins, Mein Tag, Uhrzeiten der Schnell-Eingabe, Benachrichtigungen und Umziehen an einer Stelle.

## Neu in 1.1.0

- **Ohne Verbindung weiterarbeiten:** In der Android-App lassen sich Aufgaben, Unteraufgaben, Listen, Notizbücher und Notizen jetzt auch offline anlegen, ändern und löschen. Sie erscheinen sofort (mit dem Hinweis „Noch nicht gesendet“) und gehen raus, sobald der Server erreichbar ist – auch wenn die App ein Anlegen zweimal schickt, entsteht nur eines.
- **Gleichzeitig anderswo geändert?** Hat jemand dasselbe Feld inzwischen auf einem anderen Gerät geändert, fragt die App beim Öffnen: „Meine behalten“ oder „Die andere laden“. Änderungen an verschiedenen Feldern (z. B. du den Titel, der Partner das Datum) bleiben beide.
- **Antippen einer Mitteilung öffnet die Seite:** eine Erinnerung oder Zuweisung die Aufgabe, eine geteilte Liste die Liste, ein geteiltes Notizbuch das Notizbuch, „Neues Gerät möchte Zugriff“ die Freigabe im Tresor.

## Neu in 1.0.1

Korrektur: Für den Umzug von Microsoft To Do braucht es **Mail 1.12.0** oder neuer (bisher stand hier fälschlich 1.11.0).

## Neu in 1.0.0

Das Plugin ist neu: eigene Aufgaben und Notizen plus alles, was die anderen Plugins zu erledigen haben, an einer Stelle. Umzug von Microsoft To Do und Synology DS Note, Tresor-Notizbücher, Schnell-Eingabe in normaler Sprache.

## Was das Plugin kann

- **Mein Tag:** Termine heute (z. B. „Gelbe Tonne rausstellen“ am Vorabend, Elternabend), Überfälliges, was heute ansteht, was demnächst kommt (zwei Wochen) und was heute erledigt wurde – aus deinen Listen und aus Familie, Mail, Drive, Schule und Alltag.
- **Wichtig, Geplant, Mir zugewiesen** und deine **Listen** (auch in **Gruppen** und **geteilt**, z. B. „Haus & Garten“ mit dem Partner).
- **Aufgaben** mit Unteraufgaben, Fälligkeit und Uhrzeit, **Erinnerung als Push** oder **am Ort** („beim Baumarkt“, „bei Oma“), **Wiederholen** (täglich, werktags, jeden Montag, alle 2 Wochen, monatlich, jährlich oder „3 Tage nach Erledigung“), Notiz, Anhängen und einer Person, der die Aufgabe zugewiesen ist.
- **Notizen** in Notizbüchern mit Schlagwörtern, Anheften, Farben, Überschriften, fett und kursiv, Listen, **Checklisten**, Tabellen, Links, Bildern und Anhängen. Eine Zeile einer Checkliste wird mit „→ Aufgabe“ zur Aufgabe.
- **Volltextsuche** über Aufgaben und Notizen – auch in Notizen mit Umlauten („zahnarzt“ findet „Zahnärztin“).
- **Tresor-Notizbücher:** Ende-zu-Ende verschlüsselt. Nur deine Geräte können Titel und Text lesen, der Server nicht.
- **Privat und Arbeit** getrennt: oben im Menü umschalten.

## Voraussetzungen

- GateControl **1.216.0** oder neuer. Damit ein Antippen eines Elements aus einem anderen Plugin dieses im Portal öffnet: GateControl **1.254.0** (sonst sagt das Portal, wo es zu finden ist).
- Damit Familie, Mail, Drive, Schule und Alltag hier erscheinen: ihre Versionen mit „Zu tun für Notizen & Aufgaben“. Fehlt eine Quelle, steht das unter „Einstellungen“ (Zahnrad unten links).
- Für den Umzug von Microsoft To Do: das Plugin **Mail 1.12.0** oder neuer mit deinem Microsoft-Konto.
- Für Tresor-Notizbücher im Portal: ein aktueller Browser (Chrome, Edge, Firefox, Safari der letzten Jahre).
- Für Erinnerungen am Ort: ein Handy mit der GateControl-App, die Orte kennt, und der Standort-Erlaubnis „Immer erlauben“. Für „Zuhause“ und die Regel-Orte: das Plugin **Familie 1.22.0** oder neuer. Die Ortssuche ist freiwillig.

## Einrichten

1. Installieren und lizenzieren. Unter **Einstellungen › Plugins › Notizen & Aufgaben › Einstellungen** die **Zeitzone** prüfen (bestimmt „heute“ und die Erinnerungen).
2. Festlegen, mit wem man **teilen** darf: mit allen, nur in der Familie und im Team, oder mit niemandem.
3. Unter **Einstellungen › Aufgaben aus anderen Plugins** (Zahnrad unten links im Tab) die Plugins abwählen, die hier nicht erscheinen sollen. Die Statuszeile oben sagt, welche Quellen verbunden sind.
4. Fertig: Im Portal gibt es den Tab **„Notizen & Aufgaben“**, auf der Startseite die Kachel **„Mein Tag“**.

## Aufgaben

- **Schnell hinzufügen:** oben ins Feld tippen und Enter – oder **Strg N**. Das Plugin versteht z. B. „morgen 9 Uhr Zahnarzt anrufen, wichtig, #gesundheit“: morgen 9:00, Erinnerung 9:00, wichtig, Liste „Gesundheit“. Unter dem Feld steht, was erkannt wurde. Siehe [Schnell-Eingabe](#schnell-eingabe).
- **Abhaken:** der Kreis vorne. Eine wiederholte Aufgabe bekommt gleich die nächste (mit denselben Unteraufgaben, wieder offen).
- **Erinnerung:** Zur gesetzten Zeit kommt eine Meldung mit **Erledigt**, **In 1 Std.** und **Heute Abend** (abends „Morgen früh“). Die Abend- und die Morgen-Zeit sind deine Uhrzeiten aus „Einstellungen“. Eine Aufgabe nur mit Datum bekommt keine eigene Meldung – bleibt sie offen, steht sie am nächsten Morgen unter „Gestern offen geblieben“.
- **Gestern offen geblieben:** die Karte oben in „Mein Tag“. **Erledigt** hakt ab, **Heute** legt die Aufgabe auf heute (die Uhrzeit bleibt), **Verschieben** bietet Morgen, Am Wochenende und ein anderes Datum. Die Karte bleibt, bis jede Zeile entschieden ist.
- **Im Kalender:** Aufgaben mit Datum und Uhrzeit stehen als Termin von 30 Minuten im Kalender „Aufgaben“ des Plugins Mail, bei der Person, der sie zugewiesen sind (sonst bei der, die sie angelegt hat). Erledigte bleiben als „✓ …“ stehen, gelöschte verschwinden. Der Kalender „Aufgaben“ ist immer ein GateControl-eigener Kalender in Mail.
- **Details:** eine Aufgabe antippen – rechts erscheinen Unteraufgaben, „In Mein Tag“, Fällig, Erinnerung, Wiederholen, Zugewiesen, Liste, Anhänge und Notiz.
- **Listen und Gruppen:** das **„+“** an „Meine Listen“ öffnet „Neue Liste oder Gruppe“. Eine Gruppe ist ein Ordner für mehrere Listen; „Gruppe auflösen“ lässt die Listen stehen. Gruppen gelten nur für dich.
- **⋯ an einer Liste:** Bearbeiten (Name, Farbe, Symbol, Gruppe, Einkaufstag, Erinnerung am Morgen), **Teilen …**, In Gruppe verschieben, Löschen. Die Standardliste „Aufgaben“ lässt sich umbenennen, aber nicht löschen.
- **Teilen:** Namen eintippen, Person hinzufügen und **Bearbeiten** oder **Ansehen** wählen. Wer eine geteilte Liste bekommt, sieht sie sofort und erhält eine Mitteilung. Wer nur mitmacht, findet am ⋯ „In ‚Mein Tag‘ zeigen“ und „Liste verlassen“.
- **Einkaufstag:** An den gewählten Wochentagen steht die Liste oben in „Mein Tag“ – bei allen Mitgliedern. Wer das nicht möchte, schaltet es am ⋯ der Liste nur für sich aus.
- **Löschen** fragt nach und sagt, was mit den Aufgaben passiert; danach gibt es „Rückgängig“. **Gelöschtes** liegt 30 Tage im Papierkorb und ist danach weg.

## Orte

- **Ort setzen:** In der Aufgabe die Zeile **„Ort“** öffnen. Du wählst einen deiner Orte, einen Treffer der Suche, **„Jeder Lidl“** (erinnert an der ersten Filiale, an der du ankommst) oder setzt einen **Punkt auf der Karte** und gibst ihm einen Namen. Darunter legst du fest: **Beim Ankommen** oder **Beim Verlassen**. „Ohne Ort“ nimmt ihn wieder weg.
- **Aus dem Text:** Die Schnell-Eingabe erkennt eine Art von Ort („beim Baumarkt“, „an der Apotheke“, „Tankstelle“), einen Namen („bei Lidl“), eine Adresse („Ringstraße 21“) und deine eigenen Orte („bei Oma“, „zu Hause“). Ein eigener oder gemerkter Ort wird direkt eingesetzt; sonst öffnet ein Tipp auf den Baustein „Ort: Baumarkt …“ die Auswahl. Der Baustein lässt sich wegnehmen.
- **Meine Orte** verwaltest du unter **Einstellungen** (Zahnrad unten links) **› Orte**: neuen Ort merken (Name, Punkt auf der Karte oder Adresse, Umkreis 50–2000 m), ändern, löschen, „nicht mehr merken“. Eine Aufgabe behält ihren Ort, auch wenn du ihn aus der Liste löschst.
- **Ortssuche:** Im Portal wird in der Nähe eines deiner Orte gesucht („in der Nähe von Zuhause“), auf dem Handy in der Nähe deines Standorts. Die Treffer stehen nach Entfernung, früher gewählte zuerst; die Minuten sind aus der Entfernung geschätzt. Gesucht wird erst, wenn du „Suchen“ drückst oder die Auswahl öffnest – nie beim Tippen.
- **Was dabei deinen Server verlässt:** nur das Suchwort und deine **auf etwa einen Kilometer gerundete** Position – an einen Kartendienst von OpenStreetMap. Dein Name, dein Gerät und dein genauer Standort gehen nicht mit. Gespeichert oder protokolliert wird die Position nicht.
- **Ohne Ortssuche** (Voreinstellung) funktionieren deine gemerkten Orte und die Karte. Es verlässt dann keine Suchanfrage deinen Server.
- **In der Nähe:** Hängt eine Aufgabe an einem Baumarkt, achtet dein Handy zusätzlich auf bis zu fünf weitere Baumärkte in deiner Gegend. Kommst du an einem vorbei: „Baumarkt am Ring ist gleich hier · geplant war Baumarkt Nord“. **Nicht hier** schaltet diesen einen Ort für die Aufgabe ab, **Später** gibt drei Stunden Ruhe. Je Aufgabe kommt der Hinweis höchstens einmal in drei Stunden und nicht in deiner Ruhezeit (21–7 Uhr, unter Einstellungen › Orte änderbar). Bei eigenen Orten („bei Oma“) gibt es ihn nicht.
- **Für jemand anderen:** Setzt du einer Aufgabe, die jemand anderem gehört, einen Ort, wird diese Person gefragt („… möchte dich erinnern“). Ihr Handy achtet erst nach **Annehmen** auf den Ort. Änderst du den Ort, wird neu gefragt.
- **Mit Einkaufsliste:** Hängt an der Aufgabe auch eine Liste, hat die Erinnerung am Ort den Knopf „Liste öffnen“.
- **Nie angekommen?** Die Aufgabe steht am nächsten Morgen unter „Gestern offen geblieben“, wenn sie für gestern geplant oder fällig war. Gib einer Aufgabe mit Ort ein Datum, wenn sie sich spätestens dann melden soll.
- **Wie viele Orte?** Android erlaubt einer App 100 überwachte Orte. Die Orts-Erinnerungen des Familien-Plugins haben Vorrang; „Notizen & Aufgaben“ nimmt, was übrig ist (höchstens 60), die dringendsten Aufgaben zuerst.

### Ortssuche einschalten (Administrator)

Unter **Einstellungen › Plugins › Notizen & Aufgaben › Einstellungen › Orte** steht **„Ortssuche im Internet“**:

| Wahl | Bedeutung |
|---|---|
| Aus (Voreinstellung) | Keine Suche. Gemerkte Orte und die Karte funktionieren. |
| Öffentlicher Dienst von OpenStreetMap (Nominatim) | Dein Server fragt `nominatim.openstreetmap.org`. Dafür gelten dessen [Nutzungsbedingungen](https://operations.osmfoundation.org/policies/nominatim/): höchstens eine Anfrage pro Sekunde für die ganze Installation, nur Suchen, die eine Person ausgelöst hat, kein Massenabruf. Der Dienst läuft auf gespendeten Servern, ohne Zusage, und kann den Zugang entziehen. Für einen Haushalt gedacht. |
| Eigener Dienst | Ein selbst betriebenes Nominatim. Die Adresse trägst du unter **Zugriffsziele › Ortssuche** ein. |

Das Plugin hält die Regeln des öffentlichen Dienstes von sich aus ein: eine Anfrage nach der anderen mit gut einer Sekunde Abstand, ein Zwischenspeicher, höchstens 30 neue Suchen je Person und Stunde. Die Statuszeile auf der Einstellungsseite sagt, was gerade gilt.

## Aus anderen Plugins

Was Familie (Aufgaben, Einkaufslisten), Mail („Zu tun“, markierte Mails), Drive (Fristen aus Rechnungen und Bescheiden), Schule (Hausaufgaben, Arbeiten, Elternabende) und Alltag (Müllabfuhr am Vorabend) zu erledigen haben, steht in „Mein Tag“ und unter „Aus anderen Plugins“.

- **Das Original bleibt im Plugin.** Abhaken hier hakt dort ab; antippen zeigt „Aus Mail … öffnen“.
- Brauchst du eigene **Unteraufgaben, eine Notiz oder eine Erinnerung** dazu: „Unteraufgaben, Notiz, Erinnerung …“ – dann wird daraus eine Aufgabe hier. Erledigt hier = dort erledigt.
- **Einstellungen › Aufgaben aus anderen Plugins** (Zahnrad unten links): je Quelle an/aus, „Aufgaben der Kinder zeigen“ (alle / nur mir zugewiesene / keine), „Einkaufslisten in Mein Tag“, „Markierte Mails als Aufgabe“, „Erinnern um“ für die Müllabfuhr am Vorabend. Mail-Konten und Kinder lassen sich einem Bereich zuordnen („Arbeit (Microsoft 365) → Arbeit“) oder ausblenden. „Jetzt abgleichen“ holt den Stand sofort.
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
| beim Baumarkt, an der Apotheke, bei Lidl, bei Oma, zu Hause, Ringstraße 21 | ein Ort (siehe [Orte](#orte)) |

Englisch geht auch: „tomorrow 5 pm“, „every monday“, „in 2 weeks“.

## Umziehen

### Von Microsoft To Do

1. **Einstellungen › Umziehen › Microsoft To Do:** dein Microsoft-Konto aus Mail wählen.
2. Beim ersten Mal **„Bei Microsoft zustimmen“**: auf microsoft.com/devicelogin den angezeigten Code eingeben. Microsoft fragt, ob GateControl deine Aufgaben lesen und ändern darf.
3. Die Listen erscheinen mit der Zahl der offenen Aufgaben; Listen der Arbeit stehen schon auf „Arbeit“. Wählen, ob **erledigte Aufgaben** mitkommen (z. B. letzte 90 Tage) und ob in einer **Übergangszeit in beide Richtungen** abgeglichen wird.
4. **„… Aufgaben übernehmen“.** Der Umzug läuft im Hintergrund weiter, auch wenn du die Seite schließt.

Nichts wird in To Do gelöscht. Den Abgleich beendest du unter **Einstellungen › Umziehen › Im Abgleich mit To Do › Abgleich beenden** – die Liste bleibt hier.

### Von Synology DS Note

1. In DS Note: **Einstellungen › Importieren/Exportieren › Exportieren** – du bekommst eine .nsx-Datei.
2. **Einstellungen › Umziehen › Synology DS Note › Export-Datei (.nsx) wählen.** Der Browser liest die Datei selbst; nur Bilder und Anhänge werden einzeln hochgeladen.
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
| Aufgaben mit Uhrzeit in den Kalender eintragen | an (Standard) / aus. Braucht das Plugin Mail ab 1.15.0; ohne Mail geschieht nichts, kommt es später dazu, werden die offenen Aufgaben nachgetragen. Aus: die Termine der Aufgaben werden entfernt. |
| Aus anderen Plugins | Familie, Mail, Drive, Schule, Alltag einzeln |
| Ortssuche im Internet | Aus (Standard), Öffentlicher Dienst von OpenStreetMap, Eigener Dienst – siehe [Orte](#orte) |
| Umzug | Microsoft To Do, Abgleich in beide Richtungen, DS Note |
| Größte Datei, Platz je Person | für Bilder und Anhänge |

Jede Person hat zusätzlich eigene **„Einstellungen“** (Zahnrad unten links): unter „Benachrichtigungen“ den Schalter **Morgens: „Gestern offen geblieben“** mit der **Uhrzeit des Morgen-Hinweises**, unter „Kalender“ den Schalter **Aufgaben mit Uhrzeit in meinen Kalender „Aufgaben“ eintragen** (sichtbar, wenn Mail installiert und die Einstellung des Administrators an ist).

## Ohne Verbindung (Apps)

- Die App zeigt den letzten Stand, auch ohne Verbindung. Ab Version 1.1.0 dieses Plugins kannst du dabei auch **anlegen, ändern und löschen** – Aufgaben, Unteraufgaben, Listen, Notizbücher und Notizen. Was noch nicht beim Server ist, ist mit „Noch nicht gesendet“ markiert.
- Sobald der Server erreichbar ist, sendet die App alles in der Reihenfolge, in der du es gemacht hast. Eine Unteraufgabe einer offline angelegten Aufgabe kommt nach ihrer Aufgabe.
- **Anderswo geändert:** Hat jemand dasselbe Feld inzwischen geändert, bekommt der Eintrag den Hinweis „Anderswo geändert“. Beim Öffnen wählst du „Meine behalten“ (deine Fassung überschreibt) oder „Die andere laden“ (deine Änderung wird verworfen).
- **Tresor-Notizen** lassen sich offline nur ändern, solange der Tresor auf dem Handy geöffnet ist. Gespeichert und gesendet wird nur der verschlüsselte Text – nie lesbar auf dem Handy oder dem Server.
- Bilder und Anhänge hinzufügen, teilen und der Umzug brauchen weiter eine Verbindung.

## Fragen

**Warum steht eine Aufgabe aus Mail nicht da?** Unter „Einstellungen › Aufgaben aus anderen Plugins“ prüfen, ob Mail verbunden und eingeschaltet ist und ob das Konto ausgeblendet ist. „Jetzt abgleichen“ holt den Stand.

**Erfährt der Server, wo ich bin?** Nein. Dein Handy überwacht die Orte selbst und meldet dem Server höchstens „dieser Ort hat ausgelöst“, damit zwei Geräte nicht beide klingeln. Für die Ortssuche bekommt der Server eine auf etwa einen Kilometer gerundete Position, die er nicht speichert.

**Warum meldet sich eine Aufgabe am Ort nicht?** Erinnert wird nur vom Handy: Es braucht die Standort-Erlaubnis „Immer erlauben“ und eine App-Version, die Orte kennt. Hat jemand anderes den Ort gesetzt, musst du erst zustimmen. Sind sehr viele Orte offen, überwacht das Handy die dringendsten.

**Wer sieht meine Notizen?** Nur du – außer in geteilten Notizbüchern. Tresor-Notizbücher kann auch der Server nicht lesen.

**Findet die Suche Text in Bildern?** Wenn die App den Text eines Bildes erkannt hat, ja. Das Portal erkennt keinen Text in Bildern.
