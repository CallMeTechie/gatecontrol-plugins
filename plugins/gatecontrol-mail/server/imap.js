'use strict';

// IMAP accounts through GateControl's gc.mail (≥ 1.216.0): one session per account (engine.js holds it, IDLE on the
// posteingang), the folders and their messages written to the server's copy (mailstore.js).
//
// A folder sync: open → a new UIDVALIDITY drops the folder's copy; new mail above uid_next (the first sync newest first,
// FIRST_BATCH at a time below low_uid until the retention is reached); flags of the known ones (CONDSTORE changedSince
// where the server has it, else the newest FLAGS_RECENT); mail the server no longer has goes.

const store = require('./store');
const mailstore = require('./mailstore');
const { line } = require('./util');

const HEAD_FIELDS = ['list-id', 'list-unsubscribe', 'precedence', 'auto-submitted', 'references'];
const FETCH_MAX = 500;
const FIRST_BATCH = 300;
const FLAGS_RECENT = 500;
const SKIP_USE = new Set(['\\All', '\\Flagged', '\\Important']);
const ROLE = { '\\Inbox': 'inbox', '\\Sent': 'sent', '\\Drafts': 'drafts', '\\Archive': 'archive', '\\Junk': 'junk', '\\Trash': 'trash', '\\All': 'all' };
const NAME_ROLE = [
  [/^inbox$/i, 'inbox'], [/^(sent|gesendet|sent items|gesendete (objekte|elemente))$/i, 'sent'], [/^(drafts|entw(ü|ue)rfe)$/i, 'drafts'],
  [/^(archive|archiv)$/i, 'archive'], [/^(junk|spam|junk-e-mail|unerw(ü|ue)nscht)$/i, 'junk'], [/^(trash|papierkorb|gel(ö|oe)schte (objekte|elemente)|deleted items)$/i, 'trash'],
];

/** The role of a listed folder (special-use flag, else the usual names). */
function roleOf(x) {
  if (x.specialUse && ROLE[x.specialUse]) return ROLE[x.specialUse];
  if (String(x.path).toUpperCase() === 'INBOX') return 'inbox';
  const name = String(x.name || x.path || '').split(x.delimiter || '/').pop();
  for (const [re, role] of NAME_ROLE) if (re.test(name)) return role;
  return null;
}

/**
 * The parent path of a listed folder: gc.mail's `parent` (imapflow's parentPath), else the path up to its last
 * delimiter; null on top and on a server without hierarchy (no delimiter).
 */
function parentPathOf(x) {
  if (typeof x.parent === 'string' && x.parent) return x.parent;
  const d = x.delimiter;
  if (!d) return null;
  const i = x.path.lastIndexOf(d);
  return i > 0 ? x.path.slice(0, i) : null;
}

/** INBOX is case-insensitive (RFC 3501), also as the first part of a path: "Inbox/Kunden" → "INBOX/Kunden". */
function inboxCase(p, d) {
  const s = String(p);
  if (s.toUpperCase() === 'INBOX') return 'INBOX';
  return d && s.slice(0, 5 + d.length).toUpperCase() === `INBOX${d}`.toUpperCase() ? `INBOX${s.slice(5)}` : s;
}

/**
 * Whether the server keeps every folder below INBOX (a personal namespace "INBOX." as Courier and older Dovecot set
 * up): all folders but the inbox lie below it and the well-known ones too. Then they count as on top, not as the
 * inbox's children.
 */
function inboxNamespace(shown) {
  const others = shown.filter((k) => inboxCase(k.path, k.delim) !== 'INBOX');
  if (!others.length || !shown.some((k) => inboxCase(k.path, k.delim) === 'INBOX')) return false;
  return others.every((k) => inboxCase(k.path, k.delim).startsWith(`INBOX${k.delim}`)) && others.some((k) => k.role && k.role !== 'inbox');
}

