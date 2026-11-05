'use strict';

// gatecontrol-hello — the edge part. It runs on a home gateway, in the gateway's container `edge`, once an
// administrator has switched the plugin on for that gateway (GateControl: the gateway › tab "Edge-Plugins").
// GateControl's docs/plugins.md "Edge part" and gatecontrol-gateway's docs/edge.md describe the API; this part
// uses only what needs no capability (plugin.json edge.capabilities {}), so the approval lists nothing:
//   gc.handle(method, fn)   answers the server part's gc.edge.call(gatewayId, method, params)
//   gc.emit(name, data)     an event for the server part's gc.edge.on(name, …)
//   gc.config()/onConfig    what the server part sent with gc.edge.configure — in memory only, sent again on $started
//   gc.log.info/warn/error  lines in the gateway's log of the plugin (GateControl: the gateway › Edge-Plugins › log)
// The gateway never gets the server part (server/, ui/) — only this folder and plugin.json.

const HEARTBEAT_MS = 60 * 1000;
const NAME_MAX = 64;

let timer = null;

/** An error the server part sees as edge_error "invalid_name: …" (a code of its own, ≤ 32 characters). */
function invalidName() {
  return Object.assign(new Error(`name must be a text of 1 to ${NAME_MAX} characters`), { code: 'invalid_name' });
}

module.exports = {
  start(gc) {
    const startedAt = Date.now();

    // gc.edge.call(gatewayId, 'greet', { name }) → { text, at, greeting }
    gc.handle('greet', (params) => {
      const name = params && typeof params === 'object' && typeof params.name === 'string' ? params.name.trim() : '';
      if (!name || name.length > NAME_MAX) throw invalidName();
      const cfg = gc.config();
      return {
        text: `Hallo ${name} vom Gateway`,
        at: new Date().toISOString(),
        greeting: cfg && typeof cfg.greeting === 'string' ? cfg.greeting : null,
      };
    });

    // the server part hands over its settings with gc.edge.configure (on $started and after they were saved)
    gc.onConfig((cfg) => {
      gc.log.info('configuration received', cfg && typeof cfg.greeting === 'string' ? `greeting "${cfg.greeting}"` : 'without greeting');
    });

    // a sign of life every 60 s (and one right away, so the settings page shows it without waiting)
    const beat = () => gc.emit('heartbeat', { uptimeS: Math.floor((Date.now() - startedAt) / 1000) });
    beat();
    timer = setInterval(beat, HEARTBEAT_MS);
  },

  stop() {
    if (timer) clearInterval(timer);
    timer = null;
  },
};
