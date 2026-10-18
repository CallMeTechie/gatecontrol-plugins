'use strict';

// Reminders (1.9.0): the notification of a rule's action `notify` with facts and buttons,
// and what the buttons do.
//
//   { type: 'notify', to, text?, facts?: bool, buttons?: ['quick_action:<plugin>/<id>', 'snooze_1h', 'done'] }
//
// facts: the device values and the event of the rule's conditions as data.facts
// ([{ label, value }], the apps show them under the text). buttons (at most 3) need
// GateControl ≥ 1.181.0 — push actions { type: 'callback', id, label } that GateControl hands
// back to the hook notifyAction({ userId, notificationId, action, data }) of this plugin
// (once per notification and button). Without it (an older GateControl, recognised by the
// missing gc.actions.get) the notification goes out without buttons.
//   snooze_1h          „In 1 Std.“: 60 minutes later the conditions are checked again; still met
//                      → the reminder comes again (at most 3 notifications per reminder and day),
//                      no longer met → it is resolved.
//   done               „Erledigt“: done for this run (a schedule: this day).
//   quick_action:<ref> another plugin's quick action, run as the person who presses it
//                      (gc.actions.run) — only offered to a person who has that action; done after
//                      a successful run. Logged in the rule log (trigger 'button').
// Every person who gets a reminder with buttons — and every reminder of the trigger
// 'schedule' — has a row in rule_reminders: { rule, key, user, state: open | snoozed | done |
// resolved, sends, snoozeUntil }. Open reminders of today are in GET rules (`open`), e.g.
// for a hint at the device's widget in the app. Rows are kept 14 days.
//
// Topics: a reminder of the trigger 'schedule' goes out as topic 'reminders'
// („Erinnerungen“), the rules of presence and places stay on topic 'presence'.

const store = require('./store');
const tz = require('./tz');
const push = require('./push');
const members = require('./members');
const conditions = require('./conditions');
const rulerow = require('./rulerow');

const SNOOZE_MS = 60 * 60000;
const MAX_SENDS = 3;
const KEEP_DAYS = 14;
const DAY = 86400000;
const BUTTONS_MAX = 3;
const BUTTON_RE = /^(?:snooze_1h|done|quick_action:[a-z0-9]+(?:-[a-z0-9]+)*\/[A-Za-z0-9:._-]{1,64})$/;
const TYPES = ['rule_reminder', 'presence_rule'];

/** buttons of a notify action → the checked list (≤ 3, unique) or null (invalid). */
function parseButtons(v) {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > BUTTONS_MAX || !v.every((b) => typeof b === 'string' && BUTTON_RE.test(b))) return null;
  const out = [...new Set(v)];
  return out.some((b) => b.startsWith('quick_action:gatecontrol-familie/')) ? null : out;
}

/** Does this GateControl hand push buttons back to the plugin (type 'callback', GateControl ≥ 1.181.0)? */
const callbacks = (gc) => conditions.hasGet(gc);

/** The text of a notify or messenger action: its own (or the default of the trigger) with the placeholders filled. */
function textOf(a, run, person, cfg, vars, rule) {
  const name = person ? person.name : '';
  const place = run.placeName || '';
  const v = vars || {};
  const def = run.trigger === 'schedule' ? ((rule && rule.title) || push.t(cfg.lang, 'presence.schedule')) : push.t(cfg.lang, `presence.${run.trigger}`, { name, place });
  return (a.text || def).split('{name}').join(name).split('{place}').join(place)
    .split('{value}').join(v.value || '').split('{device}').join(v.device || '').split('{event}').join(v.event || '');
}

/** The quick actions `userId` has: Set of '<plugin>/<id>' (empty when unknown). */
async function ownRefs(gc, userId, lang, cache) {
  const key = `refs|${userId}`;
  if (cache && cache.has(key)) return cache.get(key);
  let set = new Set();
  if (conditions.hasList(gc)) {
    try { set = new Set((await gc.actions.list({ userId, lang })).map(conditions.refOf)); } catch { set = new Set(); }
  }
  if (cache) cache.set(key, set);
  return set;
}

