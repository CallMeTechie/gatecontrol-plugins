# Vault (gatecontrol-vault)

Passwort-Manager auf dem eigenen GateControl-Server – Ende-zu-Ende verschlüsselt.

## 1.4.1
- **„Verstecktes Netz“:** Der WLAN-Editor im Portal-Tab hat eine Checkbox „Verstecktes Netz“ (wie die Apps). Sie
  wird im Eintrag als `hidden` gespeichert; der WLAN-QR-Code und eine Freigabe bekommen dann `H:true`, damit Handys
  auch ein Netz finden, das seinen Namen nicht ausstrahlt. Die Ansicht zeigt „Verstecktes Netz: Ja“.

## 1.4.0
- **WLAN freigeben – auf dem Wandtablet und der Portal-Startseite:** Bei einem WLAN-Eintrag gibt es den Bereich
  „Freigaben“ mit „Freigabe auf Wandtablet“ und „Freigabe auf Portalseite“. Dauer: 5 Minuten, 1 Stunde, 24 Stunden
  oder dauerhaft. Laufende Freigaben stehen am Eintrag mit Restzeit und lassen sich jederzeit beenden.
- **Wandtablet:** Die Startseite des Wandtablets (Plugin **Familie** ab 1.14.0, Wand-Tablet eingeschaltet) zeigt eine
  Karte „WLAN“ mit Netzname, großem QR-Code und dem Passwort per Tippen; nach Ablauf verschwindet sie von selbst.
- **Portal-Startseite:** Alle angemeldeten Portal-Nutzer sehen auf der Startseite dieselbe Karte (QR-Code, Passwort per
  „Anzeigen“, Restzeit) – nie ein Kiosk-Gerät, nie ohne Anmeldung, nie in der Start-Karte der Apps. Braucht
  **GateControl 1.197.0**.
- **Sicherheit, bewusst entschieden:** Vault bleibt Ende-zu-Ende verschlüsselt. Eine Freigabe ist eine **Kopie**: Die
  App entschlüsselt nur Netzname, Sicherheit und Passwort des Eintrags und legt diese Kopie lesbar auf dem Server ab,
  damit Tablet und Portal sie zeigen können. Der Dialog sagt das vorher. Nur WLAN-Einträge, nur diese Felder; nur wer
  im Tresor schreiben darf, gibt frei oder beendet; die Mitglieder des Tresors sehen laufende Freigaben. Das Ende
  setzt der Server durch (abgelaufene werden nie ausgeliefert und gelöscht), „Beenden“ löscht sofort. Papierkorb,
  Löschen oder Verschieben des Eintrags und das Löschen des Tresors beenden die Freigabe; eine Änderung des Eintrags
  nicht – die Freigabe zeigt dann den alten Stand und der Eintrag bietet „Aktualisieren“ an.
- Höchstens 4 laufende Freigaben je Ziel, 30 Freigaben pro Person und Stunde. Jede Freigabe und jedes Ende steht im
  Protokoll (wer, welcher Eintrag, wo, wie lange – ohne Inhalt); die Übersicht für Administratoren zählt die laufenden.
- App-API: `GET wifi-shares`, `POST wifi-shares`, `DELETE wifi-shares/<id>` (README „WLAN-Freigaben“). Das Update
  fragt einmal nach der neuen Berechtigung „Dienste anderer Plugins: Familie – WLAN auf dem Wand-Tablet zeigen“.
- Der WLAN-QR-Code kennt jetzt auch versteckte Netze (`H:true`, Feld `hidden`).

## 1.3.0
- **2FA mit der Kamera scannen:** Neben „QR-Code aus Bild“ gibt es beim 2FA-Schlüssel den Knopf „Mit Kamera
  scannen“. GateControl öffnet dafür seinen eigenen Kamera-Dialog, liest den QR-Code der Website (oder den Export
  aus Google Authenticator) und gibt dem Vault-Tab nur den gelesenen Text – das Kamerabild bleibt in GateControl und
  wird nirgends gespeichert, die Kamera geht sofort wieder aus. Andere QR-Codes nimmt der Dialog nicht.
- Danach geht es weiter wie mit einem Bild: Schlüssel übernehmen, leeren Titel und Benutzernamen ergänzen, bei einem
  Export mit mehreren Konten eines auswählen, HOTP wird abgelehnt.
- Wird der Tab gesperrt, während der Kamera-Dialog offen ist, wird das Ergebnis verworfen.
- Der Knopf erscheint ab **GateControl 1.196.0**; auf älteren Versionen bleibt „QR-Code aus Bild“. Das Update fragt
  einmal nach der neuen Berechtigung „QR-Codes: Kamera zum Scannen von QR-Codes (das Bild bleibt in GateControl, das
  Plugin bekommt nur den gelesenen Text)“.

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
