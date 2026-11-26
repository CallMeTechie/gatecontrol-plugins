'use strict';

// "Videos umwandeln", step 1 (Entwurf vom 26.11., Fragen 92–102): which films and episodes do not play everywhere.
// Pure rules over what Jellyfin knows about a file (MediaSources[].MediaStreams), no I/O. Fixed rules for the three
// target devices (Frage 97 a): an Android phone, the Fire TV Cube (3rd gen.) and the Windows app (Chromium). The NAS
// is assumed to be an Intel Apollo Lake (J3455/J3355/N3350, the values of the Entwurf):
//   hardware decode  H.264 8 bit, HEVC 8/10 bit, VP9, MPEG-2, VC-1   ·   hardware encode  H.264 8 bit, HEVC 8 bit
// so 10-bit H.264 is decoded in software and does not keep up live at 1080p50.
//
// Three levels: convert — at least one device cannot play it and the NAS cannot convert it live smoothly;
// hint — Jellyfin converts it live and the NAS manages; info — it only stands out. Per device: yes | maybe | no.

const LEVELS = { convert: 3, hint: 2, info: 1 };
const DEVICES = ['phone', 'tv', 'windows'];
const DEV_RANK = { no: 0, maybe: 1, yes: 2 };

// cover art and the like that Jellyfin lists as a video stream
const STILL_CODECS = new Set(['mjpeg', 'png', 'bmp', 'gif', 'webp', 'jpeg']);
const LEGACY_VIDEO = {
  mpeg2video: { label: 'MPEG-2', decode: 'hw' }, mpeg1video: { label: 'MPEG-1', decode: 'sw8' }, vc1: { label: 'VC-1', decode: 'hw' },
  mpeg4: { label: 'MPEG-4 ASP', decode: 'sw8' }, msmpeg4v1: { label: 'MPEG-4 (MS)', decode: 'sw8' }, msmpeg4v2: { label: 'MPEG-4 (MS)', decode: 'sw8' },
  msmpeg4v3: { label: 'MPEG-4 (MS)', decode: 'sw8' }, wmv1: { label: 'WMV', decode: 'sw8' }, wmv2: { label: 'WMV', decode: 'sw8' },
  wmv3: { label: 'WMV', decode: 'sw8' }, h263: { label: 'H.263', decode: 'sw8' }, flv1: { label: 'FLV1', decode: 'sw8' },
};
const OLD_CONTAINERS = { avi: 'AVI', asf: 'WMV', wmv: 'WMV', flv: 'FLV' };
const HD_AUDIO = new Set(['dts', 'truehd', 'mlp']);
const AC3_AUDIO = { ac3: 'AC3', eac3: 'E-AC3' };
const IMAGE_SUBS = { pgssub: 'PGS', hdmv_pgs_subtitle: 'PGS', pgs: 'PGS', dvd_subtitle: 'VobSub', dvdsub: 'VobSub', vobsub: 'VobSub', dvb_subtitle: 'DVB', dvbsub: 'DVB' };

const low = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const short = (v, max = 40) => (typeof v === 'string' ? v.replace(/[\0-\x1f\x7f]/g, ' ').trim().slice(0, max) : '');

/** The first real video stream (no cover art), the default audio stream (else the first), the subtitle streams. */
function streamsOf(source) {
  const all = Array.isArray(source && source.MediaStreams) ? source.MediaStreams.filter((s) => s && typeof s === 'object') : [];
  const video = all.find((s) => s.Type === 'Video' && !STILL_CODECS.has(low(s.Codec))) || null;
  const audios = all.filter((s) => s.Type === 'Audio');
  const audio = audios.find((s) => s.IsDefault) || audios[0] || null;
  return { video, audio, audios, subs: all.filter((s) => s.Type === 'Subtitle') };
}

function bitDepthOf(v) {
  const d = num(v.BitDepth);
  if (d) return d;
  const pf = low(v.PixelFormat);
  const m = /p(9|10|12|14|16)(le|be)$/.exec(pf);
  if (m) return Number(m[1]);
  if (/\b(high 10|main 10)\b/.test(low(v.Profile))) return 10;
  return pf ? 8 : null;
}

const reason = (code, level, label, devices, video) => ({ code, level, label, devices: { phone: devices[0], tv: devices[1], windows: devices[2] }, ...(video ? { decode: video } : {}) });

