'use strict';

// GateControl 1.236.0 for the mock host (tools/testing/mock-host.js): gc.print — "Drucken & Scannen"
// (src/services/homePrint.js, hostApi.js printCall, the child bootstrap's makePrint; docs/plugins.md "Print & scan").
// Opt-in: opts.gatecontrol ≥ '1.236.0' or opts.print; only a plugin with permissions.print: true has gc.print (an
// older GateControl ignores the key — no gc.print; without the permission the host answers ERR_PRINT_DENIED).
//
//   createHost(dir, { print: { devices: [<device view as gc.print.devices() answers>], offline: false } })
//
// Like the host:
//   devices()                       the devices given (a copy)
//   discover({ retrust? })          → { asked: 1 } (state.discovers counts the calls, state.retrusted the ids)
//   submit({ deviceId, mediaId, user, copies?, color?, duplex?, name? })
//                                   the plugin's media (ERR_NOT_FOUND), a printer (ERR_NOT_FOUND), the device online
//                                   (ERR_PRINT_OFFLINE); the type by the content (%PDF-, JPEG, PNG … — GateControl
//                                   1.243.0), else the stored one; PDF when the printer names application/pdf or its
//                                   gateway converts (printer.convert), pictures (image/*) as JPEG or one PDF page,
//                                   anything else ERR_PRINT_FORMAT with e.reason: file_type | damaged | printer |
//                                   gateway_update | convert_off (test hook: device.gatewayConvert 'old' | 'off', else
//                                   'printer'); copies 1 … copiesMax, colour / duplex only where the printer can;
//                                   ≤ 20 open jobs per person (ERR_PRINT_BUSY)
//   testPage({ deviceId, user })    a job "GateControl Testseite" (1 page)
//   job(id) / jobs({ since?, limit?, user? }) / cancel(id)
//   pages({ mediaId })              PDF: the number of "/Type /Page" in the file (≥ 1), a picture: 1
//   scan({ deviceId, user, source?, mode?, resolution?, duplex? }) → { scanId }  (one running scan per person)
//   scanStatus(id) / cancelScan(id)
//   pdf({ pages: [mediaId], user, name, dpi? }) → { mediaId, pages, bytes, name }  (a fake PDF in the plugin's media)
// GateControl 1.246.0 (Restpunkte phase 3c; opt-in: opts.print.ocr / opts.print.office or opts.gatecontrol ≥ 1.246.0):
//   submit/pages also take plain text (stored as text/plain or named .txt → a PDF, pages = lines / 64) and office files
//   (by the stored type: docx, xlsx, pptx, odt, ods, odp, rtf) for a printer with printer.office — else ERR_PRINT_FORMAT
//   with reason office_off | office_missing | gateway_update | printer (test hook: device.gatewayOffice 'off' |
//   'missing' | 'old'); pages of an office file: 1, estimated; submit({ media?, source? }) only what printer.media
//   names (ERR_INVALID); ocrAvailable() → { available, gateways } (opts.print.ocr: { available }), ocr({ pages, user,
//   name, dpi?, deviceId? }) → { ocrId }, ocrStatus(id), cancelOcr(id).
// The gateway's side for tests: host.printJob(id, { state, error, message, pages }) sets a job's state (as a gateway report
// would), host.printScanPages(scanId, [{ mime, data }], { state: 'done' | 'scanning' | 'failed', error }) delivers pages
// (unclaimed media of the person, a `thumb`), host.printOcr(ocrId, { state: 'running' | 'done' | 'failed', page, text,
// error }) — done: a searchable PDF as unclaimed media of the person —, host.print = { jobs: Map, scans: Map, ocr: Map,
// discovers, retrusted, calls }.

const crypto = require('node:crypto');

const OPEN = ['queued', 'sending', 'printing', 'waiting'];
const RESOLUTIONS = [150, 200, 300, 600];
const MODES = ['document', 'photo', 'bw'];
const OFFICE = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet', 'application/vnd.oasis.opendocument.presentation', 'application/rtf',
];

