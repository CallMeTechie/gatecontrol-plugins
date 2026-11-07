<!-- version: 1.1.1 -->
# Hallo Welt

> **Hinweis:** Das ist das Beispiel-Plugin des Plugin-Repositorys für Plugin-Autoren. Es wird nie veröffentlicht. Dieses Handbuch zeigt zugleich, wie ein Plugin-Handbuch aufgebaut ist.

## Was das Plugin kann

- Eine Seite „Hallo“ und eine Seite „Über“ im Admin-Bereich, ein Portal-Tab „Hallo“.
- Einstellungen: Begrüßung, „Laut“, Wiederholungen und ein API-Token (als Geheimnis gespeichert).
- Einen **Edge-Teil**, der auf einem Gateway im Heimnetz läuft: Er beantwortet „Gateway grüßen“ und meldet sich jede Minute mit einem Heartbeat.

## Voraussetzungen

- GateControl **1.228.0** oder neuer.
- Für den Edge-Teil: ein Gateway **1.19.0** oder neuer mit dem Dienst `edge` in der Compose-Datei.
- Weil das Plugin nicht signiert ist: *Unsignierte Plugins erlauben* am Server und *Unsignierte Edge-Teile erlauben* am Gateway.

## Einrichten

1. Das Plugin unsigniert bauen (`npm run pack gatecontrol-hello`) und unter **Einstellungen › Plugins** hochladen.
2. **Gateways** › dein Gateway › Reiter **„Edge-Plugins“**: Edge-Teile einschalten, dann „Hallo Welt“ einschalten und die (leere) Liste der Fähigkeiten bestätigen.
3. **Einstellungen › Plugins › Hallo Welt › Einstellungen:** oben die Seite „Gateways“ mit Zustand, Version und letztem Heartbeat, darunter die Begrüßung.

## Benutzen

- **„Gateway grüßen“** auf der Seite „Gateways“ schickt deinen Namen an den Edge-Teil. Die Antwort lautet „Hallo … vom Gateway“ mit der eingestellten Begrüßung – oder der Fehler in Klartext.
- Der Portal-Tab „Hallo“ zeigt die Begrüßung.

## Berechtigungen

Die Seite „Gateways“ und die Einstellungen sehen nur Administratoren. Den Portal-Tab „Hallo“ zeigt GateControl im Portal.

## Häufige Fragen / Fehlersuche

**„Gateway grüßen“ meldet `not_enabled`.**
Der Edge-Teil ist auf diesem Gateway noch nicht eingeschaltet (Reiter „Edge-Plugins“).

**„Gateway grüßen“ meldet `gateway_offline` oder `timeout`.**
Das Gateway ist nicht verbunden oder der Edge-Container läuft nicht.

## Neu in 1.1.1

- Dieses Handbuch im Reiter „Handbuch“ (GateControl ≥ 1.241.0) – als Beispiel für `handbook` in `plugin.json`.

Zuletzt in 1.1.0: der Edge-Teil mit „Gateway grüßen“ und Heartbeat.
