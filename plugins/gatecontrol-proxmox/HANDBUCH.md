<!-- version: 1.1.2 -->
# Proxmox VE

## Was das Plugin kann

- **Proxmox-VE-Hosts und -Cluster** im Blick: Nodes mit CPU, RAM, Speicher, Swap, Laufzeit, Version und Last; VMs und Container; Speicher, Backups und HA.
- **VMs und Container steuern:** starten, sauber herunterfahren, hart stoppen (mit eigener Warnung), neu starten. Einen Node fährt das Plugin bewusst nie herunter.
- **Mitteilungen:** Host oder Node nicht erreichbar, VM/CT unerwartet gestoppt, Speicher fast voll, Backup fehlgeschlagen, hohe Auslastung eines Nodes.
- **GateControl-Apps:** Widgets, Schnellaktionen und eine Startkachel „Proxmox“ – nur für Administratoren.

Alles ist nur für Administratoren. Im Portal erscheint nichts.

## Voraussetzungen

- GateControl **1.154.0** oder neuer (Schnellaktionen ab 1.160.0, Widgets ab 1.171.0).
- Proxmox VE 8.x mit einem API-Token (Anleitung unten).
- Ein Weg von GateControl zur Proxmox-API (Port 8006) mit einem Zertifikat, dem GateControl vertraut – am einfachsten eine Route über ein Home Gateway.

## Einrichten

### Schritt 1: API-Token in Proxmox anlegen

Auf einem Proxmox-Node als root in der Shell:

```
pveum user add gatecontrol@pve --comment "GateControl"
pveum acl modify / --users gatecontrol@pve --roles PVEAuditor
pveum role add GateControlPower --privs "VM.PowerMgmt VM.Audit"
pveum acl modify /vms --users gatecontrol@pve --roles GateControlPower
pveum user token add gatecontrol@pve monitor --privsep 0
```

Proxmox zeigt das **Secret nur einmal** an – notiere es zusammen mit der Token-ID `gatecontrol@pve!monitor`.

- **PVEAuditor** auf `/` reicht für den Status (nur lesen).
- **VM.PowerMgmt** auf `/vms` braucht es zum Starten, Herunterfahren, Stoppen und Neustarten. Ohne diese Rolle bleibt das Plugin rein lesend.
- **Sys.Modify** auf `/nodes` nur, wenn du „Verfügbare Updates anzeigen“ willst.

### Schritt 2: Weg zur Proxmox-API (Zertifikat)

GateControl prüft bei HTTPS immer das Zertifikat. Das ab Werk selbstsignierte Zertifikat von Proxmox wird bei einer direkten Zuweisung abgelehnt („Zertifikat nicht vertrauenswürdig“). Zwei Wege gehen:

