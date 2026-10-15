# Tür & Kamera (gatecontrol-door)

Nuki-Schlösser und -Opener sowie Ring-Klingeln und -Kameras in GateControl – in der App
(eigener Tab „Tür“), im Widget/den Schnellaktionen und im Portal (eigener Tab „Tür“). Alles
bleibt auf dem eigenen Server. Einrichtung, Risiken, Datenschutz und die App-API: README.md.

**Ring: inoffizielle Schnittstelle, ohne Gewähr.** Ring bietet keine offizielle Schnittstelle
an; das Plugin nutzt die, die auch die Open-Source-Projekte ring-client-api (Homebridge) und
python-ring-doorbell (Home Assistant) verwenden. Sie kann sich jederzeit ändern oder wegfallen.

## 1.0.0
Braucht **GateControl ≥ 1.169.0** (Push-Bilder, Schnellaktionen in Mitteilungen,
5-Sekunden-Hintergrundlauf). Kostenpflichtiges Zusatz-Plugin (`license.required`), nicht in
GateControl Lifetime enthalten.
- **Nuki:** pro Schloss wählbar die lokale **Nuki Bridge** (HTTP-API über das Zugriffsziel
  „Nuki Bridge“, mehrere Bridges möglich, Anmeldung mit gehashtem Token `ts`/`rnr`/`hash` – der
  Token steht nie in einer URL; Anfragen pro Bridge nacheinander, mit Timeouts) oder **Nuki Web**
  (Cloud, API-Token). Smart Lock (Typ 0, 3, 4, 5): zusperren, aufsperren, öffnen (Falle);
  Opener (Typ 2): Summer. Pro Schloss: Name, Quelle, welche Aktionen es gibt, Türsensor ja/nein,
  „offen zu lange“ nach N Minuten (Standard 5, 0 = aus), Nachtkontrolle (Standard 22:00, aus
  möglich). Zustand: zu/auf/geöffnet/sperrt/blockiert …, Tür offen/zu, Batterie kritisch und %,
  erreichbar, Stand. Abfrage alle 30 s (die Bridge-Liste, kein Funkverkehr zum Schloss), direkt
  nach jeder Aktion und alle 10 s, solange ein automatisches Aufsperren auf die Tür wartet.
  Nuki Web: Bedienungen am Schloss / Keypad werden aus dem Protokoll in den Verlauf übernommen.
- **Ring (inoffiziell, ohne Gewähr):** Anmelde-Assistent auf der Seite „Geräte“ (E-Mail +
  Passwort → Bestätigungscode per SMS/E-Mail/App). Gespeichert wird **nur das Refresh-Token**
  (verschlüsselt, es erneuert sich laufend – immer das neueste), nie Passwort oder E-Mail; eine
  Geräte-ID wird einmal pro Installation erzeugt. Klingeln und Kameras mit Name, Akku, online;
  jede Kamera kann mit einem Schloss verknüpft werden. Klingeln und Bewegung werden ohne
  Push-Empfang **abgefragt** (alle 5 s die aktiven Ereignisse, alle 30 s die Ereignisliste als
  Nachlauf, ohne Doppelte); Verzögerung etwa 5–15 s plus Bild. Bei Fehlern wird gebremst (5 s …
  5 min, bei 429 nach Retry-After). Ist Ring gestört, zeigt das Plugin „Ring-Verbindung
  gestört“ und benachrichtigt die Administratoren höchstens einmal am Tag – Nuki läuft weiter.
- **Rechte** (Seite „Berechtigungen“): pro Person und Schloss keine / ansehen / zu-/aufsperren /
  auch öffnen; optional ein Wochen-Zeitfenster pro Person (z. B. Mo–Fr 07:00–20:00, auch über
  Mitternacht); „Automatisch aufsperren bei Ankunft erlauben“ (Standard aus); pro Kamera
  Klingel-Push (Standard an) und Bewegungs-Push (Standard aus). Admins bekommen nichts
  automatisch. Kiosk-Geräte und nur per Geräte-Vertrauen erkannte Portal-Besucher sehen nur.
  **Jede Aktion wird auf dem Server erneut geprüft** (Recht, Zeitfenster, höchstens 10 pro
  Minute und Person) und in den Verlauf geschrieben – auch abgelehnte.
- **Schnellaktionen** (App-Verknüpfungen, Schnelleinstellungen, Widget): pro Schloss und Recht
  „Haustür zusperren“ / „… aufsperren“ / „… öffnen“ (Opener „… Summer“), Rückfrage bei auf/öffnen,
  Zustand als Untertitel, Symbole Schloss / offenes Schloss / Tür. IDs `<lockId>:lock|unlock|open`.
- **Klingel-Push mit Bild** (Thema „Klingel“, hoch): an alle mit mindestens „ansehen“ auf dem
  verknüpften Schloss; wer „auch öffnen“ darf, bekommt den Knopf **„Tür öffnen“** (Rückfrage und
  Geräte-Entsperrung in der App) und alle „Ansehen“. Bewegung (Thema „Bewegung“, Standard aus)
  nur für wer sich pro Kamera angemeldet hat, höchstens eine pro Kamera in 5 Minuten.
- **Automatisch aufsperren bei Ankunft** über die Familie-Regel „Person kommt heim“ → Aktion
  „Haustür aufsperren“. Angenommen nur, wenn alles stimmt: nur aufsperren (nie öffnen),
  Zustimmung und mindestens „zu-/aufsperren“, Zeitfenster, höchstens alle 10 Minuten pro
  Person und Schloss, Schloss erreichbar und zugesperrt (frisch abgefragt), Tür zu (mit
  Türsensor). Sonst abgelehnt mit Verlaufseintrag und Mitteilung „Automatisches Aufsperren
  abgelehnt: …“. Nach dem Aufsperren „Haustür automatisch aufgesperrt“ mit „Wieder zusperren“;
  wird die Tür in 3 Minuten nicht geöffnet, sperrt das Plugin wieder zu (mit Türsensor) bzw.
  fragt per Mitteilung (ohne).
- **Sicherheit:** Tür zu lange offen, Schloss blockiert, > 10 Minuten nicht erreichbar,
  Batterie kritisch (einmal am Tag), Nachtkontrolle mit „Zusperren“ – Thema „Tür & Schloss“.
- **Verlauf** (eigene Tabelle, 90 Tage): jede Aktion mit wer, über was (App, Portal,
  Mitteilung, Automatik, System, Nuki, Keypad) und Ergebnis; Klingeln und Bewegung mit Bild
  (Bilder 1–30 Tage, Standard 7).
- **Oberfläche:** Admin-Seiten „Geräte“, „Berechtigungen“, „Verlauf“, „Einstellungen“; Portal-Tab
  mit Schlosskarten, letzten Bildern („Neues Bild“) und Verlauf; Start-Kacheln pro Schloss;
  App-API für den nativen Tab (README).
- Gemeinsamer Baustein `server/notify.js` (in allen Plugins gleich): reicht ein Bild (`image`)
  an GateControl weiter und schickt eine Mitteilung ohne Bild erneut, wenn GateControl das Bild
  ablehnt.
