// The wall tablet with Wi-Fi cards at tablet sizes (1.14.1) — a manual browser check, not part of `tools/test.js`
// (Playwright is no dependency of this repository):
//
//   NODE_PATH=<a folder with playwright> node plugins/gatecontrol-familie/test/browser/wall-layout.js [<repo root>] [<out dir>]
//
// Renders the real ui/wall.* (through server/ui.js, GC.call answered with a fixed GET wall) in a portal-like page
// (top bar, .pt-main max 1320 px, the frame grows with its content) at 1280×800, 800×1280 and 1920×1200, light and
// dark, with one share, two shares, a password shown and a 63-character password shown; checks that nothing leaves
// the wall or its card, the network name is not cut, the grid cards keep ≥ 150 px and the QR code is ≥ 200 px
// (in the narrow column a shown password takes the QR code's place for its 30 s, by design); writes screenshots.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = process.argv[2] || path.join(__dirname, '..', '..', '..', '..');
const OUT = process.argv[3] || path.join(require('os').tmpdir(), 'familie-wall-layout');
const FAM = path.join(ROOT, 'plugins', 'gatecontrol-familie');
const ui = require(path.join(FAM, 'server', 'ui.js'));
const wifi = require(path.join(FAM, 'server', 'wifi.js'));
const texts = require(path.join(FAM, 'server', 'texts.json'));
const t = (lang, key, p) => { let s = texts[lang][key] || texts.de[key] || key; if (p) for (const [k, v] of Object.entries(p)) s = s.split(`{{${k}}}`).join(String(v)); return s; };

function data(dark, count) {
  const now = new Date(dark ? '2026-10-25T22:15:00+01:00' : '2026-10-25T10:30:00+01:00');
  const share = (id, ssid, pw, sec, mins) => {
    const s = { id: id.repeat(24), ssid, security: sec, password: pw, hidden: false };
    return { ...s, expiresAt: mins == null ? null : new Date(now.getTime() + mins * 60000).toISOString(), sharedBy: 'Anna', qr: wifi.qrRows(wifi.qrText(s)) };
  };
  const all = [share('a', 'Backes-Gäste-WLAN 5G', 'Korrekt Pferd Batterie Heftklammer', 'WPA', 55), share('b', 'Werkstatt', 'w0rk$hop!2026', 'SAE', null)];
  const m = (userId, name, colorHex, presence) => ({ userId, name, role: userId > 3 ? 'child' : 'parent', avatarUrl: null, color: 'x', colorHex, initials: name.slice(0, 1), presence });
  return {
    now: now.toISOString(), date: now.toISOString().slice(0, 10), time: '10:30', timezone: 'Europe/Berlin', dark, dayLabel: 'Sa',
    members: [m(2, 'Anna', '#2E7D32', 'home'), m(3, 'Marc', '#1565C0', 'away'), m(4, 'Lena', '#AD1457', 'home'), m(5, 'Tim', '#EF6C00', 'unknown')],
    modules: { tasks: true, shopping: true, dates: true, rides: true, stars: true, meals: true, presence: true },
    today: { dates: [{ id: 1, title: 'Zahnarzt Lena', date: '', time: '15:30', allDay: false }], tomorrow: [{ id: 2, title: 'Elternabend', time: '19:00', allDay: false }], birthdays: [{ title: 'Oma', inDays: 3, years: 80 }], rides: [] },
    meals: { lunch: { title: 'Pfannkuchen', cook: 2 }, dinner: null },
    school: { day: 'today', date: '', students: [{ userId: 4, name: 'Lena', start: '07:45', end: '13:05', cancelled: 1, changed: 0, holiday: null, exams: [], free: false, color: '#AD1457', initials: 'L' }] },
    tasks: [{ id: 1, title: 'Müll raus', chips: [{ userId: 4, name: 'Lena', done: false, colorHex: '#AD1457', initials: 'L' }], mode: 'fixed', done: false, stars: 2, dueTime: '18:00' },
      { id: 2, title: 'Spülmaschine', chips: [{ userId: 5, name: 'Tim', done: true, colorHex: '#EF6C00', initials: 'T' }], mode: 'fixed', done: true, stars: 0 }],
    shopping: { list: { id: 'l', name: 'Einkauf' }, open: 5, items: ['Milch', 'Brot', 'Äpfel', 'Kaffee', 'Butter'].map((x, i) => ({ id: 'i' + i, text: x })) },
    wifi: all.slice(0, count),
  };
}

