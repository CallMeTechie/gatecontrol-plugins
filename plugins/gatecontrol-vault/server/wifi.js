'use strict';

// Wi-Fi shares (1.4.0, README "WLAN-Freigaben"): a Wi-Fi entry shown for a while on the wall tablet (the Familie
// plugin's wall view) or on the portal's start page, as a card with the network name, a QR code and the password
// behind a tap.
//
// The vault is end-to-end encrypted — the server cannot read an entry. So a share is a COPY the sharing app makes: it
// decrypts the entry and sends the network name, the kind of security and the password (nothing else of the entry),
// and the server keeps that copy in the clear (wifi_shares) because the tablet and the portal have no key. Rules:
//
//   * only a person with the write role in the entry's vault shares or ends (the owner of the personal vault has
//     manage); the members of the vault see the running shares of its entries (they can read the entry anyway);
//   * one share per entry and target ('wall' | 'portal'); sharing again replaces the copy (and the time, or keeps
//     it with duration 'keep' — "Aktualisieren" after the entry changed);
//   * the time is enforced here: an expired share is never handed out and deleted by the background run; the wall
//     tablet (Familie) gets the end with the copy and enforces it too;
//   * ending deletes the copy at once (and sends the wall's new set to the Familie plugin);
//   * trashing, purging or moving the entry, and deleting its vault, end its shares — a change of the entry does
//     not: the share stays a copy of what was shared, the apps compare it with the entry and offer "Aktualisieren";
//   * at most 4 running shares per target, 30 shares (POST) per person and hour; every share and end is a log row
//     (who, which entry, where, for how long — never the content).
//
// Where the copy goes:
//   portal  the hook portalTiles: a Start tile with qr / secret / until (GateControl ≥ 1.197.0) for signed-in
//           people in the portal only — never a kiosk device, device trust alone or the apps' start card;
//   wall    the Familie plugin's service wall_wifi (permissions.services) gets the whole set of running wall shares
//           on every change (≤ 60 service calls an hour: a set, not a stream); its wall view shows them to the wall
//           tablets. A failed push marks the set dirty — the background run (every 5 minutes) sends it again, and
//           once an hour anyway while wall shares run (a reinstalled Familie plugin gets them back).

const store = require('./store');
const vaults = require('./vaults');
const account = require('./account');
const people = require('./people');
const { t } = require('./text');
const { fail, clientId, canWrite, iso, newId } = require('./util');

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const TARGETS = ['wall', 'portal'];
const DURATIONS = { '5m': 5 * MIN, '1h': HOUR, '24h': DAY, forever: null };
const SECURITY = ['WPA', 'WEP', 'SAE', 'nopass'];
const LIMITS = { perTarget: 4, sharesPerHour: 30, ssid: 64, password: 128 };
const FAMILIE = 'gatecontrol-familie';
const SERVICE = 'wall_wifi';
const RESEND_MS = HOUR;
const SHARE_ID_RE = /^[0-9a-f]{24}$/;
const CONTROL_RE = /[\0-\x1f\x7f]/;
// a Wi-Fi symbol (SVG path data like ui.nav.icon)
const ICON = 'M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01';

