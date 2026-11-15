<!-- version: 1.19.1 -->
# Messenger

## Was das Plugin kann

- **Chats zwischen den GateControl-Konten** – in der GateControl-App (Tab „Chats“), im Windows-Client und im Portal-Tab „Chats“.
- **Einzel- und Gruppenchats** mit Text, Bildern, Videos, Sprachnachrichten, Dateien und Standort; Antworten mit Zitat, Reaktionen, Bearbeiten und Löschen, Lesebestätigungen, „schreibt …“, selbstlöschende Chats.
- **Push mit Antwortfeld.**
- **Status und Storys, Abstimmungen, Termine mit Zusagen, Live-Ankunft** und **Haus-Aktionen** (z. B. Licht oder Tür aus einem anderen Plugin) im Chat.
- **Mitteilungen in Chats:** Jede Person kann wählen, ob die Mitteilungen eines Themas in GateControl, im Familien-Chat oder in einem eigenen Chat erscheinen.
- **Gruppenchats für GateControl-Gruppen**, die sich von selbst mit den Mitgliedern abgleichen.
- **In Drive speichern:** Bilder, Sprachnachrichten und Dateien eines Chats ins Plugin Drive.

Alles bleibt auf deinem Server. Texte, Standorte, Dateinamen und Gruppentitel werden verschlüsselt gespeichert. Administratoren können private Chats nicht lesen.

## Voraussetzungen

- GateControl **1.204.0** oder neuer (Gruppenchats für GateControl-Gruppen ab 1.200.0, Virenscan ab der Version nach 1.222.0).
- Eine Lizenz für das Plugin.
- Für „In Drive speichern“: das Plugin Drive. Für den Familien-Chat: das Plugin Familie.

## Einrichten

Nach der Installation kann jedes aktive GateControl-Konto chatten. Als Administrator stellst du auf der Seite **„Übersicht“** ein:

- maximale Länge von Sprachnachrichten, **Aufbewahrung** (unbegrenzt, 30, 90, 180, 365, 730 Tage), selbstlöschende Chats erlauben,
- wie lange man eine Nachricht für alle bearbeiten oder löschen darf (Standard 15 Minuten),
- Vorgaben für neue Konten (Lesebestätigungen, „schreibt …“, Inhalt in Mitteilungen),
- „Storys erlauben“ und „Haus-Aktionen in Chats“ (beide Standard an), wie lange eine Anfrage offen bleibt, wer Anfragen ohne Namen freigibt, „Kinder dürfen anfragen“,
- **Gruppenchats für GateControl-Gruppen:** Gruppen wählen, für die der Messenger einen Gruppenchat führt. Die Familie-Gruppe führt das Plugin Familie selbst.

Dateien speichert GateControl verschlüsselt (Standard 10 GB insgesamt, 25 MB je Datei). Die Grenzen änderst du unter **Einstellungen › Plugins › Messenger › Übersicht › Medien**. In Sicherungen sind die Dateien nur mit „Plugin-Medien im Backup“.

## Benutzen

- **Chat beginnen:** in der App oder im Portal eine Person oder mehrere wählen.
- **Anhängen:** Datei oder Foto, Standort (Karte, „Mein Standort“), Abstimmung, Termin, Haus-Aktion.
- **Nachricht antippen bzw. Menü:** antworten, reagieren, bearbeiten, löschen, anheften, „Erinnern“, „In Drive speichern“ (nach Meine Dateien › Messenger).
- **Chat-Info:** Mitglieder, geteilte Medien, archivieren, exportieren, blockieren.
- **Status und Storys:** oben in der Liste „Mein Status“; Storys als Text oder Foto.
- **Wo Mitteilungen erscheinen:** in den Einstellungen des Messengers je Thema GateControl, Familien-Chat oder eigener Chat. Gesperrte Themen bleiben immer in GateControl.
- Der angeheftete Eintrag **„GateControl“** ist dein Posteingang von GateControl.