function install({ opts, perms, atLeast, enabledUser, hostError, mediaStore }) {
  const o = opts.print && typeof opts.print === 'object' ? opts.print : null;
  const host = !!o || atLeast(236);
  if (host && perms.print != null && typeof perms.print !== 'boolean') throw hostError('ERR_INVALID', 'plugin.json: permissions.print: invalid');
  const on = host && perms.print === true;
  const state = { devices: ((o && o.devices) || []).map((d) => JSON.parse(JSON.stringify(d))), jobs: new Map(), scans: new Map(), ocr: new Map(), discovers: 0, retrusted: [], calls: [],
    ocrAvailable: !!(o && o.ocr && o.ocr.available !== false) };
  // GateControl 1.246.0: office files, text, paper/tray, the text recognition
  const p3c = !!(o && (o.ocr != null || o.office != null)) || atLeast(246);
  const need = () => { if (perms.print !== true) throw hostError('ERR_PRINT_DENIED', 'this plugin has no print permission'); };
  const iso = (ms) => new Date(ms).toISOString();
  const user = (v) => {
    const uid = Number(v);
    if (!Number.isSafeInteger(uid) || uid <= 0) throw hostError('ERR_INVALID', 'user: a person id');
    if (!enabledUser(uid)) throw hostError('ERR_NOT_FOUND', 'no such person');
    return uid;
  };
  const device = (id, kind) => {
    const d = state.devices.find((x) => x.id === id);
    if (typeof id !== 'string' || !d || !d[kind]) throw hostError('ERR_NOT_FOUND', kind === 'printer' ? 'no such printer' : 'no such scanner');
    if (d.gatewayOnline === false) throw hostError('ERR_PRINT_OFFLINE', 'the gateway of this device is offline');
    return d;
  };
  const media = (id) => {
    const m = typeof id === 'string' ? mediaStore.get(id) : null;
    if (!m) throw hostError('ERR_NOT_FOUND', 'no such media of this plugin');
    if (m.bytes > 50 * 1024 * 1024) throw hostError('ERR_PRINT_TOO_LARGE', 'at most 50 MB');
    return m;
  };
  const pdfPages = (buf) => Math.max(1, (Buffer.from(buf).toString('latin1').match(/\/Type\s*\/Page(?![a-zA-Z])/g) || []).length);
  // the type by the first bytes (GateControl 1.243.0, printPdf.sniff), else the stored type
  const typeOf = (m) => {
    const b = Buffer.from(m.data || '');
    if (b.subarray(0, 1024).indexOf('%PDF-') >= 0) return 'application/pdf';
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
    return m.mime;
  };
  const formatError = (message, reason) => Object.assign(hostError('ERR_PRINT_FORMAT', message), { reason });
  const noPdf = (d) => (d.gatewayConvert === 'old' ? 'gateway_update' : (d.gatewayConvert === 'off' ? 'convert_off' : 'printer'));
  const noOffice = (d) => ({ off: 'office_off', missing: 'office_missing', old: 'gateway_update' }[d.gatewayOffice] || 'printer');
  const isText = (m) => m.mime === 'text/plain' || /\.txt$/i.test(m.name || '');
  const view = (j) => ({ ...j, createdAt: iso(j.createdAt), updatedAt: iso(j.updatedAt), expiresAt: iso(j.expiresAt), doneAt: j.doneAt ? iso(j.doneAt) : null });
  const newMedia = (data, mime, name, owner) => {
    const id = crypto.randomBytes(16).toString('hex');
    mediaStore.set(id, { mime, bytes: data.length, owner, data: Buffer.from(data), claimed: false, createdAt: Date.now(), name });
    return id;
  };

  function enqueue(d, uid, { format, pages, name, copies, color, duplex, media = null, source = null }) {
    const open = [...state.jobs.values()].filter((j) => j.user === uid && OPEN.includes(j.state)).length;
    if (open >= 20) throw hostError('ERR_PRINT_BUSY', 'at most 20 open jobs per person');
    const now = Date.now();
    const j = { id: 'pj_' + crypto.randomBytes(9).toString('base64url'), deviceId: d.id, gatewayId: d.gatewayId || 1, user: uid, name, format, bytes: 1000,
      pages, copies, color, duplex, ...(p3c ? { media, source } : {}), state: 'queued', error: null, message: null, createdAt: now, updatedAt: now, expiresAt: now + 24 * 3600 * 1000, doneAt: null };
    state.jobs.set(j.id, j);
    return view(j);
  }

  function opt(a, p) {
    const max = Math.min(99, p.copiesMax || 99);
    const copies = a.copies == null ? 1 : Number(a.copies);
    if (!Number.isInteger(copies) || copies < 1 || copies > max) throw hostError('ERR_INVALID', `copies: 1 … ${max}`);
    if (a.color != null && typeof a.color !== 'boolean') throw hostError('ERR_INVALID', 'color: true or false');
    if (a.duplex != null && typeof a.duplex !== 'boolean') throw hostError('ERR_INVALID', 'duplex: true or false');
    const out = { copies, color: a.color === true && !!p.color, duplex: a.duplex === true && !!p.duplex };
    if (!p3c) return out;
    const m = p.media || { sizes: [], sources: [] };
    if (a.media != null && !(m.sizes || []).includes(a.media)) throw hostError('ERR_INVALID', 'media: one the printer names');
    if (a.source != null && !(m.sources || []).includes(a.source)) throw hostError('ERR_INVALID', 'source: one the printer names');
    return { ...out, media: a.media == null ? null : a.media, source: a.source == null ? null : a.source };
  }

  function printable(m, d) {
    const p = d.printer;
    const fmts = p.formats || [];
    const takes = (f) => !fmts.length || fmts.includes(f);
    const converts = ['image/pwg-raster', 'image/urf', 'image/jpeg'].includes(p.convert);
    const type = typeOf(m);
    if (p3c && type !== 'application/pdf' && isText(m)) return { format: 'application/pdf', pages: Math.max(1, Math.ceil(String(m.data).split('\n').length / 64)) };
    if (p3c && OFFICE.includes(type)) {
      if (!p.office) throw formatError('office files need „Office-Dateien drucken“ on the gateway of this printer', noOffice(d));
      return { format: type, pages: 1 };
    }
    if (type === 'application/pdf') {
      if (!Buffer.from(m.data || '').subarray(0, 1024).includes('%PDF-')) throw formatError('not a readable PDF file', 'damaged');
      if (!takes('application/pdf') && !converts) throw formatError('this printer takes no PDF and its gateway does not convert it', noPdf(d));
      return { format: 'application/pdf', pages: pdfPages(m.data) };
    }
    if (/^image\//.test(type)) {
      if (takes('image/jpeg')) return { format: 'image/jpeg', pages: 1 };
      if (takes('application/pdf') || converts) return { format: 'application/pdf', pages: 1 };
      throw formatError('this printer takes neither JPEG nor PDF', noPdf(d));
    }
    throw formatError('only PDF files and pictures can be printed', 'file_type');
  }

  const ownJob = (id) => {
    const j = typeof id === 'string' ? state.jobs.get(id) : null;
    if (!j) throw hostError('ERR_NOT_FOUND', 'no such job');
    return j;
  };
  const ownScan = (id) => {
    const s = typeof id === 'string' ? state.scans.get(id) : null;
    if (!s) throw hostError('ERR_NOT_FOUND', 'no such scan');
    return s;
  };

  const api = {
    'print.devices': async () => { need(); state.calls.push({ op: 'devices' }); return state.devices.map((d) => ({ ...d })); },
    'print.discover': async (a) => { need(); state.discovers++; if (a && typeof a.retrust === 'string') state.retrusted.push(a.retrust); return { asked: 1 }; },
    'print.submit': async (a0) => {
      need();
      const a = a0 && typeof a0 === 'object' ? a0 : {};
      state.calls.push({ op: 'submit', args: { ...a } });
      const uid = user(a.user);
      const d = device(a.deviceId, 'printer');
      const o2 = opt(a, d.printer);
      const m = media(a.mediaId);
      const p = printable(m, d);
      return enqueue(d, uid, { ...p, ...o2, name: (typeof a.name === 'string' && a.name.trim()) || m.name || 'GateControl' });
    },
    'print.testPage': async (a0) => {
      need();
      const a = a0 && typeof a0 === 'object' ? a0 : {};
      const uid = user(a.user);
      const d = device(a.deviceId, 'printer');
      return enqueue(d, uid, { format: 'application/pdf', pages: 1, name: 'GateControl Testseite', copies: 1, color: !!d.printer.color, duplex: false });
    },
    'print.job': async ({ id }) => { need(); return view(ownJob(id)); },
    'print.jobs': async (a0) => {
      need();
      const a = a0 && typeof a0 === 'object' ? a0 : {};
      const since = a.since == null ? 0 : (typeof a.since === 'number' ? a.since : Date.parse(a.since));
      if (!Number.isFinite(since)) throw hostError('ERR_INVALID', 'since: a time');
      const limit = a.limit == null ? 100 : a.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw hostError('ERR_INVALID', 'limit: 1 … 500');
      return [...state.jobs.values()].filter((j) => j.updatedAt > since && (a.user == null || j.user === a.user))
        .sort((x, y) => y.updatedAt - x.updatedAt).slice(0, limit).map(view);
    },
    'print.cancel': async ({ id }) => {
      need();
      const j = ownJob(id);
      if (j.state !== 'queued' && j.state !== 'waiting') return { canceled: false, state: j.state };
      Object.assign(j, { state: 'canceled', updatedAt: Date.now(), doneAt: Date.now() });
      return { canceled: true, state: 'canceled' };
    },
    'print.pages': async (a0) => {
      need();
      const m = media(a0 && a0.mediaId);
      const type = typeOf(m);
      if (type === 'application/pdf') return { pages: pdfPages(m.data), format: 'application/pdf' };
      if (/^image\//.test(type)) return { pages: 1, format: type };
      if (p3c && isText(m)) return { pages: Math.max(1, Math.ceil(String(m.data).split('\n').length / 64)), format: 'text/plain' };
      if (p3c && OFFICE.includes(type)) return { pages: 1, format: type, estimated: true };
      throw formatError('only PDF files and pictures can be printed', 'file_type');
    },
    'print.scan': async (a0) => {
      need();
      const a = a0 && typeof a0 === 'object' ? a0 : {};
      state.calls.push({ op: 'scan', args: { ...a } });
      const uid = user(a.user);
      const d = device(a.deviceId, 'scanner');
      const sc = d.scanner;
      const source = a.source == null ? (sc.feeder && sc.adf === 'loaded' ? 'feeder' : (sc.platen ? 'platen' : 'feeder')) : a.source;
      if (!['platen', 'feeder'].includes(source) || (source === 'feeder' && !sc.feeder) || (source === 'platen' && !sc.platen)) throw hostError('ERR_INVALID', 'source');
      const mode = a.mode == null ? 'document' : a.mode;
      if (!MODES.includes(mode)) throw hostError('ERR_INVALID', 'mode: document, photo or bw');
      const resolution = a.resolution == null ? 300 : a.resolution;
      if (!RESOLUTIONS.includes(resolution)) throw hostError('ERR_INVALID', 'resolution');
      if ([...state.scans.values()].some((s) => s.user === uid && s.state === 'scanning')) throw hostError('ERR_PRINT_BUSY', 'a scan of this person is still running');
      const now = Date.now();
      const s = { id: 'ps_' + crypto.randomBytes(9).toString('base64url'), deviceId: d.id, gatewayId: d.gatewayId || 1, user: uid, state: 'scanning', error: null, pages: [], source, mode, resolution, createdAt: iso(now), updatedAt: iso(now) };
      state.scans.set(s.id, s);
      return { scanId: s.id };
    },
    'print.scanStatus': async ({ id }) => { need(); return JSON.parse(JSON.stringify(ownScan(id))); },
    'print.cancelScan': async ({ id }) => {
      need();
      const s = ownScan(id);
      if (s.state !== 'scanning') return { canceled: false, state: s.state };
      s.state = 'canceled';
      return { canceled: true, state: 'canceled' };
    },
    'print.pdf': async (a0) => {
      need();
      const a = a0 && typeof a0 === 'object' ? a0 : {};
      const uid = user(a.user);
      if (!Array.isArray(a.pages) || !a.pages.length || a.pages.length > 100) throw hostError('ERR_INVALID', 'pages: 1 … 100 media ids');
      const parts = a.pages.map((id) => media(id));
      if (parts.some((m) => !/^image\//.test(m.mime))) throw hostError('ERR_PRINT_FORMAT', 'only pictures can become PDF pages');
      let name = (typeof a.name === 'string' && a.name.trim()) || 'Scan.pdf';
      if (!/\.pdf$/i.test(name)) name += '.pdf';
      const body = Buffer.from('%PDF-1.4\n' + parts.map(() => '<< /Type /Page >>').join('\n') + '\n%%EOF');
      const id = newMedia(body, 'application/pdf', name, uid);
      return { mediaId: id, pages: parts.length, bytes: body.length, name };
    },
  };

  const ownOcr = (id) => {
    const x = typeof id === 'string' ? state.ocr.get(id) : null;
    if (!x) throw hostError('ERR_NOT_FOUND', 'no such text recognition');
    return x;
  };
  const ocrView = (x) => ({ id: x.id, user: x.user, gatewayId: 1, state: x.state, page: x.page, pages: x.pageIds.length, error: x.error,
    mediaId: x.state === 'done' ? x.mediaId : null, bytes: x.state === 'done' ? x.bytes : null, text: x.state === 'done' ? x.text : null, name: x.name });
  if (p3c) {
    Object.assign(api, {
      'print.ocrAvailable': async () => { need(); return { available: state.ocrAvailable, gateways: state.ocrAvailable ? 1 : 0 }; },
      'print.ocr': async (a0) => {
        need();
        const a = a0 && typeof a0 === 'object' ? a0 : {};
        state.calls.push({ op: 'ocr', args: { ...a } });
        const uid = user(a.user);
        if (!Array.isArray(a.pages) || !a.pages.length || a.pages.length > 100) throw hostError('ERR_INVALID', 'pages: 1 … 100 media ids');
        for (const id of a.pages) if (!['image/jpeg', 'image/png'].includes(media(id).mime)) throw hostError('ERR_PRINT_FORMAT', 'text recognition reads JPEG and PNG pages');
        if (!state.ocrAvailable) throw hostError('ERR_PRINT_OCR_UNAVAILABLE', 'no gateway with „Texterkennung“ is online');
        let name = (typeof a.name === 'string' && a.name.trim()) || 'Scan.pdf';
        if (!/\.pdf$/i.test(name)) name += '.pdf';
        const x = { id: 'po_' + crypto.randomBytes(9).toString('base64url'), user: uid, pageIds: a.pages.slice(), dpi: a.dpi || 300, name, state: 'queued', page: 0, error: null, mediaId: null, bytes: null, text: null };
        state.ocr.set(x.id, x);
        return { ocrId: x.id };
      },
      'print.ocrStatus': async ({ id }) => { need(); return ocrView(ownOcr(id)); },
      'print.cancelOcr': async ({ id }) => {
        need();
        const x = ownOcr(id);
        if (x.state !== 'queued' && x.state !== 'running') return { canceled: false, state: x.state };
        x.state = 'canceled';
        return { canceled: true, state: 'canceled' };
      },
    });
  }

  const gcPart = (call) => Object.freeze({
    devices: () => call('print.devices', {}),
    discover: (x) => call('print.discover', x && typeof x === 'object' ? x : {}),
    submit: (x) => call('print.submit', x && typeof x === 'object' ? x : {}),
    testPage: (x) => call('print.testPage', x && typeof x === 'object' ? x : {}),
    job: (id) => call('print.job', { id }),
    jobs: (x) => call('print.jobs', x && typeof x === 'object' ? x : {}),
    cancel: (id) => call('print.cancel', { id }),
    pages: (x) => call('print.pages', x && typeof x === 'object' ? x : {}),
    scan: (x) => call('print.scan', x && typeof x === 'object' ? x : {}),
    scanStatus: (id) => call('print.scanStatus', { id }),
    cancelScan: (id) => call('print.cancelScan', { id }),
    pdf: (x) => call('print.pdf', x && typeof x === 'object' ? x : {}),
    ...(p3c ? {
      ocrAvailable: () => call('print.ocrAvailable', {}),
      ocr: (x) => call('print.ocr', x && typeof x === 'object' ? x : {}),
      ocrStatus: (id) => call('print.ocrStatus', { id }),
      cancelOcr: (id) => call('print.cancelOcr', { id }),
    } : {}),
  });

  /** a gateway's report: the job's new state */
  function setJob(id, x) {
    const j = state.jobs.get(id);
    if (!j) throw new Error('mock host: no such print job ' + id);
    Object.assign(j, { state: x.state || j.state, error: x.error === undefined ? j.error : x.error, message: x.message === undefined ? j.message : x.message, updatedAt: Date.now() });
    if (Number.isInteger(x.pages)) j.pages = x.pages;
    if (['done', 'failed', 'expired', 'canceled'].includes(j.state)) j.doneAt = Date.now();
    return view(j);
  }
  /** the gateway's scanned pages → media of the person, a thumb each; the state afterwards */
  function scanPages(id, pages, x = {}) {
    const s = state.scans.get(id);
    if (!s) throw new Error('mock host: no such scan ' + id);
    for (const p of pages || []) {
      const data = Buffer.from(p.data || 'jpeg');
      const mime = p.mime || 'image/jpeg';
      const n = s.pages.length + 1;
      s.pages.push({ n, mediaId: newMedia(data, mime, `Scan ${n}.jpg`, s.user), mime, bytes: data.length, thumb: Buffer.from('thumb').toString('base64') });
    }
    s.state = x.state || 'done';
    s.error = x.error || null;
    s.updatedAt = iso(Date.now());
    return JSON.parse(JSON.stringify(s));
  }

  /** the gateway's text recognition: running (page), done (a PDF as media of the person, the text) or failed */
  function setOcr(id, x = {}) {
    const r = state.ocr.get(id);
    if (!r) throw new Error('mock host: no such text recognition ' + id);
    r.state = x.state || 'done';
    r.page = Number.isInteger(x.page) ? x.page : (r.state === 'done' ? r.pageIds.length : r.page);
    r.error = r.state === 'failed' ? (x.error || 'ocr_failed') : null;
    if (r.state === 'done') {
      const body = Buffer.from('%PDF-1.4\n' + r.pageIds.map(() => '<< /Type /Page >>').join('\n') + '\n%% searchable\n%%EOF');
      r.mediaId = newMedia(body, 'application/pdf', r.name, r.user);
      r.bytes = body.length;
      r.text = typeof x.text === 'string' ? x.text : '';
    }
    return ocrView(r);
  }

  return { on, api, gcPart, state, setJob, scanPages, setOcr };
}

module.exports = { install };
