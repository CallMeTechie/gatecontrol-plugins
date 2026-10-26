# Drive (gatecontrol-drive)

Dateien der Familie und des Teams auf dem eigenen Speicher – auf diesem Server, einer NAS oder in S3.

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
