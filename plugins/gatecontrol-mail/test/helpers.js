'use strict';

// Test helpers: the mock host as GateControl 1.216.0 (gc.mail, gc.http.fetchImage; opts.gatecontrol '1.217.0': also
// gc.mail.smtp.verify and gc.http.fetch with bodyMedia) with a fake IMAP/SMTP world
// (FakeMail — mailboxes per login, IDLE events, SMTP records), a fake Microsoft (token endpoint and Graph through the
// mock host's opts.fetch), fake Drive and Familie (opts.services) and the mock host's gc.ai. No network anywhere.

const path = require('node:path');
const { createHost, hostError } = require('../../../tools/testing/mock-host');

const DIR = path.join(__dirname, '..');
const ADMIN = { id: 1, name: 'admin', role: 'admin' };
const ANNA = { id: 2, name: 'Anna', role: 'user' };
const MARC = { id: 3, name: 'Marc', role: 'user' };
const BOB = { id: 4, name: 'Bob', role: 'user' };
const USERS = [ADMIN, ANNA, MARC, BOB];
const DAY = 86400000;

const app = (u) => ({ ...u, portal: true, loggedIn: true, app: true });

/** A UID range ('1:*', '3:9,12', [4, 5], 7) → a test over a uid. */
function inRange(range, maxUid) {
  if (Array.isArray(range)) { const set = new Set(range.map(Number)); return (u) => set.has(u); }
  if (typeof range === 'number') return (u) => u === range;
  const parts = String(range).split(',').map((p) => p.split(':').map((x) => (x === '*' ? maxUid : Number(x))));
  return (u) => parts.some(([a, b]) => (b == null ? u === a : u >= Math.min(a, b) && u <= Math.max(a, b)));
}

const ms = (v) => (typeof v === 'number' ? v : Date.parse(v));

/** A fake mail world: logins → mailboxes; mail(), deliver() add mail; sent[] records SMTP; hold / held: a slow sync (fetch). */
class FakeMail {
  constructor() {
    this.logins = new Map(); // user → { pass, token, boxes: Map path → box, specialUse }
    this.sent = [];
    this.sessions = [];
    this.appended = [];
    this.uidValidity = 1;
  }

  login(user, pass, o = {}) {
    const boxes = new Map();
    const mk = (p, use) => boxes.set(p, { path: p, specialUse: use || null, uidValidity: 7, uidNext: 1, modseq: o.condstore ? 1 : null, msgs: new Map() });
    mk('INBOX', '\\Inbox');
    for (const [p, use] of Object.entries(o.folders || { Gesendet: '\\Sent', Entwürfe: '\\Drafts', Archiv: '\\Archive', Spam: '\\Junk', Papierkorb: '\\Trash' })) mk(p, use);
    // smtpPass: SMTP wants another password than IMAP (gc.mail.smtp.verify refuses the IMAP one, GateControl ≥ 1.217.0)
    this.logins.set(user, { pass, token: o.token || null, boxes, imapDisabled: !!o.imapDisabled, smtpPass: o.smtpPass || null });
    return this;
  }

  /** Put a mail into a box (no event). m: { from, to, subject, date, text, html, headers, flags, attachments, messageId, inReplyTo } */
  mail(user, boxPath, m) {
    const box = this.logins.get(user).boxes.get(boxPath);
    const uid = box.uidNext++;
    if (box.modseq != null) box.modseq++;
    const msg = {
      uid, flags: m.flags || [], size: (m.text || m.html || '').length + 500, internalDate: ms(m.date || Date.now()),
      envelope: {
        date: ms(m.date || Date.now()), subject: m.subject || '', from: [m.from || { name: 'Absender', address: 'absender@example.com' }], sender: [],
        replyTo: m.replyTo || [], to: m.to || [{ name: '', address: user }], cc: m.cc || [], bcc: [], inReplyTo: m.inReplyTo || null,
        messageId: m.messageId || `<m${uid}.${Math.random().toString(36).slice(2, 8)}@example.com>`,
      },
      headers: m.headers || {},
      bodyStructure: m.attachments && m.attachments.length ? { type: 'multipart/mixed', childNodes: [{ type: 'text/plain' }, ...m.attachments.map((a) => ({ type: a.contentType, disposition: a.inline ? 'inline' : 'attachment', dispositionParameters: { filename: a.filename } }))] } : { type: 'text/plain' },
      html: m.html || null, text: m.text || null, attachments: (m.attachments || []).map((a, i) => ({ partId: String(i + 2), ...a, size: a.data ? Buffer.byteLength(a.data) : (a.size || 0) })),
      modseq: box.modseq,
    };
    box.msgs.set(uid, msg);
    return msg;
  }

