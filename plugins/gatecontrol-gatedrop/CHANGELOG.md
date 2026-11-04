# GateDrop (gatecontrol-gatedrop)

Teilen wie Quick Share – über den eigenen GateControl-Server.

## 1.5.0
- **Übersicht für Admins mit allen Sendungen:** Die Seite „Übersicht“ zeigt jetzt oben vier Kacheln – belegter Speicher
  (abgeholt / nicht abgeholt, mit Balken), angekommen in 7 Tagen (x von y Sendungen, wartend, fehlgeschlagen), der Weg
  in 7 Tagen (direkt / Server) und was nicht abgeholt ist (Anzahl, Größe, älteste) – und darunter die **Liste der
  Sendungen**: Zeit, Von (Person und Gerät bzw. Portal), An (Person, Gerät, Familie, NAS-Ordner, Drive, Link), Umfang
  (Anzahl Dateien, Größe), Weg (Direkt, Über Server, Direkt → Server, Link), Status (Empfangen, Abgeholt, Geöffnet,
  Abgelegt, „2 von 3 abgeholt“, Wartet seit …, Fehlgeschlagen mit Grund, Abgelaufen, Vom Admin entfernt) und was davon
  bis wann auf dem Server liegt. Filter (Alle, Probleme, Wartet, Direkt, Über Server, Links) mit Anzahl, Suche nach
  Person oder Gerät, Zeitraum (7 Tage, 30 Tage, alles auf dem Server); die Liste lädt seitenweise. **Dateinamen,
  Dateitypen, Texte, Links, Notizen, Pfade unterhalb des NAS-Ordners und Link-Adressen sind dort nie zu sehen** – nur
  Namen von Personen und Geräten. Die bisherigen Inhalte (Links an/aus, aktive Links, Speicherplatz, Zusammenspiel)
  bleiben darunter.
- **Aufbewahrung einstellbar:** „Nach der Abholung“ sofort / 1 / 3 / 7 Tage und „Nicht abgeholt“ 3 / 7 / 14 / 30 Tage.
  Standard 7 / 7 – damit ändert sich für bestehende Installationen nichts (die Dateien gehen wie bisher 7 Tage nach dem
  Senden). Die Einstellung gilt auch für bestehende Sendungen; Abgeholtes bleibt nie länger als nicht Abgeholtes,
  „sofort“ lässt einem laufenden Download 15 Minuten. Links für Externe behalten die beim Erstellen gewählte Laufzeit,
  die Dateien bleiben so lange.
- **Speicher freigeben:** Ein Dialog löscht die Server-Kopien von „nicht abgeholt, älter als 1 / 3 / 7 Tage“ und / oder
  „schon abgeholt“ (Anzahl und Größe live berechnet), dazu „Löschen“ je Sendung in der Liste. Die Sendung heißt dann
  beim Absender **„Vom Admin entfernt“** (Portal; Apps: `removed: true`), Empfänger, die noch nicht abgeholt haben,
  bekommen nichts mehr (offene Zustellungen, Übertragungen und Wiederholungen enden, Links werden gesperrt). Was schon auf
  Geräten, im NAS, im Drive oder im Messenger liegt, bleibt dort.
- **„Abgeholt“ nur noch mit echter Bestätigung:** Eine Zustellung an ein Gerät, das gerade online ist, war bisher sofort
  `delivered` – auch wenn die App sie nie abholte. Jetzt gilt sie erst als abgeholt (`pickedAt`), wenn das Zielgerät
  `POST sends/<id>/opened` meldet (Android und Windows tun das, sobald alles gespeichert ist), bei Direktübertragungen
  wenn das empfangende Gerät `ok` mit allen Bytes meldet, bei Personen wenn sie die Sendung öffnen (Familie: jedes
  Mitglied), bei NAS und Drive mit dem Speichern. Der Status `delivered` bleibt für ältere Apps wie bisher; neu sind
  `pickedAt` an Zustellungen und Sendungen.
- **Direktübertragung mit mehreren Dateien:** Meldet das empfangende Gerät `ok`, aber weniger Bytes als die Dateien
  haben, gilt das als fehlgeschlagen (`incomplete`) und die Zustellung nimmt den Weg über den Server – auch wenn der
  Absender schon `ok` gemeldet hat. Ein `ok` des Absenders macht einen schon begonnenen Rückfall nicht mehr rückgängig.
