// The wall tablet at tablet sizes — a manual browser check, not part of `tools/test.js` (Playwright is no dependency
// of this repository):
//
//   NODE_PATH=<a folder with playwright> node plugins/gatecontrol-familie/test/browser/wall-layout.js \
//     <gatecontrol checkout ≥ 1.199.0> [<plugins repo root>] [<out dir>]
//
// The real ui/wall.* (through server/ui.js) inside GateControl's real frame document (src/services/plugins/frame.js)
// and parent bridge (public/js/plugin-bridge.js — GC.viewport, the frame's growth), on a page with the portal's
// chrome as a kiosk device has it (the header and tabs above, 149 px; 16 px below, no footer). GET wall is answered
// with a fixed family (0, 1 or 2 Wi-Fi shares). Sizes 1280×800, 800×1280, 1920×1200, 2560×1440, 600×960, 1024×600,
// 600×1024, light and dark (the server's clock at 10:30 / 22:15). Checked: the page does not scroll, nothing leaves
// the wall or its card, the network name is not cut, the grid cards keep their room, the QR code is ≥ 160 px.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');

const GC = process.argv[2];
const ROOT = process.argv[3] || path.join(__dirname, '..', '..', '..', '..');
const OUT = process.argv[4] || path.join(os.tmpdir(), 'familie-wall-layout');
if (!GC) { console.error('usage: wall-layout.js <gatecontrol checkout> [<plugins root>] [<out dir>]'); process.exit(2); }
const FAM = path.join(ROOT, 'plugins', 'gatecontrol-familie');
const ui = require(path.join(FAM, 'server', 'ui.js'));
const wifi = require(path.join(FAM, 'server', 'wifi.js'));
const texts = require(path.join(FAM, 'server', 'texts.json'));
const frame = require(path.join(GC, 'src', 'services', 'plugins', 'frame.js'));
const bridge = fs.readFileSync(path.join(GC, 'public', 'js', 'plugin-bridge.js'), 'utf8');
const t = (lang, key, p) => { let s = texts[lang][key] || texts.de[key] || key; if (p) for (const [k, v] of Object.entries(p)) s = s.split(`{{${k}}}`).join(String(v)); return s; };

const TOP = 149;   // the portal's header and tabs above the frame (measured: signed in, 1024 px wide)
const BOTTOM = 16; // a kiosk device's portal: no footer, 16 px below (GateControl ≥ 1.199.0)

function wallData(dark, count) {
  const now = new Date(dark ? '2026-10-25T22:15:00+01:00' : '2026-10-25T10:30:00+01:00');
  const share = (id, ssid, pw, sec, mins) => {
    const s = { id: id.repeat(24), ssid, security: sec, password: pw, hidden: false };
    return { ...s, expiresAt: mins == null ? null : new Date(now.getTime() + mins * 60000).toISOString(), sharedBy: 'Anna', qr: wifi.qrRows(wifi.qrText(s)) };
  };
  const all = [share('a', 'Backes-Gäste-WLAN 5G', 'Korrekt Pferd Batterie Heftklammer', 'WPA', 55), share('b', 'Werkstatt', 'w0rk$hop!2026', 'SAE', null)];
  const m = (userId, name, colorHex, presence) => ({ userId, name, role: userId > 3 ? 'child' : 'parent', avatarUrl: null, color: 'x', colorHex, initials: name.slice(0, 1), presence });
  return {
    ok: true,
    now: now.toISOString(), date: '2026-10-25', time: dark ? '22:15' : '10:30', timezone: 'Europe/Berlin', dark, dayLabel: 'So',
    members: [m(2, 'Anna', '#2E7D32', 'home'), m(3, 'Marc', '#1565C0', 'away'), m(4, 'Lena', '#AD1457', 'home'), m(5, 'Tim', '#EF6C00', 'unknown')],
    modules: { tasks: true, shopping: true, dates: true, rides: true, stars: true, meals: true, presence: true },
    today: { dates: [{ id: 1, title: 'Zahnarzt Lena', date: '', time: '15:30', allDay: false }], tomorrow: [{ id: 2, title: 'Elternabend', time: '19:00', allDay: false }], birthdays: [{ title: 'Oma', inDays: 3, years: 80 }], rides: [] },
    meals: { lunch: { title: 'Pfannkuchen', cook: 2 }, dinner: null },
    school: { day: 'today', date: '', students: [{ userId: 4, name: 'Lena', start: '07:45', end: '13:05', cancelled: 1, changed: 0, holiday: null, exams: [], free: false, color: '#AD1457', initials: 'L' }] },
    tasks: [{ id: 1, title: 'Müll raus', chips: [{ userId: 4, name: 'Lena', done: false, colorHex: '#AD1457', initials: 'L' }], mode: 'fixed', done: false, stars: 2, dueTime: '18:00' },
      { id: 2, title: 'Spülmaschine', chips: [{ userId: 5, name: 'Tim', done: true, colorHex: '#EF6C00', initials: 'T' }], mode: 'fixed', done: true, stars: 0 }],
    shopping: { list: { id: 'l', name: 'Einkauf' }, open: 5, items: ['Milch', 'Brot', 'Äpfel', 'Kaffee', 'Butter'].map((x, i) => ({ id: 'i' + i, text: x })) },
    wifi: count ? all.slice(0, count) : null,
  };
}

