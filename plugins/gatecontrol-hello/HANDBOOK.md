<!-- version: 1.1.1 -->
# Hello World

> **Note:** this is the example plugin of the plugin repository, for plugin authors. It is never released. This manual also shows how a plugin manual is structured.

## What the plugin does

- A page “Hello” and a page “About” in the admin area, a portal tab “Hello”.
- Settings: greeting, “Loud”, repeats and an API token (stored as a secret).
- An **edge part** that runs on a gateway in the home network: it answers “Greet gateway” and reports a heartbeat every minute.

## Requirements

- GateControl **1.228.0** or later.
- For the edge part: a gateway **1.19.0** or later with the service `edge` in its compose file.
- Because the plugin is unsigned: *allow unsigned plugins* on the server and *allow unsigned edge parts* on the gateway.

## Setting up

1. Build the plugin unsigned (`npm run pack gatecontrol-hello`) and upload it under **Settings › Plugins**.
2. **Gateways** › your gateway › tab **“Edge plugins”**: switch edge parts on, then switch “Hello World” on and confirm the (empty) list of capabilities.
3. **Settings › Plugins › Hello World › Settings:** at the top the page “Gateways” with state, version and last heartbeat, below it the greeting.

## Using it

- **“Greet gateway”** on the page “Gateways” sends your name to the edge part. It answers “Hallo … vom Gateway” with the greeting you set – or the error in plain words.
- The portal tab “Hello” shows the greeting.

## Permissions

Only administrators see the page “Gateways” and the settings. GateControl shows the portal tab “Hello” in the portal.

## FAQ / troubleshooting

**“Greet gateway” reports `not_enabled`.**
The edge part is not switched on for this gateway yet (tab “Edge plugins”).

**“Greet gateway” reports `gateway_offline` or `timeout`.**
The gateway is not connected or the edge container is not running.

## New in 1.1.1

- This manual in the tab “Manual” (GateControl ≥ 1.241.0) – as an example of `handbook` in `plugin.json`.

Last in 1.1.0: the edge part with “Greet gateway” and the heartbeat.
