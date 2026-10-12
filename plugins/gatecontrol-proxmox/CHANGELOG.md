# Proxmox VE (gatecontrol-proxmox)

Proxmox-VE-Hosts und -Cluster als GateControl-Plugin: Status, Steuerung von VMs/Containern
und Benachrichtigungen – nur für Administratoren (keine Portal-Teile).

## 1.0.0
- **Verbindungen:** mehrere Proxmox-Hosts oder -Cluster, je über eine Zuweisung des
  Zugriffsziels „Proxmox-VE-Host oder -Cluster“ (`pve`, HTTP, mehrfach) und ein **API-Token**
  (`Authorization: PVEAPIToken=BENUTZER@REALM!TOKENNAME=SECRET`). Das Token-Secret wird mit
  `gc.settings.setSecret` verschlüsselt gespeichert und nie an den Browser gegeben, nie
  protokolliert und nie in die Datenbank geschrieben. „Verbindung testen“ zeigt Version
  (`/version`), Cluster und Nodes.
- **Status** (Proxmox VE API `/api2/json`, PVE 8.x): `/cluster/status`, `/cluster/resources`
  (Nodes, VMs, Container, Speicher mit CPU/RAM/Disk/Laufzeit/Status), `/nodes/{node}/status`
  (Last, CPU, RAM, Swap, Root-Dateisystem, Kernel, PVE-Version), letzte Backups
  (`/nodes/{node}/tasks?typefilter=vzdump`), HA-Status (`/cluster/ha/status/current`, wenn
  lesbar), optional verfügbare Updates (`/nodes/{node}/apt/update`, nur lesen, alle 6 Stunden;
  Proxmox verlangt dafür Sys.Modify – Einstellung „Verfügbare Updates anzeigen“, aus).
- **Steuerung** (nur Administratoren, mit Bestätigungsdialog, im Plugin-Protokoll und in
  „Letzte Aktionen“ mit Namen festgehalten): VM/CT **starten**, **herunterfahren** (sauber),
  **stoppen** (hart, mit eigener Warnung und zusätzlicher Bestätigung), **neu starten**. Der
  Gast wird vorher frisch in Proxmox gesucht (auch nach einer Migration), die zurückgegebene
  Aufgabe (UPID) wird bis zum Ende verfolgt und ihr Ergebnis angezeigt; dauert sie länger, folgt
  die Seite bzw. der Hintergrundlauf ihr bis zur Zeitgrenze. Ein Neustart oder Herunterfahren
  eines **Nodes** wird bewusst **nicht** angeboten.
- **Hintergrundabfrage** je Verbindung (Vorgabe alle 60 s, Einstellung 30–3600 s); bei Fehlern
  verlängert sich der Abstand bis 5 Minuten. Die letzten guten Daten bleiben sichtbar, dazu
  „zuletzt aktualisiert“ bzw. der Fehler. Ein einzelner nicht erreichbarer Node stört die
  übrigen Daten nicht.
- **Benachrichtigungen** (eigene Themen, Vorgabe an Administratoren; Einstellung
  „Empfänger“ = Regel des Themas in System › Benachrichtigungen möglich):
  - **Proxmox-Host oder Node nicht erreichbar** (hoch): Verbindung 5 Minuten gestört (Netz,
    Zertifikat, Token …) bzw. Cluster-Node 5 Minuten offline; „wieder erreichbar/online“
    ersetzt die Meldung.
  - **VM/CT unerwartet gestoppt:** für Gäste mit „Überwachen“ – nicht, wenn der Gast in den
    letzten 30 Minuten über das Plugin heruntergefahren, gestoppt oder neu gestartet wurde.
  - **Speicher fast voll:** ab der Schwelle (Vorgabe 90 %), erneut erst nach Absinken um 2 Punkte.
  - **Backup fehlgeschlagen** (hoch): jede neue fehlgeschlagene vzdump-Aufgabe („WARNINGS“
    zählen nicht als Fehler).
  - **Hohe Auslastung eines Nodes:** CPU- bzw. RAM-Schwelle (Vorgabe aus), wenn sie so lange
    anhält wie eingestellt (Vorgabe 15 Minuten).
  Mit Fakten (Verbindung, Node, Gast, Belegung, Fehler …). Beim ersten Sehen wird nichts
  gemeldet, ein Neustart wiederholt nichts (Zustand in `gc.storage`); gemeinsame Obergrenze
  unter dem Limit von GateControl, Alarme haben Vorrang.
- **Seite** (ohne eigenen Kopf, Reiter zuerst): Übersicht (Verbindungen → Node-Karten mit
  CPU/RAM/Disk/Swap-Balken, Laufzeit, Version, Last, Updates, HA), VMs & Container (Suche,
  Filter nach Verbindung/Typ/Status/überwacht, Tabelle mit VMID, Name, Typ, Node, Status,
  CPU/RAM, Laufzeit, Überwachen-Schalter, Aktionen), Speicher & Backups, Verbindungen
  (hinzufügen/bearbeiten/testen/löschen, letzte Aktionen, Einrichtungshilfe). Dialoge als
  Overlay über die ganze Seite. Deutsch und Englisch.
- **Einrichtung – Zertifikat:** GateControl prüft bei HTTPS zu einem Zugriffsziel immer das
  Zertifikat (öffentliche Zertifizierungsstellen, Hostname) und bietet Plugins weder
  „Zertifikat nicht prüfen“ noch Pinning an. Das ab Werk selbstsignierte Zertifikat von
  Proxmox (Port 8006) wird bei einer direkten Zuweisung (VPN-Peer oder Adresse mit HTTPS)
  daher abgelehnt („Zertifikat nicht vertrauenswürdig“). Empfohlen: eine **GateControl-HTTP-
  Route über ein Home Gateway** zur Proxmox-IP, Port 8006, mit **„Backend HTTPS“** (das Gateway
  spricht HTTPS ins LAN und akzeptiert selbstsignierte Zertifikate, optional mit SHA-256-
  Fingerabdruck an der Route gepinnt) – Route nur intern erreichbar machen oder schützen und
  als Zugriffsziel zuweisen. Alternativ ein Zertifikat einer öffentlichen Stelle auf Proxmox
  (ACME, z. B. Let's Encrypt per DNS-Challenge) und Zuweisung als Adresse mit diesem
  DNS-Namen, HTTPS, Port 8006.
- **Einrichtung – Token** (auf einem Node als root):
  ```
  pveum user add gatecontrol@pve --comment "GateControl"
  pveum acl modify / --users gatecontrol@pve --roles PVEAuditor
  pveum role add GateControlPower --privs "VM.PowerMgmt VM.Audit"
  pveum acl modify /vms --users gatecontrol@pve --roles GateControlPower
  pveum user token add gatecontrol@pve monitor --privsep 0
  ```
  PVEAuditor auf `/` (Sys.Audit, VM.Audit, Datastore.Audit …) genügt für den Status;
  VM.PowerMgmt auf `/vms` für die Steuerung (ohne sie bleibt das Plugin lesend). Sys.Modify
  auf `/nodes` nur, wenn die Update-Liste gewünscht ist.
- Speicher: eigene SQLite-Datenbank (Verbindungen, überwachte Gäste, letzter Stand, Aktionen;
  Migration `001_init`), Benachrichtigungszustand in `gc.storage`. Lizenzpflichtig;
  benötigt GateControl ab 1.154.0.