/** The titles of the quick actions `userId` has: Map ref → title. */
async function ownTitles(gc, userId, lang, cache) {
  const key = `titles|${userId}`;
  if (cache && cache.has(key)) return cache.get(key);
  let map = new Map();
  if (conditions.hasList(gc)) {
    try { map = new Map((await gc.actions.list({ userId, lang })).map((x) => [conditions.refOf(x), x.title || x.label || x.id])); } catch { map = new Map(); }
  }
  if (cache) cache.set(key, map);
  return map;
}

/**
 * The pushes of one notify action of a run → { pushes, sent, keyed: [userId] (who gets a reminder row) }.
 * o = { rule, run, action, person, ev (conditions.evaluate result | null), to: [userId], key, cache }
 */
async function notifyPushes(gc, fam, cfg, now, o) {
  const { rule, run, action: a, person, ev, to, key } = o;
  if (!to.length) return { pushes: [], sent: 0, keyed: [] };
  const reminder = run.trigger === 'schedule';
  const text = textOf(a, run, person, cfg, ev && ev.vars, rule).slice(0, 120);
  const facts = a.facts && ev && ev.facts.length ? ev.facts : null;
  // without a text of its own a reminder's body says why it came (the values of its conditions)
  const factLine = ev && ev.facts.length ? ev.facts.map((f) => `${f.label}: ${f.value}`).join(' · ') : '';
  let title = text;
  let body = rule.title || rule.name || undefined;
  if (reminder) {
    title = (rule.title || text).slice(0, 120);
    body = rule.title && text !== rule.title ? text : (factLine || undefined);
  }
  const buttons = Array.isArray(a.buttons) ? a.buttons : [];
  const remembered = buttons.length > 0 || reminder;
  const familie = { type: reminder ? 'rule_reminder' : 'presence_rule', ruleId: rule.id, trigger: run.trigger, userId: run.userId || null };
  if (run.placeId) familie.placeId = run.placeId;
  // the reminder row the buttons act on (rule, key, person)
  if (remembered) familie.key = key;
  const withButtons = buttons.length && callbacks(gc);
  const qaRefs = buttons.filter((b) => b.startsWith('quick_action:')).map((b) => b.slice('quick_action:'.length));
  const base = {
    topic: reminder ? 'reminders' : 'presence', priority: 'normal', ttl: 6 * 3600,
    collapseKey: reminder ? `rule:${rule.id}:${key}`.slice(0, 120) : `presence:${rule.id}`, title, body,
  };
  const actionsFor = async (userId) => {
    const out = [];
    const qa = [];
    if (!withButtons) return { actions: out, qa };
    for (const b of buttons) {
      if (b === 'snooze_1h') out.push({ type: 'callback', id: 'snooze_1h', label: push.t(cfg.lang, 'rule.button_snooze') });
      else if (b === 'done') out.push({ type: 'callback', id: 'done', label: push.t(cfg.lang, 'rule.button_done') });
      else {
        const ref = b.slice('quick_action:'.length);
        // only for a person who may run it
        if (!(await ownRefs(gc, userId, cfg.lang, o.cache)).has(ref)) continue;
        const label = ((await ownTitles(gc, userId, cfg.lang, o.cache)).get(ref) || ref.split('/')[1]).slice(0, 24);
        out.push({ type: 'callback', id: `qa${qa.length}`, label });
        qa.push(ref);
      }
    }
    return { actions: out, qa };
  };
  const pushes = [];
  if (withButtons && qaRefs.length) {
    // the quick action buttons differ per person
    for (const u of to) {
      const { actions, qa } = await actionsFor(u);
      const data = { familie: qa.length ? { ...familie, qa } : familie };
      if (facts) data.facts = facts;
      if (actions.length) data.actions = actions;
      pushes.push({ ...base, users: [u], data });
    }
  } else {
    const { actions } = await actionsFor(to[0]);
    const data = { familie };
    if (facts) data.facts = facts;
    if (actions.length) data.actions = actions;
    pushes.push({ ...base, users: to, data });
  }
  const keyed = remembered ? to.slice() : [];
  return { pushes, sent: to.length, keyed };
}

