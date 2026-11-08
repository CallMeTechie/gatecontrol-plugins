<!-- version: 1.4.3 -->
# Vault

## Was das Plugin kann

- **Passwort-Manager auf deinem eigenen Server:** Logins, 2FA-Codes, Notizen, Karten, WLAN-Zugänge und Identitäten.
- **Ende-zu-Ende verschlüsselt:** Ver- und entschlüsselt wird nur in den GateControl-Apps (Android, Windows) und im Portal-Tab „Vault“ im Browser. Der Server speichert nur Daten, die er nicht lesen kann – auch kein Administrator.
- **Persönlicher Tresor** und **geteilte Tresore** (z. B. Familie, Team) mit Rollen.
- **Offline** in den Apps, Abgleich ohne VPN über die normale Adresse des Servers.
- **Wiederherstellungsschlüssel** bei vergessenem Hauptpasswort und **Notfallzugriff** für Vertrauenspersonen.
- **Papierkorb** (30 Tage) und die letzten 10 Fassungen jedes Eintrags.
- **2FA aus einem QR-Code** – aus einem Bild, einem Screenshot oder mit der Kamera.
- **WLAN freigeben** auf dem Wandtablet und der Portal-Startseite, für eine Zeit, die du wählst.

## Voraussetzungen

- GateControl **1.197.0** oder neuer (für „Mit Kamera scannen“ im Portal 1.196.0 oder neuer).
- Für die WLAN-Freigabe auf dem Wandtablet: das Plugin **Familie** ab 1.14.0 mit eingeschaltetem Wand-Tablet.

## Einrichten

Jede Person richtet Vault selbst ein – in der App oder im Portal-Tab **„Vault“**:

1. **„Vault einrichten“** und ein **Hauptpasswort** wählen. Das Hauptpasswort kennt nur die Person. Niemand kann es zurücksetzen, auch kein Administrator.
2. Den **Wiederherstellungsschlüssel** aufschreiben, kopieren oder als Textdatei speichern und an einem sicheren Ort aufbewahren. Ohne ihn sind die Daten bei vergessenem Hauptpasswort verloren.
3. Bestätigen, dass du ihn sicher aufbewahrt hast. Erst dann ist Vault eingerichtet.

Für Administratoren gibt es nichts einzurichten. Die Admin-Seite **„Übersicht“** zeigt nur, wer Vault nutzt, und Zahlen – nie Namen von Tresoren oder Einträgen.

## Benutzen

### Einträge

- **„Neu“** legt einen Eintrag an: Login, 2FA-Code, Notiz, Karte, WLAN oder Identität, mit eigenen Feldern und dem Passwort-Generator.
- Geheime Felder bleiben verdeckt, bis du **„Anzeigen“** klickst. **„Kopieren“** legt den Wert in die Zwischenablage.
- 2FA: neben dem 2FA-Schlüssel **„QR-Code aus Bild“** (Bild wählen, Screenshot mit Strg+V einfügen oder hineinziehen) oder **„Mit Kamera scannen“**. Auch der Export aus Google Authenticator wird erkannt.
- WLAN-Einträge zeigen einen **QR-Code** zum Verbinden; „Verstecktes Netz“ für ein Netz, das seinen Namen nicht ausstrahlt.
- **Papierkorb:** Gelöschtes bleibt 30 Tage. **Verlauf:** die letzten 10 Fassungen eines Eintrags.
- **Importieren / Exportieren:** Import aus anderen Passwort-Managern; der Export als CSV ist **unverschlüsselt** – das Portal warnt vorher und fragt noch einmal nach dem Hauptpasswort.

### Tresore teilen

Unter **„Tresore & Teilen“** legst du geteilte Tresore an und fügst Personen hinzu. Vor dem Hinzufügen zeigt Vault eine **Sicherheitsnummer** – vergleiche sie mit der Person (z. B. am Telefon). Rollen:

- **Sehen** – Einträge sehen und kopieren,
- **Bearbeiten** – auch anlegen, ändern, löschen,
- **Verwalten** – auch Personen hinzufügen und entfernen, Rollen ändern, den Tresor umbenennen oder löschen.

