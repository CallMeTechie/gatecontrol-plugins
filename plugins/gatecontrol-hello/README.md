# Hallo Welt / Hello World (`gatecontrol-hello`)

*English: see [below](#english).*

Das Beispiel-Plugin dieses Repositorys – für Plugin-Autoren, wird nie veröffentlicht
(`plugins.config.json`: `release: false`). Es zeigt die Host-API von GateControl
([`docs/plugins.md`](https://github.com/CallMeTechie/gatecontrol/blob/master/docs/plugins.md)): Seiten,
Portal-Tab, Einstellungen, Speicher, eigene Datenbank, Netzwerkziele, Benutzer, Mitteilungen, Hintergrund-Takt –
und seit 1.1.0 einen **Edge-Teil**, der auf Gateways im Heimnetz läuft. Braucht GateControl ≥ 1.228.0.

## Deutsch

### Der Edge-Teil

Ein Plugin kann neben dem Server-Teil (`server/`) einen zweiten Teil mitbringen, der **auf einem Gateway** läuft –
dort, wo die Geräte sind (UDP, mDNS, LAN-HTTP, MQTT …). In diesem Beispiel braucht er keine dieser Fähigkeiten
(`edge.capabilities: {}`), damit die Bestätigung beim Einschalten kurz bleibt; er zeigt nur den Weg zwischen den
beiden Teilen:

| Edge-Teil (`edge/index.js`, auf dem Gateway) | Server-Teil (`server/edge.js`) |
|---|---|
| `gc.handle('greet', …)` → `{ text: "Hallo <name> vom Gateway", at, greeting }` | `gc.edge.call(gatewayId, 'greet', { name })` – Knopf „Gateway grüßen“ |
| `gc.emit('heartbeat', { uptimeS })` beim Start und alle 60 s | `gc.edge.on('heartbeat', …)` merkt sich den letzten je Gateway |
| `gc.config()` / `gc.onConfig(…)` (Logzeile) | `gc.edge.on('$started', …)` → `gc.edge.configure(gatewayId, { greeting })`, ebenso nach dem Speichern |

Die Konfiguration liegt nur im Speicher des Edge-Teils – deshalb schickt der Server-Teil sie bei jedem `$started`
erneut. Auf das Gateway kommen nur `plugin.json` und der Ordner `edge/`.

**Einstellungsseite:** Einstellungen › Plugins › Hallo Welt › Einstellungen zeigt oben die Seite „Gateways“
(`ui.settingsPage`): jedes Gateway, für das das Plugin eingerichtet ist, mit Zustand (`running`, `offline`,
`disabled`, …), Gateway-Version und letztem Heartbeat, dazu „Gateway grüßen“ mit der Antwort oder dem Fehler in
Klartext (`gateway_offline`, `not_enabled`, `timeout`, `edge_error` mit dem Code des Edge-Teils wie
`invalid_name` …). Darunter die Einstellung „Begrüßung“.

### Auf einem Gateway einschalten

1. Gateway mit **gatecontrol-gateway ≥ 1.19.0** und dem Dienst `edge` in der Compose-Datei (die Vorlagen von
   GateControl bringen ihn mit).
2. Plugin installieren. Es ist nicht signiert: dafür *Unsignierte Plugins erlauben* (Server) und am Gateway
   *Unsignierte Edge-Teile erlauben* (Bestätigung `ERLAUBEN`) – ein signiertes Plugin braucht das nicht.
3. In GateControl die **Gateway-Seite** öffnen › Reiter **„Edge-Plugins“**: Edge-Teile für das Gateway einschalten,
   dann bei „Hallo Welt“ einschalten und die (leere) Liste der Fähigkeiten bestätigen.
4. Sobald der Zustand `running` ist, kommt der erste Heartbeat; „Gateway grüßen“ auf der Einstellungsseite
   antwortet mit der Begrüßung des Gateways.

### Lokal testen

* **Unit-Tests** (ohne Gateway): `node tools/test.js gatecontrol-hello` – `test/hello.test.js` prüft den
  Server-Teil mit dem `gc.edge` des Mock-Hosts (`tools/testing/mock-host.js`, Option `edge`, `host.edgeEvent`),
  `test/edge.test.js` den Edge-Teil mit einem eigenen kleinen `gc`.
* **Mit einem echten GateControl, ohne Gateway:** `scripts/plugin-edge-host.js` im GateControl-Repository spielt
  den Edge-Container eines Gateways (Protokoll `gc-edge.v1`, meldet eingeschaltete Plugins von selbst als
  `running` → `$started`). Plugin unsigniert bauen (`npm run pack gatecontrol-hello`) und installieren, auf einem
  Gateway einschalten (siehe oben), dann mit dem API-Token dieses Gateways (`gateway.env`) den echten Edge-Teil
  daran hängen – ein Skript im Wurzelordner dieses Repositorys:

  ```js
  const { createEdgeHost } = require('<gatecontrol>/scripts/plugin-edge-host');
  const edgePart = require('./plugins/gatecontrol-hello/edge/index.js');
  const ID = 'gatecontrol-hello';

  const host = await createEdgeHost({ serverUrl: 'http://127.0.0.1:3000', apiToken: 'gc_gw_…' });
  await host.waitForState((s) => s.plugins.some((p) => p.id === ID && p.enabled));
  edgePart.start({                                  // ein kleines gc auf dem Test-Edge-Host
    handle: (method, fn) => host.handle(ID, method, (params) => fn(params)),
    emit: (name, data) => host.emit(ID, name, data),
    config: () => host.configOf(ID),
    onConfig: () => {},                             // der Test-Edge-Host meldet configure nicht
    log: console,
  });
  console.log(await host.waitForConfig(ID));        // { greeting: 'Hallo' } – vom Server-Teil nach $started
  // jetzt: Einstellungsseite öffnen → Heartbeat ist da, „Gateway grüßen“ antwortet über edge/index.js
  // Ende: edgePart.stop(); await host.close();
  ```

  Ohne eigenen Code geht es auch von der Kommandozeile:
  `node scripts/plugin-edge-host.js --server http://localhost:3000 --token gc_gw_…` (jeder Aufruf antwortet dann
  mit `{ echo: params }`, die Seite zeigt also die Echo-Antwort statt des Grußes).

## English

The example plugin of this repository, for plugin authors; never released. It shows GateControl's host API and,
since 1.1.0, an **edge part** that runs on home gateways (GateControl ≥ 1.228.0, gateway ≥ 1.19.0).

* **Edge part** (`edge/index.js`, no capabilities, 32 MB): `gc.handle('greet')` → `{ text, at, greeting }` (name
  1–64 characters, else `invalid_name`), `gc.emit('heartbeat', { uptimeS })` at start and every 60 s,
  `gc.onConfig` logs a line.
* **Server part** (`server/edge.js`): `$started` → `gc.edge.configure(gatewayId, { greeting })` (and for every
  running gateway after the settings were saved), `heartbeat` → the last one per gateway in memory.
* **Settings page** "Gateways" (`ui.settingsPage`, administrators only): the gateways of `gc.edge.gateways()` with
  state, version and last heartbeat, "Greet gateway" (`gc.edge.call`) with the answer or the error in plain words.
* **Switch it on:** GateControl › the gateway's page › tab **"Edge-Plugins"** (edge parts on, then the plugin on,
  confirm the empty capability list; unsigned: allow unsigned edge parts on that gateway).
* **Test locally:** `node tools/test.js gatecontrol-hello` (mock host `edge` option for the server part, a small
  `gc` of its own for the edge part), or a real GateControl with `scripts/plugin-edge-host.js` playing the gateway
  and the real `edge/index.js` hooked onto it (script above).