/** LIST → the folders of account `a` (new ones made, gone ones dropped with their mail). → rows */
async function syncFolders(gc, a, s, now) {
  const listed = (await s.list()) || [];
  let keep = [];
  for (const x of listed) {
    if (!x || typeof x.path !== 'string') continue;
    if ((x.flags || []).some((fl) => /^\\(Noselect|NonExistent)$/i.test(fl))) continue;
    const role = roleOf(x);
    // Gmail's "All Mail" is kept (archiving moves there) but never synced or listed; "Flagged" / "Important" are views
    if (x.specialUse && SKIP_USE.has(x.specialUse) && role !== 'inbox' && role !== 'all') { keep.push({ path: x.path, skip: true, role }); continue; }
    keep.push({ path: x.path, name: line(x.name || x.path.split(x.delimiter || '/').pop()) || x.path, delim: x.delimiter || '/', role, parent: parentPathOf(x) });
  }
  const rows = await store.all(gc, 'SELECT * FROM folders WHERE account_id = ?', [a.id]);
  // at most FOLDERS_MAX (like Microsoft): the well-known ones first, then the ones known from before (no folder comes
  // and goes because a new one is listed earlier), then the shallow ones. The rest: a hint in the log, no error.
  const all = keep.filter((k) => !k.skip);
  const over = Math.max(0, all.length - mailstore.FOLDERS_MAX);
  if (over) {
    const known = new Set(rows.map((r) => r.path));
    const depthOf = (k) => (k.delim ? k.path.split(k.delim).length : 1);
    const rank = (k) => [k.role ? 0 : 1, known.has(k.path) ? 0 : 1, depthOf(k)];
    const ranked = all.map((k, i) => ({ k, i, r: rank(k) })).sort((p, q) => p.r[0] - q.r[0] || p.r[1] - q.r[1] || p.r[2] - q.r[2] || p.i - q.i);
    const out = new Set(ranked.slice(mailstore.FOLDERS_MAX).map((x) => x.k));
    keep = keep.filter((k) => !out.has(k));
  }
  mailstore.folderHint(gc, a.id, all.length - over, over, 0);
  // one folder per role: the special-use one wins over a name match
  const taken = new Set();
  for (const k of keep) {
    if (k.skip) continue;
    if (k.role && taken.has(k.role)) k.role = null;
    if (k.role) taken.add(k.role);
    const have = rows.find((r) => r.path === k.path);
    if (have) {
      if (have.role !== k.role || have.name !== k.name) await store.run(gc, 'UPDATE folders SET role = ?, name = ? WHERE id = ?', [k.role, k.name, have.id]);
    } else {
      await store.run(gc, 'INSERT INTO folders (account_id, path, name, delim, role) VALUES (?, ?, ?, ?, ?)', [a.id, k.path, k.name, k.delim, k.role]);
    }
  }
  const paths = new Set(keep.filter((k) => !k.skip).map((k) => k.path));
  for (const r of rows) {
    if (paths.has(r.path)) continue;
    const ids = (await store.all(gc, 'SELECT id FROM messages WHERE folder_id = ?', [r.id])).map((x) => x.id);
    await mailstore.remove(gc, ids);
    await store.run(gc, 'DELETE FROM folders WHERE id = ?', [r.id]);
  }
  // parents by the parent path the server lists (a parent it does not list, e.g. \Noselect, leaves the folder on top)
  const shown = keep.filter((k) => !k.skip);
  const lifted = inboxNamespace(shown);
  const parentOf = new Map(shown.map((k) => [inboxCase(k.path, k.delim), lifted && k.parent && inboxCase(k.parent, k.delim) === 'INBOX' ? null : k.parent]));
  const now2 = await store.all(gc, 'SELECT id, path, delim, parent_id FROM folders WHERE account_id = ?', [a.id]);
  const byPath = new Map(now2.map((r) => [inboxCase(r.path, r.delim), r]));
  for (const r of now2) {
    const pp = parentOf.get(inboxCase(r.path, r.delim));
    const parent = pp ? byPath.get(inboxCase(pp, r.delim)) : null;
    const pid = parent && parent.id !== r.id ? parent.id : null;
    if ((r.parent_id || null) !== pid) await store.run(gc, 'UPDATE folders SET parent_id = ? WHERE id = ?', [pid, r.id]);
  }
  void now;
  return store.all(gc, 'SELECT * FROM folders WHERE account_id = ?', [a.id]);
}

