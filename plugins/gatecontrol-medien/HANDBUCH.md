<!-- version: 1.2.0 -->
# Medien – Handbuch

## Was das Plugin kann {#was-das-plugin-kann}

Medien bringt deine eigene Sammlung aus **Jellyfin** und den **Freigaben deiner NAS** (SMB, WebDAV) in die GateControl-Apps – auf das Handy, GateControl TV und GateControl für Windows. Du richtest die Quellen **einmal im Server** ein. Jede Person mit dem Recht „Medien“ sieht Medien danach auf jedem ihrer Geräte von selbst, mit den Quellen, die du ihr freigibst. Am Gerät wird nichts eingegeben.

- **Jellyfin**: Jede Person bekommt ihren eigenen Jellyfin-Benutzer, so bleiben Fortschritt und „Gesehen“ je Person. Die Geräte melden sich unsichtbar über Quick Connect an. In Jellyfins Geräteliste steht jedes Gerät als „GateControl · …“.
- **NAS-Freigaben**: ein Paar aus SMB (zu Hause) und WebDAV (unterwegs) oder eine einzelne Freigabe. Das Passwort eines Lese-Benutzers liegt verschlüsselt im Server und geht nur an berechtigte Geräte.
- **Videos laufen nie über den Server.** Zu Hause spielen die Geräte direkt im Heimnetz, unterwegs durch das VPN. Der Server liefert nur die Liste, Adressen und Zugänge.
- **„Auf TV/PC abspielen“**: Das Handy schickt Titel und Stelle an den eigenen Fernseher oder PC und bleibt Fernbedienung.

## Voraussetzungen {#voraussetzungen}

- GateControl ab 1.325.0.
- Eine **eigene Lizenz für Medien**. Sie ist nicht in GateControl Lifetime oder einem Paket enthalten.
- **Jellyfin ab 10.9** mit Quick Connect (z. B. das Synology-Paket) und/oder SMB/WebDAV-Freigaben auf der NAS.
- Ein Gateway im Heimnetz, über das der Server Jellyfin erreicht (Zugriffsziel), und ein VPN, das das Heimnetz (z. B. 192.168.1.0/24) in den Tunnel gibt.
- Die GateControl-Apps in einer Version mit Medien vom Server.

## Einrichten {#einrichten}

### Zugriffsziele {#zugriffsziele}

Ein eigener Schritt ist nicht nötig: Wo der Server eine Quelle erreicht, wählst du nur im Quellen-Dialog (**„Wo läuft Jellyfin?“**, **„Wo liegt die NAS?“**). Mit **„Prüfen und speichern“** erlaubt Medien dem Server selbst, dieses Ziel zu erreichen (die **Server-Freigabe**). Dafür hat Medien die Berechtigung **„Zugriffsziele selbst zuweisen“**. Sie gilt nur in deiner Sitzung als Administrator, und jede Änderung steht im Aktivitätsprotokoll. Ab GateControl 1.325.0 zeigt **Einstellungen › Plugins › Medien › Einstellungen** keine Zugriffsziele mehr – es gibt nur noch diese eine Stelle. Bestehende Zuweisungen bleiben gültig, der Dialog bietet sie unter „Andere Route oder Adresse …“ an.

- **Jellyfin-Server (HTTP)**: Port 8096. Für mehrere Jellyfin-Server je Server ein Ziel.
- **WebDAV der NAS**: zum Prüfen von Anmeldung und Ordner einer Freigabe.
- **SMB der NAS**: nur Erreichbarkeit (mit einem VPN-Peer als NAS). Der Server spricht kein SMB, die Anmeldung per SMB prüfen die Geräte.

Im Reiter Quellen steht bei jeder Quelle, **über** welche Route sie läuft, und **„Server-Freigabe: aktiv“**. Entfernst du eine Quelle, entfernt Medien ihre Server-Freigabe mit, wenn keine andere Quelle sie nutzt. Die Freigaben anderer Quellen bleiben dabei immer, wie sie sind.

### Jellyfin hinzufügen {#jellyfin}