/** Rows for the people who got a reminder (outside any transaction: own one). */
async function remember(gc, cfg, now, ruleId, key, users) {
  if (!users.length) return;
  const day = tz.localDate(now, cfg.tz);
  try {
    await store.tx(gc, async () => {
      for (const u of users) {
        await store.run(gc, `INSERT INTO rule_reminders (rule_id, fire_key, user_id, day, state, sends, snooze_until, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'open', 1, NULL, ?, ?) ON CONFLICT(rule_id, fire_key, user_id) DO UPDATE SET state = 'open', sends = sends + 1, snooze_until = NULL, updated_at = excluded.updated_at`,
        [ruleId, key, u, day, now, now]);
      }
    });
  } catch (e) { gc.log.warn('reminder state failed', (e && e.code) || 'error'); }
}

// ─── the buttons ────────────────────────────────

async function logButton(gc, rule, userId, now, results) {
  try {
    await store.tx(gc, () => store.run(gc, `INSERT INTO presence_log (rule_id, rule_name, trigger_type, user_id, at, ok, results_json, place_id, place_name)
      VALUES (?, ?, 'button', ?, ?, ?, ?, NULL, NULL)`, [rule.id, rule.title || rule.name, userId, now, results.every((x) => x.ok) ? 1 : 0, JSON.stringify(results)]));
  } catch (e) { gc.log.warn('presence log failed', (e && e.code) || 'error'); }
}

function hostCode(e) {
  const c = e && e.code;
  if (c === 'ERR_RATE_LIMIT') return 'rate_limit';
  if (c === 'ERR_INVALID') return 'invalid';
  if (c === 'ERR_ACTIONS_DENIED') return 'denied';
  return 'error';
}

/**
 * The hook notifyAction({ userId, notificationId, action, data }) (GateControl ≥ 1.181.0): a button of one
 * of our notifications was pressed. → { ok, state?, error? } (GateControl only logs it).
 */
async function onAction(gc, cfg, args, now) {
  const x = args && typeof args === 'object' ? args : {};
  const userId = Number.isSafeInteger(x.userId) ? x.userId : null;
  const d = x.data && typeof x.data === 'object' && x.data.familie && typeof x.data.familie === 'object' ? x.data.familie : null;
  if (!userId || !d || !TYPES.includes(d.type) || !Number.isSafeInteger(d.ruleId) || typeof d.key !== 'string') return { ok: false, error: 'unknown' };
  const action = typeof x.action === 'string' ? x.action : '';
  const row = await store.one(gc, 'SELECT * FROM rule_reminders WHERE rule_id = ? AND fire_key = ? AND user_id = ?', [d.ruleId, d.key, userId]);
  if (!row) return { ok: false, error: 'not_found' };
  const fam = await members.load(gc, tz.localDate(now, cfg.tz));
  if (!fam.byId.has(userId)) return { ok: false, error: 'not_member' };
  const set = (state, snooze) => store.tx(gc, () => store.run(gc, 'UPDATE rule_reminders SET state = ?, snooze_until = ?, updated_at = ? WHERE id = ?', [state, snooze, now, row.id]));
  if (action === 'done') {
    await set('done', null);
    return { ok: true, state: 'done' };
  }
  if (action === 'snooze_1h') {
    if (row.state === 'done') return { ok: false, error: 'done' };
    if (row.sends >= MAX_SENDS) return { ok: false, error: 'limit' };
    await set('snoozed', now + SNOOZE_MS);
    return { ok: true, state: 'snoozed', until: now + SNOOZE_MS };
  }
  const m = /^qa(\d)$/.exec(action);
  const refs = Array.isArray(d.qa) ? d.qa : [];
  if (!m || !refs[Number(m[1])]) return { ok: false, error: 'unknown' };
  const ref = String(refs[Number(m[1])]);
  const rule = await rulerow.ruleById(gc, d.ruleId);
  if (!rule) return { ok: false, error: 'not_found' };
  // the person must still have that action (it runs as that person)
  const own = await ownRefs(gc, userId, cfg.lang, null);
  const slash = ref.indexOf('/');
  const base = { type: 'quick_action', plugin: ref.slice(0, slash), id: ref.slice(slash + 1), title: null, state: null, verb: null };
  let result;
  if (!own.has(ref) || !gc.actions || typeof gc.actions.run !== 'function') result = { ...base, ok: false, message: null, error: own.has(ref) ? 'unavailable' : 'not_found' };
  else {
    try {
      const r = await gc.actions.run({ userId, plugin: base.plugin, id: base.id, lang: cfg.lang });
      result = { ...base, ok: !!(r && r.ok === true), message: (r && (r.message || (r.result && r.result.message))) || null, error: (r && r.ok === true) ? null : ((r && r.error) || 'failed'), unchanged: !!(r && r.unchanged === true) };
    } catch (e) {
      result = { ...base, ok: false, message: null, error: hostCode(e) };
    }
  }
  await logButton(gc, rule, userId, now, [result]);
  if (result.ok) await set('done', null);
  return result.ok ? { ok: true, state: 'done' } : { ok: false, state: row.state, error: result.error || 'failed' };
}

