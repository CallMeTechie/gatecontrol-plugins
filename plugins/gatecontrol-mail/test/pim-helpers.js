'use strict';

// Test doubles for calendars and contacts (Mail 1.2.0): a CalDAV/CardDAV server behind the mock host's gc.mail.dav
// (GateControl 1.219.0 — it answers with the parsed Multi-Status the host's reader gives), Microsoft Graph's calendars
// and contacts (through opts.fetch, with the token endpoint and its granted scopes), Familie's calendar_range and
// Alltag's calendar_list / calendar_query as services. No network anywhere.

const crypto = require('node:crypto');

const D = 'DAV:';
const C = 'urn:ietf:params:xml:ns:caldav';
const A = 'urn:ietf:params:xml:ns:carddav';
const CS = 'http://calendarserver.org/ns/';
const IC = 'http://apple.com/ns/ical/';
const n = (ns, local) => `{${ns}}${local}`;
const node = (text, children) => ({ text: text == null ? null : String(text), ...(children ? { children } : {}) });
const kid = (ns, local, text, attrs) => ({ name: n(ns, local), text: text == null ? null : String(text), ...(attrs ? { attrs } : {}) });
const hrefNode = (h) => node(null, [kid(D, 'href', h)]);
const etagOf = () => `"${crypto.randomBytes(4).toString('hex')}"`;

/**
 * A CalDAV and CardDAV server for one or more logins: ics: new FakeDav({ origin: 'https://caldav.gmx.net', user, pass })
 * .calendar('privat', { name, color }) …; handler() is opts.mail.dav of the mock host.
 */
class FakeDav {
  constructor(o = {}) {
    this.origins = new Set(o.origins || ['https://caldav.gmx.net', 'https://carddav.gmx.net']);
    this.user = o.user || 'anna@gmx.de';
    this.pass = o.pass || 'geheim-123';
    this.autoSchedule = !!o.autoSchedule;
    this.syncTokens = o.syncTokens !== false;
    this.cols = new Map(); // path → { kind, name, color, token, ctag, objects: Map path → { data, etag }, log: [{ token, path, gone }] }
    this.requests = [];
    this.fail = null; // (req) → status | null
  }

  get home() { return `/dav/${this.user}/`; }

  calendar(id, o = {}) { const p = `${this.home}cal-${id}/`; this.cols.set(p, { kind: 'cal', name: o.name || id, color: o.color || null, token: 1, ctag: 1, objects: new Map(), log: [], readOnly: !!o.readOnly }); return p; }

  book(id, o = {}) { const p = `${this.home}book-${id}/`; this.cols.set(p, { kind: 'book', name: o.name || id, version: o.version || '3.0', token: 1, ctag: 1, objects: new Map(), log: [] }); return p; }

  /** Put an object as another client would (the next sync sees it). */
  put(col, name, data) {
    const c = this.cols.get(col);
    const p = `${col}${name}`;
    const etag = etagOf();
    c.objects.set(p, { data, etag });
    c.token++; c.ctag++;
    c.log.push({ token: c.token, path: p, gone: false });
    return { href: p, etag };
  }

  remove(col, p) {
    const c = this.cols.get(col);
    c.objects.delete(p);
    c.token++; c.ctag++;
    c.log.push({ token: c.token, path: p, gone: true });
  }

  colOf(path) { return [...this.cols.entries()].find(([p]) => path.startsWith(p)) || null; }