Im Portal öffnen sich Dateien außer Bildern, Ton und Video in den Apps.

## Berechtigungen

- Jedes aktive Konto darf chatten. Kiosk-Geräte (Wand-Tablet) haben keinen Tab „Chats“ und werden nicht als Person angeboten.
- In Gruppenchats für GateControl-Gruppen ändern Mitglieder weder Mitglieder noch Titel und können nicht austreten; Chat-Admins sind die Leitungen der Gruppe.
- Den Familien-Chat als Ziel für Mitteilungen dürfen nur Administratoren und Eltern aus dem Plugin Familie für den Haushalt einstellen.
- Administratoren sehen auf „Übersicht“ und „Protokoll“ nur Zahlen und Fehler – nie Texte, Titel, Dateinamen, Mitglieder oder wer wem schreibt.
- Brücken zu anderen Messengern (nur wenn der Server sie anbietet): Administratoren schalten sie und sehen Zustand, Arbeitsspeicher und die Zahl der verknüpften Personen – keine Nummern, Kontakte oder Inhalte. Verknüpfen kann jede Person nur ihr eigenes Konto; Kinder erst, wenn ein Elternteil den Dienst freigeschaltet hat (Plugin Familie, Karte „Andere Messenger“). Nimmt ein Elternteil die Freigabe zurück, wird die Verknüpfung des Kindes getrennt – GateControl hält im Aktivitätsprotokoll fest, wer das war.

## Häufige Fragen / Fehlersuche

**„Nicht gesendet – Schadsoftware gefunden.“**
Der Virenscan von GateControl hat in der Datei etwas gefunden. Gesperrte Dateien zeigen „Datei gesperrt“.

**Eine Datei lässt sich im Portal nicht öffnen.**
Das Portal zeigt nur Bilder, Ton und Video. Andere Dateien öffnest du in der App.

**„Mein Standort“ fragt nicht nach.**
Der Browser erlaubt den Standort im Portal nicht. Setz den Punkt auf der Karte von Hand.

**Ich finde den Familien-Chat nicht.**
Den führt das Plugin Familie (Seite „Funktionen“ › Messenger-Gruppe).

**Der ältere WhatsApp-Verlauf fehlt.**
Er kommt nur beim Verknüpfen und erscheint nachts. Steht „Älteren Verlauf laden“ auf „Aus“, oder hat der Administrator ihn abgeschaltet, kommt keiner. WhatsApp schickt nicht für jeden Chat alles mit.

**Alte Nachrichten sind weg.**
Der Administrator hat eine Aufbewahrung eingestellt, oder der Chat ist selbstlöschend.

## Neu in 1.19.1

- **Profilbilder aus WhatsApp kommen nach.** Ließ sich das Bild eines Chats oder Kontakts einige Male nicht holen (z. B. vor GateControl 1.278.1, als der Server die Antwort der Brücke nicht annahm), gab der Messenger es bisher für immer auf – der Chat zeigte nur Initialen. Jetzt versucht er es später erneut, mit wachsendem Abstand (höchstens alle 6 Stunden), und holt beim Start einmal alle Bilder nach, die bisher fehlen. Zeigt ein Kontakt sein Profilbild in WhatsApp nicht für dich (Datenschutz), bleiben ehrlich die Initialen.
- **Initialen ohne Fragezeichen-Raute:** Ein Name mit Emoji („Schatzimausi 💕“) zeigt „S“ statt „S“ mit einer Fragezeichen-Raute. Initialen sind nur noch Buchstaben und Ziffern; ein Name nur aus Emoji zeigt das Personen-Symbol.

## Neu in 1.19.0