1. In Jellyfin: **Dashboard › API-Schlüssel › „+“**, App-Name „GateControl“. Den Schlüssel kopieren.
2. In GateControl: **Einstellungen › Plugins › Medien › Quellen › Quelle hinzufügen › Jellyfin-Server**.
3. **Wo läuft Jellyfin?** Routen, die nach Jellyfin aussehen (Name oder Port 8096), stehen oben zur Wahl. Alles andere – jede Route, ein VPN-Peer oder eine schon zugewiesene Adresse – unter **„Andere Route oder Adresse …“**.
4. Den **API-Schlüssel** einfügen. Den **Namen** übernimmt Medien beim Prüfen aus Jellyfin (Servername).
5. **Prüfen und speichern**: erreichbar, Version, Schlüssel gültig, Quick Connect – das Ergebnis steht im Dialog und auf der Quelle. Ist Quick Connect aus, schaltet **„In Jellyfin einschalten“** es nach Rückfrage in der Jellyfin-Konfiguration ein. Der Schlüssel ist danach nur noch ersetzbar, nicht mehr lesbar.

Unter **„Erweitert“** stehen, vorbelegt: der Name, die **Adresse zu Hause** (aus dem Ziel der Route, z. B. `http://192.168.2.151:8096`, sonst die Adresse, die Jellyfin selbst meldet), **Unterwegs** (nur über VPN oder die Ausnahme ohne VPN mit `https://<Domain der Route>`) und **Herunterladen für offline**.

Die DSM-Firewall muss TCP 8096 vom Gateway und aus dem Tunnelnetz zulassen. Die Suche im Heimnetz (UDP 7359) wird nicht gebraucht.

### NAS-Freigabe hinzufügen {#freigabe}

1. In DSM einen eigenen Benutzer nur mit **Leserecht** auf die Medien-Freigaben anlegen (z. B. „medien-lesen“, ohne DSM-Anmeldung).
2. **Quelle hinzufügen › NAS-Freigabe**: **Wo liegt die NAS?** (Route, VPN-Peer oder schon zugewiesene Adresse), **Freigabename** (z. B. `video`), **Benutzer** und **Passwort**.
3. **Prüfen und speichern.** Medien legt die SMB-Adresse (`smb://<NAS>/video`) und – wenn die NAS per HTTPS erreichbar ist – die WebDAV-Adresse (`https://<NAS>:5006/video`) selbst an und erlaubt dem Server, die NAS zu erreichen.

Unter **„Erweitert“**: Name, SMB- und WebDAV-Adresse, das Zertifikat (SHA-256, zum Anheften bei selbst signierten Zertifikaten) und Unterwegs. Bei einem VPN-Peer als NAS trägst du die Heimnetz-Adressen dort selbst ein – die VPN-Adresse des Peers ist zu Hause nicht erreichbar. Nimm IP-Adressen statt Namen wie `\\nas`: Namen werden unterwegs nicht aufgelöst.

### Netz: zu Hause direkt, unterwegs über VPN {#netz}

- **Zu Hause** spielen die Geräte direkt im Heimnetz, nie über den Server oder den Tunnel, auch wenn das VPN an ist. Ob ein Gerät zu Hause ist, erkennt es selbst über das WLAN/LAN (nie durch den Tunnel): Es fragt den Jellyfin-Server (passende Server-ID) oder prüft das angeheftete Zertifikat der WebDAV-Freigabe. Gibt es beides nicht, prüft es, ob die Heimadresse der Quelle antwortet (z. B. SMB-Port 445 der NAS) – das reicht, damit das Gerät zu Hause nicht durch das VPN geht, ist aber nicht eindeutig: Ein fremdes Netz mit derselben Adresse antwortet auch. Solche Quellen zeigt der Reiter Quellen mit **„Heimnetz nicht eindeutig“**; eindeutig werden sie mit einer WebDAV-Adresse samt Zertifikat (SHA-256). Die Server-ID von Jellyfin merkt sich das Plugin beim Speichern; war Jellyfin da aus, holt „Prüfen“ oder der nächste Abgleich (alle 5 Minuten) sie nach. Eine beliebige 192.168.1.x-Adresse allein reicht nicht.
- **Unterwegs** gehen Medien **nur durch das VPN**. Ist es aus, schaltet die App es beim Abspielen selbst ein. Ohne VPN spielt die App unterwegs nichts ab und sagt „Unterwegs nur über VPN“.
- **Ausnahme „Unterwegs ohne VPN erlauben“**: im Quellen-Dialog je Quelle oder unter Einstellungen › Netz für alle Quellen. Dann braucht die Quelle eine **HTTPS-Adresse für unterwegs**, z. B. eine GateControl-Route (`https://jellyfin.example.test`). Eine Adresse mit `http://` nimmt der Dialog nicht an. Quellen ohne diese Adresse bleiben unterwegs beim VPN.

