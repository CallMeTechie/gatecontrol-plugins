'use strict';

// 1.4.0 — status line and stories (README "Status and stories").
//
//   status   one per person: preset none | homeoffice | away (eta, destLabel) | dnd | auto_place (the place
//            Familie reports through the service set_place_status), an optional text (≤ 60), an end
//            (`until`, null = until changed) and an audience (all | family | custom userIds). dnd: the person
//            gets no chat pushes while it lasts (messages still arrive). Expired rows are removed by the
//            background run.
//   stories  text (bg colour, font), image or video, 24 h, with an audience like the status; viewers are
//            recorded (the owner sees who and their reaction); files are bound as story media (role story /
//            story_thumb) and deleted with the story. Reactions go to the owner as a direct message with
//            `replyStory`.
//
// Texts (status text, destination, place, story texts) are stored encrypted.

const store = require('./store');
const seal = require('./seal');
const live = require('./live');
const people = require('./people');
const social = require('./social');
const messages = require('./messages');
const conversations = require('./conversations');
const { fail, posInt, optText, line, iso, parseIso, userIds, parseJson } = require('./util');

const PRESETS = ['none', 'homeoffice', 'away', 'dnd', 'auto_place'];
const VISIBILITY = ['all', 'family', 'custom'];
const FONTS = ['sans', 'serif', 'mono'];
const STATUS_TEXT_MAX = 60;
const STORY_TEXT_MAX = 700;
const STORY_TTL_MS = 24 * 3600 * 1000;
const STORIES_MAX = 30; // active stories per person
const CUSTOM_MAX = 256;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const UNTIL_MAX_MS = 366 * 86400000;
const DIGEST_HOUR = 18;

const openText = (v) => { const s = seal.open(v); return typeof s === 'string' ? s : null; };

/** The status row of a person when it is still valid (not expired), else null. */
async function rowOf(gc, userId, now) {
  const r = await store.one(gc, 'SELECT * FROM statuses WHERE user_id = ?', [userId]);
  if (!r || (r.until != null && r.until <= now)) return null;
  return r;
}

/** A status row as `viewer` sees it (null when it is not for them). */
function view(s, row, viewer, now) {
  if (!row || (row.until != null && row.until <= now)) return null;
  const owner = row.user_id;
  const ids = parseJson(row.user_ids, []);
  if (!s.audience(row.visibility, ids, viewer, owner)) return null;
  const mine = viewer === owner;
  const text = openText(row.text_enc);
  const place = openText(row.place_enc);
  const pp = s.prefs.get(owner);
  const placeVisible = row.preset === 'auto_place' && !!place && (mine || (pp ? s.allows(pp.privacy.placeInStatus, viewer, owner) : false));
  return {
    preset: row.preset,
    text: placeVisible ? place : (text || null),
    ownText: mine ? text : undefined,
    place: placeVisible ? place : null,
    until: iso(row.until),
    eta: row.preset === 'away' ? iso(row.eta) : null,
    destLabel: row.preset === 'away' ? openText(row.dest_enc) : null,
    visibility: mine ? row.visibility : undefined,
    userIds: mine ? (row.visibility === 'custom' ? ids : []) : undefined,
    updatedAt: iso(row.updated_at),
  };
}

/** Everyone (ids) who may see something with this audience of `owner` — plus the owner. */
function audienceOf(ctx, s, visibility, ids, owner) {
  return [...ctx.users.keys()].filter((u) => u === owner || s.audience(visibility, ids, u, owner));
}

function checkAudience(ctx, b, fallback) {
  const visibility = b.visibility === undefined ? fallback : b.visibility;
  if (!VISIBILITY.includes(visibility)) throw fail('invalid');
  let ids = [];
  if (visibility === 'custom') {
    ids = userIds(b.userIds, CUSTOM_MAX).filter((id) => id !== ctx.viewer && ctx.users.has(id));
    if (!ids.length) throw fail('invalid');
  } else if (b.userIds != null && !Array.isArray(b.userIds)) throw fail('invalid');
  return { visibility, ids };
}