- **Nur Geräte mit GateDrop als Ziel:** `GET targets` bietet als eigene Geräte nur noch App-Installationen an, die
  GateDrop schon benutzt haben (eine Anfrage an die App-API; was bekannt war, übernimmt die Migration). Apps ohne GateDrop
  erscheinen nicht mehr; Sendungen an eine schon bekannte Geräte-ID gehen weiter.
- Migration 004 (Einstellungen, Abholungen, „vom Admin entfernt“, bekannte Geräte) – nur Ergänzungen. Neue
  Admin-Endpunkte nur für Admins in der Admin-Oberfläche. Keine neue GateControl-Funktion: Mindestversion bleibt 1.193.0.

## 1.4.1
- **Zustellung wartet auf die Virenprüfung statt zu scheitern:** Wird eine Datei beim Weitergeben an den Messenger, an
  einen NAS-Ordner oder an „Mein Drive“ noch von GateControl geprüft (`ERR_MEDIA_SCAN_PENDING` bzw. `scan_pending` des
  Ziel-Plugins), bleibt die Zustellung **ausstehend** (`status: 'pending'`, `error: 'scan_pending'`) statt als
  fehlgeschlagen gespeichert zu werden. Weitergegeben wird dann noch nichts (keine halbe Chat-Nachricht, keine doppelten
  Dateien). Sobald GateControl das Ergebnis meldet (Hook `mediaScanned`), stellt GateDrop sie zu: unauffällig (oder nur
  markiert) → zugestellt; Quarantäne, gelöscht → fehlgeschlagen mit `quarantined`; nicht prüfbar und blockiert →
  `scan_blocked` (NAS und Drive speichern die übrigen Dateien).
- **Sicherheitsnetz in der Hintergrundpflege:** Kam kein Ergebnis an, versucht GateDrop wartende Zustellungen alle
  5 Minuten erneut; 24 Stunden nach dem Senden gibt es auf (fehlgeschlagen mit `scan_pending`).
- Die Apps zeigen solche Zustellungen wie bisher als „ausstehend“ (`pending` kennen sie), das Portal als „wartet auf die
  Virenprüfung“. Keine neue Migration.

## 1.4.0
- **Virenscan von GateControl** (README „Virus scan“). GateControl prüft ab der Version nach 1.222.0 jede hochgeladene
  Datei direkt nach dem Speichern. GateDrop übernimmt das Ergebnis je Datei einer Sendung (Migration 003) und zeigt es als
  `scan { state, blocked, finding }` an den Einträgen. Ältere GateControl-Versionen liefern kein `scan`: Dann ändert sich
  nichts. Die Mindestversion bleibt 1.193.0.
- **Gesperrte Dateien werden nicht gesendet:** `POST sends` lehnt eine Datei in Quarantäne mit `422 infected` ab, eine
  noch laufende Prüfung mit `423 scan_pending` (gleich erneut senden), eine nicht prüfbare, blockierte Datei mit `423
  scan_blocked` – jeweils mit dem Dateinamen. Es wird dann nichts zugestellt.
- **Nachträglich gesperrt** (nächtliche Nachprüfung, Admin – neuer Hook `mediaScanned`): Die Datei ist für Empfänger
  nicht mehr verfügbar, `GET items/<mediaId>` antwortet `423 quarantined | scan_pending | scan_blocked`. Weitergaben an
  Messenger, NAS oder Drive scheitern mit diesem Code.
- **Portal:** Ein vom Virenscan abgelehnter Upload zeigt „<Name> abgelehnt – Schadsoftware gefunden.“ Große Dateien,
  die noch geprüft werden, sendet das Portal automatisch erneut („Wird auf Viren geprüft …“). Empfangene Dateien zeigen
  „Gesperrt – Schadsoftware“, „Gesperrt – nicht prüfbar“, „Wird geprüft …“ oder „Warnung – Schadsoftware“. Gesperrte
  Dateien lassen sich nicht herunterladen, bei markierten fragt das Portal vorher nach.

