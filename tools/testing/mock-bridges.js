'use strict';

// gc.bridges for the mock host (tools/testing/mock-host.js): the messenger bridges of GateControl
// (src/services/bridges, hostApi.js bridgesCall, the child bootstrap's makeBridges; docs/plugins.md "Messenger
// bridges", docs/feature-messenger-bridges.md). A PREVIEW in GateControl — no released version has it yet, so it is
// opt-in only: opts.bridges; only a plugin with permissions.bridges: true has gc.bridges then (an older GateControl
// ignores the key).
//
//   createHost(dir, { bridges: true })                         preview on, bridges off (the default of a server)
//   createHost(dir, { bridges: { preview: false } })           gc.bridges exists, status() → { available: false, reason: 'preview_off' }
//   createHost(dir, { bridges: { enabled: true, networks: { whatsapp: true }, running: true } })
//
// It stands in for the server AND for the bridge behind it (no WhatsApp, no Matrix): the "phone" is the test.
//   host.bridges.confirm(processId)          the person confirmed the code / scanned the QR code on the phone
//   host.bridges.expire(processId)           the code ran out
//   host.bridges.logOut(userId, loginId)     the service dropped the linked device (state logged_out)
//   host.bridges.setHost({ state, error, running, memMb })   what update.sh reported
//   host.bridges.setHost({ bridgeDown: true })   reported as running, but the bridge itself does not answer
//   host.bridges.oddStep = 'webauthn'        the next login starts with a step GateControl does not offer
//   host.bridges.setHost({ outdated: true })     the bridge runs an older image than GateControl pins (networks[].outdated)
//   host.bridges.setHost({ probe: {…} })         what `update.sh bridges-probe` measured (status().host.probe)
//   host.bridges.acting(userId, fn)          run fn while that person has a changing request to ANOTHER plugin in
//                                            flight (the Familie page calling this plugin's service) — unlinkFor
//   createHost(dir, { bridges: { …, version: 1 } })   a GateControl whose gc.bridges has no unlinkFor yet (1.273.x)
//   host.bridges.state                       { enabled, networks, logins: Map userId → [...], processes: Map, log: [{ op, … }] }
//
// Version 3 (GateControl with stage 3 — messages; createHost(dir, { bridges: { …, version: 3 } })):
//   await host.bridges.deliver([event, …])   the bridges delivered neutral events ({ userId, network?, type, chat, … } as
//                                            services/bridges/events.js makes them): into the inbox, then the hook bridgeEvents
//   await host.bridges.ephemeral([event, …]) typing / read receipts: only in the hook's payload, never in the inbox
//   host.bridges.chat(userId, { kind?, name? }) → the reference of a new chat of that person (what send() accepts)
//   host.bridges.sent                        what the plugin sent out: [{ op: 'send' | 'react' | 'redact' | 'read' | 'typing', userId, network, chatId, … , id? }]
//   host.bridges.failSend = { code, reason } the next send / react / redact is refused that way (once)
//   host.bridges.failFetch = { code, reason, times? } media.fetch is refused that way (`times` calls, default every one;
//                                            null: fetched again) — the host's refusals a plugin cannot tell from the name
//   host.bridges.state.inbox                 what was delivered and not acknowledged
//
// Version 4 (GateControl with stage 4 — files, pictures, a new chat by number; createHost(dir, { bridges: { …, version: 4 } })):
//   host.bridges.file(userId, { data, mime, name? }) → a reference (`m…`) as an event carries it (media.ref,
//                                            chat.avatar, contact.avatar); gc.bridges.media.fetch stores it into the
//                                            plugin's media like GateControl: maxBytes first, the type (any other file
//                                            that is no picture, sound or video → application/octet-stream when declared),
//                                            the quota, the virus scan (opts.scan) — answer { mediaId, mime, bytes, name, scan? }
//   host.bridges.gone(ref)                   the homeserver lost the file (ERR_BRIDGE m_not_found)
//   host.bridges.fetches                     every media.fetch: [{ userId, network, ref }]
//   host.bridges.numbers                     Map '+49…' → { name } — who is at the service (resolve / createDm)
//   sent rows of a file: { op: 'send', …, media: { mediaId, kind, … }, mime, bytes } — only a file of the plugin the
//   scan lets be served (ERR_MEDIA_SCAN_PENDING / ERR_MEDIA_QUARANTINED / ERR_MEDIA_BLOCKED, ERR_NOT_FOUND)
//   resolve / createDm: a changing request of that person, a link (else ERR_BRIDGE bridge_error), + and the country
//   code (ERR_INVALID invalid_number), 20 per person and hour (ERR_RATE_LIMIT with retryAfterS); logged as
//   { op: 'resolve' | 'create_dm', userId } — never the number
// Version 5 (GateControl with stage 5 — history, health, snapshot, clean-up; createHost(dir, { bridges: { …, version: 5 } })):
//   await host.bridges.deliverHistory([event, …])  older messages the people wanted (GateControl's bridge_backlog):
//                                            gc.bridges.history.pull / ack (no person needed); `history: true` on each
//   host.bridges.backlog                     what of it was not acknowledged
//   host.bridges.setHistory(false)           an administrator forbade older messages (status().history.enabled)
//   host.bridges.phoneOffline(userId, loginId, sinceIso | null)   the bridge's warning "phone not seen for 12 days"
//                                            (logins / health: phoneOffline, since; state stays connected)
//   host.bridges.clientOutdated(userId, loginId, on)   WhatsApp turned the bridge's version away (clientOutdated)
//   history.get / set: inside a request (set: a changing one) of that person; days 0 | 30 | -1 (default 30)
//   health({ userIds, network }): no person needed, ≤ 100 people; status() also carries backup and cleanup;
//   configure() takes history, backupNow, backupTime
// Version 6 (GateControl with stage 4c — a new chat with a contact; createHost(dir, { bridges: { …, version: 6 } })):
//   host.bridges.contacts = [{ number, name, avatar?, chatId?, contactId? }]   the person's contacts at the bridge (all
//                                            people the same; `avatar` a picture reference like contact.avatar, `chatId`
//                                            the chat reference of a chat that exists, `contactId` the sender.id the
//                                            events name the contact by — made up from the number when missing). Like the host: contacts / matchNumbers a
//                                            request of that person, a link (else ERR_BRIDGE refused); createDmByRef a
//                                            changing request, the person's own reference of the last 30 minutes (else
//                                            ERR_INVALID expired_ref), nothing counted; logged as { op: 'contacts' |
//                                            'match' | 'create_dm_ref', userId } — never a number
//   host.bridges.expireRefs()                every reference handed out runs out (as after 30 minutes or a restart)
// Version 7 (GateControl with channels, groups, format; createHost(dir, { bridges: { …, version: 7 } })): no new call —
//   events carry chat.channel / chat.readOnly, sender { channel: true, system: true }, marks and preview (the test writes
//   them into deliver()); host.bridges.chat(userId, { channel, readOnly }); chats() names channel and readOnly.
// Version 8 (GateControl with the user profile; createHost(dir, { bridges: { …, version: 8 } })):
//   host.bridges.accounts = [{ contactId, userId, strength, via, viewer? }]   which contacts at the bridge (sender.id of
//                                            the events) are accounts — what the server's profile service would compare;
//                                            matchAccounts: a request of that person, a link; never the person herself,
//                                            never a disabled account; logged as { op: 'match_accounts', userId }
// Version 9 (chats v2, persons; createHost(dir, { bridges: { …, version: 9 } })): recognition.get(userId) → { asked,
//   allowed, linked } (a request of that person), recognition.set(userId, allowed) (a changing one; whatsapp only) —
//   host.bridges.recognition(userId) → { asked, allowed }
// Version 10 (Signal, stage 7a; createHost(dir, { bridges: { …, version: 10, networks: { whatsapp, signal } } })): the
//   network 'signal' (QR code only — login.start refuses 'phone'; the code sgnl://linkdevice?…, a login named by its
//   number), status().networks[] with flows, history { maxDays, phoneConfirms }, needs, scriptNeeded;
//   status().stickers { animated } and configure({ animatedStickers }); recognition.get / set per network (whatsapp,
//   signal, telegram) — host.bridges.recognition(userId, network); host.bridges.setNeeds(network, 'compose' | 'script' | null)
// Version 11 (Telegram, stage 7b; createHost(dir, { bridges: { …, version: 11, networks: { whatsapp, signal, telegram } } })):
//   the network 'telegram' (QR code or number → code → password, as mautrix-telegram: a wrong code or password comes back
//   as the same kind of step with retry: true; host.bridges.tgPassword = '…' turns the two-step verification on, the
//   code is '47000'); status().telegramApp { set, setAt, setBy } and configure({ telegramApp: { apiId, apiHash } | null })
//   — without it Telegram's needs is 'app' and every call for a person answers ERR_BRIDGES_UNAVAILABLE / no_app;
//   host.bridges.tgApps lists what configure was given (the test checks it went nowhere else)
// Version 12 (WhatsApp status; createHost(dir, { bridges: { …, version: 12 } })): host.bridges.chat(userId, { status: true })
//   makes the room of the contacts' status updates (kind 'group', readOnly); send / react / redact there answer
//   ERR_BRIDGE / status_room, read there sends nothing without { status: true } ({ ok: true, skipped: 'status' }) —
//   host.bridges.sent shows the reads that went out, with status: true; chats() names status.
// Version 13 (old media from the phone; createHost(dir, { bridges: { …, version: 13 } })): status().mediaRequests
//   { mode, options, dailyAt, timeZone } and configure({ mediaRequests: 'off' | 'daily' | 'now' }) —
//   host.bridges.mediaRequests is the mode. Events with message.oldMedia / edit.media / edit.oldMedia are delivered as
//   the test writes them (host.bridges.deliver).
// Version 14 (a location over the bridge; createHost(dir, { bridges: { …, version: 14 } })): status().networks[].location
//   (whatsapp, telegram: true; signal: false) and send(…, { txnId, location: { lat, lon, label? }, replyTo? }) — m.location
//   at the bridge; to a network without location ERR_INVALID / unsupported; with text, media or edit ERR_INVALID. Sent rows: { op: 'send', …, text: null,
//   location: { lat, lon, label }, replyTo }.
// events.pull / events.ack need no person; chats() a request of that person; send / react / redact / read / typing a
// changing request of that person, their own chat (else ERR_INVALID 'unknown chat'), a bridge that runs.
//
// Like the host: status() anywhere; configure() only inside a changing request of an administrator (ERR_NOT_PERSON /
// ERR_NOT_ADMIN); everything with a userId only while a request of THAT person is in flight (flows / logins: any
// request, the rest a changing one) — else ERR_NOT_PERSON. A bridge that is off → ERR_BRIDGES_UNAVAILABLE (reason
// 'off' / 'preview_off'), one that does not run → ERR_BRIDGE_UNREACHABLE ('not_running'); a refusal of the bridge →
// ERR_BRIDGE with a reason ('not_found', 'm_bad_json', 'fi_mau_whatsapp_login_timeout', 'unsupported_step').
// unlinkFor(userId, network, actor) (version 2): the one call for somebody else — it only ends links; `actor` must be
// another person with a changing request in flight right now (here or, with acting(), elsewhere), the target is
// never an administrator (ERR_BRIDGES_DENIED); logged as { op: 'unlink_for', userId, by, network, logins }.