/** PUT status → { status } */
async function put(ctx, body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b) throw fail('invalid');
  const preset = b.preset === undefined ? 'none' : b.preset;
  if (!PRESETS.includes(preset)) throw fail('invalid');
  const text = optText(b.text, STATUS_TEXT_MAX);
  let until = null;
  if (b.until != null) {
    until = parseIso(b.until);
    if (until == null || until <= ctx.now || until > ctx.now + UNTIL_MAX_MS) throw fail('invalid');
  }
  let eta = null;
  let dest = null;
  if (b.eta != null || b.destLabel != null) {
    if (preset !== 'away') throw fail('invalid');
    if (b.eta != null) { eta = parseIso(b.eta); if (eta == null) throw fail('invalid'); }
    dest = optText(b.destLabel, 80);
  }
  if (preset === 'none' && !text) throw fail('invalid'); // nothing to show: DELETE status
  const me = (await people.prefsOf(ctx.gc, [ctx.viewer])).get(ctx.viewer);
  const { visibility, ids } = checkAudience(ctx, b, me.privacy.statusDefault);
  const old = await store.one(ctx.gc, 'SELECT * FROM statuses WHERE user_id = ?', [ctx.viewer]);
  // the last place Familie reported stays (auto_place shows it again when chosen again)
  const place = old ? old.place_enc : null;
  await store.run(ctx.gc, `INSERT INTO statuses (user_id, preset, text_enc, until, visibility, user_ids, eta, dest_enc, place_enc, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET preset = excluded.preset, text_enc = excluded.text_enc, until = excluded.until, visibility = excluded.visibility,
    user_ids = excluded.user_ids, eta = excluded.eta, dest_enc = excluded.dest_enc, place_enc = excluded.place_enc, updated_at = excluded.updated_at`,
  [ctx.viewer, preset, seal.seal(text), until, visibility, visibility === 'custom' ? JSON.stringify(ids) : null, eta, seal.seal(dest), place, ctx.now]);
  const s = await social.load(ctx);
  // the old audience learns that it changed too (it may no longer see it)
  const to = new Set(audienceOf(ctx, s, visibility, ids, ctx.viewer));
  if (old) for (const u of audienceOf(ctx, s, old.visibility, parseJson(old.user_ids, []), ctx.viewer)) to.add(u);
  live.queue(ctx.box, [...to], 'status.update', { userId: ctx.viewer });
  return { status: view(s, await rowOf(ctx.gc, ctx.viewer, ctx.now), ctx.viewer, ctx.now) };
}

/** DELETE status */
async function remove(ctx) {
  const old = await store.one(ctx.gc, 'SELECT * FROM statuses WHERE user_id = ?', [ctx.viewer]);
  if (!old) return { status: null };
  await store.run(ctx.gc, 'DELETE FROM statuses WHERE user_id = ?', [ctx.viewer]);
  const s = await social.load(ctx);
  live.queue(ctx.box, audienceOf(ctx, s, old.visibility, parseJson(old.user_ids, []), ctx.viewer), 'status.update', { userId: ctx.viewer });
  return { status: null };
}

/**
 * Familie's presence (service set_place_status { userId, place }): only when that person's status is
 * auto_place it is shown; the place is remembered either way. → { applied }
 */
async function setPlace(ctx, userId, place) {
  const old = await store.one(ctx.gc, 'SELECT * FROM statuses WHERE user_id = ?', [userId]);
  if (!old || old.preset !== 'auto_place' || (old.until != null && old.until <= ctx.now)) return { applied: false };
  const cur = openText(old.place_enc);
  if (cur === place) return { applied: true, changed: false };
  await store.run(ctx.gc, 'UPDATE statuses SET place_enc = ?, updated_at = ? WHERE user_id = ?', [seal.seal(place), ctx.now, userId]);
  const s = await social.load(ctx);
  live.queue(ctx.box, audienceOf(ctx, s, old.visibility, parseJson(old.user_ids, []), userId), 'status.update', { userId });
  return { applied: true, changed: true };
}

// ─── stories ────────────────────────────────────────────────────────────────

function storyBody(r) { const o = seal.openJson(r.body_enc); return o && typeof o === 'object' ? o : {}; }

async function mediaUrl(ctx, id) {
  if (!ctx.portal || !id) return null;
  try { return await ctx.gc.media.url(id, { user: ctx.viewer, ttlS: messages.URL_TTL_S }); } catch { return null; }
}