### Personen verknüpfen {#personen}

Reiter **Personen**:

- **Medien**: das Recht, den Bereich Medien in den Apps zu sehen. „wie Gruppen“ übernimmt es aus den Gruppen (Tabelle Gruppen darunter). Administratoren haben es ohne Einstellung.
- **Jellyfin-Benutzer**: automatisch per Name (ganzer Name oder Vorname, Groß/klein egal), sonst von Hand wählen, „bewusst ohne“ oder **„In Jellyfin anlegen“** (normaler Benutzer mit zufälligem Passwort, das niemand sieht). Bibliotheken und Altersgrenze stellst du in Jellyfin je Benutzer ein. Jellyfin-Administratoren bietet die Liste nicht an. Wer selbst Jellyfin-Admin ist, bekommt einen zweiten, normalen Benutzer.
- **Häkchen je Quelle**: wer die Quelle sieht. „Standard“ entfernt die eigene Einstellung einer Person.

Für ein Familien-TV legst du in GateControl eine Person „Wohnzimmer“ an und verknüpfst sie mit einem Jellyfin-Benutzer „familie“.

## Benutzen {#benutzen}

- In den Apps erscheint **Medien** von selbst, sobald die Person das Recht und mindestens eine Quelle hat. **Medien › Quellen** ist dort nur eine Anzeige.
- **Reiter Geräte**: alle Apps von Personen mit Medien-Recht, ob sie bei Jellyfin angemeldet sind, welche Freigabe-Passwörter sie bekommen haben und was sie über ihren Weg melden. **Abmelden** löscht das Gerät in Jellyfin und schickt ihm eine stille Mitteilung (Zugänge und Downloads löschen). Solange die Person das Recht hat, meldet es sich danach selbst neu an.
- **Passwort ersetzen**: Alle berechtigten Geräte bekommen das neue Passwort beim nächsten Kontakt.
- **Übersicht** (Seitenleiste Apps › Medien): Lizenz, Zahlen, Zustand der Quellen, Protokoll.
- **„Auf TV/PC abspielen“** (Einstellung unter Geräte): Das Handy bietet die eigenen GateControl-TV- und Windows-Geräte an. Der Fernseher holt das Video selbst von der NAS.

## Berechtigungen {#berechtigungen}

| Wer | Was |
|---|---|
| Administratoren | richten alles ein. Sie haben das Recht „Medien“, solange es nicht für sie ausgeschaltet ist. |
| Personen mit „Medien“ | sehen Medien in ihren Apps mit den Quellen, die für sie freigegeben sind. |
| Kinder (Familie: Kind) | sehen NAS-Freigaben nur mit der Einstellung „Kinder sehen NAS-Freigaben“. Bei Jellyfin gilt der Jugendschutz ihres Jellyfin-Benutzers. |
| Geräte | bekommen ein NAS-Passwort nur mit Gerätebindung, einer aktiven Person mit Recht auf die Freigabe. Der Jellyfin-Zugang entsteht auf dem Gerät selbst, der Server sieht ihn nie. |

Der Jellyfin-Schlüssel verlässt den Server nie. Das Protokoll nennt Personen, Geräte und Quellen, nie Passwörter, Schlüssel, Codes oder Jellyfin-Zugänge.

## Häufige Fragen / Fehlersuche {#fehlersuche}