  /** A new mail that arrives now: every open session on that box gets 'exists'. */
  deliver(user, m, boxPath = 'INBOX') {
    const msg = this.mail(user, boxPath, m);
    for (const s of this.sessions) if (s.user === user && s.open && s.ctx) s.ctx.emit('exists', { path: boxPath, count: this.logins.get(user).boxes.get(boxPath).msgs.size });
    return msg;
  }

  box(user, p) { return this.logins.get(user).boxes.get(p); }

  /** opts.mail of the mock host. */
  handler() {
    const world = this;
    return {
      autoconfig: async (email) => (email.endsWith('@firma.example') ? { imap: { host: 'imap.firma.example', port: 993, security: 'tls' }, smtp: { host: 'smtp.firma.example', port: 587, security: 'starttls' }, source: 'ispdb' } : { imap: null, smtp: null, source: null }),
      verify: async (o) => {
        const l = world.logins.get(o.auth.user);
        const pass = l && (l.smtpPass || l.pass);
        if (!l || (o.auth.pass !== pass && o.auth.accessToken !== l.token)) throw Object.assign(hostError('ERR_MAIL_AUTH', 'bad'), { serverText: '535 5.7.8 authentication failed' });
        return { ok: true };
      },
      smtp: async (o, ctx) => {
        const l = world.logins.get(o.auth.user);
        if (!l || (o.auth.pass !== l.pass && o.auth.accessToken !== l.token)) throw hostError('ERR_MAIL_AUTH', 'bad');
        world.sent.push({ ...o, files: (o.message.attachments || []).map((a) => ({ ...a, data: ctx.media(a.mediaId) && ctx.media(a.mediaId).data.toString() })) });
        return { messageId: `<sent${world.sent.length}@example.com>` };
      },
      imap: async (o, ctx) => {
        const l = world.logins.get(o.auth.user);
        if (!l || (o.auth.pass != null ? o.auth.pass !== l.pass : o.auth.accessToken !== l.token)) throw Object.assign(hostError('ERR_MAIL_AUTH', 'authentication failed'), { serverText: 'authentication failed' });
        if (l.imapDisabled) throw Object.assign(hostError('ERR_MAIL_AUTH', 'IMAP is disabled, enable IMAP in web mail'), { serverText: 'IMAP is disabled, enable IMAP in web mail' });
        const s = { user: o.auth.user, open: true, ctx, cur: null, idling: false };
        world.sessions.push(s);
        const box = () => { if (!s.cur) throw hostError('ERR_MAIL_PROTOCOL', 'no mailbox open'); return l.boxes.get(s.cur); };
        const match = (m, q) => {
          if (q.uid && !inRange(q.uid, 1e9)(m.uid)) return false;
          if (q.since && m.internalDate < ms(q.since)) return false;
          if (q.before && m.internalDate >= ms(q.before)) return false;
          if (q.seen === false && m.flags.includes('\\Seen')) return false;
          const has = (v, w) => String(v || '').toLowerCase().includes(String(w).toLowerCase());
          if (q.subject && !has(m.envelope.subject, q.subject)) return false;
          if (q.from && !has(JSON.stringify(m.envelope.from), q.from)) return false;
          if (q.body && !has((m.text || '') + (m.html || ''), q.body)) return false;
          if (q.or && !q.or.some((x) => match(m, x))) return false;
          return true;
        };
        return {
          capabilities: ['IMAP4rev1', 'IDLE', 'MOVE', 'UIDPLUS', ...(l.boxes.get('INBOX').modseq != null ? ['CONDSTORE'] : [])],
          list: async () => [...l.boxes.values()].map((b) => ({ path: b.path, name: b.path, delimiter: '/', parent: null, specialUse: b.specialUse, flags: [], subscribed: true })),
          status: async (p) => { const b = l.boxes.get(p); return { messages: b.msgs.size, uidNext: b.uidNext, uidValidity: b.uidValidity }; },
          open: async (p) => {
            const b = l.boxes.get(p);
            if (!b) throw hostError('ERR_MAIL_PROTOCOL', 'no such mailbox');
            s.cur = p;
            return { path: p, uidValidity: b.uidValidity, uidNext: b.uidNext, exists: b.msgs.size, highestModseq: b.modseq };
          },
          search: async (q) => [...box().msgs.values()].filter((m) => match(m, q || {})).map((m) => m.uid),
          fetch: async (range, o2) => {
            // world.hold (a promise): header fetches (a sync step) wait for it — a slow server in the middle of a sync
            if (o2.envelope && world.hold) { world.held = (world.held || 0) + 1; await world.hold; }
            const b = box();
            const test = inRange(range, b.uidNext - 1);
            return [...b.msgs.values()].filter((m) => test(m.uid) && (o2.changedSince == null || (m.modseq || 0) > o2.changedSince)).map((m) => ({
              uid: m.uid, flags: [...m.flags], ...(o2.size ? { size: m.size } : {}), ...(o2.internalDate ? { internalDate: m.internalDate } : {}),
              ...(o2.envelope ? { envelope: m.envelope } : {}), ...(o2.headers ? { headers: m.headers } : {}), ...(o2.bodyStructure ? { bodyStructure: m.bodyStructure } : {}),
            }));
          },
          message: async (uid) => {
            const m = box().msgs.get(uid);
            if (!m) throw hostError('ERR_INVALID', 'unknown uid');
            return { messageId: m.envelope.messageId, html: m.html, text: m.text, attachments: m.attachments.map(({ data, ...a }) => ({ ...a, mediaId: null, checksum: null })) };
          },
          download: async (uid, partId, o2) => {
            const m = box().msgs.get(uid);
            const a = m && m.attachments.find((x) => x.partId === partId);
            if (!a) throw hostError('ERR_INVALID', 'unknown part');
            const mediaId = ctx.putMedia({ data: a.data || 'x', mime: a.contentType, name: o2 && o2.name });
            return { mediaId, bytes: Buffer.byteLength(a.data || 'x'), mime: a.contentType, name: a.filename };
          },
          flags: async (range, o2) => {
            const b = box();
            const test = inRange(range, b.uidNext - 1);
            for (const m of b.msgs.values()) {
              if (!test(m.uid)) continue;
              for (const f of o2.add || []) if (!m.flags.includes(f)) m.flags.push(f);
              m.flags = m.flags.filter((f) => !(o2.remove || []).includes(f));
            }
            return null;
          },
          move: async (range, to) => {
            const b = box();
            const d = l.boxes.get(to);
            const test = inRange(range, b.uidNext - 1);
            const uidMap = {};
            for (const m of [...b.msgs.values()]) {
              if (!test(m.uid)) continue;
              b.msgs.delete(m.uid);
              const nu = d.uidNext++;
              d.msgs.set(nu, { ...m, uid: nu });
              uidMap[m.uid] = nu;
            }
            return { uidMap };
          },
          expunge: async (range) => { const b = box(); const test = inRange(range, b.uidNext - 1); for (const m of [...b.msgs.values()]) if (test(m.uid) && m.flags.includes('\\Deleted')) b.msgs.delete(m.uid); return null; },
          append: async (p, mediaId, o2) => { world.appended.push({ path: p, mediaId, flags: o2 && o2.flags, data: ctx.media(mediaId) && ctx.media(mediaId).data.toString() }); return { uid: null }; },
          idle: async () => { s.idling = true; },
          noop: async () => null,
          close: async () => { s.open = false; },
        };
      },
    };
  }
}