/** A story row → the API object for `viewer` (seen from story_views). */
async function storyOut(ctx, r, seenSet, own) {
  const b = storyBody(r);
  const out = {
    id: r.id, kind: r.kind, text: typeof b.text === 'string' ? b.text : null, bg: b.bg || null, font: b.font || null,
    mediaId: r.media_id || null, thumbMediaId: r.thumb_media_id || null, video: b.video || null,
    url: await mediaUrl(ctx, r.media_id), thumbUrl: await mediaUrl(ctx, r.thumb_media_id),
    createdAt: iso(r.created_at), expiresAt: iso(r.expires_at), seen: own ? true : seenSet.has(r.id), place: b.place || null,
    eventMessageId: r.event_msg_id || null,
  };
  if (own) {
    const v = await store.one(ctx.gc, 'SELECT COUNT(*) AS n, SUM(CASE WHEN reaction IS NOT NULL THEN 1 ELSE 0 END) AS r FROM story_views WHERE story_id = ?', [r.id]);
    out.viewerCount = v ? Number(v.n) || 0 : 0;
    out.reactionCount = v ? Number(v.r) || 0 : 0;
    out.visibility = r.visibility;
  }
  return out;
}

const userOut = (ctx, id) => {
  const u = ctx.users.get(id);
  return u ? { id, name: u.name, avatarUrl: u.avatarUrl || null, initials: u.initials || null, colorHex: u.colorHex || null } : { id, name: null, avatarUrl: null, initials: null, colorHex: null };
};

/** A story the viewer may see (not expired) or not_found. */
async function visibleStory(ctx, idRaw) {
  const id = posInt(idRaw);
  if (!id) throw fail('not_found');
  const r = await store.one(ctx.gc, 'SELECT * FROM stories WHERE id = ? AND expires_at > ?', [id, ctx.now]);
  if (!r) throw fail('not_found');
  const s = await social.load(ctx);
  if (!s.audience(r.visibility, parseJson(r.user_ids, []), ctx.viewer, r.user_id)) throw fail('not_found');
  return r;
}

/** POST status/stories → { story } */
async function createStory(ctx, body) {
  if (!ctx.cfg.allowStories) throw fail('feature_off');
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b) throw fail('invalid');
  const kind = b.kind;
  if (!['text', 'image', 'video'].includes(kind)) throw fail('invalid');
  const n = await store.one(ctx.gc, 'SELECT COUNT(*) AS n FROM stories WHERE user_id = ? AND expires_at > ?', [ctx.viewer, ctx.now]);
  if (n && n.n >= STORIES_MAX) throw fail('too_many');
  let text = null;
  if (b.text != null) {
    text = messages.cleanText(b.text, false);
    if (text && text.length > STORY_TEXT_MAX) throw fail('invalid');
  }
  if (kind === 'text' && !text) throw fail('invalid');
  if (b.bg != null && !COLOR_RE.test(String(b.bg))) throw fail('invalid');
  if (b.font != null && !FONTS.includes(b.font)) throw fail('invalid');
  const place = optText(b.place, 80);
  let media = null;
  let thumb = null;
  let video = null;
  if (kind === 'image' || kind === 'video') {
    media = await messages.checkMedia(ctx, b.mediaId, kind === 'image' ? 'image' : 'file');
    if (kind === 'video' && !messages.isVideo(media.mime)) throw fail('media_invalid');
    if (b.thumbMediaId != null) {
      if (b.thumbMediaId === b.mediaId) throw fail('invalid');
      thumb = await messages.checkMedia(ctx, b.thumbMediaId, 'file', { thumb: true });
    }
    if (b.video != null) { if (kind !== 'video') throw fail('invalid'); video = messages.cleanVideo(b.video, media.mime); }
  } else if (b.mediaId != null || b.thumbMediaId != null || b.video != null) throw fail('invalid');
  let eventMsg = null;
  if (b.eventMessageId != null) {
    const id = posInt(b.eventMessageId);
    const row = id ? await store.one(ctx.gc, "SELECT * FROM messages WHERE id = ? AND kind = 'event' AND deleted_at IS NULL", [id]) : null;
    const me = row ? await store.one(ctx.gc, 'SELECT * FROM members WHERE conv_id = ? AND user_id = ? AND left_at IS NULL', [row.conv_id, ctx.viewer]) : null;
    if (!row || !me || row.id <= me.joined_msg_id) throw fail('invalid');
    eventMsg = row.id;
  }
  const prefs = (await people.prefsOf(ctx.gc, [ctx.viewer])).get(ctx.viewer);
  const { visibility, ids } = checkAudience(ctx, b, prefs.privacy.statusDefault);
  const bodyJson = { text, bg: b.bg || (kind === 'text' ? '#0F766E' : null), font: b.font || (kind === 'text' ? 'sans' : null), video, place };
  const r = await store.run(ctx.gc, 'INSERT INTO stories (user_id, kind, body_enc, media_id, thumb_media_id, visibility, user_ids, event_msg_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [ctx.viewer, kind, seal.sealJson(bodyJson), media ? media.mediaId : null, thumb ? thumb.mediaId : null, visibility, visibility === 'custom' ? JSON.stringify(ids) : null, eventMsg, ctx.now, ctx.now + STORY_TTL_MS]);
  const id = r.lastInsertRowid;
  if (media) {
    await messages.bindMedia(ctx, media, { convId: 0, msgId: null, role: 'story', kind: kind === 'image' ? 'image' : 'file' });
    await store.run(ctx.gc, 'UPDATE media SET story_id = ? WHERE media_id = ?', [id, media.mediaId]);
  }
  if (thumb) {
    await messages.bindMedia(ctx, thumb, { convId: 0, msgId: null, role: 'story_thumb', kind: 'image' });
    await store.run(ctx.gc, 'UPDATE media SET story_id = ? WHERE media_id = ?', [id, thumb.mediaId]);
  }
  const s = await social.load(ctx);
  live.queue(ctx.box, audienceOf(ctx, s, visibility, ids, ctx.viewer), 'story.new', { userId: ctx.viewer, storyId: id });
  const row = await store.one(ctx.gc, 'SELECT * FROM stories WHERE id = ?', [id]);
  return { story: await storyOut(ctx, row, new Set(), true) };
}