const SIZES = [[1280, 800], [800, 1280], [1920, 1200], [2560, 1440], [600, 960], [1024, 600], [600, 1024]];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const report = [];
  for (const [W, H] of SIZES) for (const dark of [false, true]) for (const count of [0, 1, 2]) {
    const fragment = ui.render({ view: 'portal', wall: true, lang: 'de', user: { id: 6, portal: true, loggedIn: true, kiosk: true } }, t);
    const doc = frame.document({ html: fragment, lang: 'de' });
    const gutter = Math.max(16, Math.round(W * 0.025));
    const page = `<!doctype html><html><head><meta charset="utf-8"><script src="/js/plugin-bridge.js"></script><style>
      body{margin:0;min-height:100vh;background:${dark ? '#0b0f0d' : '#f4f5f2'};font-family:system-ui}
      .top{height:${TOP - 24}px;background:${dark ? '#121614' : '#fff'};border-bottom:1px solid #8884}
      main{max-width:1320px;margin:0 auto;padding:24px ${gutter}px ${BOTTOM}px;box-sizing:border-box}
      iframe{display:block;width:100%;border:0;min-height:320px}</style></head><body>
      <div class="top"></div><main><iframe id="f" data-plugin-frame data-plugin-id="gatecontrol-familie" data-plugin-api="/api/v1/portal/plugins/gatecontrol-familie/api/"
      sandbox="allow-scripts allow-forms"></iframe></main>
      <script>document.addEventListener('DOMContentLoaded', () => { document.getElementById('f').src = '/frame'; });</script></body></html>`;
    const context = await browser.newContext({ viewport: { width: W, height: H }, timezoneId: 'Europe/Berlin' });
    await context.clock.install({ time: new Date(dark ? '2026-10-25T22:15:00+01:00' : '2026-10-25T10:30:00+01:00') });
    const p = await context.newPage();
    const answer = wallData(dark, count);
    await p.route('http://wall.test/**', (route) => {
      const u = new URL(route.request().url());
      if (u.pathname === '/') return route.fulfill({ contentType: 'text/html', body: page });
      if (u.pathname === '/js/plugin-bridge.js') return route.fulfill({ contentType: 'application/javascript', body: bridge });
      if (u.pathname === '/frame') return route.fulfill({ contentType: 'text/html', body: doc });
      if (u.pathname.endsWith('/api/wall')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(answer) });
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{"ok":false}' });
    });
    await p.goto('http://wall.test/');
    const f = await (await p.$('#f')).contentFrame();
    await f.waitForSelector(count ? '#fa-w-wifi:not([hidden]) .fa-w-wifi-qr' : '.fa-w-person', { timeout: 8000 }).catch(() => {});
    await p.clock.runFor(1500);
    await p.waitForTimeout(400);
    const pageScroll = await p.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
    const m = await f.evaluate(() => {
      const wall = document.getElementById('fa-wall');
      const wr = wall.getBoundingClientRect();
      const problems = [];
      const inside = (el, box, name) => {
        const r = el.getBoundingClientRect();
        if (!r.width && !r.height) return;
        if (r.bottom > box.bottom + 0.5 || r.right > box.right + 0.5 || r.left < box.left - 0.5 || r.top < box.top - 0.5) problems.push(`${name} outside (${Math.round(r.left)}..${Math.round(r.right)} × ${Math.round(r.top)}..${Math.round(r.bottom)} vs ${Math.round(box.right)}×${Math.round(box.bottom)})`);
      };
      if (wall.scrollHeight > wall.clientHeight + 1) problems.push(`wall overflows (${wall.scrollHeight} > ${wall.clientHeight})`);
      ['.fa-w-head', '.fa-w-school:not([hidden])', '.fa-w-grid'].forEach((s) => { const e = document.querySelector(s); if (e) inside(e, wr, s); });
      const cards = [...document.querySelectorAll('.fa-w-card')].filter((c) => !c.hidden);
      cards.forEach((c, i) => { inside(c, wr, 'card ' + i); const r = c.getBoundingClientRect(); if (r.height < 140) problems.push(`card ${i} only ${Math.round(r.height)} px high`); });
      const sec = document.getElementById('fa-w-wifi');
      let qr = null;
      let wifiScrolls = false;
      if (sec && !sec.hidden) {
        const sr = sec.getBoundingClientRect();
        inside(sec, wr, 'wifi');
        const list = document.getElementById('fa-w-wifi-list');
        wifiScrolls = list.scrollHeight > list.clientHeight + 1;
        const card = sec.querySelector('.fa-w-wifi-card:not([hidden])');
        const svg = card && card.querySelector('.fa-w-wifi-qr');
        if (svg) { const r = svg.getBoundingClientRect(); qr = Math.round(Math.min(r.width, r.height)); }
        sec.querySelectorAll('.fa-w-wifi-head').forEach((e) => inside(e, sr, 'wifi head'));
        if (!wifiScrolls && card) card.querySelectorAll('.fa-w-wifi-ssid, .fa-w-wifi-row').forEach((e) => inside(e, sr, 'wifi ' + e.className));
        const ss = card && card.querySelector('.fa-w-wifi-ssid');
        if (ss && ss.scrollWidth > ss.clientWidth + 1) problems.push('network name cut sideways');
      }
      if (!document.querySelector('.fa-w-person')) problems.push('no data: ' + (document.getElementById('fa-w-banner').textContent || '(no answer)'));
      return { wall: [Math.round(wr.width), Math.round(wr.height)], qr, wifiScrolls, problems, cls: wall.className };
    });
    if (pageScroll > 0) m.problems.push(`the page scrolls by ${pageScroll} px`);
    if (count && (m.qr == null || m.qr < 160)) m.problems.push(`QR code ${m.qr} px`);
    const name = `wall-${W}x${H}-${dark ? 'dark' : 'light'}-${count}wifi.png`;
    await p.screenshot({ path: path.join(OUT, name) });
    report.push({ name, ...m });
    await context.close();
  }
  await browser.close();
  for (const r of report) console.log(r.problems.length ? '✗' : '✓', r.name, 'wall', r.wall.join('×'), r.cls.replace('fa-wall', '').trim(), 'qr', r.qr, r.wifiScrolls ? '(card scrolls)' : '', r.problems.join(' | '));
  process.exit(report.some((r) => r.problems.length) ? 1 : 0);
})();