- **Empfohlen:** eine **GateControl-HTTP-Route über ein Home Gateway** zur Proxmox-IP, Port 8006, mit **„Backend HTTPS“**. Das Gateway spricht HTTPS ins Heimnetz und akzeptiert das selbstsignierte Zertifikat (optional mit SHA-256-Fingerabdruck gepinnt). Mach die Route nur intern erreichbar oder schütze sie.
- **Oder:** Proxmox bekommt ein Zertifikat einer öffentlichen Stelle (Datacenter › ACME, Node › Zertifikate, z. B. Let's Encrypt per DNS-Challenge). Dann weist du die Adresse mit diesem DNS-Namen, HTTPS und Port 8006 zu.

### Schritt 3: Zugriffsziel zuweisen

**Einstellungen › Plugins › Proxmox VE › Zugriffsziele** › dem Ziel „Proxmox-VE-Host oder -Cluster“ die Route bzw. Adresse aus Schritt 2 zuweisen. Für mehrere Hosts oder Cluster weist du das Ziel mehrfach zu.

### Schritt 4: Verbindung anlegen

Im Plugin › Reiter **„Verbindungen“** › **„Verbindung hinzufügen“**: Name, Zugriffsziel, **API-Token-ID** (z. B. `gatecontrol@pve!monitor`) und **Token-Secret**. **„Verbindung testen“** zeigt Version, Cluster und Nodes.

Das Secret wird verschlüsselt gespeichert und nie wieder angezeigt.

### Schritt 5: Gäste überwachen und Einstellungen

- Im Reiter **„VMs & Container“** bei den wichtigen Gästen **„Überwachen“** einschalten. Nur überwachte Gäste melden „unerwartet gestoppt“ und erscheinen als Schalter in der App.
- **Einstellungen › Plugins › Proxmox VE › Einstellungen:** Abfrageintervall (Standard 60 Sekunden), Speicher fast voll ab … % (Standard 90), Schwellen für CPU und RAM eines Nodes (Standard aus) und wie lange sie anhalten müssen, „Verfügbare Updates anzeigen“, Empfänger und Sprache der Mitteilungen.

## Benutzen

- **Übersicht:** je Verbindung die Nodes mit Balken für CPU, RAM, Disk und Swap, Laufzeit, Version, Last, Updates und HA.
- **VMs & Container:** Suche und Filter, Tabelle mit Status und Last, Aktionen. Vor jeder Aktion fragt das Plugin nach; „Stoppen“ braucht eine zusätzliche Bestätigung. Das Ergebnis der Proxmox-Aufgabe wird angezeigt.
- **Speicher & Backups:** Belegung der Speicher und die letzten Backups.
- **Verbindungen:** hinzufügen, bearbeiten, testen, löschen, „Letzte Aktionen“ und die Einrichtungshilfe.
- **App (nur Administratoren):** je Verbindung „Aktualisieren“ mit einem Widget (aktive Gäste, CPU, RAM, Speicher, Erreichbarkeit); je überwachtem Gast ein Schalter (an = starten, aus = sauber herunterfahren, nie hart stoppen) und „Neustart“; die Startkachel „Proxmox“.

## Berechtigungen

Seite, Aktionen, Widgets und Startkachel gibt es nur für GateControl-Administratoren. Jede Aktion prüft die Rolle erneut und steht mit Namen und Herkunft („admin (App)“, „admin (Regel)“) im Protokoll und unter „Letzte Aktionen“. Was das Plugin in Proxmox darf, bestimmen die Rollen des Tokens (Schritt 1).

## Häufige Fragen / Fehlersuche

**„Zertifikat nicht vertrauenswürdig“.**
Proxmox nutzt ein selbstsigniertes Zertifikat. Nimm eine Route über ein Home Gateway mit „Backend HTTPS“ oder ein öffentliches Zertifikat (Schritt 2).

**Die Knöpfe melden fehlende Rechte.**
Dem Token fehlt VM.PowerMgmt auf `/vms` (Schritt 1).

**Keine Update-Liste.**
„Verfügbare Updates anzeigen“ ist aus, oder dem Token fehlt Sys.Modify auf `/nodes`.

**Ein Gast meldet „unerwartet gestoppt“ nicht.**
Nur überwachte Gäste melden das, und nicht, wenn der Gast in den letzten 30 Minuten über das Plugin gesteuert wurde.

**Die Werte sind alt.**
Bei Fehlern fragt das Plugin seltener (bis alle 5 Minuten) und zeigt die letzten guten Daten mit „zuletzt aktualisiert“ und dem Fehler.

## Neu in 1.1.2

- **Weniger Schreibarbeit:** Proxmox speichert den Stand der Server nur noch alle 5 Minuten; angezeigt wird trotzdem immer die letzte Abfrage. Auf einem langsamen Datenträger (NAS mit Festplatten) bleibt GateControl dadurch flüssiger.

## Neu in 1.1.1

- Dieses Handbuch im Reiter „Handbuch“ (GateControl ≥ 1.241.0).

Zuletzt in 1.1.0: Widgets, Schnellaktionen und die Startkachel „Proxmox“ in den GateControl-Apps für Administratoren.