- **Chats über WhatsApp heißen wie der Kontakt, nie wie seine Nummer.** Kennt WhatsApp noch keinen Namen (z. B. direkt nach dem Verknüpfen), heißt der Chat nach dem Kontakt in deinem Adressbuch (Mail), sonst „WhatsApp-Kontakt“ – bis der Kontakt seinen Namen zeigt. Chats und Kontakte, die bisher nur eine Telefonnummer als Namen hatten, werden beim Start einmal korrigiert (Protokoll: „… korrigiert“). Die Nummer verlässt deinen Server dafür nicht.
- **Kein endloses „wird geladen …“ mehr:** Lässt sich ein Bild, Video oder eine Datei aus WhatsApp nach einigen Versuchen nicht holen, steht in der Zeile „kam nicht an“ mit **„Erneut versuchen“**. Ist nur die Brücke gerade nicht erreichbar, wartet die Datei weiter. Das Protokoll nennt den Grund („Brücke: Datei ließ sich nicht holen“), ohne Namen und Nummern.

## Neu in 1.18.0

- **Neuer Chat mit deinen Kontakten:** „Neuer Chat“ (Stift) zeigt unter einem Suchfeld drei Abschnitte: **GateControl** (die Konten auf deinem Server), **WhatsApp** (deine WhatsApp-Kontakte) und **„Aus deinem Adressbuch“** (deine Kontakte mit Telefonnummer aus Mail). Lange Abschnitte zeigen die ersten Treffer und „Alle … anzeigen“. Gibt es schon einen Chat, steht „Chat öffnen“ in der Zeile.
- **WhatsApp-Kontakt antippen** startet den Chat sofort, ohne Prüfung.
- **Adressbuch-Kontakt antippen** prüft genau diese eine Nummer bei WhatsApp, dann geht der Chat auf. Hat der Kontakt mehrere Nummern, wählst du sie in der Zeile – Mobil zuerst, Festnetz ausgegraut. Gibt es unter der Nummer kein WhatsApp, merkt sich GateControl das 30 Tage (ohne die Nummer zu speichern) und fragt nicht erneut.
- **Dieselbe Person nur einmal:** Steht eine Nummer aus deinem Adressbuch auch in WhatsApp, erscheint die Person unter WhatsApp mit dem Namen aus deinem Adressbuch und „auch in deinem Adressbuch“.
- **„Nicht dabei? Nummer eingeben“** unten öffnet den bisherigen Dialog. Tippst du eine Nummer ins Suchfeld, steht unten „… bei WhatsApp prüfen“.
- **Bremse:** Jedes Antippen eines Adressbuch-Kontakts, das WhatsApp fragt, zählt wie eine getippte Nummer (voreingestellt 10 je Stunde). WhatsApp-Kontakte und bestehende Chats gehen immer.
- **Datenschutz:** Deine WhatsApp-Kontakte bleiben auf deinem Server – die Apps bekommen Namen, keine Nummern. Eine Nummer aus deinem Adressbuch geht nur dann an WhatsApp, wenn du den Kontakt antippst. Das Protokoll notiert nur „WhatsApp-Nummer geprüft“ mit Quelle und Ergebnis.
- **Voraussetzungen:** ein GateControl mit der Brücken-Vorschau (Stufe 4c); für das Adressbuch das Plugin Mail ab 1.16.0. Kinder ohne Freigabe der Eltern für neue Chats sehen nur GateControl.

## Neu in 1.17.0