## 1.3.0
- **Neues Ziel „Mein Drive“:** Dateien lassen sich jetzt ins eigene Drive schicken (Drive-Plugin ab 1.4.0). Ohne
  weitere Angabe landen sie in **Meine Dateien › GateDrop**, aus einer App auch in einem dort gewählten Ordner; ist ein
  Name schon vergeben, heißt die Datei „Foto (2).jpg“. Text, Link und Notiz bleiben in GateDrop (wie beim NAS). Das
  Speichern läuft nach dem Senden im Hintergrund; danach zeigt die Sendung „Gespeichert in Meine Dateien › GateDrop ›
  Foto.jpg“ bzw. den Grund, z. B. „kein Drive-Platz“ (`no_seat`) oder „Drive ist voll“ (`quota`).
- Angeboten wird das Ziel nur Personen mit Drive-Platz (im Portal als Chip „Mein Drive“ neben den NAS-Ordnern, in den
  Apps über `GET targets` → `drive`). Die Übersicht im Admin-Bereich zeigt, ob Drive verfügbar ist.
- App-API: `POST sends` mit `to.drive` (`true` oder `{ "folderId": 12 }`), Zustellungen der Art `drive` mit `files`
  und `where`, `GET targets` mit `drive: true|false` – siehe README.
- **Neue Berechtigung:** GateDrop nutzt die Dienste `gatecontrol-drive:save_file` und `gatecontrol-drive:list_areas`.
  Ein Admin muss das Update deshalb unter Einstellungen › Plugins bestätigen, bevor es aktiv wird.

## 1.2.1
- **Direktübertragung im WLAN – schneller Wechsel auf den Server:** `GET transfers/<id>` nennt jetzt unter `peer`, was
  die andere Seite gemeldet hat (`{ ok, error }`, z. B. `pull_failed`). Die Apps fragen das ab, während sie auf die
  Gegenseite warten, und nehmen sofort den Weg über den Server, wenn diese aufgegeben hat – statt bis zu einer Minute
  (Abholen) bzw. zehn Minuten (Empfang) zu warten. Im Protokoll der Apps steht dann auch der Grund.

## 1.2.0
- **Wer darf an dieses Gerät senden?** Neue Einstellung pro Gerät (in der Android-App und im Windows-Client auf der
  GateDrop-Seite): **„Nur ich“** (Standard, wie bisher) oder **„Alle im GateControl-Netz“**. Ist ein Gerät für alle
  freigegeben, sehen es die anderen Personen dieses Servers beim Teilen unter **„Geräte anderer“** (z. B. „Surface ·
  Marc“) und können direkt dorthin senden – im selben WLAN direkt von Gerät zu Gerät, sonst über den Server; ist das
  Gerät aus, wartet die Sendung, bis es wieder online ist. Der Besitzer bekommt „Anna hat dir … geschickt“ auf genau
  diesem Gerät, die Sendung steht bei ihm unter „Empfangen“. Wird die Freigabe zurückgenommen, verschwindet das Gerät
  sofort aus den Zielen der anderen. Kiosk-Geräte (Wand-Tablet) werden nie angeboten.
- App-API: `GET`/`PUT device` (`receiveFrom: self | everyone`), `GET targets` mit `me.receiveFrom` und
  `peopleDevices` (Geräte anderer mit `owner`), Zustellungen an fremde Geräte mit `ownerId`.

## 1.1.1
- **Senden an eigene Geräte aus der Android-App:** die App schickt die Geräte-ID als Zahl (`"devices": [107]`),
  GateDrop nahm nur Text an und lehnte die Sendung mit `invalid` ab („Nicht gesendet“). Positive ganze Zahlen werden
  jetzt wie die gleiche ID als Text behandelt.

## 1.1.0
- **Senden an ausgeschaltete Geräte:** ist das eigene Gerät beim Senden offline (z. B. der Windows-PC ist aus), klappt
  das Senden trotzdem – die Dateien bleiben auf dem Server, die Zustellung steht auf **„Wartet, bis „Büro-PC“ online
  ist“** (Status `waiting`, kein Fehler) und die Mitteilung geht wie bisher raus (GateControl stellt sie zu, sobald das
  Gerät wieder da ist). Sobald das Gerät wieder online ist, holt es die Dateien **automatisch**: die Apps fragen den neuen
  Endpunkt `GET pending` ab (alles, was über den Server an dieses Gerät ging und dort noch nicht als empfangen gemeldet
  ist – Dateien ebenso wie ein Text oder Link ohne Dateien, solange die Sendung nicht abgelaufen ist; danach
  „zugestellt“). Mit `POST sends/<id>/opened` meldet das Gerät den Empfang, dann verschwindet die Sendung aus
  der Liste. Direktübertragung im WLAN weiterhin nur an Geräte, die online sind.
