'use strict';

// GateControl 1.181.0 for the tests of rules and reminders (1.9.0), on top of the mock host
// (which knows GateControl up to 1.180.0): the plugin's own gc with
//   gc.actions.get({ userId, actionId, withWidget })  one action as that person sees it, or null
//   gc.actions.list({ …, withWidget: true })          every action with actionId and its widget
//   gc.notify(…) with push actions of type 'callback' — recorded in `sent` as given, passed on to the
//                mock host without them (the mock host would refuse the unknown type)
// widgets: { '<plugin>/<id>': { value, unit, badge, readings, … } } (changeable by the test).
// Hooks run with this gc: run.request(user, method, path, body), run.tick(), run.notifyAction(args).

function gc181(host, widgets = {}) {
  const base = host.gc;
  const sent = [];
  const ref = (a) => `${a.plugin}/${a.id}`;
  const withWidget = (a) => ({ ...a, actionId: ref(a), widget: widgets[ref(a)] || null });
  const gc = {
    ...base,
    actions: {
      ...base.actions,
      list: async (o) => {
        const l = await base.actions.list({ userId: o.userId, lang: o.lang });
        return o.withWidget ? l.map(withWidget) : l.map((a) => ({ ...a, actionId: ref(a) }));
      },
      get: async (o) => {
        const l = await base.actions.list({ userId: o.userId, lang: o.lang });
        const a = l.find((x) => ref(x) === o.actionId);
        return a ? (o.withWidget ? withWidget(a) : { ...a, actionId: ref(a) }) : null;
      },
    },
    notify: async (n, opts) => {
      if (n && typeof n === 'object') {
        sent.push(JSON.parse(JSON.stringify(n)));
        const acts = n.data && Array.isArray(n.data.actions) ? n.data.actions.filter((x) => x.type !== 'callback') : null;
        const data = n.data ? { ...n.data } : n.data;
        if (acts) { if (acts.length) data.actions = acts; else delete data.actions; }
        return base.notify({ ...n, data }, opts);
      }
      return base.notify(n, opts);
    },
  };
  const p = host.plugin;
  return {
    gc, sent, widgets,
    request: async (user, method, path, body, query) => {
      const r = await p.request({ method, path, body: body === undefined ? null : body, query: query || {}, user, lang: 'de' }, gc);
      return { status: 200, ...r };
    },
    tick: () => p.tick(gc),
    notifyAction: (args) => p.notifyAction(JSON.parse(JSON.stringify(args)), gc),
  };
}

module.exports = { gc181 };
