<!-- version: 1.25.0 -->
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

- GateControl **1.293.0** oder neuer (Telegram-Brücke; Signal-Brücke ab 1.291.0; Gruppenchats für GateControl-Gruppen ab 1.200.0, Virenscan ab der Version nach 1.222.0).
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

**Der ältere Signal-Verlauf fehlt.**
Signal liefert ihn nur einmal beim Verknüpfen, und nur wenn du auf dem Handy „Übertragen“ wählst. GateControl nimmt höchstens 30 Tage. Wer später umstellt, bekommt bei Signal nichts mehr.

**Der ältere WhatsApp-Verlauf fehlt.**
Er kommt nur beim Verknüpfen und erscheint nachts. Steht „Älteren Verlauf laden“ auf „Aus“, oder hat der Administrator ihn abgeschaltet, kommt keiner. WhatsApp schickt nicht für jeden Chat alles mit.

**Alte Nachrichten sind weg.**
Der Administrator hat eine Aufbewahrung eingestellt, oder der Chat ist selbstlöschend.

## Neu in 1.25.0

- **WhatsApp-Status in der Status-Reihe.** Die Status deiner WhatsApp-Kontakte stehen oben in der Status-Reihe der Chats, gemischt mit den GateControl-Personen: ungesehen zuerst, dann die neuesten. Du erkennst sie am WhatsApp-Logo am Bild. Der Chat „WhatsApp Status Broadcast“ verschwindet aus der Liste, aus der Suche und aus dem Ungelesen-Zähler.
- **Ansehen:** Bild, Video und Text, ein Text-Status in der App-Farbe (WhatsApp liefert Farbe und Schrift nicht mit). Es gibt keine Zuschauerliste.
- **Antworten und reagieren:** Antwort und Reaktion gehen als normale Nachricht in deinen WhatsApp-Chat mit dieser Person, eine Reaktion als „❤️ auf deinen Status“. Direkt auf einen Status reagieren kann die Brücke nicht. Das steht auch unter dem Antwortfeld.
- **„Gesehen“:** Der Status wird hier als gesehen markiert (grauer Ring). WhatsApp erfährt es nur, wenn du in den Einstellungen unter „Status“ den Schalter **„WhatsApp mitteilen, wenn ich einen Status ansehe“** einschaltest (Standard aus). Das wirkt nur mit eingeschalteten Lesebestätigungen und nur für Status, die du wirklich angesehen hast.
- **24 Stunden:** Wie bei WhatsApp. Danach werden Status und Datei gelöscht. Löscht der Kontakt seinen Status, verschwindet er sofort. WhatsApp-Status lösen keine Mitteilung aus.
- **Wo:** im Portal, in der Android-App und im Windows-Client mit ihren neuen Versionen. Braucht GateControl mit `gc.bridges` Version 12. Mit einem älteren GateControl bleibt alles wie bisher.

## Neu in 1.24.0

- **Telegram im Messenger.** Unter „Verknüpfte Dienste“ verknüpfst du dein eigenes Telegram. Telegram-Chats stehen mit Papierflieger-Logo in derselben Liste, mit Chip „Telegram“; Telegram-Kanäle stehen auf der Kanal-Seite.
- **Zwei Wege:** Am PC ist der QR-Code vorgewählt (Telegram › Einstellungen › Geräte › Desktop-Gerät verbinden). Auf dem Handy geht es mit der Telefonnummer: Telegram schickt den Code in die Telegram-App. Hast du die zweistufige Bestätigung an, fragt GateControl einmal das Passwort ab – es geht nur an Telegram und wird nirgends gespeichert.
- **Bots** sind Einzelchats mit dem Zusatz „Bot“; ihre Knöpfe gehen nur in Telegram. **Große Gruppen** ab 200 Mitgliedern sind anfangs stumm. Dateien, die zu groß für GateControl sind, öffnest du in Telegram. **Geheime Chats** kommen nie an, sie bleiben auf deinem Handy.
- **Für Administratoren:** Telegram startet erst mit einer eigenen Anwendungskennung. In der Karte „Brücken“ → Telegram → „Einrichten“: bei my.telegram.org mit deiner Telegram-Nummer anmelden, unter „API development tools“ eine Anwendung anlegen (Name „GateControl“, Plattform „Other“) und `api_id` und `api_hash` ins Formular eintragen – nie in einen Chat oder eine Datei. GateControl speichert beides verschlüsselt und zeigt es nie wieder an. Der Schalter „Animierte Sticker umwandeln“ wirkt jetzt für Telegram.
- **Eltern** schalten in Familie je Kind Telegram frei und zusätzlich „Telegram-Kanäle“ (Standard aus).

