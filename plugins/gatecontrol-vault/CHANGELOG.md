# Vault (gatecontrol-vault)

Passwort-Manager auf dem eigenen GateControl-Server – Ende-zu-Ende verschlüsselt.

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