- **Älteren Verlauf laden:** Unter **„Verknüpfte Dienste“** wählst du, wie viel älterer Verlauf beim Verknüpfen mitkommt: **Aus**, **Letzte 30 Tage** (voreingestellt) oder **Alles**, was WhatsApp mitschickt. Die Wahl gilt beim (nächsten) Verknüpfen.
- **Nachts, in kleinen Portionen:** Der ältere Verlauf erscheint über Nacht in deinen Chats – an der richtigen Stelle, ohne Push und als gelesen. Schreibt dir vorher jemand in einem dieser Chats, kommt sein Verlauf gleich mit.
- **Dateien aus dem Verlauf** (Bilder, Videos, Sprachnachrichten) stehen als Zeile „älterer Verlauf“ mit **„Laden“** da – erst dann holt GateControl sie. Sehr alte Dateien hat WhatsApp oft nicht mehr; dann steht da, dass du sie in WhatsApp ansehen kannst.
- **„Handy seit … Tagen nicht gesehen“:** War dein Handy 12 Tage nicht online, bekommst du eine Mitteilung und siehst den Hinweis unter „Verknüpfte Dienste“. Öffne WhatsApp auf dem Handy – sonst trennt WhatsApp die Verknüpfung nach etwa 14 Tagen.
- **„Brücke veraltet“** steht auch da, wenn WhatsApp die Version der Brücke ablehnt. Das behebt dein Administrator mit einem GateControl-Update; neu verknüpfen musst du nicht.
- **Für Administratoren** (Karte „Brücken“ auf „Übersicht“): Älteren Verlauf erlauben oder abschalten, das Nachtfenster (voreingestellt 01:00–05:00), wo die Medien liegen (Ort ändern unter Einstellungen › Plugins › Messenger › Speicherorte – dieselben Speicherziele wie bei Drive, dort immer verschlüsselt), die tägliche verschlüsselte Sicherung des Brücken-Zustands im GateControl-Backup mit **„Jetzt sichern“**.

## Neu in 1.16.0

- **Neuer WhatsApp-Chat per Nummer:** Hast du WhatsApp unter „Verknüpfte Dienste“ verknüpft, steht in „Neuer Chat“ (Stift) unter den Reitern die Zeile **„WhatsApp-Chat mit Nummer“**. Nummer eingeben – die Vorwahl +49 ist voreingestellt, eine 0 am Anfang und Leerzeichen sind egal –, darunter steht „Wird geprüft als +49 …“. Erst auf **„Prüfen“** fragt GateControl über deine Brücke bei WhatsApp nach. Dann siehst du den Namen und startest mit **„Chat starten“** den Chat; er öffnet sich sofort.
- **Chat gibt es schon:** Hast du mit der Nummer schon einen Chat begonnen, steht „Ihr habt schon einen Chat“ und **„Chat öffnen“** – ohne neue Anfrage an WhatsApp.
- **Wenn es nicht geht,** sagt der Dialog warum: kein WhatsApp unter der Nummer, keine vollständige Nummer, zu viele Prüfungen (mit der Uhrzeit der nächsten), Brücke nicht erreichbar, WhatsApp abgemeldet („Neu verknüpfen“) oder – bei Kindern – von den Eltern gesperrt.
- **Höchstens 10 Prüfungen je Stunde** (der Administrator kann den Wert ändern), damit WhatsApp dein Konto nicht wegen vieler Nummern-Abfragen sperrt. Ungültige Nummern und Chats, die es schon gibt, zählen nicht.
- **Kinder** brauchen dafür eine zweite Freigabe der Eltern („Neue Chats per Nummer“ in der Familie-Karte „Andere Messenger“), zunächst aus. Antworten in bestehenden Chats gehen immer.
- **Datenschutz:** Zum Prüfen geht die Nummer über deine Brücke an WhatsApp. GateControl schreibt sie nicht ins Protokoll; gespeichert wird sie nur, wenn du den Chat startest.

## Neu in 1.15.0

- **Bilder, Videos, Sprachnachrichten und Dateien über WhatsApp:** Was ein Kontakt schickt, steht zuerst als „wird geladen …“ im Chat und erscheint kurz danach wie jeder andere Anhang. Es wird wie deine eigenen Anhänge auf Schadsoftware geprüft.
- Ist eine Datei zu groß für GateControl, eine Art, die GateControl nicht annimmt, oder bei WhatsApp nicht mehr da, bleibt die Zeile stehen und sagt, warum – dann in WhatsApp ansehen. Ein Standort öffnet die Kartenansicht.
- **Senden:** Über die Büroklammer schickst du Bilder, Videos und Dateien, über das Mikrofon Sprachnachrichten in einen WhatsApp-Chat. Gesendet wird erst, wenn die Prüfung auf Schadsoftware fertig ist. Manche Formate nimmt WhatsApp nicht an – dann sagt GateControl das.
- **Profilbilder:** In der Chatliste siehst du das Bild deines Kontakts oder der Gruppe.
- **Neuer Chat per Nummer:** Der Server kann schon einen Chat mit einer Telefonnummer beginnen; die Apps und das Portal bekommen die Eingabe dafür in einer späteren Version.