- **Portal:** ausgeschaltete Geräte lassen sich auswählen, mit dem Hinweis „offline · kommt an, sobald es online ist“;
  das Ergebnis nach dem Senden zeigt „Wartet, bis „<Gerät>“ online ist“.
- **„Geöffnet“ je Gerät:** eine Zustellung an ein Gerät markiert nur dieses Gerät selbst als geöffnet – das Öffnen im
  Portal oder auf einem anderen Gerät nimmt dem Gerät die Sendung nicht mehr weg.
- **App-API:** `GET pending`, Zustellstatus `waiting` – siehe README.

## 1.0.0
Braucht **GateControl ≥ 1.193.0** (Dateien bis 2 GB, Geräte der Person, stille Mitteilungen, Übergabe von Dateien an
andere Plugins, öffentliche Links). Kostenpflichtig wie die anderen Plugins (Lizenz).
- **Senden an Personen:** als Nachricht der sendenden Person im Messenger (Einzelchat oder Familien-Chat; Dienst
  `send_file` des Messengers ab 1.8.0). In den Chat kommen Dateien bis 25 MB (zusammen höchstens 100 MB je Sendung,
  höchstens 200 Übergaben je Person und Tag); größere – oder Typen, die der Messenger nicht nimmt – bleiben in GateDrop
  (Mitteilung „Anna hat dir … geschickt“, Herunterladen in GateDrop, 7 Tage), die Chat-Nachricht nennt sie („+2 Dateien
  in GateDrop: …“). Lehnt der Messenger ab (Blockierung, kein Mitglied, nur lesen …), schlägt die Zustellung fehl – es
  gibt keinen Umweg. Nur ohne Messenger bekommt die Person alles über GateDrop.
- **Familie:** eine Sendung an „Familie“ sehen nur die, die beim Senden zur Familie gehörten.
- **Senden an eigene Geräte** (Android, Windows): im gemeinsamen WLAN **direkt** (das Plugin vermittelt nur:
  einmaliges Ticket für 10 Minuten, Schlüssel, Adressen – nach Ende der Übertragung gelöscht; die Daten gehen nie über
  den Server), sonst **über den
  Server** mit einer Mitteilung an genau dieses Gerät. Klappt die Direktübertragung nicht, geht es automatisch über den
  Server (liegt die Datei nur auf dem sendenden Gerät, lädt es sie dann hoch).
- **Ablegen im NAS:** in Ordner, die ein Admin im Plugin **NAS (Synology)** ab 1.2.0 für GateDrop freigibt.
- **Link für Externe:** 1 Stunde, 1 Tag, 7 Tage oder 1× herunterladen, auf Wunsch mit 4-stelliger PIN (nach 5
  falschen PINs gesperrt; mit PIN ein allgemeiner Titel „Geteilte Dateien“ statt des Dateinamens); die Seite zum Herunterladen liefert GateControl. **Standardmäßig aus** – ein Admin schaltet
  sie unter Einstellungen › Plugins › GateDrop › Berechtigungen ein. „Link geladen“ als Mitteilung.
- **Wer darf was:** an Personen und eigene Geräte senden alle Konten (keine Kiosk-Geräte); Links und NAS-Ablage nur
  Admins und Eltern aus dem Familie-Plugin (Dienst `family_roles`, Familie ab 1.13.2).
- **Inhalte:** 1–20 Dateien je Sendung (je ≤ 2 GB), Text (≤ 20 000 Zeichen), Link, Notiz. Empfangenes bleibt **7 Tage**
  auf dem Server, danach löscht der Hintergrund die Dateien (der Verlauf bleibt 30 Tage). Speicher gesamt 10 GB
  (änderbar unter Plugins › GateDrop › Übersicht → Medien).
- **Portal-Tab „GateDrop“:** Dateien ziehen, auswählen oder einfügen, Text/Link, Ziele, Senden; aktive Links mit
  „Beenden“; Verlauf (gesendet/empfangen, Herunterladen).
- **Admin-Seite „Übersicht“:** Speicher, Aufbewahrung, aktive Links, Sendungen, Hinweis zum Links-Schalter, was mit
  GateDrop zusammenspielt – keine Inhalte.
- **App-API** für die Android-App und den Windows-Client (Teilen-Blatt, „Geteilt“, Presence, Direktübertragung):
  siehe README.
