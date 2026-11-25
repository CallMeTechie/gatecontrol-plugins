// Spike M0 of gatecontrol-medien: run against a fresh Jellyfin (e.g. the official Linux release started with --nowebclient).
//   JF=http://127.0.0.1:8096 node jellyfin-spike.mjs out.json   — completes the start wizard (admin / spike-admin-pw, a local test
//   server only), creates an API key, then uses only that key: users, Quick Connect via the configuration, Authorize for
//   another user, the device list, DELETE /Devices. The answers go to out.json (test/fixtures are those, sanitized).
const B = process.env.JF || 'http://127.0.0.1:8096';
const rec = []; // recorded answers
async function call(method, path, { token, body, dev } = {}) {
  const auth = `MediaBrowser Client="GateControl", Device="${encodeURIComponent(dev?.name || "GateControl Server")}", DeviceId="${dev?.id || 'gc-server-spike'}", Version="1.0.0"` + (token ? `, Token="${token}"` : '');
  const r = await fetch(B + path, { method, headers: { 'Authorization': auth, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  rec.push({ method, path: path.replace(/(Secret|secret|code)=[^&]*/g, '$1=…'), status: r.status, body: j });
  console.log(method, path, r.status, typeof j === 'string' ? j.slice(0, 200) : JSON.stringify(j).slice(0, 300));
  return { status: r.status, body: j };
}
const ver = (await call('GET', '/System/Info/Public')).body;
if (!ver.StartupWizardCompleted) {
  await call('POST', '/Startup/Configuration', { body: { UICulture: 'de', MetadataCountryCode: 'DE', PreferredMetadataLanguage: 'de' } });
  await call('GET', '/Startup/User');
  await call('POST', '/Startup/User', { body: { Name: 'admin', Password: 'spike-admin-pw' } });
  await call('POST', '/Startup/RemoteAccess', { body: { EnableRemoteAccess: true, EnableAutomaticPortMapping: false } });
  await call('POST', '/Startup/Complete');
}
const adm = (await call('POST', '/Users/AuthenticateByName', { body: { Username: 'admin', Pw: 'spike-admin-pw' } })).body;
await call('POST', '/Auth/Keys?app=GateControl', { token: adm.AccessToken });
const keys = (await call('GET', '/Auth/Keys', { token: adm.AccessToken })).body;
const KEY = keys.Items.find(k => k.AppName === 'GateControl').AccessToken;
// log out admin session so only the api key is used from here on
await call('POST', '/Sessions/Logout', { token: adm.AccessToken });
console.log('--- from here only the API key ---');
await call('GET', '/System/Info', { token: KEY });
let users = (await call('GET', '/Users', { token: KEY })).body;
let mila = users.find(u => u.Name === 'mila');
if (!mila) mila = (await call('POST', '/Users/New', { token: KEY, body: { Name: 'mila', Password: '' } })).body;
await call('GET', '/QuickConnect/Enabled');
// switch quick connect off then on through the configuration
const cfg = (await call('GET', '/System/Configuration', { token: KEY })).body;
console.log('QuickConnectAvailable default =', cfg.QuickConnectAvailable);
await call('POST', '/System/Configuration', { token: KEY, body: { ...cfg, QuickConnectAvailable: false } });
await call('GET', '/QuickConnect/Enabled');
const dev = { id: 'gc-7Hq2mXk4Rb9tLp0sVw3N', name: 'GateControl · Pixel von Mila' };
await call('POST', '/QuickConnect/Initiate', { dev }); // expect 401 when off
await call('POST', '/System/Configuration', { token: KEY, body: { ...cfg, QuickConnectAvailable: true } });
await call('GET', '/QuickConnect/Enabled');
// device initiates
const qc = (await call('POST', '/QuickConnect/Initiate', { dev })).body;
await call('GET', '/QuickConnect/Connect?secret=' + qc.Secret, { dev });
// wrong code
await call('POST', '/QuickConnect/Authorize?code=000000&userId=' + mila.Id, { token: KEY });
// plugin authorizes with the API key for another user
const a = await call('POST', `/QuickConnect/Authorize?code=${qc.Code}&userId=${mila.Id}`, { token: KEY });
// same code twice
await call('POST', `/QuickConnect/Authorize?code=${qc.Code}&userId=${mila.Id}`, { token: KEY });
await call('GET', '/QuickConnect/Connect?secret=' + qc.Secret, { dev });
const auth = (await call('POST', '/Users/AuthenticateWithQuickConnect', { dev, body: { Secret: qc.Secret } })).body;
const devTok = auth.AccessToken;
console.log('device user =', auth.User?.Name, 'device id in session =', auth.SessionInfo?.DeviceId);
await call('GET', '/Users/Me', { token: devTok, dev });
await call('GET', '/Devices', { token: KEY });
await call('GET', '/Devices/Info?id=' + encodeURIComponent(dev.id), { token: KEY });
// the device itself cannot use admin calls
await call('GET', '/Devices', { token: devTok, dev });
// revoke
await call('DELETE', '/Devices?id=' + encodeURIComponent(dev.id), { token: KEY });
await call('GET', '/Users/Me', { token: devTok, dev });
await call('GET', '/Devices', { token: KEY });
// user policy / admin flag
await call('GET', '/Users/' + mila.Id, { token: KEY });
// authorize for an admin user (plugin must refuse itself) – just to see jellyfin accepts it
const qc2 = (await call('POST', '/QuickConnect/Initiate', { dev: { id: 'gc-second', name: 'GateControl · Test' } })).body;
const adminUser = users.find(u => u.Name === 'admin');
await call('POST', `/QuickConnect/Authorize?code=${qc2.Code}&userId=${adminUser.Id}`, { token: KEY });
await call('DELETE', '/Devices?id=gc-second', { token: KEY });
await call('GET', '/Library/VirtualFolders', { token: KEY });
await call('GET', '/Users/' + mila.Id, { token: KEY });
const fs = await import('node:fs');
fs.writeFileSync(process.argv[2], JSON.stringify({ version: ver.Version, calls: rec }, null, 1));