Ein Tresor hat immer mindestens eine verwaltende Person. Der persönliche Tresor wird nie geteilt.

### Notfallzugriff

Unter **„Notfallzugriff“** benennst du Vertrauenspersonen mit einer Wartezeit (1 bis 720 Stunden). Fordert eine Vertrauensperson Zugriff an, bekommst du eine Mitteilung und kannst ablehnen. Erst wenn die Wartezeit um ist (oder du früher zustimmst), kann sie alle deine Tresore lesen – nur lesen. Du kannst den Zugriff jederzeit zurücknehmen.

### WLAN freigeben

Bei einem WLAN-Eintrag unter **„Freigaben“**: **„Freigabe auf Wandtablet“** oder **„Freigabe auf Portalseite“**, für 5 Minuten, 1 Stunde, 24 Stunden oder dauerhaft. Laufende Freigaben stehen mit Restzeit am Eintrag und lassen sich jederzeit beenden.

> **Hinweis:** Eine Freigabe ist eine **lesbare Kopie** von Netzname, Sicherheit und Passwort auf dem Server – sonst könnten Tablet und Portal sie nicht zeigen. Der Dialog sagt das vorher. Die Portal-Startseite zeigt sie allen angemeldeten Personen, nie einem Kiosk-Gerät und nie ohne Anmeldung.

### Sperren

Der Portal-Tab sperrt sich nach 5 Minuten ohne Eingabe, bei **„Jetzt sperren“** und beim Schließen. Die Schlüssel liegen nur im Speicher des Tabs.

## Berechtigungen

- Vault nutzen kann jede angemeldete Person – nie ein Kiosk-Gerät und nie ein Besuch, der nur über Geräte-Vertrauen erkannt ist.
- In geteilten Tresoren gelten die Rollen Sehen, Bearbeiten, Verwalten. WLAN freigeben oder eine Freigabe beenden darf nur, wer im Tresor mindestens bearbeiten darf.
- Administratoren sehen nur die Übersicht mit Zahlen. Es gibt **kein Zurücksetzen durch einen Administrator**.

## Häufige Fragen / Fehlersuche

**Ich habe mein Hauptpasswort vergessen.**
Wähle beim Entsperren den Wiederherstellungsschlüssel. Danach wählst du ein neues Hauptpasswort und bekommst einen neuen Wiederherstellungsschlüssel – der alte gilt dann nicht mehr. Ohne Wiederherstellungsschlüssel helfen nur ein freigegebener Notfallzugriff oder geteilte Tresore anderer.

**Das Portal zeigt „Bitte melde dich an“.**
Vault braucht eine richtige Anmeldung im Portal. Auf Kiosk-Geräten gibt es Vault nicht.

**„Mit Kamera scannen“ fehlt.**
Das braucht GateControl 1.196.0 oder neuer. „QR-Code aus Bild“ geht immer.

**Beim Speichern meldet Vault eine neuere Fassung.**
Jemand hat den Eintrag inzwischen geändert. Wähle „Meine Fassung speichern“ (die andere bleibt im Verlauf) oder speichere als Kopie.

**Die WLAN-Karte auf dem Tablet zeigt ein altes Passwort.**
Eine Freigabe ist eine Kopie. Nach einer Änderung am Eintrag bietet der Eintrag „Aktualisieren“ an.

## Neu in 1.4.3

- **Weniger Schreibarbeit:** „Zuletzt gesehen“ eines Kontos geht jetzt auf 10 Minuten genau. Auf einem langsamen Datenträger (NAS mit Festplatten) bleibt GateControl dadurch flüssiger.

## Neu in 1.4.2

- Dieses Handbuch im Reiter „Handbuch“ (GateControl ≥ 1.241.0).

Zuletzt in 1.4.1: „Verstecktes Netz“ im WLAN-Editor des Portals; QR-Code und Freigabe finden dann auch Netze ohne ausgestrahlten Namen.
