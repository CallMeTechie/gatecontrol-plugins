# Vault (gatecontrol-vault)

Passwort-Manager auf dem eigenen GateControl-Server – Ende-zu-Ende verschlüsselt.

## 1.2.0
- **2FA per QR-Code einrichten:** Beim Anlegen oder Bearbeiten eines Logins oder eines 2FA-Codes gibt es neben dem
  2FA-Schlüssel den Knopf „QR-Code aus Bild“. Dort ein Bild wählen, einen Screenshot mit Strg+V einfügen oder das Bild
  hineinziehen: Der Schlüssel wird übernommen, ein leerer Titel kommt vom Anbieter, bei Logins ein leerer
  Benutzername vom Konto.
- Nur zeitbasierte Codes (TOTP): Für HOTP-Codes, Bilder ohne 2FA-QR-Code und Bilder, die der Browser nicht lesen kann,
  sagt der Tab, was nicht geht.
- **Export aus Google Authenticator:** Enthält der QR-Code mehrere Konten, wählt man eines davon aus; Konten, die Vault
  nicht nutzen kann (HOTP), werden angezeigt, lassen sich aber nicht wählen. Bei einem Export aus mehreren QR-Codes
  liest man die anderen einzeln ein.
- Das Bild wird nur im Browser-Tab gelesen und danach verworfen – es wird weder gespeichert noch gesendet. Ein
  Ergebnis, das erst nach dem Sperren fertig wird, wird verworfen.
- Mit der Kamera scannen geht im Portal-Tab nicht: Der Browser gibt dem abgeschotteten Tab keine Kamera. Ein Foto
  oder Screenshot des QR-Codes funktioniert.

## 1.1.0
- **Vault im Portal:** Der neue Portal-Tab „Vault“ ist der ganze Passwort-Manager im Browser – Ende-zu-Ende
  verschlüsselt wie in den Apps. Entschlüsselt wird nur in diesem Browser-Tab: Er sperrt nach 5 Minuten ohne Eingabe,
  beim Schließen und mit „Jetzt sperren“; dabei werden alle Schlüssel und alles Entschlüsselte verworfen. Im Browser
  wird nichts gespeichert – der Tab arbeitet nur online.
- **Einrichten und Entsperren im Browser:** Hauptpasswort (mindestens 12 Zeichen, mit Stärke-Anzeige),
  Wiederherstellungsschlüssel zum Kopieren oder als Textdatei, erst nach „Ich habe ihn sicher aufbewahrt“ wird Vault
  angelegt. Passwort vergessen: mit dem Wiederherstellungsschlüssel ein neues Hauptpasswort und einen neuen
  Wiederherstellungsschlüssel wählen. Das Hauptpasswort lässt sich auch im Portal ändern.
- **Einträge:** Tresore mit Anzahl, Suche, Favoriten; Logins, 2FA-Codes (mit laufendem Code), Notizen, Karten, WLAN
  (mit QR-Code für Gäste) und Identitäten ansehen, anlegen und bearbeiten – mit weiteren Feldern und
  Passwort-Generator. Geheimes bleibt verdeckt, bis man es anzeigt; Kopieren mit einem Klick. Papierkorb und Verlauf
  (frühere Fassungen wiederherstellen).
- **Teilen und Notfallzugriff:** Geteilte Tresore anlegen, umbenennen, löschen, Personen mit Rolle hinzufügen – vorher
  die Sicherheitsnummer vergleichen. Vertrauenspersonen mit Wartezeit festlegen, Anfragen ablehnen oder freigeben,
  einen freigegebenen Vault nur lesend öffnen.
- **Importieren und Exportieren:** Bitwarden (JSON/CSV), Chrome/Edge, 1Password, KeePass und Firefox (CSV) mit
  Vorschau und Erkennung von Doppelten; Export als unverschlüsselte CSV-Datei erst nach Warnhinweis und Hauptpasswort.
- Gleichzeitige Änderungen gehen nicht verloren: Wurde ein Eintrag inzwischen woanders geändert, lädt der Tab die neue
  Fassung und fragt, ob die eigene gespeichert oder als Kopie abgelegt werden soll. Während eines Schlüsselwechsels
  speichert der Tab mit dem neuen Schlüssel; den Wechsel selbst erledigen weiterhin die Apps.
- Der Portal-Tab erscheint nicht auf Wand-Tablets (Kiosk-Geräten) und nur nach einer Anmeldung im Portal.
- Sicherheit im Browser: Bei der Wiederherstellung gelten neues Passwort und neuer Schlüssel erst nach „Ich habe ihn
  sicher aufbewahrt“; solange ein Wiederherstellungsschlüssel angezeigt wird, sperrt der Tab nicht von selbst. Die
  Seite bleibt bedienbar, während das Hauptpasswort geprüft wird; wird dabei gesperrt, wird nichts gesendet. Konten,
  die mehr als 256 MB für das Hauptpasswort verlangen, öffnet der Tab nicht (das schützt vor einem Server, der den
  Browser überlasten will). Im CSV-Export werden Werte, die eine Tabellenkalkulation als Formel ausführen würde, mit
  einem ' entschärft (Passwörter und 2FA-Schlüssel bleiben unverändert).

## 1.0.1
- **Schlüsselwechsel nur noch einer zur Zeit:** Starten zwei Verwalter gleichzeitig einen Schlüsselwechsel, lehnt der
  Server den zweiten ab (`rekeying`); dessen App macht mit dem bereits begonnenen Wechsel weiter. Bisher konnten
  Einträge unter einem Schlüssel landen, den der Tresor danach nicht mehr kannte. Ein Wechsel, der einen Tag lang
  ohne Fortschritt hängt, darf neu begonnen werden.

## 1.0.0
- **Der Server-Teil von Vault.** Logins, 2FA-Codes, Notizen, Karten und WLAN-Zugänge liegen verschlüsselt auf dem
  eigenen Server. Ver- und entschlüsselt wird nur in den Apps (Android, Windows, später das Portal); der Server
  speichert ausschließlich Daten, die er nicht lesen kann – auch ein Administrator nicht.
- **Persönlicher Tresor und geteilte Tresore** (z. B. „Familie“, „Team“) mit Rollen: *lesen*, *bearbeiten*,
  *verwalten*. Wer einen geteilten Tresor verlässt oder entfernt wird, löst einen Schlüsselwechsel aus, den die App
  eines Verwalters im Hintergrund erledigt.
- **Offline und ohne VPN:** Die Apps halten eine verschlüsselte Kopie und gleichen über die normale Server-Adresse
  ab – nur die Änderungen seit dem letzten Abgleich. Gleichzeitige Änderungen gehen nie verloren: beide Fassungen
  bleiben erhalten.
- **Papierkorb (30 Tage) und Versionen** (die letzten 10 je Eintrag).
- **Wiederherstellung:** Wiederherstellungsschlüssel bei der Einrichtung (zum Ausdrucken, als QR oder Wortliste) und
  **Notfallzugriff** für Vertrauenspersonen mit Wartezeit (1 Stunde bis 30 Tage): Die Anfrage kommt als Mitteilung,
  Ablehnen geht bis zum Ende der Wartezeit. Kein Zurücksetzen durch den Admin.
- **Admin-Seite „Übersicht“:** wer Vault eingerichtet hat und Zahlen – keine Inhalte, keine Schlüssel.
- Mitteilungen: „Tresor mit dir geteilt“ und Notfallzugriff (angefordert, abgelehnt, freigegeben).
- App-API und Kryptoformat im README.