/** Delete story rows for good (inside a transaction): views, files (orphaned) — and queue story.remove. */
async function dropStories(ctx, rows) {
  if (!rows.length) return 0;
  const s = await social.load(ctx);
  for (const r of rows) {
    await store.run(ctx.gc, 'UPDATE media SET orphan = 1 WHERE story_id = ?', [r.id]);
    await store.run(ctx.gc, 'DELETE FROM story_views WHERE story_id = ?', [r.id]);
    await store.run(ctx.gc, 'DELETE FROM stories WHERE id = ?', [r.id]);
    live.queue(ctx.box, audienceOf(ctx, s, r.visibility, parseJson(r.user_ids, []), r.user_id), 'story.remove', { userId: r.user_id, storyId: r.id });
  }
  return rows.length;
}

/** DELETE status/stories/:id (own) */
async function deleteStory(ctx, idRaw) {
  const id = posInt(idRaw);
  const r = id ? await store.one(ctx.gc, 'SELECT * FROM stories WHERE id = ? AND user_id = ?', [id, ctx.viewer]) : null;
  if (!r) throw fail('not_found');
  await dropStories(ctx, [r]);
  return { deleted: true };
}

/** POST status/stories/:id/seen */
async function seen(ctx, idRaw) {
  const r = await visibleStory(ctx, idRaw);
  if (r.user_id !== ctx.viewer) await store.run(ctx.gc, 'INSERT OR IGNORE INTO story_views (story_id, user_id, seen_at) VALUES (?, ?, ?)', [r.id, ctx.viewer, ctx.now]);
  return { seen: true };
}

/** GET status/stories/:id/viewers (own stories) → { viewers: [{ user, seenAt, reaction }] } */
async function viewers(ctx, idRaw) {
  const id = posInt(idRaw);
  const r = id ? await store.one(ctx.gc, 'SELECT * FROM stories WHERE id = ? AND user_id = ?', [id, ctx.viewer]) : null;
  if (!r) throw fail('not_found');
  const rows = await store.all(ctx.gc, 'SELECT * FROM story_views WHERE story_id = ? ORDER BY seen_at DESC', [id]);
  return { viewers: rows.filter((v) => ctx.users.has(v.user_id)).map((v) => ({ user: userOut(ctx, v.user_id), seenAt: iso(v.seen_at), reaction: v.reaction || null })) };
}

/** The preview of a story for `replyStory` of a message. */
function replyPreview(r) {
  const b = storyBody(r);
  const t = typeof b.text === 'string' ? b.text.slice(0, 100) : null;
  return { kind: r.kind, text: t, thumbMediaId: r.thumb_media_id || (r.kind === 'image' ? r.media_id : null) };
}

/**
 * messages.send with `replyStory: { storyId }` (a direct chat with the story's owner): checks and the
 * stored value → { storyId, ownerId, preview }.
 */
async function replyRef(ctx, conv, members, v) {
  const id = v && typeof v === 'object' && !Array.isArray(v) ? posInt(v.storyId) : null;
  if (!id || conv.kind !== 'direct') throw fail('invalid');
  const r = await store.one(ctx.gc, 'SELECT * FROM stories WHERE id = ? AND expires_at > ?', [id, ctx.now]);
  if (!r || r.user_id === ctx.viewer || !members.some((m) => m.user_id === r.user_id)) throw fail('invalid');
  const s = await social.load(ctx);
  if (!s.audience(r.visibility, parseJson(r.user_ids, []), ctx.viewer, r.user_id)) throw fail('invalid');
  return { storyId: r.id, ownerId: r.user_id, preview: replyPreview(r) };
}