/** Does a body structure (imapflow's form) hold a real attachment? */
function hasAttachment(bs) {
  if (!bs || typeof bs !== 'object') return false;
  if (Array.isArray(bs.childNodes) && bs.childNodes.length) return bs.childNodes.some(hasAttachment);
  const disp = String(bs.disposition || '').toLowerCase();
  const type = String(bs.type || '').toLowerCase();
  if (disp === 'attachment') return true;
  if (disp === 'inline' && !/^text\//.test(type)) return false;
  return !!(bs.dispositionParameters && bs.dispositionParameters.filename) || !!(bs.parameters && bs.parameters.name && !/^text\//.test(type));
}

const hdr = (headers, name) => {
  if (!headers || typeof headers !== 'object') return null;
  const v = headers[name] != null ? headers[name] : headers[name.toLowerCase()];
  return v == null ? null : String(Array.isArray(v) ? v[0] : v).trim() || null;
};

/** "<https://…>, <mailto:…>" → { url?, mail? } | null */
function unsubOf(v) {
  if (!v) return null;
  const out = {};
  for (const m of String(v).matchAll(/<([^>]+)>/g)) {
    const u = m[1].trim();
    if (!out.url && /^https:\/\//i.test(u)) out.url = u.slice(0, 1000);
    if (!out.mail && /^mailto:/i.test(u)) out.mail = u.slice(7, 500);
  }
  return out.url || out.mail ? out : null;
}

/** A fetched IMAP entry → mailstore header. */
function headerOf(x) {
  const e = x.envelope || {};
  const flags = Array.isArray(x.flags) ? x.flags : [];
  const refs = hdr(x.headers, 'references');
  return {
    uid: x.uid, messageId: e.messageId, inReplyTo: e.inReplyTo, refs: refs ? refs.split(/\s+/) : [],
    date: Number.isFinite(e.date) ? e.date : (e.date ? Date.parse(e.date) : x.internalDate) || x.internalDate,
    from: (e.from || [])[0] || null, to: e.to, cc: e.cc, bcc: e.bcc, replyTo: e.replyTo, subject: e.subject || '',
    unread: !flags.includes('\\Seen'), flagged: flags.includes('\\Flagged'), answered: flags.includes('\\Answered'),
    hasAtt: hasAttachment(x.bodyStructure), size: x.size,
    listId: hdr(x.headers, 'list-id'), precedence: hdr(x.headers, 'precedence'), autoSubmitted: hdr(x.headers, 'auto-submitted'),
    listUnsub: unsubOf(hdr(x.headers, 'list-unsubscribe')),
  };
}

const FETCH_OPTS = { envelope: true, flags: true, size: true, internalDate: true, bodyStructure: true, headers: HEAD_FIELDS };

/** Fetch `uids` (any number) in parts of FETCH_MAX → entries. */
async function fetchUids(s, uids, opts = FETCH_OPTS) {
  const out = [];
  for (let i = 0; i < uids.length; i += FETCH_MAX) out.push(...((await s.fetch(uids.slice(i, i + FETCH_MAX), opts)) || []));
  return out;
}

const sinceArg = (ms) => new Date(ms).toISOString();

/**
 * Sync folder `f` → { created: [message ids], changed }. o: { since (ms, 0 = everything), arrival (new mail may push),
 * budget (most new headers this run), reconcile (look for mail that went) }.
 */
async function syncFolder(gc, a, s, f, o) {
  const now = Date.now();
  const st = await s.open(f.path, { readOnly: false });
  const out = { created: [], changed: false };
  if (f.uid_validity != null && st.uidValidity != null && Number(st.uidValidity) !== Number(f.uid_validity)) {
    const ids = (await store.all(gc, 'SELECT id FROM messages WHERE folder_id = ?', [f.id])).map((r) => r.id);
    await mailstore.remove(gc, ids);
    await store.run(gc, 'UPDATE folders SET uid_next = NULL, low_uid = NULL, modseq = NULL, complete = 0 WHERE id = ?', [f.id]);
    f.uid_next = null; f.low_uid = null; f.modseq = null;
    out.changed = true;
  }
  const budget = o.budget || FIRST_BATCH;
  const since = o.since || 0;
  let lowUid = f.low_uid;
  let uidNext = f.uid_next;
  // 1. new mail
  if (!uidNext) {
    // the first sync: newest first
    const all = ((await s.search(since ? { since: sinceArg(since) } : { uid: '1:*' })) || []).filter((u) => Number.isSafeInteger(u)).sort((x, y) => y - x);
    const take = all.slice(0, budget);
    for (const x of await fetchUids(s, take)) {
      const r = await mailstore.upsert(gc, a, f, headerOf(x), { arrival: false, now });
      if (r.created) out.created.push(r.id);
    }
    uidNext = Number(st.uidNext) || ((all[0] || 0) + 1);
    lowUid = all.length > take.length ? take[take.length - 1] : 0;
  } else if (Number(st.uidNext) > uidNext || st.uidNext == null) {
    const found = ((await s.search({ uid: `${uidNext}:*` })) || []).filter((u) => Number.isSafeInteger(u) && u >= uidNext).sort((x, y) => x - y);
    for (const x of await fetchUids(s, found)) {
      const r = await mailstore.upsert(gc, a, f, headerOf(x), { arrival: o.arrival, now });
      if (r.created) out.created.push(r.id);
    }
    uidNext = Math.max(Number(st.uidNext) || 0, (found[found.length - 1] || 0) + 1, uidNext);
  }
  // 2. the rest of the first sync, below low_uid
  if (lowUid && lowUid > 1 && out.created.length < budget) {
    const older = ((await s.search(since ? { since: sinceArg(since), uid: `1:${lowUid - 1}` } : { uid: `1:${lowUid - 1}` })) || [])
      .filter((u) => Number.isSafeInteger(u) && u < lowUid).sort((x, y) => y - x);
    const take = older.slice(0, budget - out.created.length);
    for (const x of await fetchUids(s, take)) {
      const r = await mailstore.upsert(gc, a, f, headerOf(x), { arrival: false, now });
      if (r.created) out.created.push(r.id);
    }
    lowUid = older.length > take.length ? take[take.length - 1] : 0;
  }
  // 3. flags of the known ones
  const condstore = st.highestModseq != null && f.modseq != null;
  if (condstore && String(st.highestModseq) !== String(f.modseq)) {
    for (const x of (await s.fetch('1:*', { flags: true, changedSince: f.modseq })) || []) {
      const r = await mailstore.upsert(gc, a, f, { uid: x.uid, unread: !(x.flags || []).includes('\\Seen'), flagged: (x.flags || []).includes('\\Flagged'), answered: (x.flags || []).includes('\\Answered') }, { now });
      if (r.changed) out.changed = true;
    }
  } else if (!condstore) {
    const known = (await store.all(gc, 'SELECT uid FROM messages WHERE folder_id = ? AND uid IS NOT NULL ORDER BY uid DESC LIMIT ?', [f.id, FLAGS_RECENT])).map((r) => r.uid);
    if (known.length) {
      for (const x of await fetchUids(s, known, { flags: true })) {
        const fl = x.flags || [];
        const r = await mailstore.upsert(gc, a, f, { uid: x.uid, unread: !fl.includes('\\Seen'), flagged: fl.includes('\\Flagged'), answered: fl.includes('\\Answered') }, { now });
        if (r.changed) out.changed = true;
      }
    }
  }
  // 4. mail that went (another device moved or deleted it)
  if (o.reconcile) {
    const present = new Set(((await s.search(since ? { since: sinceArg(since) } : { uid: '1:*' })) || []).map(Number));
    const rows = await store.all(gc, 'SELECT id, uid FROM messages WHERE folder_id = ? AND uid IS NOT NULL AND date >= ?', [f.id, since ? since + 86400000 : 0]);
    const gone = rows.filter((r) => !present.has(r.uid) && (!lowUid || r.uid >= lowUid)).map((r) => r.id);
    if (gone.length) { await mailstore.remove(gc, gone); out.changed = true; }
  }
  await store.run(gc, 'UPDATE folders SET uid_validity = ?, uid_next = ?, low_uid = ?, modseq = ?, remote_total = ?, synced_at = ?, complete = ? WHERE id = ?',
    [st.uidValidity == null ? null : Number(st.uidValidity), uidNext, lowUid || 0, st.highestModseq == null ? null : String(st.highestModseq),
      Number(st.exists) || 0, now, lowUid ? 0 : (since ? 0 : 1), f.id]);
  if (out.created.length) out.changed = true;
  return out;
}

/** Headers older than `before` (ms) the server keeps beyond the retention → created ids (≤ count). */
async function older(gc, a, s, f, before, count) {
  await s.open(f.path, { readOnly: true });
  const uids = ((await s.search({ before: sinceArg(before) })) || []).filter(Number.isSafeInteger).sort((x, y) => y - x);
  const known = new Set((await store.all(gc, 'SELECT uid FROM messages WHERE folder_id = ? AND uid IS NOT NULL', [f.id])).map((r) => r.uid));
  const take = uids.filter((u) => !known.has(u)).slice(0, count);
  const created = [];
  for (const x of await fetchUids(s, take)) {
    const r = await mailstore.upsert(gc, a, f, headerOf(x), { arrival: false });
    if (r.created) created.push(r.id);
  }
  if (!take.length) await store.run(gc, 'UPDATE folders SET complete = 1 WHERE id = ?', [f.id]);
  return created;
}

/** The full message (body and the list of attachments) of row `m` in folder `f`. → the parsed mail */
async function message(s, f, m, maxBytes) {
  await s.open(f.path, { readOnly: true });
  return s.message(m.uid, { attachments: 'meta', ...(maxBytes ? { maxBytes } : {}) });
}

async function download(s, f, m, att, maxBytes) {
  await s.open(f.path, { readOnly: true });
  return s.download(m.uid, att.part_id, { name: att.name, maxBytes });
}

/** Search the server (beyond the retention) → uids of folder `f`. */
async function search(s, f, q) {
  await s.open(f.path, { readOnly: true });
  return ((await s.search(q)) || []).filter(Number.isSafeInteger).sort((x, y) => y - x).slice(0, 50);
}

module.exports = { syncFolders, syncFolder, older, message, download, search, headerOf, roleOf, hasAttachment, unsubOf, fetchUids, FETCH_OPTS, HEAD_FIELDS };
