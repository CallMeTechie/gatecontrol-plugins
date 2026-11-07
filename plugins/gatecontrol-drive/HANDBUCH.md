<!-- version: 1.20.1 -->
# Drive

## Was das Plugin kann

- **Dateien der Familie und des Teams auf deinem eigenen Speicher** – auf diesem Server, einer NAS oder in S3.
- **Bereiche mit Rechten:** Meine Dateien, Familie, Ordner der Kinder und Team-Ordner.
- **Versionen, Papierkorb, Links** für Personen ohne Konto und **Abgleich** mit allen Geräten (Apps).
- **Fotos:** Zeitleiste, Alben, Erinnerungen, Orte und Personen, Fotorahmen auf dem Wand-Tablet.
- **Tresor-Ordner:** Ende-zu-Ende verschlüsselte Ordner, die nur deine Geräte öffnen.
- **KI für Dokumente:** Art, Name und Fristen erkennen, Fragen an deine Dateien, Scans in Dokumente umwandeln, Fristen in den Familienkalender.
- **Schutz vor Erpressungstrojanern:** Drive stoppt ein Gerät, das ungewöhnlich viele Dateien ändert.
- **Import** aus Google Drive und OneDrive, **Office im Browser** mit einem eigenen Office-Server.
- **Zwischenspeicher im Heimnetz:** Gateways halten oft genutzte Dateien zu Hause vor; „offline verfügbar“ für einzelne Dateien und Ordner.

Drive ist ein eigenes Abo (Familie, Business oder Kombi, fünf Personen inklusive, mehr buchbar auf callmetechie.de) und nicht in GateControl Lifetime enthalten.

## Voraussetzungen

- GateControl **1.216.0** oder neuer (Zwischenspeicher im Heimnetz ab 1.231.0).
- Eine Drive-Lizenz.
- Für die Familie und die Kinderordner: eine GateControl-Gruppe der Art Familie.
- Für KI und Import: der KI-Anbieter bzw. Cloud-Konten in GateControl.
- Optional ein Speicherziel (NAS über SMB oder WebDAV, S3 …) unter **Einstellungen › Plugins › Speicher**.

## Einrichten

1. **Personen einschalten:** Admin-Seite **„Personen“** – je Person **Familie** oder **Business** (je nach Lizenz). Nur eingeschaltete Personen nutzen Drive.
2. **Speicherorte:** **Einstellungen › Plugins › Drive › Speicherorte** – je Bereich dieser Server oder ein Speicherziel. Auf einer NAS in der lesbaren Form liegen die Dateien als normale Dateien.
3. **Team-Ordner** (Business): Admin-Seite **„Team-Ordner“** – Ordner anlegen und Personen oder Gruppen mit lesen, schreiben oder verwalten eintragen.
4. **Einstellungen** (**Einstellungen › Plugins › Drive › Einstellungen**): Versionen aufbewahren, Papierkorb leeren nach … Tagen, Platz je Person, „Eltern dürfen die Ordner der Kinder ansehen“, Schutz vor Erpressungstrojanern (ab wie vielen Dateien oder Prozent in welcher Zeit), Fotorahmen, KI für Dokumente, Import, Adresse des Office-Servers, Adresse von GateControl für Direktlinks.
5. **Sicherung:** Das Backup von GateControl sichert **keine Drive-Dateien**, nur die Datenbank. Liegen die Dateien nur an einem Ort, zeigt die Übersicht einen Hinweis. Sichere die Dateien selbst (z. B. Speicherziel S3 oder eine Sicherung der NAS).
6. **Zwischenspeicher im Heimnetz** (optional): am Gateway unter **Gateways › Zwischenspeicher** einschalten und wählen, welche Arten es hält.

## Benutzen