/**
 * Background (every minute, outside any transaction): snoozed reminders whose hour is up — the rule's
 * conditions checked again; still met → the notification again (to that person), else resolved.
 * syncHold: the rule's own conditions (time window, after sunset).
 */
async function tick(gc, fam, cfg, now, pushes) {
  const rows = await store.all(gc, "SELECT * FROM rule_reminders WHERE state = 'snoozed' AND snooze_until <= ? ORDER BY snooze_until LIMIT 50", [now]);
  if (!rows.length) return;
  const cache = new Map();
  for (const row of rows) {
    const rule = await rulerow.ruleById(gc, row.rule_id);
    const a = rule ? rule.actions.find((x) => x.type === 'notify') : null;
    const finish = (state, extra) => store.tx(gc, () => store.run(gc, `UPDATE rule_reminders SET state = ?, snooze_until = NULL${extra ? ', sends = sends + 1' : ''}, updated_at = ? WHERE id = ?`, [state, now, row.id]));
    try {
      if (!rule || !rule.active || !a || !fam.byId.has(row.user_id) || row.sends >= MAX_SENDS) { await finish('resolved'); continue; }
      let ok = conditions.syncHold(rule, cfg, now);
      let ev = null;
      if (ok && conditions.needsEvaluate(rule)) {
        ev = await conditions.evaluate(gc, fam, cfg, now, rule, cfg.lang, cache);
        ok = ev.ok;
      }
      if (!ok) { await finish('resolved'); continue; }
      const run = { rule, trigger: rule.trigger === 'schedule' ? 'schedule' : rule.trigger, userId: null };
      const out = await notifyPushes(gc, fam, cfg, now, { rule, run, action: a, person: null, ev, to: [row.user_id], key: row.fire_key, cache });
      pushes.push(...out.pushes);
      await finish('open', true);
    } catch (e) {
      gc.log.warn('reminder snooze failed', row.rule_id, (e && (e.code || e.message)) || 'error');
      await finish('resolved').catch(() => {});
    }
  }
}

/** The open reminders of `userId` today (GET rules `open`): [{ ruleId, title, key, state, since, actionIds }]. */
async function openFor(gc, cfg, now, userId) {
  const today = tz.localDate(now, cfg.tz);
  const rows = await store.all(gc, `SELECT r.*, p.title AS rule_title, p.name AS rule_name, p.conditions_json FROM rule_reminders r JOIN presence_rules p ON p.id = r.rule_id
    WHERE r.user_id = ? AND r.state IN ('open', 'snoozed') AND r.day = ? ORDER BY r.created_at`, [userId, today]);
  return rows.map((x) => {
    let dev = [];
    try { const c = JSON.parse(x.conditions_json || '{}'); dev = Array.isArray(c.device) ? c.device.map((d) => d.actionId).filter(Boolean) : []; } catch { dev = []; }
    return { ruleId: x.rule_id, title: x.rule_title || x.rule_name || '', key: x.fire_key, state: x.state, since: new Date(x.created_at).toISOString().replace(/\.\d{3}Z$/, 'Z'), actionIds: [...new Set(dev)] };
  });
}

async function purge(gc, now) {
  await store.run(gc, 'DELETE FROM rule_reminders WHERE updated_at < ?', [now - KEEP_DAYS * DAY]);
}

module.exports = { SNOOZE_MS, MAX_SENDS, BUTTONS_MAX, parseButtons, callbacks, textOf, notifyPushes, remember, onAction, tick, openFor, purge, ownRefs };