const NETWORKS = ['whatsapp'];
const ID_RE = /^[A-Za-z0-9._:=+-]{1,128}$/;
const FLOWS = [
  { id: 'qr', name: 'QR', description: 'Scan a QR code from the app' },
  { id: 'phone', name: 'Pairing code', description: 'Enter a pairing code in the app' },
];

const NET_FACTS = {
  whatsapp: { flows: ['phone', 'qr'], history: { maxDays: null, phoneConfirms: false }, scriptNeeded: 8 },
  signal: { flows: ['qr'], history: { maxDays: 30, phoneConfirms: true }, scriptNeeded: 10 },
  telegram: { flows: ['qr', 'phone'], history: { maxDays: null, phoneConfirms: false }, scriptNeeded: 10 },
};
const TG = 'fi.mau.telegram.login.';

function install({ opts, perms, enabledUser, hostError, personCtx, mediaHost }) {
  const o = opts.bridges === true ? {} : (opts.bridges && typeof opts.bridges === 'object' ? opts.bridges : null);
  const v10 = !!(o && o.version >= 10);
  // version 11: Telegram as well
  const v11 = !!(o && o.version >= 11);
  // version 13: old media from the phone
  const v13 = !!(o && o.version >= 13);
  // version 14: a location over the bridge
  const v14 = !!(o && o.version >= 14);
  // version 10: Signal next to WhatsApp
  const NETS = v11 ? ['whatsapp', 'signal', 'telegram'] : (v10 ? ['whatsapp', 'signal'] : NETWORKS);
  const host = !!o;
  if (host && perms.bridges != null && typeof perms.bridges !== 'boolean') throw hostError('ERR_INVALID', 'plugin.json: permissions.bridges: invalid');
  const on = host && perms.bridges === true;
  const st = {
    preview: !(o && o.preview === false),
    enabled: !!(o && o.enabled),
    networks: { whatsapp: !!(o && o.networks && o.networks.whatsapp), ...(v10 ? { signal: !!(o && o.networks && o.networks.signal) } : {}), ...(v11 ? { telegram: !!(o && o.networks && o.networks.telegram) } : {}) },
    stickers: false, mediaRequests: 'off', needs: {}, tgApp: o && o.telegramApp ? { setAt: '2026-11-16T09:00:00.000Z', setBy: 'Max Berger' } : null, tgApps: [], tgPassword: null,
    host: { state: o && o.running ? 'running' : null, error: null, running: !!(o && o.running), memMb: o && o.running ? 88 : null, outdated: false, probe: null },
    logins: new Map(), processes: new Map(), log: [], seq: 0, oddStep: null, elsewhere: new Map(),
  };
  const version = o && [1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].includes(o.version) ? o.version : 2;
  Object.assign(st, { inbox: [], inboxSeq: 0, chats: new Map(), sent: [], failSend: null, wake: null });
  Object.assign(st, { files: new Map(), fetches: [], numbers: new Map(), lookups: new Map(), dms: new Map(), failFetch: null });
  Object.assign(st, { contacts: [], contactRefs: new Map(), contactDms: new Map() });
  Object.assign(st, { accounts: [], recognition: new Map() });
  Object.assign(st, { history: true, historyPeople: new Map(), backlog: [], backlogSeq: 0, backup: { time: '03:10', timeZone: 'Europe/Berlin', lastAt: null, bytes: null, requested: false, error: null, restore: null }, backupTime: '03:10' });

  const err = (code, message, reason) => { const e = hostError(code, message); if (reason) e.reason = reason; return e; };
  const need = () => { if (perms.bridges !== true) throw hostError('ERR_BRIDGES_DENIED', 'this plugin has no bridges permission'); };
  const refuse = (reason) => err('ERR_BRIDGE', 'the bridge refused or failed', reason);

  function status() {
    if (!st.preview) return { available: false, reason: 'preview_off', enabled: false, location: 'server', locations: [], networks: [], host: null, history: { enabled: false } };
    const up = st.enabled && st.host.state === 'running' && st.host.running;
    return {
      available: true, reason: null, enabled: st.enabled, location: 'server',
      locations: [{ id: 'server', kind: 'server', cores: 4, memMb: 7953, freeMb: 5017 }],
      networks: NETS.map((id) => {
        let state = 'off';
        if (st.enabled && st.networks[id]) state = up ? 'running' : (st.host.state === 'failed' ? 'failed' : 'starting');
        if (st.enabled && st.networks[id] && st.needs[id] === 'compose') state = 'failed';
        // version 11: Telegram without the application id is not started
        const noApp = id === 'telegram' && st.networks[id] && !st.tgApp;
        if (noApp) state = st.enabled ? 'stopped' : 'off';
        return {
          id, enabled: st.networks[id], state, version: up ? (st.host.outdated ? '0.2609.0' : '0.2610.0') : null, memMb: up ? st.host.memMb : null, limitMb: up ? 512 : null,
          ...(version >= 2 ? { outdated: up && st.host.outdated === true, wantVersion: '0.2610.0' } : {}),
          ...(version >= 5 ? { clientOutdated: [...st.logins.values()].some((l) => l.some((x) => x.clientOutdated)) } : {}),
          ...(v10 ? { flows: [...NET_FACTS[id].flows], history: { ...NET_FACTS[id].history }, needs: noApp ? 'app' : (st.needs[id] || null), scriptNeeded: NET_FACTS[id].scriptNeeded } : {}),
          ...(v14 ? { location: id !== 'signal' } : {}),
        };
      }),
      ...(v10 ? { stickers: { animated: st.stickers } } : {}),
      ...(v13 ? { mediaRequests: { mode: st.mediaRequests, options: ['off', 'daily', 'now'], dailyAt: '11:10', timeZone: 'Europe/Berlin' } } : {}),
      ...(v11 ? { telegramApp: { set: !!st.tgApp, setAt: st.tgApp ? st.tgApp.setAt : null, setBy: st.tgApp ? st.tgApp.setBy : null } } : {}),
      host: {
        state: st.enabled ? st.host.state : 'stopped', error: st.enabled ? st.host.error : null, checkedAt: st.host.state ? new Date().toISOString() : null,
        cron: 'ok', script: { host: version >= 5 ? 8 : (version >= 3 ? 7 : (version >= 2 ? 6 : 5)), needed: version >= 5 ? 8 : (version >= 3 ? 7 : (version >= 2 ? 6 : 5)) },
        homeserver: { running: up, memMb: up ? 61 : null, limitMb: up ? 384 : null, version: up ? '1.9.4' : null, ...(version >= 2 ? { outdated: false, wantVersion: '1.9.4' } : {}) },
        ...(version >= 2 ? { limitsProvisional: true, probe: st.host.probe || null } : {}),
      },
      history: version >= 5 ? { enabled: st.history, default: 30, options: [0, 30, -1], pending: st.backlog.length, conversations: 30, messages: 200, timeZone: 'Europe/Berlin' } : { enabled: false },
      ...(version >= 5 ? { backup: { ...st.backup, time: st.backupTime }, cleanup: { deleted: 0, lastAt: null, error: null, waiting: 0 }, version } : {}),
      ...(version >= 3 ? { messages: { listening: st.enabled, relay: !st.enabled ? null : (st.host.relay || 'running'), lastEventAt: null, transactions: 0, pending: st.inbox.length } } : {}),
    };
  }

  function admin() {
    const writers = [...personCtx.entries()].filter(([, e]) => e.write > 0).map(([uid]) => uid);
    if (!writers.length) throw hostError('ERR_NOT_PERSON', 'only inside a changing request (POST/PUT/PATCH/DELETE) of a signed-in person, or with { actor }');
    if (writers.length !== 1) throw hostError('ERR_NOT_PERSON', 'several people are changing something right now — name the acting person with { actor }');
    const u = enabledUser(writers[0]);
    if (!u) throw hostError('ERR_NOT_PERSON', 'unknown or disabled person');
    if (u.role !== 'admin') throw hostError('ERR_NOT_ADMIN', 'only an administrator');
    return u;
  }

  /** the person of the call: their own request must be in flight */
  function person(userId, write) {
    if (!Number.isSafeInteger(userId) || userId <= 0) throw hostError('ERR_INVALID', 'invalid user id');
    const e = personCtx.get(userId);
    if (!e || (write ? e.write <= 0 : e.read + e.write <= 0)) {
      throw hostError('ERR_NOT_PERSON', write ? 'only inside a changing request (POST/PUT/PATCH/DELETE) of that person' : 'only inside a request of that person');
    }
    return userId;
  }

  function bridge(network) {
    if (!NETS.includes(network)) throw hostError('ERR_INVALID', 'unknown network');
    if (!st.preview) throw err('ERR_BRIDGES_UNAVAILABLE', 'the bridges are not offered on this server', 'preview_off');
    if (!st.enabled || !st.networks[network]) throw err('ERR_BRIDGES_UNAVAILABLE', 'this bridge is switched off', 'off');
    if (network === 'telegram' && !st.tgApp) throw err('ERR_BRIDGES_UNAVAILABLE', 'this bridge is not set up yet', 'no_app');
    if (!st.host.running || st.host.bridgeDown) throw err('ERR_BRIDGE_UNREACHABLE', 'connect ENOENT', 'not_running');
  }
  const id = (v) => { if (!ID_RE.test(String(v || ''))) throw hostError('ERR_INVALID', 'invalid id'); return v; };
  const proc = (userId, processId) => {
    const p = st.processes.get(id(processId));
    if (!p || p.userId !== userId) throw refuse('not_found');
    return p;
  };

  function complete(p) {
    // like GateControl: a reference (HMAC per person), never the bridge's id — which is the person's number at WhatsApp
    const loginId = 'l' + Buffer.from(`login-${++st.seq}-${p.userId}`).toString('base64url').padEnd(22, 'A').slice(0, 22);
    const list = st.logins.get(p.userId) || [];
    list.push({ id: loginId, name: p.phone || '+490000000', state: 'connected', since: new Date().toISOString(), error: null, ...(v10 ? { network: p.network } : {}) });
    st.logins.set(p.userId, list);
    st.processes.delete(p.id);
    st.log.push({ op: 'linked', userId: p.userId, network: p.network, loginId });
    return { processId: p.id, step: { id: `fi.mau.${p.network}.login.complete`, type: 'complete', instructions: p.network === 'signal' ? 'Signal is linked.' : (p.network === 'telegram' ? 'Telegram is linked.' : 'Successfully logged in'), loginId } };
  }

  const api = {
    'bridges.status': async () => { need(); return status(); },
    'bridges.configure': async ({ patch }) => {
      need();
      const who = admin();
      if (!st.preview) throw err('ERR_BRIDGES_UNAVAILABLE', 'the bridges are not offered on this server', 'preview_off');
      const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : null;
      if (!p) throw hostError('ERR_INVALID', 'patch: an object');
      const keys = version >= 5 ? ['enabled', 'networks', 'history', 'backupNow', 'backupTime', ...(v10 ? ['animatedStickers'] : []), ...(v11 ? ['telegramApp'] : []), ...(v13 ? ['mediaRequests'] : [])] : ['enabled', 'networks'];
      for (const k of Object.keys(p)) if (!keys.includes(k)) throw hostError('ERR_INVALID', 'unknown key');
      // version 11: the Telegram application id — kept as "set" only (the value goes into tgApps for the test, nowhere else)
      if (p.telegramApp !== undefined) {
        const t = p.telegramApp;
        if (t !== null && (!t || !/^[1-9][0-9]{4,9}$/.test(String(t.apiId)) || !/^[0-9a-f]{32}$/.test(String(t.apiHash)))) throw err('ERR_INVALID', 'telegramApp: { apiId, apiHash } or null', 'telegram_app');
        st.tgApps.push(t);
        st.tgApp = t ? { setAt: new Date().toISOString(), setBy: who.display_name || who.username || null } : null;
      }
      if (p.animatedStickers !== undefined) { if (typeof p.animatedStickers !== 'boolean') throw hostError('ERR_INVALID', 'animatedStickers: a boolean'); st.stickers = p.animatedStickers; }
      if (p.mediaRequests !== undefined) { if (!['off', 'daily', 'now'].includes(p.mediaRequests)) throw hostError('ERR_INVALID', 'mediaRequests: off | daily | now'); st.mediaRequests = p.mediaRequests; }
      if (p.history !== undefined) { if (typeof p.history !== 'boolean') throw hostError('ERR_INVALID', 'history: a boolean'); st.history = p.history; }
      if (p.backupTime !== undefined) { if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(String(p.backupTime))) throw hostError('ERR_INVALID', 'backupTime: HH:MM'); st.backupTime = p.backupTime; }
      if (p.backupNow !== undefined) { if (p.backupNow !== true) throw hostError('ERR_INVALID', 'backupNow: true'); st.backup.requested = true; }
      if (p.enabled !== undefined && typeof p.enabled !== 'boolean') throw hostError('ERR_INVALID', 'enabled: a boolean');
      if (p.networks !== undefined) {
        if (!p.networks || typeof p.networks !== 'object' || Array.isArray(p.networks)) throw hostError('ERR_INVALID', 'networks: an object');
        for (const [n, v] of Object.entries(p.networks)) if (!NETS.includes(n) || typeof v !== 'boolean') throw hostError('ERR_INVALID', 'networks: unknown network or not a boolean');
        Object.assign(st.networks, p.networks);
      }
      if (p.enabled !== undefined) st.enabled = p.enabled;
      st.log.push({ op: 'configure', by: who.id, enabled: st.enabled, networks: { ...st.networks }, ...(version >= 5 ? { history: st.history, backupNow: p.backupNow === true } : {}) });
      return status();
    },
    'bridges.login.flows': async ({ userId, network }) => { need(); person(userId, false); bridge(network); return FLOWS.filter((f) => !v10 || NET_FACTS[network].flows.includes(f.id)).map((f) => ({ ...f })); },
    'bridges.login.start': async ({ userId, network, flowId }) => {
      need(); person(userId, true); bridge(network);
      if (!FLOWS.some((f) => f.id === id(flowId))) throw refuse('not_found');
      // version 10: only a flow the network offers (Signal: the QR code)
      if (v10 && !NET_FACTS[network].flows.includes(flowId)) throw hostError('ERR_INVALID', 'this login flow is not offered for this network');
      if (st.oddStep) { st.oddStep = null; throw refuse('unsupported_step'); }
      const p = { id: `proc-${++st.seq}`, userId, network, flow: flowId, phone: null, settled: null };
      st.processes.set(p.id, p);
      if (network === 'telegram' && flowId === 'phone') {
        return { processId: p.id, step: { id: `${TG}phone_number`, type: 'user_input', instructions: '', fields: [{ id: `${TG}phone_number`, type: 'phone_number', name: '', description: '', optional: false }] } };
      }
      if (network === 'telegram') return { processId: p.id, step: { id: `${TG}show_qr`, type: 'display_and_wait', instructions: '', display: { type: 'qr', data: 'tg://login?token=ZmFrZVRva2Vu' } } };
      if (flowId === 'phone') {
        return { processId: p.id, step: { id: 'fi.mau.whatsapp.login.phone', type: 'user_input', instructions: 'Enter your phone number',
          fields: [{ id: 'phone_number', type: 'phone_number', name: 'Phone number', description: 'Include the country code with a +', optional: false }] } };
      }
      if (network === 'signal') return { processId: p.id, step: { id: 'fi.mau.signal.login.qr', type: 'display_and_wait', instructions: '', display: { type: 'qr', data: 'sgnl://linkdevice?uuid=fakeCode&pub_key=fakeKey' } } };
      return { processId: p.id, step: { id: 'fi.mau.whatsapp.login.qr', type: 'display_and_wait', instructions: 'Scan the QR code', display: { type: 'qr', data: '2@fake-qr-payload,one,two,three' } } };
    },
    'bridges.login.step': async ({ userId, network, processId, stepId, kind, input }) => {
      need(); person(userId, true); bridge(network);
      id(stepId);
      if (kind !== 'user_input' && kind !== 'display_and_wait') throw hostError('ERR_INVALID', 'invalid step kind');
      const p = proc(userId, processId);
      if (kind === 'user_input') {
        if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length) throw hostError('ERR_INVALID', 'input: an object');
        for (const [k, v] of Object.entries(input)) if (!ID_RE.test(k) || typeof v !== 'string' || v.length > 500) throw hostError('ERR_INVALID', 'input: invalid field');
        // version 11: Telegram — number → code → (password) → complete; a wrong code or password: the step again, retry
        if (network === 'telegram') {
          const field = (fid, type, retry) => ({ processId: p.id, step: { id: fid + (retry ? '.incorrect' : ''), type: 'user_input', instructions: '', fields: [{ id: fid, type, name: '', description: '', optional: false }], ...(retry ? { retry: true } : {}) } });
          if (!p.stage) {
            if (!/^\+[0-9]{6,15}$/.test(String(input[`${TG}phone_number`] || ''))) throw refuse('fi_mau_telegram_phone_number_invalid');
            p.phone = input[`${TG}phone_number`]; p.stage = 'code';
            return field(`${TG}code`, '2fa_code', false);
          }
          if (p.stage === 'code') {
            if (input[`${TG}code`] !== '47000') return field(`${TG}code`, '2fa_code', true);
            if (st.tgPassword) { p.stage = 'password'; return field(`${TG}password`, 'password', false); }
            return complete(p);
          }
          if (input[`${TG}password`] !== st.tgPassword) return field(`${TG}password`, 'password', true);
          return complete(p);
        }
        if (!/^\+[0-9]{6,15}$/.test(String(input.phone_number || ''))) throw refuse('m_bad_json');
        p.phone = input.phone_number;
        return { processId: p.id, step: { id: 'fi.mau.whatsapp.login.pairing_code', type: 'display_and_wait', instructions: 'Enter the code in the app', display: { type: 'code', data: 'K7P2-M4X9' } } };
      }
      // the host asks the bridge once and lets the caller poll: { waiting: true } until the phone answered
      if (!p.settled) return { processId: p.id, waiting: true };
      if (p.settled === 'expire') { st.processes.delete(p.id); throw refuse('fi_mau_whatsapp_login_timeout'); }
      return complete(p);
    },
    'bridges.login.cancel': async ({ userId, network, processId }) => {
      need(); person(userId, true); bridge(network);
      st.processes.delete(proc(userId, processId).id);
      return { ok: true };
    },
    'bridges.logins': async ({ userId, network }) => {
      need(); person(userId, false); bridge(network);
      return (st.logins.get(userId) || []).filter((l) => !l.network || l.network === network).map((l) => ({ network, ...l }));
    },
    'bridges.logout': async ({ userId, network, loginId }) => {
      need(); person(userId, true); bridge(network);
      const list = st.logins.get(userId) || [];
      if (!list.some((l) => l.id === id(loginId))) throw refuse('not_found');
      st.logins.set(userId, list.filter((l) => l.id !== loginId));
      st.log.push({ op: 'logout', userId, network, loginId });
      return { ok: true };
    },
    ...(version >= 2 ? {
      'bridges.unlinkFor': async ({ userId, network, actor }) => {
        need();
        if (!Number.isSafeInteger(userId) || userId <= 0) throw hostError('ERR_INVALID', 'invalid user id');
        if (!Number.isSafeInteger(actor) || actor <= 0 || actor === userId) throw hostError('ERR_INVALID', 'actor: another person');
        const e = personCtx.get(actor);
        if (!((e && e.write > 0) || (st.elsewhere.get(actor) || 0) > 0)) throw hostError('ERR_NOT_PERSON', 'only while the acting person has a changing request (POST/PUT/PATCH/DELETE) in flight');
        if (!enabledUser(actor)) throw hostError('ERR_NOT_PERSON', 'unknown or disabled person');
        const target = enabledUser(userId);
        if (target && target.role === 'admin') throw hostError('ERR_BRIDGES_DENIED', "an administrator's link is never ended by somebody else");
        bridge(network);
        const n = (st.logins.get(userId) || []).length;
        st.logins.set(userId, []);
        st.log.push({ op: 'unlink_for', userId, by: actor, network, logins: n });
        return { unlinked: n };
      },
    } : {}),
  };

  // ── version 3: messages ──
  const EVENT_RE = /^\$[A-Za-z0-9._=/+-]{1,128}(:[a-z0-9.-]{1,64})?$/;
  const TXN_RE = /^[A-Za-z0-9_-]{8,96}$/;
  function chatOf(userId, network, chatId) {
    const c = typeof chatId === 'string' ? st.chats.get(chatId) : null;
    if (!c || c.userId !== userId || c.network !== network) throw hostError('ERR_INVALID', 'unknown chat');
    if (c.closed) throw refuse('chat_closed');
    return c;
  }
  /** version 12: the status room takes nothing from the person */
  function noStatusRoom(c) { if (c && c.status) throw refuse('status_room'); }
  const out = (op, userId, network, chatId, extra) => {
    if (st.failSend && op !== 'read' && op !== 'typing') { const f = st.failSend; st.failSend = null; throw err(f.code || 'ERR_BRIDGE', 'the bridge refused or failed', f.reason || 'bridge_error'); }
    const row = { op, userId, network, chatId, ...extra };
    st.sent.push(row);
    return row;
  };
  if (version >= 3) Object.assign(api, {
    'bridges.events.pull': async ({ after, limit }) => {
      need();
      if (!st.preview) return { events: [], more: false };
      const a = Number.isSafeInteger(after) && after >= 0 ? after : 0;
      const n = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 200) : 100;
      const rows = st.inbox.filter((e) => e.seq > a);
      return { events: rows.slice(0, n).map((e) => JSON.parse(JSON.stringify(e))), more: rows.length > n };
    },
    'bridges.events.ack': async ({ upTo }) => {
      need();
      if (!Number.isSafeInteger(upTo) || upTo < 0) throw hostError('ERR_INVALID', 'upTo: a sequence number');
      st.inbox = st.inbox.filter((e) => e.seq > upTo);
      return { ok: true, pending: st.inbox.length };
    },
    'bridges.chats': async ({ userId, network }) => {
      need(); person(userId, false);
      if (!NETS.includes(network)) throw hostError('ERR_INVALID', 'unknown network');
      return [...st.chats.entries()].filter(([, c]) => c.userId === userId && c.network === network).map(([id, c]) => ({ id, kind: c.kind, open: !c.closed, ...(version >= 7 ? { channel: !!c.channel, readOnly: !!c.readOnly || !!c.status } : {}), ...(version >= 12 && c.status ? { status: true } : {}) }));
    },
    'bridges.send': async ({ userId, network, chatId, message }) => {
      need();
      // a file is checked before anything else (its own, servable) — like the host
      const file = version >= 4 && message && typeof message === 'object' && message.media != null ? mediaHost.servable(message.media && message.media.mediaId) : null;
      person(userId, true); bridge(network);
      const c = chatOf(userId, network, chatId);
      noStatusRoom(c);
      const m = message && typeof message === 'object' && !Array.isArray(message) ? message : null;
      if (file) {
        if (!['image', 'video', 'audio', 'voice', 'file'].includes(m.media.kind) || m.edit != null || !TXN_RE.test(String(m.txnId || ''))) throw hostError('ERR_INVALID', 'media: { kind: image | video | audio | voice | file }');
        if (m.replyTo != null && !EVENT_RE.test(String(m.replyTo))) throw hostError('ERR_INVALID', 'replyTo: a message id');
        const key = `${userId}|${m.txnId}`;
        if (c.txns.has(key)) return { id: c.txns.get(key) };
        const id = `$out${++st.seq}`;
        out('send', userId, network, chatId, { txnId: m.txnId, text: typeof m.text === 'string' && m.text.trim() ? m.text : null, replyTo: m.replyTo || null, edit: null, media: { ...m.media }, mime: file.mime, bytes: file.bytes, id });
        c.txns.set(key, id);
        return { id };
      }
      // version 14: a location (m.location at the bridge) — only where the bridge sends one
      if (v14 && m && m.location != null) {
        const l = m.location && typeof m.location === 'object' && !Array.isArray(m.location) ? m.location : null;
        const ok = l && typeof l.lat === 'number' && Number.isFinite(l.lat) && Math.abs(l.lat) <= 90 && typeof l.lon === 'number' && Number.isFinite(l.lon) && Math.abs(l.lon) <= 180
          && (l.label == null || (typeof l.label === 'string' && l.label.length <= 200));
        if (!ok || m.edit != null || m.media != null || (typeof m.text === 'string' && m.text.trim()) || !TXN_RE.test(String(m.txnId || ''))) throw hostError('ERR_INVALID', 'location: { lat, lon, label? }');
        if (m.replyTo != null && !EVENT_RE.test(String(m.replyTo))) throw hostError('ERR_INVALID', 'replyTo: a message id');
        if (network === 'signal') throw err('ERR_INVALID', 'this network sends no location', 'unsupported');
        const key = `${userId}|${m.txnId}`;
        if (c.txns.has(key)) return { id: c.txns.get(key) };
        const id = `$out${++st.seq}`;
        out('send', userId, network, chatId, { txnId: m.txnId, text: null, location: { lat: l.lat, lon: l.lon, label: l.label || null }, replyTo: m.replyTo || null, edit: null, id });
        c.txns.set(key, id);
        return { id };
      }
      if (!m || typeof m.text !== 'string' || !m.text.trim() || m.text.length > 16000 || !TXN_RE.test(String(m.txnId || ''))) throw hostError('ERR_INVALID', 'message: { txnId, text }');
      for (const k of ['replyTo', 'edit']) if (m[k] != null && !EVENT_RE.test(String(m[k]))) throw hostError('ERR_INVALID', `${k}: a message id`);
      // the same txnId sends once
      const key = `${userId}|${m.txnId}`;
      if (c.txns.has(key)) return { id: c.txns.get(key) };
      const id = `$out${++st.seq}`;
      out('send', userId, network, chatId, { txnId: m.txnId, text: m.text, replyTo: m.replyTo || null, edit: m.edit || null, id });
      c.txns.set(key, id);
      return { id };
    },
    'bridges.react': async ({ userId, network, chatId, reaction }) => {
      need(); person(userId, true); bridge(network);
      noStatusRoom(chatOf(userId, network, chatId));
      const r = reaction && typeof reaction === 'object' ? reaction : {};
      if (typeof r.emoji !== 'string' || !r.emoji || !EVENT_RE.test(String(r.target || '')) || !TXN_RE.test(String(r.txnId || ''))) throw hostError('ERR_INVALID', 'reaction: { txnId, target, emoji }');
      const id = `$react${++st.seq}`;
      out('react', userId, network, chatId, { txnId: r.txnId, target: r.target, emoji: r.emoji, id });
      return { id };
    },
    'bridges.redact': async ({ userId, network, chatId, redaction }) => {
      need(); person(userId, true); bridge(network);
      noStatusRoom(chatOf(userId, network, chatId));
      const r = redaction && typeof redaction === 'object' ? redaction : {};
      if (!EVENT_RE.test(String(r.target || '')) || !TXN_RE.test(String(r.txnId || ''))) throw hostError('ERR_INVALID', 'redaction: { txnId, target }');
      out('redact', userId, network, chatId, { txnId: r.txnId, target: r.target });
      return { ok: true };
    },
    'bridges.read': async ({ userId, network, chatId, messageId, status }) => {
      need(); person(userId, true); bridge(network);
      const c = chatOf(userId, network, chatId);
      if (!EVENT_RE.test(String(messageId || ''))) throw hostError('ERR_INVALID', 'messageId: a message id');
      // version 12: in the status room only on the plugin's explicit word
      if (c.status && status !== true) return { ok: true, skipped: 'status' };
      out('read', userId, network, chatId, { messageId, ...(c.status ? { status: true } : {}) });
      return { ok: true };
    },
    'bridges.typing': async ({ userId, network, chatId, on }) => {
      need(); person(userId, true); bridge(network);
      chatOf(userId, network, chatId);
      out('typing', userId, network, chatId, { on: on === true });
      return { ok: true };
    },
  });

  // ── version 4: files, pictures, a new chat by number ──
  const NUMBER_RE = /^\+[1-9][0-9]{6,14}$/;
  const numberOf = (v) => {
    if (typeof v !== 'string' || v.length > 40) return null;
    let x = v.replace(/[\s\-./()]/g, '');
    if (x.startsWith('00')) x = '+' + x.slice(2);
    return NUMBER_RE.test(x) ? x : null;
  };
  const lookup = (userId, number) => {
    const n = numberOf(number);
    if (!n) throw err('ERR_INVALID', 'number: + and the country code', 'invalid_number');
    const now = Date.now();
    const list = (st.lookups.get(userId) || []).filter((t) => now - t < 3600000);
    if (list.length >= 20) throw Object.assign(err('ERR_RATE_LIMIT', 'too many numbers asked for in the last hour'), { retryAfterS: Math.ceil((3600000 - (now - list[0])) / 1000) });
    list.push(now);
    st.lookups.set(userId, list);
    if (!(st.logins.get(userId) || []).length) throw refuse('bridge_error');
    return n;
  };
  if (version >= 4) Object.assign(api, {
    'bridges.media.fetch': async ({ userId, network, ref, name }) => {
      need();
      if (!Number.isSafeInteger(userId) || userId <= 0) throw hostError('ERR_INVALID', 'invalid user id');
      bridge(network);
      const f = typeof ref === 'string' ? st.files.get(ref) : null;
      st.fetches.push({ userId, network, ref });
      if (st.failFetch) {
        const ff = st.failFetch;
        if (Number.isSafeInteger(ff.times) && --ff.times <= 0) st.failFetch = null;
        throw err(ff.code || 'ERR_BRIDGE', 'the bridge refused or failed', ff.reason || 'bad_answer');
      }
      if (!f || f.userId !== userId) throw hostError('ERR_INVALID', 'unknown file');
      if (f.gone) throw refuse('m_not_found');
      return mediaHost.store(f.data, { mime: f.mime, name: name == null ? (f.name || null) : name });
    },
    'bridges.resolve': async ({ userId, network, number }) => {
      need(); person(userId, true); bridge(network);
      const n = lookup(userId, number);
      st.log.push({ op: 'resolve', userId, network });
      const who = st.numbers.get(n);
      return who ? { found: true, name: who.name || null } : { found: false };
    },
    'bridges.createDm': async ({ userId, network, number }) => {
      need(); person(userId, true); bridge(network);
      const n = lookup(userId, number);
      st.log.push({ op: 'create_dm', userId, network });
      const who = st.numbers.get(n);
      if (!who) throw refuse('not_found');
      const k = `${userId}|${network}|${n}`;
      if (!st.dms.has(k)) st.dms.set(k, control.chat(userId, { kind: 'direct', name: who.name || null, network }));
      return { chat: { id: st.dms.get(k), kind: 'direct', name: who.name || null } };
    },
  });

  // ── version 5: older messages, the state of the logins ──
  const daysOf = (userId) => (!st.history ? 0 : (st.historyPeople.has(userId) ? st.historyPeople.get(userId) : 30));
  if (version >= 5) Object.assign(api, {
    'bridges.history.get': async ({ userId }) => {
      need(); person(userId, false);
      return { allowed: st.preview && st.history, days: st.historyPeople.has(userId) ? st.historyPeople.get(userId) : 30, default: 30, options: [0, 30, -1], pending: st.backlog.filter((e) => e.userId === userId).length };
    },
    'bridges.history.set': async ({ userId, days }) => {
      need(); person(userId, true);
      if (![0, 30, -1].includes(days)) throw hostError('ERR_INVALID', 'days: one of 0, 30, -1');
      if (days === 30) st.historyPeople.delete(userId); else st.historyPeople.set(userId, days);
      st.log.push({ op: 'history_set', userId, days });
      // fewer days: what waits and is not wanted any more goes now
      const d = daysOf(userId);
      st.backlog = st.backlog.filter((e) => e.userId !== userId || (d !== 0 && (d < 0 || (Number(e.at) || 0) >= Date.now() - d * 86400000)));
      return api['bridges.history.get']({ userId });
    },
    'bridges.history.pull': async ({ limit, chatId, userId }) => {
      need();
      if (!st.preview) return { events: [], more: false };
      const n = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 200) : 100;
      const rows = st.backlog.filter((e) => (chatId == null || (e.chat && e.chat.id === chatId)) && (userId == null || e.userId === userId));
      return { events: rows.slice(0, n).map((e) => JSON.parse(JSON.stringify(e))), more: rows.length > n };
    },
    'bridges.history.ack': async ({ seqs }) => {
      need();
      if (!Array.isArray(seqs) || seqs.length > 1000 || seqs.some((x) => !Number.isSafeInteger(x) || x < 0)) throw hostError('ERR_INVALID', 'seqs: up to 1000 sequence numbers');
      st.backlog = st.backlog.filter((e) => !seqs.includes(e.seq));
      st.log.push({ op: 'history_ack', count: seqs.length });
      return { ok: true, pending: st.backlog.length };
    },
    'bridges.health': async ({ userIds, network }) => {
      need();
      if (!Array.isArray(userIds) || userIds.length > 100 || userIds.some((u) => !Number.isSafeInteger(u) || u <= 0)) throw hostError('ERR_INVALID', 'userIds: up to 100 people');
      bridge(network);
      st.log.push({ op: 'health', count: userIds.length });
      // like the host: no id, no name of a login (WhatsApp names both after the number)
      return userIds.map((u) => ({ userId: u, logins: (st.logins.get(u) || []).map((l) => ({ state: l.state, since: l.since, error: l.error, phoneOffline: !!l.phoneOffline, clientOutdated: !!l.clientOutdated })) }));
    },
  });

  // ── version 6: a new chat with a contact ──
  const contactOut = (userId, network, c, i) => {
    const ref = 'k' + Buffer.from(`contact-${++st.seq}-${userId}-${i}`).toString('base64url').padEnd(44, 'A');
    st.contactRefs.set(ref, { userId, network, i, at: Date.now() });
    return { ref, contactId: c.contactId || 'c' + Buffer.from(`c-${i}-${c.number}`).toString('base64url').slice(0, 21).padEnd(21, 'A'), name: c.name || null, avatar: c.avatar || null, chatId: c.chatId || null };
  };
  const linked = (userId) => { if (!(st.logins.get(userId) || []).some((l) => l.state !== 'logged_out')) throw refuse('refused'); };
  if (version >= 6) Object.assign(api, {
    'bridges.contacts': async ({ userId, network, query }) => {
      need(); person(userId, false); bridge(network); linked(userId);
      st.log.push({ op: 'contacts', userId, network });
      const q = typeof query === 'string' ? query.trim().toLowerCase() : '';
      return { contacts: st.contacts.map((c, i) => [c, i]).filter(([c]) => !q || String(c.name || '').toLowerCase().includes(q)).map(([c, i]) => contactOut(userId, network, c, i)) };
    },
    'bridges.matchNumbers': async ({ userId, network, numbers }) => {
      need(); person(userId, false); bridge(network);
      if (!Array.isArray(numbers) || numbers.length > 2000) throw hostError('ERR_INVALID', 'numbers: up to 2000');
      linked(userId);
      st.log.push({ op: 'match', userId, network, count: numbers.length });
      const matches = [];
      numbers.forEach((v, index) => {
        const n = numberOf(v);
        const i = n ? st.contacts.findIndex((c) => c.number === n) : -1;
        if (i >= 0) matches.push({ index, ...contactOut(userId, network, st.contacts[i], i) });
      });
      return { matches };
    },
    'bridges.createDmByRef': async ({ userId, network, ref }) => {
      need(); person(userId, true); bridge(network);
      const r = typeof ref === 'string' ? st.contactRefs.get(ref) : null;
      if (!r || r.userId !== userId || r.network !== network || Date.now() - r.at > 30 * 60000) throw err('ERR_INVALID', 'unknown or expired contact', 'expired_ref');
      linked(userId);
      const c = st.contacts[r.i];
      if (!c) throw refuse('not_found');
      st.log.push({ op: 'create_dm_ref', userId, network });
      const k = `${userId}|${network}|${c.number}`;
      if (!st.contactDms.has(k)) st.contactDms.set(k, c.chatId || control.chat(userId, { kind: 'direct', name: c.name || null, network }));
      return { chat: { id: st.contactDms.get(k), kind: 'direct', name: c.name || null } };
    },
  });

  // ── version 8: accounts among the contacts (the user profile) ──
  if (version >= 8) Object.assign(api, {
    'bridges.matchAccounts': async ({ userId, network }) => {
      need(); person(userId, false); bridge(network); linked(userId);
      st.log.push({ op: 'match_accounts', userId, network });
      // like the server: never the person herself, never a disabled account; the test names the pairings
      const matches = st.accounts.filter((a) => (a.viewer == null || a.viewer === userId) && a.userId !== userId && enabledUser(a.userId))
        .map((a) => ({ contactId: a.contactId, userId: a.userId, strength: a.strength === 'strong' ? 'strong' : 'medium', via: a.via === 'own_whatsapp' ? 'own_whatsapp' : 'profile_phone' }));
      return { matches };
    },
  });
  // ── version 9: the consent to be recognised by the own WhatsApp ──
  // version 10: one consent per network (whatsapp's under the person's id as before)
  const recKey = (userId, network) => (network == null || network === 'whatsapp' ? userId : `${userId}|${network}`);
  const recOf = (userId, network) => st.recognition.get(recKey(userId, network)) || { asked: false, allowed: false };
  const recNets = () => (v10 ? ['whatsapp', 'signal', 'telegram'] : ['whatsapp']);
  const linkedOn = (userId, network) => (st.logins.get(userId) || []).some((l) => !l.network || l.network === (network || 'whatsapp'));
  if (version >= 9) Object.assign(api, {
    'bridges.recognition.get': async ({ userId, network }) => {
      need(); person(userId, false);
      if (network != null && !recNets().includes(network)) throw hostError('ERR_INVALID', 'recognition: whatsapp only');
      const r = recOf(userId, network);
      return { asked: r.asked, allowed: r.allowed, linked: linkedOn(userId, network) };
    },
    'bridges.recognition.set': async ({ userId, allowed, network }) => {
      need(); person(userId, true);
      if (network != null && !recNets().includes(network)) throw hostError('ERR_INVALID', 'recognition: whatsapp only');
      if (typeof allowed !== 'boolean') throw hostError('ERR_INVALID', 'allowed: true or false');
      st.recognition.set(recKey(userId, network), { asked: true, allowed });
      st.log.push({ op: 'recognition', userId, allowed, ...(v10 ? { network: network || 'whatsapp' } : {}) });
      return { asked: true, allowed, linked: linkedOn(userId, network) };
    },
  });

  /** gc.bridges (the child bootstrap's shape) */
  const gcPart = (call) => Object.freeze({
    version,
    status: () => call('bridges.status', {}),
    configure: (patch) => call('bridges.configure', { patch }),
    login: Object.freeze({
      flows: (userId, network) => call('bridges.login.flows', { userId, network }),
      start: (userId, network, flowId) => call('bridges.login.start', { userId, network, flowId }),
      step: (userId, network, processId, stepId, kind, input) => call('bridges.login.step', { userId, network, processId, stepId, kind, input }),
      cancel: (userId, network, processId) => call('bridges.login.cancel', { userId, network, processId }),
    }),
    logins: (userId, network) => call('bridges.logins', { userId, network }),
    logout: (userId, network, loginId) => call('bridges.logout', { userId, network, loginId }),
    ...(version >= 2 ? { unlinkFor: (userId, network, actor) => call('bridges.unlinkFor', { userId, network, actor }) } : {}),
    ...(version >= 3 ? {
      events: Object.freeze({
        pull: (o2) => call('bridges.events.pull', { after: o2 && o2.after, limit: o2 && o2.limit }),
        ack: (upTo) => call('bridges.events.ack', { upTo }),
      }),
      chats: (userId, network) => call('bridges.chats', { userId, network }),
      send: (userId, network, chatId, message) => call('bridges.send', { userId, network, chatId, message }),
      react: (userId, network, chatId, reaction) => call('bridges.react', { userId, network, chatId, reaction }),
      redact: (userId, network, chatId, redaction) => call('bridges.redact', { userId, network, chatId, redaction }),
      read: (userId, network, chatId, messageId, opts) => call('bridges.read', { userId, network, chatId, messageId, ...(version >= 12 ? { status: !!(opts && opts.status === true) } : {}) }),
      typing: (userId, network, chatId, on) => call('bridges.typing', { userId, network, chatId, on: on === true }),
    } : {}),
    ...(version >= 4 ? {
      media: Object.freeze({ fetch: (userId, network, ref, o2) => call('bridges.media.fetch', { userId, network, ref, name: o2 && o2.name != null ? o2.name : null }) }),
      resolve: (userId, network, number) => call('bridges.resolve', { userId, network, number }),
      createDm: (userId, network, number) => call('bridges.createDm', { userId, network, number }),
    } : {}),
    ...(version >= 5 ? {
      history: Object.freeze({
        get: (userId) => call('bridges.history.get', { userId }),
        set: (userId, days) => call('bridges.history.set', { userId, days }),
        pull: (o2) => call('bridges.history.pull', { limit: o2 && o2.limit, chatId: o2 && o2.chatId, userId: o2 && o2.userId }),
        ack: (seqs) => call('bridges.history.ack', { seqs }),
      }),
      health: (o2) => call('bridges.health', { userIds: o2 && o2.userIds, network: o2 && o2.network }),
    } : {}),
    ...(version >= 6 ? {
      contacts: (userId, network, o2) => call('bridges.contacts', { userId, network, query: o2 && typeof o2.query === 'string' ? o2.query : null }),
      matchNumbers: (userId, network, numbers) => call('bridges.matchNumbers', { userId, network, numbers }),
      createDmByRef: (userId, network, ref) => call('bridges.createDmByRef', { userId, network, ref }),
    } : {}),
    ...(version >= 8 ? { matchAccounts: (userId, network) => call('bridges.matchAccounts', { userId, network }) } : {}),
    ...(version >= 9 ? {
      recognition: Object.freeze({
        get: (userId, network) => call('bridges.recognition.get', { userId, network: network == null ? 'whatsapp' : network }),
        set: (userId, allowed, network) => call('bridges.recognition.set', { userId, allowed, network: network == null ? 'whatsapp' : network }),
      }),
    } : {}),
  });

  const settle = (processId, how) => {
    const p = st.processes.get(processId);
    if (!p) throw new Error('mock host: unknown login process ' + processId);
    p.settled = how;
  };
  const control = {
    state: st,
    confirm: (processId) => settle(processId, 'confirm'),
    expire: (processId) => settle(processId, 'expire'),
    logOut(userId, loginId) {
      const l = (st.logins.get(userId) || []).find((x) => x.id === loginId);
      if (!l) throw new Error('mock host: unknown login ' + loginId);
      l.state = 'logged_out'; l.error = 'wa-logged-out'; l.since = new Date().toISOString();
    },
    setHost(x = {}) { Object.assign(st.host, x); },
    async acting(userId, fn) {
      st.elsewhere.set(userId, (st.elsewhere.get(userId) || 0) + 1);
      try { return await fn(); } finally { st.elsewhere.set(userId, st.elsewhere.get(userId) - 1); }
    },
    set oddStep(v) { st.oddStep = v; },
    // ── version 3 ──
    get sent() { return st.sent; },
    set failSend(v) { st.failSend = v; },
    set failFetch(v) { st.failFetch = v ? { ...v } : null; },
    /** the mock host hands over how it calls a hook of the plugin */
    onWake(fn) { st.wake = fn; },
    chat(userId, { kind = 'direct', name = null, network = 'whatsapp', channel = false, readOnly = false, status = false } = {}) {
      const id = 'r' + String(++st.seq).padStart(20, '0');
      st.chats.set(id, { userId, network, kind: status ? 'group' : kind, name, closed: false, txns: new Map(), channel, readOnly, status: version >= 12 && status === true });
      return id;
    },
    closeChat(id) { const c = st.chats.get(id); if (c) c.closed = true; },
    // ── version 4 ──
    file(userId, { data, mime = 'application/octet-stream', name = null } = {}) {
      const ref = 'm' + Buffer.from(`file-${++st.seq}-${userId}`).toString('base64url').padEnd(44, 'A');
      st.files.set(ref, { userId, data: Buffer.from(data), mime, name });
      return ref;
    },
    gone(ref) { const f = st.files.get(ref); if (f) f.gone = true; },
    get fetches() { return st.fetches; },
    get numbers() { return st.numbers; },
    // ── version 6 ──
    get contacts() { return st.contacts; },
    set contacts(v) { st.contacts = v; },
    expireRefs() { for (const r of st.contactRefs.values()) r.at = 0; },
    // ── version 8 / 9 ──
    get accounts() { return st.accounts; },
    set accounts(v) { st.accounts = v; },
    recognition(userId, network) { return recOf(userId, network); },
    setNeeds(network, needs) { st.needs[network] = needs || null; },
    // version 11: the two-step verification of the Telegram test account, what configure got as the application id
    set tgPassword(v) { st.tgPassword = v || null; },
    get tgApps() { return st.tgApps; },
    // ── version 13 ──
    get mediaRequests() { return st.mediaRequests; },
    async deliver(events, { wake = true } = {}) {
      for (const e of events) st.inbox.push({ network: 'whatsapp', at: Date.now(), ...JSON.parse(JSON.stringify(e)), seq: ++st.inboxSeq });
      if (wake && st.wake) await st.wake({ pending: st.inbox.length, ephemeral: [] });
    },
    // ── version 5 ──
    async deliverHistory(events) {
      for (const e of events) st.backlog.push({ network: 'whatsapp', at: Date.now(), ...JSON.parse(JSON.stringify(e)), history: true, seq: ++st.backlogSeq });
    },
    get backlog() { return st.backlog; },
    setHistory(on) { st.history = on === true; },
    phoneOffline(userId, loginId, since) {
      const l = (st.logins.get(userId) || []).find((x) => x.id === loginId);
      if (!l) throw new Error('mock host: unknown login ' + loginId);
      l.phoneOffline = !!since; l.error = since ? 'wa-phone-offline' : null; if (since) l.since = since;
    },
    clientOutdated(userId, loginId, on) {
      const l = (st.logins.get(userId) || []).find((x) => x.id === loginId);
      if (!l) throw new Error('mock host: unknown login ' + loginId);
      l.clientOutdated = on !== false; l.error = on !== false ? 'wa-client-outdated' : null;
    },
    async ephemeral(events) {
      if (st.wake) await st.wake({ pending: st.inbox.length, ephemeral: events.map((e) => ({ network: 'whatsapp', ...JSON.parse(JSON.stringify(e)) })) });
    },
  };

  return { on, api, gcPart, control };
}

module.exports = { install, NETWORKS, FLOWS };
