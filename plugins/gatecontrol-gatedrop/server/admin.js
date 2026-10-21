'use strict';

// The admin page "Übersicht": storage (GateControl's media of this plugin), retention, active links, sends of
// the last 7 days, whether public links are on and what the other plugins offer. Nothing of anybody's content.

const store = require('./store');
const people = require('./people');

async function overview(gc, user, now) {
  let usage = null;
  try { usage = await gc.media.usage(); } catch { usage = null; }
  const sends = await store.one(gc, 'SELECT COUNT(*) AS n FROM sends WHERE created_at > ?', [now - 7 * 86400000]);
  const links = await store.one(gc, 'SELECT COUNT(*) AS n FROM links WHERE revoked_at IS NULL AND expires_at > ?', [now]);
  people.forgetLinks();
  return {
    storage: usage ? { bytes: usage.bytes, count: usage.count, quota: usage.quota, maxBytes: usage.maxBytes } : null,
    retentionDays: 7,
    sends7d: sends ? sends.n : 0,
    activeLinks: links ? links.n : 0,
    linksEnabled: await people.linksEnabled(gc, user.id, now),
    integrations: {
      messenger: await people.available(gc, people.MESSENGER, 'send_file'),
      nas: await people.available(gc, people.SYNOLOGY, 'save_file'),
      familie: await people.available(gc, people.FAMILIE, 'family_roles'),
    },
  };
}

module.exports = { overview };
