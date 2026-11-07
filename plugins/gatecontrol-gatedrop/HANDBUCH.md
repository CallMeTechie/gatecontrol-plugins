<!-- version: 1.5.1 -->
# GateDrop

## Was das Plugin kann

Teilen wie Quick Share – über deinen eigenen GateControl-Server:

- **Dateien** (1 bis 20 je Sendung, bis 2 GB je Datei), einen **Text** oder einen **Link** senden.
- **An Personen:** als Nachricht im Messenger.
- **An die eigenen Geräte** (Android, Windows): im selben WLAN direkt von Gerät zu Gerät, sonst über den Server.
- **In NAS-Ordner** (Plugin NAS (Synology)) und **ins eigene Drive** (Plugin Drive).
- **Als Link für Externe:** zeitlich begrenzt, auf Wunsch mit PIN.
- Empfangenes bleibt auf dem Server, bis es abgeholt ist – wie lange, legt ein Administrator fest (Standard 7 Tage).
- Neue Dateien prüft der Virenscan von GateControl, wenn er eingerichtet ist.

## Voraussetzungen

- GateControl **1.193.0** oder neuer.
- Zum Senden an Personen: das Plugin **Messenger**.
- Für NAS-Ordner: das Plugin **NAS (Synology)** mit freigegebenen Ordnern („Ablage für GateDrop“).
- Fürs eigene Drive: das Plugin **Drive** ab 1.4.0 und einen Drive-Platz für die Person.
- Für Geräte: die GateControl-App auf Android oder der Windows-Client.

## Einrichten

1. **Plugin installieren.** Senden an Personen und eigene Geräte geht danach sofort.
2. **Links für Externe** (optional): **Einstellungen › Plugins › GateDrop › Berechtigungen** › **„Öffentliche Links erlauben“** einschalten (Standard aus). Die Links laufen über die öffentliche Adresse deines Servers.
3. **NAS-Ordner** (optional): im Plugin NAS (Synology) unter „Ablage für GateDrop“ Ordner freigeben.
4. **Aufbewahrung** auf der Admin-Seite **„Übersicht“**: „Nach der Abholung“ sofort / 1 / 3 / 7 Tage und „Nicht abgeholt“ 3 / 7 / 14 / 30 Tage (Standard 7 / 7).
5. **Auf den Geräten:** In der App bzw. im Windows-Client auf der Seite GateDrop legst du fest, wer an dieses Gerät senden darf – nur du (Standard) oder alle Konten dieses GateControl.

## Benutzen

### Senden

- **Portal-Tab „GateDrop“:** Dateien hineinziehen oder auswählen, Text oder Link einfügen (Strg+V), unter **„Senden an“** das Ziel wählen, **„Senden“**.
- **Apps:** GateDrop-Seite der App oder „Teilen“ aus einer anderen App.
- Ziele: Personen (auch die ganze Familie), deine Geräte, freigegebene Geräte anderer, NAS-Ordner, dein Drive, „Link für Externe …“.

### Link für Externe

Gültig 1 Stunde, 1 Tag, 7 Tage oder für 1× herunterladen, auf Wunsch **„Mit PIN schützen“** – gib die PIN getrennt weiter, z. B. per Anruf. Nach 5 falschen PINs ist der Link gesperrt. Unter **„Aktive Links“** siehst du deine Links und kannst sie beenden.

### Empfangen

- Auf Geräten holt die App die Dateien ab; „Abgeholt“ gilt erst, wenn das Gerät alles gespeichert hat.
- Personen bekommen die Sendung als Nachricht im Messenger.
- Mitteilungen: „Empfangen“ und „Link geladen“ (wie oft heruntergeladen, „Link gesperrt“ nach 5 falschen PINs).

### Übersicht (Administratoren)

Belegter Speicher, angekommene Sendungen, der Weg (direkt oder über den Server), was nicht abgeholt ist, und die Liste aller Sendungen mit Status – **ohne** Dateinamen, Texte, Links und Pfade, nur mit Namen von Personen und Geräten. **„Speicher freigeben“** löscht Server-Kopien alter oder schon abgeholter Sendungen; was schon auf Geräten, im NAS, im Drive oder im Messenger liegt, bleibt dort.

## Berechtigungen

- **An Personen und eigene Geräte senden:** alle Konten – nie ein Kiosk-Gerät, nie ein Besuch nur über Geräte-Vertrauen.
- **An das Gerät einer anderen Person:** nur, wenn sie es auf diesem Gerät für alle geöffnet hat.
- **Links für Externe und NAS-Ordner:** Administratoren und Eltern aus dem Plugin Familie. Links zusätzlich nur mit „Öffentliche Links erlauben“.
- **Eigenes Drive:** jede Person mit einem Drive-Platz.

## Häufige Fragen / Fehlersuche

**„Links für Externe sind ausgeschaltet.“**
Ein Administrator schaltet sie unter Einstellungen › Plugins › GateDrop › Berechtigungen › „Öffentliche Links erlauben“ ein.

**Mein Gerät erscheint nicht als Ziel.**
Als eigene Geräte erscheinen nur App-Installationen, die GateDrop schon einmal benutzt haben. Öffne einmal die GateDrop-Seite der App.

**Die Übertragung geht nicht direkt.**
Direkt geht es nur, wenn beide Geräte im selben WLAN sind. Sonst nimmt GateDrop von selbst den Weg über den Server.

**„Der Virenscan ist gerade nicht erreichbar“.**
Sende später noch einmal. Gesperrte Dateien gibt GateDrop nicht weiter.

**Eine Sendung heißt „Vom Admin entfernt“.**
Ein Administrator hat ihre Dateien auf dem Server gelöscht.

## Neu in 1.5.1

- Dieses Handbuch im Reiter „Handbuch“ (GateControl ≥ 1.241.0).

Zuletzt in 1.5.0: Übersicht mit allen Sendungen (ohne Inhalte), einstellbare Aufbewahrung, „Speicher freigeben“ und „Abgeholt“ nur mit echter Bestätigung.
