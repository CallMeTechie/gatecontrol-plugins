'use strict';

// The hook service({ name, caller, user, payload }) — docs/notes-sources-contract.md § 3. Every answer is JSON ≤ 16 KB;
// a refusal is { ok: false, code, … } (never thrown).

const sources = require('./sources');
const bound = require('./bound');
const shopping = require('./shopping');
const famtasks = require('./famtasks');
const drivedue = require('./drivedue');
const { isKnown } = require('./util');

async function handle(gc, base, call) {
  const c = call && typeof call === 'object' ? call : {};
  const p = c.payload && typeof c.payload === 'object' && !Array.isArray(c.payload) ? c.payload : {};
  try {
    switch (c.name) {
      case 'todo_changed': return await sources.push(gc, base, c.caller, p);
      case 'notes_bind': return await bound.bind(gc, base, c.caller, p);
      case 'notes_list': return await bound.listNotes(gc, base, c.caller, c.user, p);
      case 'note_save': return await bound.save(gc, base, c.caller, c.user, p);
      case 'note_check': return await bound.checkItem(gc, base, c.caller, c.user, p);
      case 'note_delete': return await bound.del(gc, base, c.caller, c.user, p);
      case 'notes_import': return await bound.importNotes(gc, base, c.caller, p);
      // 1.4.0: Familie's shopping lists live here (server/shopping.js)
      case 'shopping_bind': return await shopping.bind(gc, base, c.caller, p);
      case 'shopping_put': return await shopping.put(gc, base, c.caller, p);
      case 'shopping_list': return await shopping.listFor(gc, base, c.caller, p);
      // 1.6.0: Familie's tasks and place reminders live here (server/famtasks.js)
      case 'tasks_bind': return await famtasks.bind(gc, base, c.caller, p);
      case 'tasks_put': return await famtasks.put(gc, base, c.caller, p);
      case 'tasks_list': return await famtasks.listFor(gc, base, c.caller, p);
      // 1.7.0: the reminders of Drive's deadlines ring from here (server/drivedue.js)
      case 'deadline_reminders': return await drivedue.put(gc, base, c.caller, p);
      default: return { ok: false, code: 'not_found' };
    }
  } catch (e) {
    if (isKnown(e)) return { ok: false, code: e.code, ...(e.extra || {}) };
    gc.log.warn('service failed', c.name, (e && (e.code || e.message)) || 'error');
    return { ok: false, code: 'failed' };
  }
}

module.exports = { handle };