/** Send a message into the direct chat with `peerId` (created when missing) — after the commit: event + push. */
async function sendDirect(ctx, peerId, body) {
  const r = await conversations.create(ctx, { kind: 'direct', userIds: [peerId] });
  const x = await conversations.access(ctx, r.conv.id);
  const res = await messages.send(ctx, x.conv, x.me, x.members, body);
  if (!res.duplicate) {
    messages.queueNew(ctx, x.conv, x.members, res.row);
    ctx.box.pushes.push({ conv: x.conv, members: x.members, row: res.row, text: res.text, meta: res.meta, title: null });
  }
  const rc = await conversations.receipts(ctx, x.conv, x.members);
  const me2 = await store.one(ctx.gc, 'SELECT * FROM members WHERE conv_id = ? AND user_id = ?', [x.conv.id, ctx.viewer]);
  return (await messages.views(ctx, me2, [res.row], rc))[0];
}

/** POST status/stories/:id/react { emoji } → { message } (a direct message to the owner with replyStory) */
async function react(ctx, idRaw, body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const emoji = b.emoji == null ? null : messages.cleanEmoji(b.emoji);
  if (!emoji) throw fail('invalid');
  const r = await visibleStory(ctx, idRaw);
  if (r.user_id === ctx.viewer) throw fail('invalid');
  await store.run(ctx.gc, `INSERT INTO story_views (story_id, user_id, seen_at, reaction) VALUES (?, ?, ?, ?)
    ON CONFLICT(story_id, user_id) DO UPDATE SET reaction = excluded.reaction`, [r.id, ctx.viewer, ctx.now, emoji]);
  const message = await sendDirect(ctx, r.user_id, { clientId: `story-${r.id}-${ctx.viewer}-${ctx.now}`.slice(0, 64), kind: 'text', text: emoji, replyStory: { storyId: r.id } });
  return { message };
}

/** GET status/feed → { items, me } — unseen first, then by the newest story; people with only a status last. */
async function feed(ctx) {
  const s = await social.load(ctx);
  const statusRows = await store.all(ctx.gc, 'SELECT * FROM statuses WHERE until IS NULL OR until > ?', [ctx.now]);
  const storyRows = ctx.cfg.allowStories ? await store.all(ctx.gc, 'SELECT * FROM stories WHERE expires_at > ? ORDER BY created_at ASC, id ASC', [ctx.now]) : [];
  const seenSet = new Set((await store.all(ctx.gc, 'SELECT story_id FROM story_views WHERE user_id = ?', [ctx.viewer])).map((r) => r.story_id));
  const kiosk = new Set((await store.all(ctx.gc, 'SELECT user_id FROM prefs WHERE kiosk = 1')).map((r) => r.user_id));
  const byUser = new Map();
  const entry = (u) => { if (!byUser.has(u)) byUser.set(u, { status: null, stories: [] }); return byUser.get(u); };
  for (const r of statusRows) {
    if (!ctx.users.has(r.user_id) || kiosk.has(r.user_id)) continue;
    const v = view(s, r, ctx.viewer, ctx.now);
    if (v) entry(r.user_id).status = v;
  }
  for (const r of storyRows) {
    if (!ctx.users.has(r.user_id) || kiosk.has(r.user_id)) continue;
    if (!s.audience(r.visibility, parseJson(r.user_ids, []), ctx.viewer, r.user_id)) continue;
    entry(r.user_id).stories.push(r);
  }
  const items = [];
  let me = { user: userOut(ctx, ctx.viewer), status: null, stories: [], unseen: false };
  for (const [u, e] of byUser) {
    const own = u === ctx.viewer;
    const stories = [];
    for (const r of e.stories) stories.push(await storyOut(ctx, r, seenSet, own));
    const item = { user: userOut(ctx, u), status: e.status, stories, unseen: !own && stories.some((x) => !x.seen) };
    if (own) me = item; else items.push(item);
  }
  const newest = (it) => (it.stories.length ? it.stories[it.stories.length - 1].createdAt : '');
  items.sort((a, b) => {
    if (a.unseen !== b.unseen) return a.unseen ? -1 : 1;
    const na = newest(a);
    const nb = newest(b);
    if (na !== nb) return na < nb ? 1 : -1;
    const ua = a.status ? a.status.updatedAt : '';
    const ub = b.status ? b.status.updatedAt : '';
    return ua < ub ? 1 : ua > ub ? -1 : a.user.id - b.user.id;
  });
  return { items, me, serverTime: iso(ctx.now) };
}