/** A fake Drive (services + media) that records its calls. */
function fakeDrive(o = {}) {
  const calls = [];
  const d = {
    plugin: 'gatecontrol-drive', calls,
    provides: ['list_areas', 'save_file', 'suggest_folder', 'give_file', 'share_link', 'browse'],
    media: { maxBytes: 104857600, types: ['application/*', 'image/*', 'text/plain'], quotaDefault: '10GB' },
    service: async ({ name, user, payload }) => {
      calls.push({ name, user: user && user.id, payload });
      if (o.noSeat && o.noSeat.includes(user && user.id)) return { ok: false, code: 'no_seat' };
      if (name === 'list_areas') return { ok: true, areas: [{ id: `mine:${user.id}`, kind: 'mine', label: 'Meine Dateien', role: 'manage', writable: true }] };
      if (name === 'suggest_folder') {
        const s = o.suggest ? o.suggest(payload) : { folderId: 11, areaId: `mine:${user.id}`, path: 'Finanzen/Strom', where: 'Meine Dateien › Finanzen › Strom', name: payload.name, confidence: 0.95, reason: 'learned' };
        return { ok: true, suggestion: s, sha256Exists: !!o.duplicate };
      }
      if (name === 'save_file') return { ok: true, nodeId: 100 + calls.length, areaId: `mine:${user.id}`, path: 'x', name: payload.name, created: true, where: `Meine Dateien › Finanzen › ${payload.name}` };
      if (name === 'give_file') {
        if (!d.host) return { ok: false, code: 'unavailable' };
        const size = o.fileSize || 1000;
        const mediaId = d.host._putFromDrive(size, payload.nodeId);
        return { ok: true, mediaId, name: `Datei-${payload.nodeId}.pdf`, mime: 'application/pdf', size };
      }
      if (name === 'share_link') return { ok: true, url: `https://gc.example.com/s/link${payload.nodeId}`, expiresAt: Date.now() + payload.expiresDays * DAY };
      if (name === 'browse') return { ok: true, folder: { id: 5, name: 'Meine Dateien', path: '', where: 'Meine Dateien', areaId: `mine:${user.id}`, writable: true }, items: [{ id: 9, name: 'Angebot.pdf', isDir: false, size: 340000, mime: 'application/pdf' }], next: null };
      return { ok: false, code: 'not_found' };
    },
  };
  return d;
}