## Neu in 1.23.0

- **Signal im Messenger.** Unter „Verknüpfte Dienste“ verknüpfst du dein eigenes Signal – wie Signal Desktop, als verknüpftes Gerät. Signal-Chats stehen mit blauem Logo in derselben Liste wie GateControl und WhatsApp, mit Chip „Signal“, Gruppen inklusive.
- **Nur per QR-Code.** Signal verknüpft nur per Code auf einem zweiten Bildschirm. In der App tippst du „Im Portal fortsetzen“ oder „Im Windows-Client fortsetzen“ – der Schritt öffnet sich dort, angemeldet als du, und du scannst ihn mit Signal auf dem Handy. Der Code erneuert sich von selbst.
- **Älterer Verlauf:** Signal fragt nach dem Scannen auf dem Handy, ob es den Verlauf überträgt. GateControl übernimmt davon höchstens die letzten 30 Tage, nachts und in Häppchen. Später geht das bei Signal nicht mehr.
- **Sicherheitsnummern** prüfst du nur in der Signal-App: Die Brücke nimmt neue Schlüssel von selbst an, oben im Signal-Chat steht ein Hinweis dazu.
- **Verschwindende Nachrichten** aus Signal gelten auch hier („Nachrichten verschwinden nach 1 Woche“); ändern geht nur in Signal. Eine **Einmal-Ansicht** öffnest du in Signal. Sticker kommen als Bild.
- **Erkennen je Dienst:** Nach dem Verknüpfen fragt der Messenger einmal: „Dürfen andere auf diesem Server dich an deinem Signal erkennen?“ – unabhängig von WhatsApp, änderbar in „Mein Profil“ unter „Erkennung“.
- **Für Administratoren:** In der Karte „Brücken“ eine Zeile für Signal und der Schalter „Animierte Sticker umwandeln“ (Standard aus: Standbild). Kennt die `docker-compose.yml` des Servers Signal noch nicht, sagt die Karte das – tausche sie einmal gegen die neue aus.

## Neu in 1.22.0

- **„Wer sieht dein Bild?“ gilt jetzt in ganz GateControl.** Die Einstellung steht nicht mehr im Messenger, sondern in deinem Profil („Mein Profil“ im Portal, Profil in der App): Alle auf diesem Server, **Kontakte**, Familie oder Nur ich. Sie gilt in Chats, in Familie, in Drive und überall sonst.
- **Kontakte** heißt: deine Familie und alle, mit denen du einen Einzelchat oder eine Gruppe hast. Wer dein Bild nicht sehen darf, sieht deine Initialen in deiner Farbe – in der Liste, im Chatkopf, als Absender in Gruppen und in der Push-Nachricht.
- **Einmal übernommen:** Beim ersten Start mit dem neuen GateControl übernimmt der Messenger deine bisherige Wahl („Familie“ bleibt Familie, „Niemand“ wird „Nur ich“) – nur, wenn du im Profil noch nichts gewählt hast.
- In den Privatsphäre-Einstellungen der App führt „Profilbild“ jetzt zur Profilseite. Ältere Apps, die die Einstellung noch im Messenger ändern, ändern sie im Profil.
- WhatsApp, Signal und Telegram bekommen dein GateControl-Bild nie.
- Auf einem älteren GateControl bleibt alles wie bisher im Messenger.

## Neu in 1.21.0