- **Portal-Tab „Drive“ und Apps:** links das Menü mit „Persönlich“ (Meine Dateien) und „Gemeinsam“ (Familie, Kinderordner, Team-Ordner) als Ordnerbaum, „Fotos“, „Alben“ und „Tresore“. Drive öffnet mit der **Übersicht**: zu erledigen, zuletzt geöffnet, neu in der Familie, Erinnerungen, Personen, Orte.
- **Dateien:** hochladen (auch ganze Ordner), neuer Ordner, umbenennen, verschieben, kopieren, Versionen, Papierkorb, teilen, „Direktlink kopieren“. Mehrere auswählen mit Strg/Umschalt und als ZIP laden, verschieben oder löschen.
- **Teilen:** Links für Personen ohne Konto; „Geteilte Links“ listet sie.
- **Geräte:** deine Geräte mit ihren gesicherten Ordnern und der letzten Sicherung.
- **Fotos:** Zeitleiste nach Monat, „Nur Kamera-Uploads“, Alben, „Im Fotorahmen zeigen“, Suche nach Personen, Orten und Inhalt, Karte, „Wer ist das?“. Gesichter werden nur auf den Geräten erkannt; Drive speichert keine Gesichtsbilder.
- **Tresor-Ordner:** „Neu“ › „Neuer Tresor“, wer ihn öffnen darf (nur ich, Familie, Team-Ordner). Den Wiederherstellungsschlüssel sicher aufbewahren. Ein neues Gerät fragt mit „Freigabe anfragen“, ein schon freigegebenes gibt frei. Tresore sperren sich nach einigen Minuten ohne Eingabe; die KI liest sie nie.
- **KI für Dokumente:** „Dokument-Infos“ an einer Datei, „Fragen“ unter der Suche, die Seite „Fristen“ mit „In den Familienkalender“ und „Erinnern“, „In Dokument umwandeln“ für Scans.
- **Importieren** aus Google Drive und OneDrive: verbinden, auswählen, Ziel wählen.
- **Im Browser bearbeiten** für Office-Dokumente, wenn ein Office-Server eingetragen ist.

## Berechtigungen

| Bereich | Wer | Recht |
|---|---|---|
| Meine Dateien | jede eingeschaltete Person | verwalten |
| Familie | Mitglieder der Familie mit Familien-Platz | schreiben |
| Kinder · Name | das Kind | verwalten |
| | seine Eltern, solange „Eltern dürfen die Ordner der Kinder ansehen“ an ist | lesen (das Kind bekommt einmal am Tag einen Hinweis) |
| Team-Ordner | eingetragene Personen und Gruppen mit Business-Platz | lesen / schreiben / verwalten |

„Lesen“ heißt ansehen und herunterladen, „schreiben“ auch hochladen, anlegen, umbenennen, verschieben, löschen. Ohne Platz antwortet Drive „nicht freigeschaltet“, ohne gültige Lizenz geht nichts außer der Anzeige. Administratoren sehen auf ihren Seiten Zahlen, Personen und Bereiche – Tresore können auch sie nicht öffnen.

## Häufige Fragen / Fehlersuche

**Eine Person sieht Drive nicht.**
Schalte sie auf der Seite „Personen“ ein. Ist die Lizenz voll, geht das erst nach einem weiteren gebuchten Platz.

**Ein Gerät ist „gestoppt“.**
Der Schutz vor Erpressungstrojanern hat ungewöhnlich viele Änderungen gesehen. Im roten Hinweis „Rückgängig machen“ oder, wenn du es warst, „War ich – freigeben“.

**Die Übersicht warnt „Drive-Dateien sind nicht gesichert“.**
Das GateControl-Backup sichert die Dateien nicht. Lege eine eigene Sicherung an oder nimm ein Speicherziel mit eigener Sicherung.

**„Im Browser bearbeiten“ fehlt.**
Unter Einstellungen ist keine Adresse eines Office-Servers eingetragen.

**Ein Tresor lässt sich auf einem neuen Gerät nicht öffnen.**
Frage mit „Freigabe anfragen“ an und gib auf einem schon freigegebenen Gerät frei – oder öffne ihn mit dem Wiederherstellungsschlüssel.

**Dateien sind „vom Virenscan zurückgehalten“.**
Der Virenscan von GateControl prüft neue Dateien; gesperrte Dateien öffnet und teilt Drive nicht.

## Neu in 1.20.1

- Dieses Handbuch im Reiter „Handbuch“ (GateControl ≥ 1.241.0).

Zuletzt in 1.20.0: Zwischenspeicher im Heimnetz – Gateways halten oft genutzte Dateien zu Hause vor; „offline verfügbar“ für Dateien und Ordner.
