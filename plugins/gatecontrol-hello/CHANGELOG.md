# Hallo Welt (gatecontrol-hello)

Beispiel-Plugin dieses Repositorys — wird nicht veröffentlicht (`plugins.config.json`: `release: false`).

## 1.1.1

- Handbuch im Reiter „Handbuch“ (GateControl ≥ 1.241.0): `HANDBUCH.md` / `HANDBOOK.md` im Paket, in `plugin.json` unter `handbook`. Ältere GateControl-Versionen ignorieren es; die Mindestversion bleibt `>=1.228.0`.

## 1.1.0
- **Edge-Teil** (GateControl ≥ 1.228.0, Gateway ≥ 1.19.0): `edge/index.js` läuft auf Gateways, auf denen ein
  Administrator das Plugin eingeschaltet hat (Gateway-Seite › Reiter „Edge-Plugins“). Keine Fähigkeiten
  (`edge.capabilities: {}`), `memoryMb` 32. Er beantwortet `greet` (`{ name }` → `{ text, at, greeting }`, Name 1–64
  Zeichen, sonst `invalid_name`), meldet sich alle 60 s mit `heartbeat` (`{ uptimeS }`) und schreibt eine Logzeile,
  wenn eine Konfiguration ankommt.
- **Server-Teil:** `gc.edge.on('$started')` übergibt dem Gateway die Einstellung „Begrüßung“
  (`gc.edge.configure`), nach dem Speichern der Einstellungen alle laufenden Gateways; `gc.edge.on('heartbeat')`
  merkt sich den letzten Heartbeat je Gateway (im Speicher).
- **Einstellungsseite „Gateways“** (`ui.settingsPage`, über der Einstellung „Begrüßung“): die Gateways aus
  `gc.edge.gateways()` mit Zustand, Version und letztem Heartbeat, Knopf „Gateway grüßen“ (`gc.edge.call`) mit der
  Antwort oder dem Fehler in Klartext (`gateway_offline`, `not_enabled`, `timeout`, `edge_error` mit dem Code des
  Edge-Teils …); Texte de/en; nur für Administratoren.
- Braucht jetzt GateControl ≥ 1.228.0 (vorher ≥ 1.146.0).

## 1.0.0
- Erste Version: portiert aus `tests/fixtures/plugins/hello` von GateControl.
