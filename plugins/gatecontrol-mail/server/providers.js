'use strict';

// The providers people pick when they add an account (GET providers, POST accounts/discover): their servers, how they
// sign in and what they must do first (IMAP allowed in the webmail, an app password, …), and the size limit of a mail.

const { email } = require('./util');

const T = {
  gmx: { de: 'Erlaube zuerst im GMX-Webmail unter Einstellungen › POP3/IMAP-Abruf den Zugriff per IMAP.', en: 'First allow IMAP access in GMX webmail under Settings › POP3/IMAP.' },
  webde: { de: 'Erlaube zuerst im WEB.DE-Webmail unter Einstellungen › POP3/IMAP-Abruf den Zugriff per IMAP.', en: 'First allow IMAP access in WEB.DE webmail under Settings › POP3/IMAP.' },
  tonline: { de: 'Nimm das E-Mail-Passwort aus dem Telekom-Kundencenter, nicht das Passwort deines Telekom-Logins.', en: 'Use the e-mail password from the Telekom customer centre, not the password of your Telekom login.' },
  gmail: { de: 'Gmail braucht ein App-Passwort: Bestätigung in zwei Schritten einschalten, dann unter myaccount.google.com › Sicherheit › App-Passwörter eins erstellen.', en: 'Gmail needs an app password: turn on 2-step verification, then create one under myaccount.google.com › Security › App passwords.' },
  microsoft: { de: 'Du meldest dich bei Microsoft an – GateControl sieht dein Passwort nie.', en: 'You sign in at Microsoft – GateControl never sees your password.' },
};

const LIST = [
  { id: 'gmx', label: 'GMX', auth: 'password', hint: T.gmx, help: 'https://hilfe.gmx.net/pop-imap/einschalten.html',
    imap: { host: 'imap.gmx.net', port: 993, security: 'tls' }, smtp: { host: 'mail.gmx.net', port: 465, security: 'tls' }, maxBytes: 20 * 1024 * 1024 },
  { id: 'webde', label: 'WEB.DE', auth: 'password', hint: T.webde, help: 'https://hilfe.web.de/pop-imap/einschalten.html',
    imap: { host: 'imap.web.de', port: 993, security: 'tls' }, smtp: { host: 'smtp.web.de', port: 587, security: 'starttls' }, maxBytes: 20 * 1024 * 1024 },
  { id: 'tonline', label: 'T-Online', auth: 'password', hint: T.tonline, help: 'https://www.telekom.de/hilfe/apps-dienste/e-mail/einrichtung',
    imap: { host: 'secureimap.t-online.de', port: 993, security: 'tls' }, smtp: { host: 'securesmtp.t-online.de', port: 465, security: 'tls' }, maxBytes: 25 * 1024 * 1024 },
  { id: 'gmail', label: 'Gmail', auth: 'app_password', hint: T.gmail, help: 'https://support.google.com/accounts/answer/185833',
    imap: { host: 'imap.gmail.com', port: 993, security: 'tls' }, smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls' }, maxBytes: 25 * 1024 * 1024 },
  { id: 'outlook', label: 'Outlook.com', auth: 'microsoft', hint: T.microsoft, help: null, maxBytes: 25 * 1024 * 1024 },
  { id: 'm365', label: 'Microsoft 365', auth: 'microsoft', hint: T.microsoft, help: null, maxBytes: 25 * 1024 * 1024 },
  { id: 'imap', label: { de: 'Anderes Konto (IMAP)', en: 'Other account (IMAP)' }, auth: 'imap', hint: null, help: null, maxBytes: 25 * 1024 * 1024 },
];
const BY_ID = new Map(LIST.map((p) => [p.id, p]));

// domains of the well-known providers
const DOMAINS = {
  gmx: ['gmx.de', 'gmx.net', 'gmx.at', 'gmx.ch', 'gmx.com', 'gmx.eu'],
  webde: ['web.de'],
  tonline: ['t-online.de', 'magenta.de'],
  gmail: ['gmail.com', 'googlemail.com'],
  outlook: ['outlook.com', 'outlook.de', 'hotmail.com', 'hotmail.de', 'live.com', 'live.de', 'msn.com'],
};

const get = (id) => BY_ID.get(id) || null;
const isMicrosoft = (id) => id === 'outlook' || id === 'm365';

/** GET providers → [{ id, label, auth, hint, help }] in the viewer's language for the label. */
function list(lang) {
  return LIST.map((p) => ({ id: p.id, label: typeof p.label === 'string' ? p.label : p.label[lang === 'en' ? 'en' : 'de'], auth: p.auth, hint: p.hint, help: p.help }));
}

const PORT_SEC = { imap: { 993: 'tls', 143: 'starttls' }, smtp: { 465: 'tls', 587: 'starttls' } };

/** A server { host, port, security } of `kind` (imap | smtp) → checked copy, or null. */
function server(kind, v) {
  if (!v || typeof v !== 'object') return null;
  const host = typeof v.host === 'string' ? v.host.trim().toLowerCase() : '';
  const port = Number(v.port);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/.test(host) || host.length > 253) return null;
  const sec = PORT_SEC[kind][port];
  if (!sec || (v.security != null && v.security !== sec)) return null;
  return { host, port, security: sec };
}

/** The provider an address belongs to by its domain, or null. */
function byDomain(addr) {
  const d = String(addr || '').split('@')[1] || '';
  for (const [id, list] of Object.entries(DOMAINS)) if (list.includes(d)) return id;
  return null;
}

/** POST accounts/discover { email } → { provider, auth, imap, smtp, hint }. */
async function discover(gc, body) {
  const addr = email(body && body.email);
  if (!addr) { const e = new Error('invalid'); e.code = 'invalid'; e.extra = { field: 'email' }; throw e; }
  const known = byDomain(addr);
  if (known) {
    const p = get(known);
    return { provider: p.id, auth: p.auth, imap: p.imap || null, smtp: p.smtp || null, hint: p.hint };
  }
  let ac = null;
  if (gc.mail && typeof gc.mail.autoconfig === 'function') {
    try { ac = await gc.mail.autoconfig(addr); } catch { ac = null; }
  }
  const imap = ac ? server('imap', ac.imap) : null;
  const smtp = ac ? server('smtp', ac.smtp) : null;
  // a company domain on Microsoft 365
  if (imap && /(^|\.)outlook\.office365\.com$|(^|\.)office365\.com$/.test(imap.host)) {
    const p = get('m365');
    return { provider: 'm365', auth: 'microsoft', imap: null, smtp: null, hint: p.hint };
  }
  return { provider: 'imap', auth: 'imap', imap, smtp, hint: null };
}

/** The largest mail the provider takes (bytes). */
const maxBytes = (id) => (get(id) || BY_ID.get('imap')).maxBytes;

module.exports = { LIST, get, list, discover, server, byDomain, isMicrosoft, maxBytes };