/** The statuses the viewer may see of these people (conversation members): Map id → status view. */
async function statusesFor(ctx, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const s = await social.load(ctx);
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    for (const r of await store.all(ctx.gc, `SELECT * FROM statuses WHERE user_id IN (${store.marks(part.length)})`, part)) {
      const v = view(s, r, ctx.viewer, ctx.now);
      if (v) out.set(r.user_id, v);
    }
  }
  return out;
}

/** Users with dnd right now (no chat pushes). */
async function dndUsers(gc, now) {
  return new Set((await store.all(gc, "SELECT user_id FROM statuses WHERE preset = 'dnd' AND (until IS NULL OR until > ?)", [now])).map((r) => r.user_id));
}

/** Background: expired statuses and stories. → { statuses, stories } */
async function expire(ctx) {
  const st = await store.all(ctx.gc, 'SELECT * FROM statuses WHERE until IS NOT NULL AND until <= ?', [ctx.now]);
  const s = await social.load(ctx);
  for (const r of st) {
    await store.run(ctx.gc, 'DELETE FROM statuses WHERE user_id = ?', [r.user_id]);
    live.queue(ctx.box, audienceOf(ctx, s, r.visibility, parseJson(r.user_ids, []), r.user_id), 'status.update', { userId: r.user_id });
  }
  const rows = await store.all(ctx.gc, 'SELECT * FROM stories WHERE expires_at <= ? LIMIT 500', [ctx.now]);
  const n = await dropStories(ctx, rows);
  return { statuses: st.length, stories: n };
}

/** May `viewer` read a story file? (mediaAccess) */
async function mediaAllowed(ctx, m) {
  if (!m.story_id) return false;
  const r = await store.one(ctx.gc, 'SELECT * FROM stories WHERE id = ? AND expires_at > ?', [m.story_id, ctx.now]);
  if (!r) return false;
  const s = await social.load(ctx);
  return s.audience(r.visibility, parseJson(r.user_ids, []), ctx.viewer, r.user_id);
}

/** Daily digest candidates: people with notify.statusDigest whose last digest is ≥ 20 h ago → [{ userId, names }]. */
async function digest(ctx) {
  const s = await social.load(ctx);
  const out = [];
  if (new Date(ctx.now).getHours() < DIGEST_HOUR) return out; // once a day, in the evening (server time)
  const rows = await store.all(ctx.gc, 'SELECT * FROM stories WHERE expires_at > ? AND created_at > ?', [ctx.now, ctx.now - STORY_TTL_MS]);
  if (!rows.length) return out;
  for (const [uid, p] of s.prefs) {
    if (!p.notify.statusDigest || !ctx.users.has(uid)) continue;
    const pr = await store.one(ctx.gc, 'SELECT digest_at FROM prefs WHERE user_id = ?', [uid]);
    const last = pr && pr.digest_at ? pr.digest_at : 0;
    if (ctx.now - last < 20 * 3600000) continue;
    const seenSet = new Set((await store.all(ctx.gc, 'SELECT story_id FROM story_views WHERE user_id = ?', [uid])).map((r) => r.story_id));
    const owners = [];
    for (const r of rows) {
      if (r.user_id === uid || r.created_at <= last || seenSet.has(r.id)) continue;
      if (!s.audience(r.visibility, parseJson(r.user_ids, []), uid, r.user_id)) continue;
      if (!owners.includes(r.user_id)) owners.push(r.user_id);
    }
    await store.run(ctx.gc, 'UPDATE prefs SET digest_at = ? WHERE user_id = ?', [ctx.now, uid]);
    if (owners.length) out.push({ userId: uid, lang: p.lang, names: owners.map((o) => (ctx.users.get(o) || {}).name).filter(Boolean) });
  }
  return out;
}

module.exports = {
  put, remove, setPlace, view, rowOf, feed, createStory, deleteStory, seen, viewers, react, replyRef, statusesFor, dndUsers, expire, mediaAllowed, digest, dropStories, sendDirect,
  PRESETS, VISIBILITY, FONTS, STATUS_TEXT_MAX, STORY_TEXT_MAX, STORY_TTL_MS, STORIES_MAX, line,
};