/** Every rule that applies to one media source → [{ code, level, label, devices, decode? }] in the order of the table. */
function reasonsOf(source) {
  const out = [];
  const { video: v, audio: a, subs } = streamsOf(source);
  if (v) {
    const codec = low(v.Codec);
    const profile = low(v.Profile);
    const pf = low(v.PixelFormat);
    const depth = bitDepthOf(v);
    const range = String(v.VideoRangeType || '');
    const chroma = (codec === 'h264' || codec === 'hevc')
      && (/^yuv4(22|44)p/.test(pf) || /4:2:2|4:4:4|rext/.test(profile) || (depth != null && depth >= 12));
    if (chroma) {
      const label = /^yuv444p|4:4:4/.test(pf + ' ' + profile) ? '4:4:4' : (/^yuv422p|4:2:2/.test(pf + ' ' + profile) ? '4:2:2' : '12-Bit');
      out.push(reason('chroma', 'convert', (codec === 'h264' ? 'H.264 ' : 'HEVC ') + label, ['no', 'no', 'no'], 'sw10'));
    } else if (codec === 'h264' && ((depth != null && depth > 8) || /high 10/.test(profile) || /10(le|be)$/.test(pf))) {
      out.push(reason('h264_10bit', 'convert', 'H.264 10-Bit', ['no', 'no', 'no'], 'sw10'));
    } else if (range === 'DOVI') {
      // Dolby Vision without a fallback layer (profile 5): wrong colours without DV, tone mapping on the NAS is too slow
      out.push(reason('dovi', 'convert', 'Dolby Vision' + (num(v.DvProfile) ? ' ' + v.DvProfile : ''), ['maybe', 'yes', 'no'], 'hw'));
    } else if (codec === 'hevc' && depth != null && depth >= 10) {
      out.push(reason('hevc_10bit', 'hint', 'HEVC 10-Bit' + (/^HDR10|^HLG|^DOVI/.test(range) ? ' HDR' : ''), ['maybe', 'yes', 'maybe'], 'hw'));
    } else if (codec === 'av1') {
      out.push(reason('av1', 'hint', 'AV1', ['maybe', 'yes', 'yes'], 'sw8'));
    } else if (LEGACY_VIDEO[codec]) {
      out.push(reason('legacy_video', 'hint', LEGACY_VIDEO[codec].label, ['maybe', 'maybe', 'no'], LEGACY_VIDEO[codec].decode));
    }
  }
  const containers = low(source && source.Container).split(',').map((x) => x.trim()).filter(Boolean);
  const old = containers.find((c) => OLD_CONTAINERS[c]);
  if (old) out.push(reason('container', 'hint', OLD_CONTAINERS[old], ['maybe', 'maybe', 'no']));
  if (a) {
    const ac = low(a.Codec);
    if (HD_AUDIO.has(ac)) {
      const p = short(a.Profile, 24);
      const label = ac === 'dts' ? (/^dts/i.test(p) ? p : 'DTS') : 'TrueHD';
      out.push(reason('audio_hd', 'info', label, ['no', 'maybe', 'no']));
    } else if (AC3_AUDIO[ac]) {
      out.push(reason('audio_ac3', 'info', AC3_AUDIO[ac], ['maybe', 'yes', 'no']));
    }
  }
  const img = subs.map((s) => IMAGE_SUBS[low(s.Codec)]).find(Boolean);
  if (img) out.push(reason('image_subs', 'hint', img, ['yes', 'yes', 'no']));
  if (v && v.IsInterlaced === true) out.push(reason('interlaced', 'info', 'Interlaced', ['yes', 'yes', 'yes']));
  return out;
}

/** Per device the worst value over the reasons (no reasons → yes everywhere). */
function devicesOf(reasons) {
  const d = { phone: 'yes', tv: 'yes', windows: 'yes' };
  for (const r of reasons) for (const k of DEVICES) if (DEV_RANK[r.devices[k]] < DEV_RANK[d[k]]) d[k] = r.devices[k];
  return d;
}

function levelOf(reasons) {
  let best = null;
  for (const r of reasons) if (!best || LEVELS[r.level] > LEVELS[best]) best = r.level;
  return best;
}

// ── Estimates (Entwurf Abschnitt 3; not measured — the spike S0 measures the real rate on the NAS) ──
// Target H.264 High 8 bit by Intel hardware, VBR ≈ 8 Mbit/s at 1080p50; audio, subtitles, chapters, fonts copied.
// Speed in pixels per second (throttled: 3 threads, nice 19): the 10-bit source is decoded in software (≈ 45 B/s at
// 1080p — a 20-minute episode in 1080p50 ≈ 22 min), a source the GPU decodes about twice as fast, other software
// decoding of 8-bit material in between.
const PX_1080 = 1920 * 1080;
const RATE = { sw10: PX_1080 * 45, hw: PX_1080 * 100, sw8: PX_1080 * 75 };
const BASE_BPS = 8e6;
const AUDIO_GUESS_BPS = { 1: 96e3, 2: 192e3, 6: 640e3, 8: 1.5e6 };

