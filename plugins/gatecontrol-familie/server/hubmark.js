'use strict';

// 1.24.0: the small switch between the tasks / place reminders and their move to „Notizen & Aufgaben“
// (server/tasksync.js sets it; server/tasks.js and server/places.js read it — so those two need not know the sync).
//
//   on        the tasks and place reminders live in the hub (the button was pressed)
//   there     … and the hub is there right now (else Familie works on with its copy and reminds itself)
//   task(gc, id) / place(gc, id)   a row changed in Familie: it goes to the hub next (counted, so a change made while a
//                                  push runs is not lost). Nothing is written while the tasks are Familie's own.

const store = require('./store');

const state = { on: false, there: false, watch: new Map() };
const WATCH_DAYS = 7;
const WATCH_WRITE_MS = 3600000;
const DAY = 86400000;

async function task(gc, id) {
  if (!state.on || !id) return;
  await store.run(gc, 'UPDATE tasks SET dirty = dirty + 1 WHERE id = ?', [id]);
}

async function place(gc, id) {
  if (!state.on || !id) return;
  await store.run(gc, 'UPDATE places SET dirty = dirty + 1 WHERE id = ? AND in_hub = 1', [id]);
}

/** Does the hub remind of this task row (it has it, and it is there)? Then Familie keeps quiet. */
const hubReminds = (r) => state.on && state.there && r.synced_at > 0;

/** The person's phone asked the hub which places to watch (service geofences) — written down at most once an hour. */
async function watching(gc, userId, now) {
  const have = state.watch.get(userId);
  if (have && now - have < WATCH_WRITE_MS && now >= have) return;
  state.watch.set(userId, now);
  await store.run(gc, 'INSERT INTO hub_watch (user_id, at) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET at = excluded.at', [userId, now]);
}

/** Does this person's phone get its places from the hub (it asked within the last week)? */
async function hubWatches(gc, userId, now) {
  let at = state.watch.get(userId);
  if (at == null) {
    const r = await store.one(gc, 'SELECT at FROM hub_watch WHERE user_id = ?', [userId]);
    at = r ? r.at : 0;
    state.watch.set(userId, at);
  }
  return at > 0 && now - at < WATCH_DAYS * DAY;
}

/**
 * Is the place reminder row `r` served by the hub for its target — the hub has it, is there, and that person's phone
 * asks the hub? Then Familie hands it to no phone (GET places says active false, home 'notizen') and does not count it.
 */
async function hubServes(gc, r, now) {
  return state.on && state.there && r.in_hub === 1 && r.synced_at > 0 && (await hubWatches(gc, r.target_user_id, now));
}

function reset() { state.on = false; state.there = false; state.watch = new Map(); }

module.exports = { state, task, place, hubReminds, watching, hubWatches, hubServes, reset, WATCH_DAYS };