function fakeFamilie() {
  const calls = [];
  return { plugin: 'gatecontrol-familie', calls, provides: ['calendar_add'], service: async ({ name, user, payload }) => { calls.push({ name, user: user && user.id, payload }); return { ok: true, eventId: 1 }; } };
}

/**
 * opts: { settings (admin settings via PUT admin/settings), ai (the mock host's opts.ai), services, fetch (Microsoft), fetchImage, gatecontrol,
 *   license, groups, licenseRefresh }
 * fn(host, c): c = { as(user) → (method, path, body, query), admin(method, path, body), mail (FakeMail), tick(), addGmx(user, o) → account,
 *   drive, familie }
 */
async function withMail(opts, fn) {
  const o = opts || {};
  const world = o.world || new FakeMail();
  const drive = o.drive === false ? null : (o.drive || fakeDrive(o.driveOpts));
  const familie = o.familie === false ? null : fakeFamilie();
  const services = [...(drive ? [drive] : []), ...(familie ? [familie] : [])];
  const host = await createHost(DIR, {
    users: USERS, gatecontrol: o.gatecontrol || '1.216.0', mail: world.handler(),
    services, ...(o.ai ? { ai: o.ai } : {}), ...(o.fetch ? { fetch: o.fetch } : {}),
    fetchImage: o.fetchImage || (async () => ({ status: 200, mime: 'image/png', body: Buffer.from('PNGDATA') })),
    // o.license { tier, seats: { included, family, business }, licensed } — the licence's people (seats.js); o.groups: person groups
    license: { required: true, licensed: true, state: 'valid', expiresAt: null, ...(o.license || {}) },
    ...(o.groups ? { groups: o.groups } : {}), ...(o.licenseRefresh ? { licenseRefresh: o.licenseRefresh } : {}),
  });
  // a file Drive hands over: straight into this plugin's media (like gc.media.handOver of the real Drive)
  if (drive) {
    drive.host = { _putFromDrive: (size, nodeId) => {
      const id = require('node:crypto').randomBytes(16).toString('hex');
      host.media.set(id, { mime: 'application/pdf', bytes: size, owner: null, data: Buffer.from(`drive-${nodeId}`), claimed: false, createdAt: Date.now(), name: `Datei-${nodeId}.pdf` });
      return id;
    } };
  }
  await host.start();
  const call = (user, method, p, body, query) => host.request({ method, path: p, body: body === undefined ? null : body, query: query || {}, user, lang: o.lang || 'de' });
  const as = (u) => (method, p, body, query) => call(app(u), method, p, body, query);
  const admin = (method, p, body) => call(ADMIN, method, p, body);
  if (o.settings) { const r = await admin('PUT', 'admin/settings', o.settings); if (r.status !== 200) throw new Error('settings: ' + JSON.stringify(r.json)); }
  const c = {
    as, admin, mail: world, drive, familie, call,
    async tick() { await host.tick(); await settle(); },
    async addGmx(user, extra = {}) {
      const addr = extra.email || `${user.name.toLowerCase()}@gmx.de`;
      if (!world.logins.has(addr)) world.login(addr, 'geheim-123', extra.login || {});
      const r = await as(user)('POST', 'accounts', { provider: 'gmx', email: addr, password: 'geheim-123', name: extra.name || user.name, ...(extra.body || {}) });
      if (r.status !== 200) throw new Error('add: ' + JSON.stringify(r.json));
      await settle();
      return r.json.account;
    },
    async list(user, q) { return (await as(user)('GET', 'messages', null, q || {})).json; },
    db: (sql, params) => host.gc.db.query(sql, params || []).then((r) => r.rows),
  };
  try {
    return await fn(host, c);
  } finally {
    await host.close();
  }
}

/** Let the background work of the plugin (first syncs, IDLE events) finish. */
async function settle(ms2 = 60) {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, ms2 / 4));
}

module.exports = { DIR, ADMIN, ANNA, MARC, BOB, USERS, DAY, FakeMail, fakeDrive, fakeFamilie, withMail, settle, app, hostError };