- **Eine Person, ein Chat.** Wer dir über GateControl und über WhatsApp schreibt, kann in deiner Liste einmal stehen – mit einem gemeinsamen Verlauf, nach der Zeit gemischt. Jede Nachricht trägt das Logo ihres Weges; oben im Chat filterst du „Alle“, „GateControl“ oder „WhatsApp“. Hinter dem Namen in der Liste stehen die Wege.
- **Erst fragen, dann zusammenführen.** Erkennt GateControl dieselbe Person auf zwei Wegen, erscheint eine Karte über der Liste („„Schatzimausi 💕“ bei WhatsApp ist vielleicht Jenny Backes.“). Zusammengeführt wird erst nach deinem „Zusammenführen“; du wählst dabei den Namen (vorgewählt der des GateControl-Kontos). „Nicht jetzt“ blendet den Vorschlag 7 Tage aus, „Nicht mehr vorschlagen“ für immer. GateControl erkennt nur, wer zugestimmt hat (im Profil unter „Erkennung“) – nie nach dem Namen.
- **Von Hand:** In der Chat-Info eines Chats mit einer Person „Mit Person zusammenführen …“ – ein GateControl-Konto oder ein anderer Chat. Gruppen und Kanäle werden nie zusammengeführt.
- **Antworten:** Deine Antwort geht automatisch über den Weg der letzten Nachricht, die du bekommen hast (bei Gleichstand und ohne eingehende Nachricht über GateControl). Das Eingabefeld nennt den Weg („Nachricht über WhatsApp“); geht sie über WhatsApp, erinnert eine Zeile daran, dass die Verschlüsselung von WhatsApp an der Brücke neben deinem Server endet. Eine Antwort auf eine bestimmte Nachricht geht über deren Weg.
- **Für die Person:** Ungelesen zählt beide Wege, Stumm und Archiv gelten für beide, eine Push-Nachricht heißt „Jenny Backes · über WhatsApp“. Die Suche findet alle Namen der Person.
- **Nur für dich:** Die andere Person sieht davon nichts. „Trennen“ in „Wege von …“ zeigt die Chats wieder getrennt – keine Nachricht geht verloren.
- **Beim Verknüpfen von WhatsApp** fragt der Messenger einmal: „Dürfen andere auf diesem Server dich an deinem WhatsApp erkennen?“ (Standard: nein; änderbar in „Mein Profil“ unter „Erkennung“).
- Vorschläge und die Frage beim Verknüpfen brauchen einen GateControl-Server mit Nutzerprofil und Brücken in der neuen Fassung; von Hand zusammenführen geht mit jedem Server mit Brücken.

## Neu in 1.20.0

- **WhatsApp-Kanäle bekommen eine eigene Seite.** Kanäle, denen du in WhatsApp folgst, stehen nicht mehr zwischen deinen Chats, sondern unter „Kanäle“ (im Portal ein Eintrag über der Liste, mit grauem Punkt bei neuen Beiträgen). Ein Beitrag sieht aus wie in WhatsApp: Vorschaubild, Titel, Domain, Text mit Format und klickbarem Link. Kanäle sind nur zum Lesen da, melden sich standardmäßig nicht per Push (die Glocke im Kanal schaltet das ein) und zählen nicht bei „Ungelesen“. Du kannst auf einen Beitrag reagieren; Reaktionen anderer zeigt WhatsApp nur in der eigenen App. Lehnt WhatsApp Reaktionen in Kanälen ab, blendet GateControl das Reagieren dort aus.
- **Gruppen, in denen nur Admins schreiben,** zeigen „Nur Admins schreiben in dieser Gruppe.“ statt des Eingabefelds.
- **WhatsApp-Gruppen** werden als Gruppen erkannt (vorher teils als Einzelchat).
- **Fett, kursiv, durchgestrichen, Code** aus WhatsApp erscheinen so; **Links sind in allen Chats klickbar**, Link-Vorschauen mit Bild.
- Statt „WA“ steht das **WhatsApp-Logo** am Bild eines Chats.
- Braucht einen GateControl-Server, dessen Brücken das unterstützen (Vorschau).

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