  handler() {
    return async (req) => {
      this.requests.push({ method: req.method, url: req.url, headers: req.headers, body: req.body });
      const u = new URL(req.url);
      if (!this.origins.has(u.origin)) return { status: 404 };
      if (this.fail) { const st = this.fail(req); if (st) return { status: st }; }
      if (!req.auth || req.auth.user !== this.user || req.auth.pass !== this.pass) return { status: 401 };
      const path = decodeURIComponent(u.pathname);
      const m = req.method;
      const depth = req.headers.depth;
      const body = req.body || '';
      if (m === 'OPTIONS') return { status: 200, headers: { dav: `1, 2, 3, calendar-access, addressbook${this.autoSchedule ? ', calendar-auto-schedule' : ''}` } };
      if (m === 'PROPFIND' && (path === '/.well-known/caldav' || path === '/.well-known/carddav')) return { status: 301, headers: { location: '/dav/' } };
      if (m === 'PROPFIND' && path === '/dav/') {
        return { status: 207, multistatus: { responses: [{ href: '/dav/', status: null, propstat: [{ status: 200, props: { [n(D, 'current-user-principal')]: hrefNode(`/principals/${this.user}/`) } }] }] } };
      }
      if (m === 'PROPFIND' && path.startsWith('/principals/')) {
        return { status: 207, multistatus: { responses: [{ href: u.pathname, status: null, propstat: [{ status: 200, props: {
          [n(C, 'calendar-home-set')]: hrefNode(this.home), [n(A, 'addressbook-home-set')]: hrefNode(this.home) } }] }] } };
      }
      if (m === 'PROPFIND' && path === this.home && depth === '1') {
        const wantCal = /calendar-color|supported-calendar-component-set/.test(body);
        const responses = [{ href: this.home, status: null, propstat: [{ status: 200, props: { [n(D, 'resourcetype')]: node(null, [kid(D, 'collection')]) } }] }];
        for (const [p, c] of this.cols) {
          if ((c.kind === 'cal') !== wantCal) continue;
          const props = {
            [n(D, 'displayname')]: node(c.name), [n(D, 'resourcetype')]: node(null, [kid(D, 'collection'), c.kind === 'cal' ? kid(C, 'calendar') : kid(A, 'addressbook')]),
            [n(CS, 'getctag')]: node(String(c.ctag)), ...(this.syncTokens ? { [n(D, 'sync-token')]: node(`tok-${c.token}`) } : {}),
            [n(D, 'current-user-privilege-set')]: node(null, [kid(D, 'privilege', null), ...(c.readOnly ? [] : [{ name: n(D, 'privilege'), text: null, children: [kid(D, 'write')] }])]),
          };
          if (c.kind === 'cal') {
            props[n(C, 'supported-calendar-component-set')] = node(null, [kid(C, 'comp', null, { name: 'VEVENT' })]);
            if (c.color) props[n(IC, 'calendar-color')] = node(`${c.color}FF`);
          } else props[n(A, 'supported-address-data')] = node(null, [kid(A, 'address-data-type', null, { 'content-type': 'text/vcard', version: c.version })]);
          responses.push({ href: p, status: null, propstat: [{ status: 200, props }] });
        }
        return { status: 207, multistatus: { responses } };
      }
      if (m === 'PROPFIND' && path === this.home) {
        return { status: 207, multistatus: { responses: [{ href: this.home, status: null, propstat: [{ status: 200, props: {
          [n(C, 'calendar-home-set')]: hrefNode(this.home), [n(A, 'addressbook-home-set')]: hrefNode(this.home) } }] }] } };
      }
      const hit = this.colOf(path);
      if (!hit) return { status: 404 };
      const [colPath, col] = hit;
      if (path === colPath) {
        if (m === 'PROPFIND' && depth === '0') {
          return { status: 207, multistatus: { responses: [{ href: colPath, status: null, propstat: [{ status: 200, props: {
            [n(CS, 'getctag')]: node(String(col.ctag)), ...(this.syncTokens ? { [n(D, 'sync-token')]: node(`tok-${col.token}`) } : {}) } }] }] } };
        }
        if (m === 'REPORT' && /sync-collection/.test(body)) {
          if (!this.syncTokens) return { status: 403 };
          const tm = /<d:sync-token>([^<]*)<\/d:sync-token>/.exec(body);
          const from = tm && tm[1] ? Number(String(tm[1]).replace('tok-', '')) : 0;
          if (!Number.isFinite(from) || from > col.token || (col.minToken && from < col.minToken)) return { status: 403 };
          const changed = new Map();
          for (const e of col.log) if (e.token > from) changed.set(e.path, e.gone);
          const responses = [];
          for (const [p, gone] of changed) {
            if (gone || !col.objects.has(p)) responses.push({ href: p, status: 404, propstat: [] });
            else responses.push({ href: p, status: null, propstat: [{ status: 200, props: { [n(D, 'getetag')]: node(col.objects.get(p).etag) } }] });
          }
          return { status: 207, multistatus: { responses, syncToken: `tok-${col.token}` } };
        }
        if ((m === 'REPORT' && /calendar-query/.test(body)) || (m === 'PROPFIND' && depth === '1')) {
          const responses = [{ href: colPath, status: null, propstat: [{ status: 200, props: { [n(D, 'resourcetype')]: node(null, [kid(D, 'collection')]) } }] }];
          for (const [p, o] of col.objects) responses.push({ href: p, status: null, propstat: [{ status: 200, props: { [n(D, 'getetag')]: node(o.etag), [n(D, 'resourcetype')]: node(null) } }] });
          return { status: 207, multistatus: { responses } };
        }
        if (m === 'REPORT' && /multiget/.test(body)) {
          const hrefs = [...body.matchAll(/<d:href>([^<]*)<\/d:href>/g)].map((x) => decodeURIComponent(x[1].replace(/&amp;/g, '&')));
          const dataName = col.kind === 'cal' ? n(C, 'calendar-data') : n(A, 'address-data');
          const responses = hrefs.map((h) => {
            const o = col.objects.get(h);
            if (!o) return { href: h, status: 404, propstat: [] };
            // the host's reader turns CRLF into LF in the text (GateControl 1.219.0)
            return { href: h, status: null, propstat: [{ status: 200, props: { [n(D, 'getetag')]: node(o.etag), [dataName]: node(o.data.replace(/\r\n/g, '\n')) } }] };
          });
          return { status: 207, multistatus: { responses } };
        }
        return { status: 405 };
      }
      // an object
      const o = col.objects.get(path);
      if (m === 'GET') return o ? { status: 200, headers: { etag: o.etag, 'content-type': col.kind === 'cal' ? 'text/calendar' : 'text/vcard' }, body: o.data } : { status: 404 };
      if (m === 'PUT') {
        if (col.readOnly) return { status: 403 };
        if (req.headers['if-none-match'] === '*' && o) return { status: 412 };
        if (req.headers['if-match'] && (!o || o.etag !== req.headers['if-match'])) return { status: 412 };
        const etag = etagOf();
        col.objects.set(path, { data: req.body, etag });
        col.token++; col.ctag++;
        col.log.push({ token: col.token, path, gone: false });
        return { status: o ? 204 : 201, headers: { etag } };
      }
      if (m === 'DELETE') {
        if (!o) return { status: 404 };
        if (req.headers['if-match'] && o.etag !== req.headers['if-match']) return { status: 412 };
        this.remove(colPath, path);
        return { status: 204 };
      }
      return { status: 405 };
    };
  }
}