## Neu in 1.14.0

- **Chats über WhatsApp:** Hast du unter „Verknüpfte Dienste“ dein WhatsApp-Konto verknüpft, erscheint ein Chat mit einem Kontakt oder einer Gruppe in deiner Chatliste, sobald dort eine neue Nachricht eintrifft. Am Profilbild steht das Kennzeichen „WA“; über der Liste kannst du nach Dienst filtern.
- **Nur du** siehst diese Chats – kein anderes Familienmitglied und kein Administrator.
- **Was geht:** Text, Antworten, Reaktionen, Bearbeiten, Löschen für alle, Lesebestätigung und „schreibt …“. Unter deiner Nachricht steht, ob sie gesendet, zugestellt oder gelesen wurde – oder nicht gesendet, mit Grund und „Erneut senden“.
- **Was noch nicht geht:** Bilder, Videos, Sprachnachrichten und Dateien. Kommt so etwas an, steht im Chat eine Zeile wie „Bild – folgt; in WhatsApp ansehen“. Abstimmungen, Termine, Haus-Aktionen, Karten und Standort gibt es in diesen Chats nicht.
- **Wichtig:** Diese Chats laufen über WhatsApp und nicht nur über deinen Server. Die Verschlüsselung von WhatsApp endet an der Brücke neben deinem GateControl-Server.
- **Trennen** unter „Verknüpfte Dienste“ beendet die Zustellung; die Chats bleiben lesbar. Kinder brauchen weiter die Freigabe der Eltern.
- **Für Administratoren:** Auf „Übersicht“ erst den Hauptschalter der Brücken einschalten, dann unter „3 · Welche Dienste?“ jeden Dienst einzeln.

## Neu in 1.13.0

Nur auf einem GateControl-Server, der Brücken anbietet (dort noch eine Vorschau) und sie eingeschaltet hat – überall sonst ändert sich nichts.

- **„Verknüpfte Dienste“ im Portal:** Unter **Chats › Einstellungen › Verknüpfte Dienste** verknüpfst du dein eigenes WhatsApp-Konto. Zuerst liest und bestätigst du die Hinweise; danach wählst du **Mit Code** (Nummer eingeben, den angezeigten Code in WhatsApp unter „Verknüpfte Geräte › Gerät hinzufügen › Stattdessen mit Telefonnummer verknüpfen“ eintippen) oder **QR-Code** (auf einem zweiten Bildschirm anzeigen und mit dem Handy scannen). Die Seite zeigt, ob das Konto verknüpft ist, ob WhatsApp die Brücke abgemeldet hat („Neu verknüpfen“ – ein neuer Code genügt) und lässt dich jederzeit **trennen**.
- **Kinder:** Die Schalter der Eltern stehen jetzt im Plugin Familie (Portal, Karte „Andere Messenger“). Nimmt ein Elternteil die Freigabe zurück, wird die Verknüpfung des Kindes getrennt.
- **Für Administratoren:** Die Karte „Brücken“ zeigt „Veraltet“, wenn eine Brücke mit einer älteren Version läuft als vorgesehen, und nennt den Befehl, mit dem am Server Speicher und Schreiblast gemessen werden.
- In dieser Version lassen sich Konten verknüpfen; die Chats mit Kontakten des Dienstes folgen später.

Zuletzt in 1.12.0: die Karte „Brücken zu anderen Messengern“ auf „Übersicht“ (Schalter, Ort, Zustand je Brücke, belegter Arbeitsspeicher, Zahl der verknüpften Personen) und das Recht „Brücken zu anderen Messengern“.