- **„Der Admin muss Quick Connect in Jellyfin einschalten“**: Quellen › Jellyfin › „In Jellyfin einschalten“, oder in Jellyfin Dashboard › Allgemein › Quick Connect.
- **„Der Admin muss dich … mit Jellyfin verknüpfen“**: Reiter Personen, Jellyfin-Benutzer wählen oder anlegen.
- **Jellyfin nicht erreichbar**: Richtige Route bzw. richtiger Peer unter „Wo läuft Jellyfin?“? Gateway online? DSM-Firewall Port 8096?
- **„durch den Tunnel nicht erreichbar“** im Reiter Geräte: Das Gateway gibt das Heimnetz nicht in den Tunnel weiter, oder die DSM-Firewall lässt das Tunnelnetz nicht zu (8096, 5006, ggf. 445).
- **Ein Handy ist verloren**: in GateControl entfernen (Jellyfin ist sofort bzw. nach höchstens 5 Minuten zu). Das NAS-Passwort lässt sich von einem Gerät, das nicht mehr online kommt, nicht zurückholen: Passwort in DSM ändern und unter Quellen ersetzen.
- **Lizenz**: Ohne eigene Lizenz für Medien blenden die Apps Medien aus. Eine GateControl-Lifetime-Lizenz zählt hier nicht.

## Neu in 1.2.0 {#neu-1-2-0}

- **Eine Stelle für Quellen:** Der Dialog fragt nur noch das Nötige – **„Wo läuft Jellyfin?“**, API-Schlüssel und den Namen aus Jellyfin; bei NAS-Freigaben **„Wo liegt die NAS?“**, Freigabename, Benutzer und Passwort. Alles andere steht vorbelegt unter **„Erweitert“**.
- **Server-Freigabe automatisch:** Mit „Prüfen und speichern“ erlaubt Medien dem Server, das gewählte Ziel zu erreichen; der Dialog sagt vorher, welches. SMB- und WebDAV-Adresse entstehen aus der NAS und dem Freigabenamen.
- **Reiter Quellen:** je Quelle „über“ mit der Route und „Server-Freigabe: aktiv“. Beim Entfernen geht eine Freigabe mit, die keine andere Quelle nutzt.
- GateControl zeigt die Zugriffsziele von Medien unter Einstellungen nicht mehr (siehe [Zugriffsziele](#zugriffsziele)). Braucht GateControl ab 1.325.0.

## Neu in 1.1.0 {#neu-1-1-0}

- **Einrichtung an einer Stelle:** Jellyfin-Server und NAS-Freigaben legst du nur noch unter Medien › Quellen an. Im Dialog wählst du die Route oder den Peer, beim Speichern weist Medien das Zugriffsziel selbst zu. Der Knopf „Zugriffsziele öffnen“ ist weg (siehe [Zugriffsziele](#zugriffsziele)).
- **Adressen vorbelegt:** Die Heimnetz-Adresse kommt aus dem Ziel der Route, die HTTPS-Adresse für unterwegs aus ihrer Domain. Beides lässt sich überschreiben.
- Zugriffsziele, die du schon zugewiesen hast, bleiben gültig. Braucht GateControl ab 1.324.0.

## Neu in 1.0.1 {#neu-1-0-1}

- **Heimnetz für jede Quelle erkannt:** Bisher erkannten die Geräte das Heimnetz nur an einem Jellyfin mit bekannter Server-ID oder an einer WebDAV-Freigabe mit angeheftetem Zertifikat. Bei einer reinen SMB-Freigabe oder einem Jellyfin, der beim Speichern aus war, gingen die Geräte auch zu Hause durch das VPN. Jetzt bekommt jede Quelle eine Erkennung, notfalls „die Heimadresse antwortet“ (siehe [Netz](#netz)).
- **Reiter Quellen und Übersicht:** Zeile „Heimnetz-Erkennung“ und das Zeichen **„Heimnetz nicht eindeutig“**.

## Neu in 1.0.0 {#neu-1-0-0}

Erste Version: Jellyfin und NAS-Freigaben zentral im Server, Recht „Medien“ und Sicht je Quelle, automatische Zuordnung zu Jellyfin-Benutzern, Anmeldung der Geräte ohne Eingabe über Quick Connect, Widerruf, Netz-Regel (zu Hause direkt, unterwegs über VPN, Ausnahme mit HTTPS-Adresse), „Auf TV/PC abspielen“.