/** A VEVENT calendar object. */
function vevent(uid, lines, o = {}) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//Test//EN', ...(o.method ? [`METHOD:${o.method}`] : []), 'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20261001T080000Z',
    ...lines, 'END:VEVENT', ...(o.more || []), 'END:VCALENDAR', ''].join('\r\n');
}

/** A vCard 3.0. */
function vcf(uid, lines) {
  return ['BEGIN:VCARD', 'VERSION:3.0', `UID:${uid}`, ...lines, 'END:VCARD', ''].join('\r\n');
}

/** UTC iCalendar time of ms. */
const utc = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Familie and Alltag as services (provides calendar_range / calendar_list / calendar_query). */
function fakeOverlays(o = {}) {
  const familie = {
    plugin: 'gatecontrol-familie', calls: [], provides: ['calendar_add', 'calendar_range'],
    service: async ({ name, user, payload }) => {
      familie.calls.push({ name, user: user && user.id, payload });
      if (name === 'calendar_add') return { ok: true, eventId: 1 };
      if (!user) return { ok: false, code: 'forbidden' };
      const all = (o.familie || []).filter((e) => e.date >= payload.from && e.date <= payload.to);
      const start = payload.cursor ? Number(payload.cursor) : 0;
      return { ok: true, tz: 'Europe/Berlin', events: all.slice(start, start + 2), next: start + 2 < all.length ? String(start + 2) : null };
    },
  };
  const alltag = {
    plugin: 'gatecontrol-alltag', calls: [], provides: ['calendar_list', 'calendar_query'],
    service: async ({ name, user, payload }) => {
      alltag.calls.push({ name, user: user && user.id, payload });
      const subs = o.alltagSubs || [{ id: 7, name: 'Müllabfuhr' }];
      if (name === 'calendar_list') return { ok: true, subscriptions: subs };
      const evs = (o.alltag || []).filter((e) => e.date >= payload.from && e.date <= payload.to);
      return { ok: true, events: evs, subscriptions: subs, next: null };
    },
  };
  return { familie, alltag };
}

module.exports = { FakeDav, vevent, vcf, utc, fakeOverlays, n, node, kid, hrefNode, D, C, A, CS };
