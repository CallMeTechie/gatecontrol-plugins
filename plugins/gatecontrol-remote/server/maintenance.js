'use strict';

// Maintenance windows of a device, the same format and rules as GateControl's
// Remote Desktops (src/services/rdpMaintenance.js): "Mo-Fr 08:00-18:00", several
// windows separated by a new line or ";". Day codes Mo Di Mi Do Fr Sa So or
// Mon Tue Wed Thu Fri Sat Sun; a day range may wrap the week ("Fr-Mo"), a time
// range midnight ("Mo 22:00-06:00"). Decided in the server's local time.

const DAY_MAP = { Mo: 1, Di: 2, Mi: 3, Do: 4, Fr: 5, Sa: 6, So: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 };
const LINE_RE = /^(\w{2,3})(?:-(\w{2,3}))?\s+(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/;

const inRange = (d, a, b) => (a <= b ? d >= a && d <= b : d >= a || d <= b);

function lines(schedule) {
  let s = schedule;
  // older rows were JSON-encoded strings
  if (typeof s === 'string' && s.startsWith('"') && s.endsWith('"')) { try { s = JSON.parse(s); } catch { /* keep */ } }
  return String(s || '').split(/[\n;]+/).map((l) => l.trim()).filter(Boolean);
}

/** { windows, errors } — errors are the lines that are no window. */
function parse(schedule) {
  const windows = [];
  const errors = [];
  for (const line of lines(schedule)) {
    const m = LINE_RE.exec(line);
    if (!m) { errors.push(line); continue; }
    const [, a, b, h1, m1, h2, m2] = m;
    if (DAY_MAP[a] === undefined || (b !== undefined && DAY_MAP[b] === undefined) || +h1 > 23 || +h2 > 23 || +m1 > 59 || +m2 > 59) { errors.push(line); continue; }
    windows.push({ from: DAY_MAP[a], to: b === undefined ? DAY_MAP[a] : DAY_MAP[b], start: +h1 * 60 + +m1, end: +h2 * 60 + +m2 });
  }
  return { windows, errors };
}

/** Does the schedule cover `now`? */
function active(schedule, now = new Date()) {
  const day = now.getDay();
  const yesterday = (day + 6) % 7;
  const min = now.getHours() * 60 + now.getMinutes();
  for (const w of parse(schedule).windows) {
    if (w.start <= w.end) {
      if (inRange(day, w.from, w.to) && min >= w.start && min < w.end) return true;
    } else {
      if (inRange(day, w.from, w.to) && min >= w.start) return true;
      if (inRange(yesterday, w.from, w.to) && min < w.end) return true;
    }
  }
  return false;
}

/** Is a device in its maintenance window right now? */
function inWindow(cfg, now = new Date()) {
  return !!(cfg && cfg.maintenance_enabled && cfg.maintenance_schedule && active(cfg.maintenance_schedule, now));
}

module.exports = { parse, active, inWindow };
