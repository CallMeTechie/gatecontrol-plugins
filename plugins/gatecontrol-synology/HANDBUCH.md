<!-- version: 1.2.1 -->
# NAS (Synology)

## Was das Plugin kann

- **Synology-NAS überwachen:** Modell, DSM-Version, Laufzeit, Temperatur, CPU und RAM, Volumes, Speicherpools, Laufwerke mit S.M.A.R.T.-Zustand und Temperatur, DSM-Updates, Hyper-Backup-Aufgaben und USV.
- **Steuern:** Neustart, Herunterfahren (mit ausdrücklicher Bestätigung) und Hyper Backup „Jetzt sichern“.
- **Mitteilungen:** NAS nicht erreichbar, Speicher beeinträchtigt oder fast voll, Laufwerk mit Warnung oder zu heiß, DSM-Update verfügbar, Datensicherung fehlgeschlagen, NAS neu gestartet / heruntergefahren.
- **GateControl-Apps:** je NAS ein Widget, Schnellaktionen und eine Startkachel – nur für Administratoren.
- **Ablage für GateDrop:** freigegebene NAS-Ordner, in die das Plugin GateDrop Dateien legen darf.

Seite und Steuerung sind nur für Administratoren. Im Web-Portal erscheint nichts.

## Voraussetzungen

- GateControl **1.193.0** oder neuer.
- Ein Synology-NAS mit DSM 6.0 bis 7.2.
- Ein **DSM-Konto in der Gruppe „administrators“**, am besten nur für GateControl.
- Ein Weg von GateControl zu DSM, dem GateControl vertraut (siehe Schritt 2).

## Einrichten

### Schritt 1: Konto in DSM anlegen

In DSM unter **Systemsteuerung › Benutzer** ein eigenes Konto anlegen und in die Gruppe **„administrators“** aufnehmen. Status und Steuerung brauchen Administratorrechte. Soll GateDrop Dateien ablegen, braucht das Konto Schreibrecht in diesen Ordnern.

### Schritt 2: Weg zu DSM wählen (Zertifikat)

GateControl prüft Zertifikate immer, das Standard-Zertifikat von DSM ist selbstsigniert. Diese Wege funktionieren:

1. **Empfohlen:** eine GateControl-HTTP-Route über ein Heim-Gateway zu DSM, Port 5001, mit „HTTPS zum Backend“. Das Gateway spricht HTTPS mit dem NAS, optional mit hinterlegtem Zertifikats-Fingerabdruck.
2. DSM per **HTTP auf Port 5000** als VPN-Gerät oder Adresse – der Weg läuft durch den WireGuard-Tunnel bzw. das Heimnetz. Schalte dafür in DSM „HTTP-Verbindung automatisch auf HTTPS umleiten“ aus.
3. HTTPS mit einem **gültigen Zertifikat** (z. B. Let's Encrypt) unter dem Namen, den das Ziel verwendet.

### Schritt 3: Zugriffsziel zuweisen

**Einstellungen › Plugins › NAS (Synology) › Zugriffsziele** › dem Ziel „Synology-NAS (DSM)“ die Route, das VPN-Gerät oder die Adresse zuweisen – je NAS ein Eintrag.

### Schritt 4: NAS hinzufügen

Im Plugin › **„NAS hinzufügen“**: Name, Zugriffsziel, Benutzername und Passwort des DSM-Kontos. **„Verbindung testen“** zeigt Modell, DSM-Version und ob das Konto Administratorrechte hat.

Ist für das Konto 2-Faktor aktiv, gib **einmal** den Bestätigungscode aus der Authenticator-App ein. DSM vergibt dafür ein Geräte-Token „GateControl“ (in DSM unter Persönlich › Sicherheit › Vertrauenswürdige Geräte sichtbar und widerrufbar). Spätere Anmeldungen brauchen keinen Code.

Konto, Passwort und Geräte-Token werden verschlüsselt gespeichert.

### Schritt 5: Einstellungen

**Einstellungen › Plugins › NAS (Synology) › Einstellungen:** Abfrageintervall (Standard 120 Sekunden), „Nicht erreichbar“ nach … Fehlversuchen (Standard 3), Speicher fast voll ab … % (Standard 90), Laufwerkstemperatur zu hoch ab … °C (Standard 55), Sprache der Mitteilungen.

### Ablage für GateDrop (optional)

Auf der Plugin-Seite unter **„Ablage für GateDrop“** gibst du NAS-Ordner frei: NAS, Pfad wie in der File Station (z. B. `/Familie/Fotos`) und Name. Nur in diese Ordner und ihre Unterordner darf GateDrop Dateien ablegen. Wer das in GateDrop darf, entscheidet GateDrop (Admins und Eltern).

## Benutzen

- **Seite „NAS (Synology)“:** je NAS eine Karte mit Zustand, Belegung, Laufwerken und Hinweisen; die Detailansicht mit Volumes, Pools, Laufwerkstabelle, Sicherungen und USV; Knöpfe für Neustart, Herunterfahren und „Jetzt sichern“.
- **App (nur Administratoren):** je NAS „Aktualisieren“ mit dem NAS-Widget (Speicher belegt, CPU, RAM, Temperatur, Zustand), „Backup jetzt“ je Hyper-Backup-Aufgabe, „Neustart“ und „Herunterfahren“ mit Rückfrage; dazu eine Startkachel je NAS.
- Ein heruntergefahrenes NAS kann das Plugin nicht wieder einschalten. Deshalb fährt eine **Regel** das NAS nie herunter – nur du per Hand. Neustart und Backup gehen auch per Regel.

## Berechtigungen

Nur GateControl-Administratoren sehen die Seite, das Widget, die Schnellaktionen und die Startkachel. Jede Aktion steht im Plugin-Protokoll mit dem Weg („von admin (App)“, „von admin (Regel)“); Neustart und Herunterfahren zusätzlich im Aktivitätsprotokoll. Was das Plugin am NAS darf, bestimmt das DSM-Konto.

## Häufige Fragen / Fehlersuche

**„HTTPS-Zertifikat nicht vertrauenswürdig“.**
Nimm einen der Wege aus [Schritt 2](#schritt-2-weg-zu-dsm-waehlen-zertifikat).

**„DSM leitet HTTP auf HTTPS um“.**
Schalte in DSM „HTTP-Verbindung automatisch auf HTTPS umleiten“ aus oder nutze eine Route über ein Heim-Gateway.

**„Das Konto hat keine Administratorrechte“.**
Nimm das Konto in DSM in die Gruppe „administrators“ auf.

**Die Abfrage pausiert nach einem Anmeldefehler.**
DSM sperrt Adressen nach wiederholten Fehlanmeldungen. Prüfe Benutzername und Passwort und speichere erneut. Verlangt DSM einen Code, klicke auf der Karte „Code eingeben“.

**GateDrop kann nichts ablegen.**
Der Ordner ist nicht unter „Ablage für GateDrop“ freigegeben, oder dem DSM-Konto fehlt das Schreibrecht.

## Neu in 1.2.1

- Dieses Handbuch im Reiter „Handbuch“ (GateControl ≥ 1.241.0).

Zuletzt in 1.2.0: Ablage für GateDrop – freigegebene NAS-Ordner, in die GateDrop Dateien legt.