function runtimeOf(source, item) {
  const ticks = num(source && source.RunTimeTicks) || num(item && item.RunTimeTicks);
  return ticks ? Math.round(ticks / 1e7) : null;
}

/**
 * What converting one media source would take → { kind: 'encode' | 'remux', size, minutes } (size in bytes, both
 * rounded estimates), or null when nothing about the video would change (audio, subtitles or interlacing only).
 */
function estimateOf(source, reasons, item) {
  const runtime = runtimeOf(source, item);
  const size = num(source && source.Size);
  const video = reasons.find((r) => r.decode);
  if (!video) {
    if (!reasons.some((r) => r.code === 'container')) return null;
    return { kind: 'remux', size: size || null, minutes: 1 };
  }
  const { video: v, audios } = streamsOf(source);
  if (!v || !runtime) return { kind: 'encode', size: null, minutes: null };
  const w = num(v.Width) || 1920;
  const h = num(v.Height) || 1080;
  const fps = num(v.RealFrameRate) || num(v.AverageFrameRate) || 25;
  const px = w * h;
  const videoBps = Math.max(1.5e6, BASE_BPS * Math.min(2.2, Math.max(0.25, px / PX_1080)) * (fps > 30 ? 1 : 0.75));
  let otherBps = 0;
  for (const a of audios) otherBps += num(a.BitRate) || AUDIO_GUESS_BPS[num(a.Channels)] || 384e3;
  const newSize = Math.round(((videoBps + otherBps) * runtime) / 8);
  const minutes = Math.max(1, Math.round((runtime * fps * px) / RATE[video.decode] / 60));
  return { kind: 'encode', size: newSize, minutes };
}

/** One line about the video ("h264 · High 10 · 10 Bit · yuv420p10le · 1920×1080 · 50 B/s · SDR"). */
function videoSummary(source) {
  const { video: v } = streamsOf(source);
  if (!v) return null;
  const depth = bitDepthOf(v);
  const fps = num(v.RealFrameRate) || num(v.AverageFrameRate);
  return [short(v.Codec, 20), short(v.Profile, 30), depth ? depth + ' Bit' : '', short(v.PixelFormat, 20),
    num(v.Width) && num(v.Height) ? v.Width + '×' + v.Height : '', fps ? Math.round(fps * 100) / 100 + ' fps' : '',
    short(v.VideoRangeType, 20), v.IsInterlaced ? 'interlaced' : ''].filter(Boolean).join(' · ');
}

/**
 * Judge one Jellyfin item (Movie / Episode with MediaSources). With several versions of a file the best one counts:
 * a film with one version that plays everywhere is not on the list. → { level, reasons, devices, estimate, video,
 * source: { id, path, container, size, runtime, fps } } — level null for a file without anything to report.
 */
function judgeItem(item) {
  const sources = Array.isArray(item && item.MediaSources) ? item.MediaSources.filter((s) => s && typeof s === 'object') : [];
  if (!sources.length) return null;
  let best = null;
  for (const s of sources) {
    const reasons = reasonsOf(s);
    const level = levelOf(reasons);
    const rank = level ? LEVELS[level] : 0;
    if (!best || rank < best.rank) best = { s, reasons, level, rank };
  }
  const s = best.s;
  const { video: v } = streamsOf(s);
  return {
    level: best.level,
    reasons: best.reasons,
    devices: devicesOf(best.reasons),
    estimate: best.level ? estimateOf(s, best.reasons, item) : null,
    video: videoSummary(s),
    source: {
      id: short(s.Id, 64) || null, path: typeof s.Path === 'string' ? s.Path.slice(0, 1000) : (typeof item.Path === 'string' ? item.Path.slice(0, 1000) : null),
      container: short(s.Container, 40) || null, size: num(s.Size), runtime: runtimeOf(s, item),
      fps: v ? (num(v.RealFrameRate) || num(v.AverageFrameRate)) : null,
    },
  };
}

/** Jellyfin's TranscodeReasons: an array or a comma-separated string → at most 10 names. */
function transcodeReasons(v) {
  const list = Array.isArray(v) ? v : (typeof v === 'string' ? v.split(',') : []);
  return list.map((x) => short(String(x), 40)).filter((x) => /^[A-Za-z0-9]+$/.test(x)).slice(0, 10);
}

module.exports = { LEVELS, DEVICES, reasonsOf, devicesOf, levelOf, estimateOf, judgeItem, videoSummary, streamsOf, bitDepthOf, transcodeReasons, RATE };