/** The text of a Wi-Fi QR code: WIFI:T:<WPA|WEP|SAE|nopass>;S:<ssid>;P:<password>;H:true;; — \ ; , : " escaped. */
function qrText(s) {
  const esc = (v) => String(v == null ? '' : v).replace(/([\\;,:"])/g, '\\$1');
  return 'WIFI:T:' + s.security + ';S:' + esc(s.ssid) + ';' + (s.security === 'nopass' ? '' : 'P:' + esc(s.password) + ';') + (s.hidden ? 'H:true;' : '') + ';';
}

/** The copy the app sends: { ssid, security, password, hidden } checked, else invalid. */
function parseCopy(b) {
  const ssid = b.ssid;
  if (typeof ssid !== 'string' || !ssid.trim() || ssid.length > LIMITS.ssid || CONTROL_RE.test(ssid)) throw fail('invalid');
  if (!SECURITY.includes(b.security)) throw fail('invalid');
  const pw = b.password == null ? '' : b.password;
  if (typeof pw !== 'string' || pw.length > LIMITS.password || CONTROL_RE.test(pw)) throw fail('invalid');
  if (b.security === 'nopass' ? pw !== '' : pw === '') throw fail('invalid');
  if (b.hidden != null && typeof b.hidden !== 'boolean') throw fail('invalid');
  return { ssid, security: b.security, password: pw, hidden: b.hidden === true };
}

const active = (now) => ['(expires_at IS NULL OR expires_at > ?)', now];

function view(r, users, role) {
  const by = (id) => ({ id, name: (users && users.get(id) && users.get(id).name) || `#${id}` });
  return {
    id: r.id, itemId: r.item_id, vaultId: r.vault_id, target: r.target,
    ssid: r.ssid, security: r.security, password: r.password, hidden: r.hidden > 0,
    expiresAt: iso(r.expires_at), createdAt: iso(r.created_at), createdBy: by(r.created_by),
    updatedAt: iso(r.updated_at), updatedBy: by(r.updated_by),
    canEnd: canWrite(role),
  };
}

// ── the wall tablet's copy (Familie plugin) ──────────────

let dirty = false;      // mirrors meta.wall_dirty: the Familie plugin may be out of step (the background run resends)
let kick = false;       // a request ended wall shares on the side: send the new set when it is done (flush)
let lock = Promise.resolve();

/** Run fn with the wall pushes serialised (one set at a time, in order). */
function wallLock(fn) {
  const p = lock.then(fn, fn);
  lock = p.catch(() => {});
  return p;
}

/** meta.wall_dirty inside a transaction. */
async function markDirty(gc, on) {
  dirty = on;
  await store.run(gc, "UPDATE meta SET value = ? WHERE key = 'wall_dirty'", [on ? 1 : 0]);
}

/** meta.wall_dirty (and the time of a push that went through) in a transaction of its own. */
function setDirty(gc, on, pushedAt) {
  return store.tx(gc, async () => {
    await markDirty(gc, on);
    if (pushedAt) await store.run(gc, "UPDATE meta SET value = ? WHERE key = 'wall_pushed_at'", [pushedAt]);
  });
}

/** Is the Familie plugin's service there (GateControl ≥ 1.178.0: asks nobody, not counted)? */
async function wallAvailable(gc) {
  try {
    return !!(gc.services && typeof gc.services.available === 'function' && await gc.services.available(FAMILIE, SERVICE));
  } catch {
    return false;
  }
}

/**
 * Send the whole set of running wall shares to the Familie plugin → { ok: true, walls } | { ok: false, code }.
 * code: 'no_wall' (no service, its wall module off or no wall tablet), 'unavailable' (the call failed — dirty).
 * Never throws. Call inside wallLock.
 */
async function pushWall(gc, now) {
  const rows = await store.all(gc, `SELECT * FROM wifi_shares WHERE target = 'wall' AND ${active(now)[0]} ORDER BY created_at, id`, [now]);
  const users = await people.users(gc);
  const payload = {
    shares: rows.map((r) => ({
      id: r.id, ssid: r.ssid, security: r.security, password: r.password, hidden: r.hidden > 0,
      expiresAt: iso(r.expires_at), sharedBy: (users.get(r.created_by) && users.get(r.created_by).name) || null,
    })),
  };
  if (!(await wallAvailable(gc))) {
    // nothing to send to: the set is "in step" when it is empty, else it waits for the plugin
    await setDirty(gc, rows.length > 0);
    return { ok: false, code: 'no_wall' };
  }
  let res;
  try {
    res = await gc.services.call({ plugin: FAMILIE, service: SERVICE, payload });
  } catch (e) {
    gc.log.warn('wall push failed', (e && e.code) || 'error');
    await setDirty(gc, true);
    return { ok: false, code: 'unavailable' };
  }
  if (!res || res.ok !== true) {
    await setDirty(gc, true);
    return { ok: false, code: 'unavailable' };
  }
  await setDirty(gc, false, now);
  const walls = Number.isSafeInteger(res.walls) ? res.walls : 0;
  return { ok: true, walls, wall: res.wall !== false && walls > 0 };
}

/** After a request that ended wall shares on the side (trash, purge, move, vault deleted): send the new set now. */
async function flush(gc) {
  if (!kick) return;
  kick = false;
  await wallLock(() => pushWall(gc, Date.now()));
}

// ── API ──────────────────────────────────────────────────

/** GET wifi-shares?item=<id> — the running shares of entries in the caller's vaults (of one entry with item). */
async function list(ctx, query) {
  const { gc, viewer, now } = ctx;
  const q = query || {};
  const item = q.item != null && q.item !== '' ? clientId(q.item) : null;
  await account.need(gc, viewer);
  const rows = await store.all(gc, `SELECT s.*, m.role FROM wifi_shares s JOIN members m ON m.vault_id = s.vault_id AND m.user_id = ?
    WHERE ${active(now)[0]}${item ? ' AND s.item_id = ?' : ''} ORDER BY s.created_at, s.id`, item ? [viewer, now, item] : [viewer, now]);
  return { shares: rows.map((r) => view(r, ctx.users, r.role)), targets: { wall: await wallAvailable(gc), portal: true } };
}

/**
 * POST wifi-shares — { itemId, target: 'wall'|'portal', duration: '5m'|'1h'|'24h'|'forever'|'keep',
 *   ssid, security: 'WPA'|'WEP'|'SAE'|'nopass', password ('' for nopass), hidden? } → { share }.
 * The entry: live, in a vault where the caller may write. 'keep' renews the copy of a running share, keeping its end.
 */
async function share(ctx, body) {
  const b = body || {};
  const itemId = clientId(b.itemId);
  if (!TARGETS.includes(b.target)) throw fail('invalid');
  const keep = b.duration === 'keep';
  if (!keep && !Object.prototype.hasOwnProperty.call(DURATIONS, b.duration)) throw fail('invalid');
  const copy = parseCopy(b);
  const { gc, viewer } = ctx;
  if (b.target === 'wall' && !(await wallAvailable(gc))) throw fail('no_wall');
  const write = async () => store.tx(gc, async () => {
    const now = Date.now();
    await account.need(gc, viewer);
    const it = await store.one(gc, 'SELECT id, vault_id, state FROM items WHERE id = ?', [itemId]);
    if (!it || it.state === 2) throw fail('not_found');
    const m = await vaults.membership(gc, it.vault_id, viewer);
    if (!canWrite(m.role)) throw fail('forbidden');
    if (it.state !== 0) throw fail('conflict');
    const recent = await store.one(gc, "SELECT COUNT(*) AS n FROM events WHERE user_id = ? AND action = 'wifi.share' AND at > ?", [viewer, now - HOUR]);
    if (recent.n >= LIMITS.sharesPerHour) throw fail('rate_limited');
    const old = await store.one(gc, `SELECT * FROM wifi_shares WHERE item_id = ? AND target = ? AND ${active(now)[0]}`, [itemId, b.target, now]);
    if (keep && !old) throw fail('not_found');
    const others = await store.one(gc, `SELECT COUNT(*) AS n FROM wifi_shares WHERE target = ? AND item_id != ? AND ${active(now)[0]}`, [b.target, itemId, now]);
    if (others.n >= LIMITS.perTarget) throw fail('limit');
    const expires = keep ? old.expires_at : (DURATIONS[b.duration] == null ? null : now + DURATIONS[b.duration]);
    const prev = await store.one(gc, 'SELECT * FROM wifi_shares WHERE item_id = ? AND target = ?', [itemId, b.target]);
    const id = old ? old.id : newId();
    if (prev && !old) await store.run(gc, 'DELETE FROM wifi_shares WHERE id = ?', [prev.id]); // an expired one not yet cleaned up
    await store.run(gc, `INSERT INTO wifi_shares (id, item_id, vault_id, target, ssid, security, password, hidden, expires_at, created_by, created_at, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET ssid = excluded.ssid, security = excluded.security, password = excluded.password, hidden = excluded.hidden,
        expires_at = excluded.expires_at, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    [id, itemId, it.vault_id, b.target, copy.ssid, copy.security, copy.password, copy.hidden ? 1 : 0, expires, viewer, now, viewer, now]);
    await store.event(gc, now, viewer, 'wifi.share', it.vault_id, itemId, `${b.target} ${keep ? 'keep' : b.duration}`);
    return { id, old: old || null, role: m.role, vaultId: it.vault_id };
  });
  const done = async (w) => {
    const r = await store.one(gc, 'SELECT * FROM wifi_shares WHERE id = ?', [w.id]);
    return { share: view(r, ctx.users, w.role) };
  };
  if (b.target === 'portal') return done(await write());
  return wallLock(async () => {
    const w = await write();
    const res = await pushWall(gc, Date.now());
    if (res.ok && res.wall) return done(w);
    // not shown anywhere: back to what was there before (and the Familie plugin's set with it)
    await store.tx(gc, async () => {
      await store.run(gc, 'DELETE FROM wifi_shares WHERE id = ?', [w.id]);
      if (w.old) {
        const o = w.old;
        await store.run(gc, `INSERT INTO wifi_shares (id, item_id, vault_id, target, ssid, security, password, hidden, expires_at, created_by, created_at, updated_by, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [o.id, o.item_id, o.vault_id, o.target, o.ssid, o.security, o.password, o.hidden, o.expires_at, o.created_by, o.created_at, o.updated_by, o.updated_at]);
      }
      await store.event(gc, Date.now(), viewer, 'wifi.end', w.vaultId, itemId, `wall undone: ${res.ok ? 'no_wall' : res.code}`);
    });
    if (res.ok) await pushWall(gc, Date.now());
    throw fail(res.ok ? 'no_wall' : res.code);
  });
}

/** DELETE wifi-shares/<id> — end a share now (write role in its vault) → { removed }. */
async function end(ctx, idRaw) {
  const id = String(idRaw || '');
  if (!SHARE_ID_RE.test(id)) throw fail('not_found');
  const { gc, viewer } = ctx;
  const run = async () => {
    const now = Date.now();
    const row = await store.tx(gc, async () => {
      await account.need(gc, viewer);
      const r = await store.one(gc, 'SELECT * FROM wifi_shares WHERE id = ?', [id]);
      if (!r) throw fail('not_found');
      const m = await vaults.membership(gc, r.vault_id, viewer);
      if (!canWrite(m.role)) throw fail('forbidden');
      await store.run(gc, 'DELETE FROM wifi_shares WHERE id = ?', [id]);
      await store.event(gc, now, viewer, 'wifi.end', r.vault_id, r.item_id, `${r.target} ended`);
      return r;
    });
    if (row.target === 'wall') await pushWall(gc, now);
    return { removed: id };
  };
  // a wall share: in line with the other wall pushes; the Familie plugin's copy goes now (or with the next run)
  return wallLock(run);
}

// ── hooks into the rest of Vault (inside their transactions) ──

/**
 * The entry was trashed, purged or moved: its shares end (reason in the log). Marks the wall set dirty when one of
 * them was a wall share — the request then sends the new set (flush), the background run otherwise.
 */
async function dropItem(gc, itemId, now, userId, reason) {
  const rows = await store.all(gc, 'SELECT id, vault_id, target FROM wifi_shares WHERE item_id = ?', [itemId]);
  if (!rows.length) return;
  await store.run(gc, 'DELETE FROM wifi_shares WHERE item_id = ?', [itemId]);
  for (const r of rows) await store.event(gc, now, userId || 0, 'wifi.end', r.vault_id, itemId, `${r.target} ended: ${reason}`);
  if (rows.some((r) => r.target === 'wall')) { await markDirty(gc, true); kick = true; }
}

/** The vault goes (deleted, the last member left, an account deleted): its shares with it. */
async function dropVault(gc, vaultId) {
  const rows = await store.all(gc, 'SELECT target FROM wifi_shares WHERE vault_id = ?', [vaultId]);
  if (!rows.length) return;
  await store.run(gc, 'DELETE FROM wifi_shares WHERE vault_id = ?', [vaultId]);
  if (rows.some((r) => r.target === 'wall')) { await markDirty(gc, true); kick = true; }
}

// ── portal Start tiles ───────────────────────────────────

/** Is this viewer a signed-in person in the portal (not a kiosk device, not device trust alone, not an app)? */
function portalPerson(user) {
  return !!(user && Number.isSafeInteger(user.id) && user.portal === true && user.loggedIn === true && user.kiosk !== true && user.app !== true);
}

/** portalTiles({ user, lang }): the running portal shares as Start tiles (GateControl ≥ 1.197.0 draws the QR code). */
async function tiles(gc, q) {
  const user = (q && q.user) || null;
  if (!portalPerson(user)) return [];
  if ((await people.kioskIds(gc)).has(user.id)) return [];
  const lang = q && q.lang === 'en' ? 'en' : 'de';
  const now = Date.now();
  const rows = await store.all(gc, `SELECT * FROM wifi_shares WHERE target = 'portal' AND ${active(now)[0]} ORDER BY created_at, id LIMIT ?`, [now, LIMITS.perTarget]);
  return rows.map((r) => ({
    title: t(lang, 'share.tile_title'),
    value: r.ssid,
    icon: ICON,
    state: 'on',
    qr: qrText({ ssid: r.ssid, security: r.security, password: r.password, hidden: r.hidden > 0 }),
    ...(r.security === 'nopass' ? {} : { secret: { label: t(lang, 'share.tile_password'), value: r.password } }),
    ...(r.expires_at == null ? {} : { until: iso(r.expires_at) }),
  }));
}

// ── background ───────────────────────────────────────────

/** Expired shares go (a log row each); the wall set is sent again when dirty, and hourly while wall shares run. */
async function tick(gc, now) {
  const expired = await store.tx(gc, async () => {
    const rows = await store.all(gc, 'SELECT * FROM wifi_shares WHERE expires_at IS NOT NULL AND expires_at <= ?', [now]);
    for (const r of rows) {
      await store.run(gc, 'DELETE FROM wifi_shares WHERE id = ?', [r.id]);
      await store.event(gc, now, r.created_by, 'wifi.end', r.vault_id, r.item_id, `${r.target} expired`);
    }
    return rows.length;
  });
  const meta = await store.all(gc, "SELECT key, value FROM meta WHERE key IN ('wall_dirty', 'wall_pushed_at')");
  const get = (k) => (meta.find((x) => x.key === k) || {}).value || 0;
  dirty = get('wall_dirty') > 0;
  const running = (await store.one(gc, `SELECT COUNT(*) AS n FROM wifi_shares WHERE target = 'wall' AND ${active(now)[0]}`, [now])).n;
  let pushed = false;
  if (dirty || (running > 0 && now - get('wall_pushed_at') >= RESEND_MS)) {
    const r = await wallLock(() => pushWall(gc, now));
    pushed = r.ok;
  }
  return { expired, pushed };
}

/** Counts for the admin page (no names, no content). */
async function counts(gc, now = Date.now()) {
  const rows = await store.all(gc, `SELECT target, COUNT(*) AS n FROM wifi_shares WHERE ${active(now)[0]} GROUP BY target`, [now]);
  const n = (k) => (rows.find((r) => r.target === k) || {}).n || 0;
  return { wall: n('wall'), portal: n('portal') };
}

module.exports = { list, share, end, dropItem, dropVault, flush, tiles, tick, counts, qrText, parseCopy, portalPerson, TARGETS, DURATIONS, SECURITY, LIMITS, FAMILIE, SERVICE };