const SIZES = [[1280, 800], [800, 1280], [1920, 1200]];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const report = [];
  for (const [W, H] of SIZES) for (const dark of [false, true]) for (const variant of [1, 2, 'pw', 'long']) {
    const count = variant === 2 ? 2 : 1;
    let qrHidden = false;
    const html = ui.render({ view: 'portal', wall: true, lang: 'de', user: { id: 6, portal: true, loggedIn: true, kiosk: true } }, t);
    const answer = data(dark, count);
    if (variant === 'long') { answer.wifi[0].password = 'x7#Lq2!pVz9@Rt4$Wm8&Kc3*Hn6^Bf1%Gd5(Js0)Np'.padEnd(63, 'Q'); answer.wifi[0].ssid = 'FRITZ!Box 7590 XY Gäste Obergeschoss'; }
    const gc = `<script>window.GC={call:function(m,p){return Promise.resolve(p==='wall'?${JSON.stringify(answer)}:{ok:true});},navigate:function(){}};</script>`;
    const frameDoc = '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font-family:system-ui,sans-serif}</style></head><body>' + gc + html + '</body></html>';
    // the portal around the frame: top bar + tabs (~124 px), .pt-main max 1320 px with a gutter of max(16px, 2.5%)
    const context = await browser.newContext({ viewport: { width: W, height: H }, timezoneId: 'Europe/Berlin' });
    await context.clock.install({ time: new Date(dark ? '2026-10-25T22:15:00+01:00' : '2026-10-25T10:30:00+01:00') });
    const page = await context.newPage();
    const gutter = Math.max(16, Math.round(W * 0.025));
    const frameW = Math.min(W, 1320) - 2 * gutter;
    await page.setContent(`<!doctype html><html><body style="margin:0;background:${dark ? '#0b0f0d' : '#f4f5f2'}">
      <div style="height:100px;background:${dark ? '#111' : '#fff'};border-bottom:1px solid #8884"></div>
      <div style="max-width:1320px;margin:0 auto;padding:24px ${gutter}px">
      <iframe id="f" sandbox="allow-scripts" style="display:block;width:${frameW}px;height:700px;border:0" srcdoc="${frameDoc.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></iframe></div></body></html>`);
    const frame = page.frame({ url: /about:srcdoc/ }) || page.frames()[1];
    await frame.waitForSelector('#fa-w-wifi:not([hidden])', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(300);
    if (variant === 'pw' || variant === 'long') { qrHidden = true; await frame.click('.fa-w-wifi-card:not([hidden]) .fa-w-wifi-show'); await page.waitForTimeout(100); }
    // the host's frame grows with its content
    const wallH = await frame.evaluate(() => document.getElementById('fa-wall').getBoundingClientRect().height);
    await page.evaluate((h) => { document.getElementById('f').style.height = (Math.ceil(h) + 8) + 'px'; }, wallH);
    await page.waitForTimeout(150);
    const m = await frame.evaluate(() => {
      const wall = document.getElementById('fa-wall');
      const wr = wall.getBoundingClientRect();
      const problems = [];
      const check = (el, name) => {
        if (!el || el.hidden || !el.offsetParent) return;
        const r = el.getBoundingClientRect();
        if (r.bottom > wr.bottom + 0.5 || r.right > wr.right + 0.5 || r.left < wr.left - 0.5) problems.push(`${name} outside the wall (${Math.round(r.right)}×${Math.round(r.bottom)} vs ${Math.round(wr.right)}×${Math.round(wr.bottom)})`);
        if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible') problems.push(`${name} clips horizontally (${el.scrollWidth} > ${el.clientWidth})`);
      };
      document.querySelectorAll('.fa-w-wifi-card:not([hidden])').forEach((c, i) => {
        check(c, 'wifi card ' + i);
        c.querySelectorAll('.fa-w-wifi-ssid, .fa-w-wifi-pw, .fa-w-wifi-show, .fa-w-wifi-meta, .fa-w-wifi-hint').forEach((e) => check(e, 'wifi card ' + i + ' ' + e.className));
        const ssid = c.querySelector('.fa-w-wifi-ssid');
        if (ssid && ssid.scrollWidth > ssid.clientWidth + 1) problems.push(`wifi card ${i}: network name cut (${ssid.scrollWidth} > ${ssid.clientWidth})`);
      });
      const sec = document.getElementById('fa-w-wifi');
      if (sec && !sec.hidden) {
        const sr = sec.getBoundingClientRect();
        sec.querySelectorAll('.fa-w-wifi-head, .fa-w-wifi-card:not([hidden]) .fa-w-wifi-qr, .fa-w-wifi-card:not([hidden]) .fa-w-wifi-ssid, .fa-w-wifi-card:not([hidden]) .fa-w-wifi-row, .fa-w-wifi-card:not([hidden]) .fa-w-wifi-meta, .fa-w-wifi-card:not([hidden]) .fa-w-wifi-show').forEach((e) => {
          const r = e.getBoundingClientRect();
          if (!r.width && !r.height) return; // not shown (display: none)
          if (r.bottom > sr.bottom - 4 || r.top < sr.top || r.right > sr.right + 0.5 || r.left < sr.left - 0.5) problems.push(`wifi: ${e.className.baseVal || e.className} cut by its card (${Math.round(r.bottom)} > ${Math.round(sr.bottom)})`);
        });
        const ss = [...sec.querySelectorAll('.fa-w-wifi-card:not([hidden]) .fa-w-wifi-ssid')];
        ss.forEach((e) => { if (e.scrollHeight > e.clientHeight + 1) problems.push('wifi: network name clamped'); });
        if (getComputedStyle(document.getElementById('fa-wall')).backgroundColor === 'rgb(238, 241, 236)' && document.getElementById('fa-wall').classList.contains('is-dark')) problems.push('dark?');
      }
      const cards = [...document.querySelectorAll('.fa-w-card')].filter((c) => !c.hidden);
      cards.forEach((c, i) => { const r = c.getBoundingClientRect(); if (r.height < 150) problems.push(`grid card ${i} only ${Math.round(r.height)} px high`); check(c, 'grid card ' + i); });
      const qrs = [...document.querySelectorAll('.fa-w-wifi-qr')].filter((q) => q.closest('.fa-w-wifi-card') && !q.closest('.fa-w-wifi-card').hidden).map((q) => Math.round(q.getBoundingClientRect().width));
      if (wall.scrollHeight > wall.clientHeight + 1) problems.push(`wall overflows (${wall.scrollHeight} > ${wall.clientHeight})`);
      return { qrs, problems, wall: [Math.round(wr.width), Math.round(wr.height)] };
    });
    // shown password in the narrow column: it takes the QR code's place for 30 s (by design)
    if (m.qrs.some((q) => q < 200 && !(qrHidden && q === 0)) || (!m.qrs.length && !qrHidden)) m.problems.push(`QR code smaller than 200 px: ${m.qrs.join(', ')}`);
    const name = `wall-${W}x${H}-${dark ? 'dark' : 'light'}-${variant === 'pw' ? '1wifi-password' : variant === 'long' ? '1wifi-long-password' : count + 'wifi'}.png`;
    await page.screenshot({ path: path.join(OUT, name) });
    report.push({ name, ...m });
    await context.close();
  }
  await browser.close();
  for (const r of report) console.log(r.problems.length ? '✗' : '✓', r.name, 'wall', r.wall.join('×'), 'qr', r.qrs.join('/'), r.problems.join(' | '));
  process.exit(report.some((r) => r.problems.length) ? 1 : 0);
})();
