'use strict';

// "Videos umwandeln", step 1: the rules for the three target devices against Jellyfin items (test/fixtures/media-items.json).

const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../server/convert-rules');
const { items } = require('./fixtures/media-items.json');

const byName = (n) => items.find((x) => x.Name === n);
const codes = (j) => j.reasons.map((r) => r.code);
const NONE = { phone: 'no', tv: 'no', windows: 'no' };

test('H.264 High 10 (yuv420p10le) 1080p50 with AAC and ASS: convert, no device plays it, estimate like the Entwurf', () => {
  const j = rules.judgeItem(byName('Die stille Werft'));
  assert.equal(j.level, 'convert');
  assert.deepEqual(codes(j), ['h264_10bit']);
  assert.equal(j.reasons[0].label, 'H.264 10-Bit');
  assert.deepEqual(j.devices, NONE);
  assert.equal(j.estimate.kind, 'encode');
  // 812 MB, 22:41 → about 1,2–1,6 GB and 15–30 minutes on a J3455
  assert.ok(j.estimate.size > 1.0e9 && j.estimate.size < 1.6e9, String(j.estimate.size));
  assert.ok(j.estimate.minutes >= 15 && j.estimate.minutes <= 30, String(j.estimate.minutes));
  assert.equal(j.video, 'h264 · High 10 · 10 Bit · yuv420p10le · 1920×1080 · 50 fps · SDR');
  assert.equal(j.source.fps, 50);
  assert.equal(j.source.runtime, 1361);
});

test('10 bit known only from the pixel format, DTS-HD MA as the default track: convert + info', () => {
  const j = rules.judgeItem(byName('Die Uhrmacherin'));
  assert.equal(j.level, 'convert');
  assert.deepEqual(codes(j), ['h264_10bit', 'audio_hd']);
  assert.equal(j.reasons[1].label, 'DTS-HD MA');
  assert.equal(j.reasons[1].level, 'info');
  assert.deepEqual(j.reasons[1].devices, { phone: 'no', tv: 'maybe', windows: 'no' });
  assert.equal(rules.bitDepthOf({ PixelFormat: 'yuv420p10le' }), 10);
});

test('PGS next to 10 bit: both reasons, the level stays convert', () => {
  const j = rules.judgeItem(byName('Leuchtfeuer'));
  assert.deepEqual(codes(j), ['h264_10bit', 'image_subs']);
  assert.equal(j.reasons[1].label, 'PGS');
  assert.equal(j.level, 'convert');
});

test('HEVC Main 10 HDR10 with E-AC3: notice (the NAS decodes it in hardware), Windows no because of the audio', () => {
  const j = rules.judgeItem(byName('Gipfelglühen'));
  assert.equal(j.level, 'hint');
  assert.deepEqual(codes(j), ['hevc_10bit', 'audio_ac3']);
  assert.equal(j.reasons[0].label, 'HEVC 10-Bit HDR');
  assert.deepEqual(j.reasons[0].devices, { phone: 'maybe', tv: 'yes', windows: 'maybe' });
  assert.deepEqual(j.devices, { phone: 'maybe', tv: 'yes', windows: 'no' });
  assert.equal(j.estimate.kind, 'encode');
});

test('HEVC Main 10 SDR without BitDepth: notice without "HDR"', () => {
  const r = rules.reasonsOf({ Container: 'mkv', MediaStreams: [{ Type: 'Video', Codec: 'hevc', Profile: 'Main 10', VideoRangeType: 'SDR' }] });
  assert.deepEqual(r.map((x) => [x.code, x.label, x.level]), [['hevc_10bit', 'HEVC 10-Bit', 'hint']]);
});

test('TrueHD + PGS on 8-bit HEVC: only shown (Frage 98 a) — notice for Windows, info for the audio, nothing to convert', () => {
  const j = rules.judgeItem(byName('Wolkenkante'));
  assert.equal(j.level, 'hint');
  assert.deepEqual(codes(j), ['audio_hd', 'image_subs']);
  assert.equal(j.reasons[0].label, 'TrueHD');
  assert.equal(j.estimate, null);
  assert.deepEqual(j.devices, { phone: 'no', tv: 'maybe', windows: 'no' });
});

test('DTS alone is info, AAC is nothing', () => {
  const v = { Type: 'Video', Codec: 'h264', Profile: 'High', BitDepth: 8, PixelFormat: 'yuv420p' };
  const dts = rules.judgeItem({ MediaSources: [{ Container: 'mkv', MediaStreams: [v, { Type: 'Audio', Codec: 'dts', Profile: 'DTS', IsDefault: true }] }] });
  assert.equal(dts.level, 'info');
  assert.deepEqual(codes(dts), ['audio_hd']);
  assert.equal(dts.estimate, null);
  const aac = rules.judgeItem({ MediaSources: [{ Container: 'mkv', MediaStreams: [v, { Type: 'Audio', Codec: 'aac', IsDefault: true }] }] });
  assert.equal(aac.level, null);
  assert.deepEqual(aac.reasons, []);
  assert.deepEqual(aac.devices, { phone: 'yes', tv: 'yes', windows: 'yes' });
  // a DTS track that is not the default does not count
  const second = rules.reasonsOf({ MediaStreams: [v, { Type: 'Audio', Codec: 'aac', IsDefault: true }, { Type: 'Audio', Codec: 'dts' }] });
  assert.deepEqual(second, []);
});

test('8-bit H.264: no row; a cover image (mjpeg) is not the video', () => {
  assert.equal(rules.judgeItem(byName('Ankunft')).level, null);
  const j = rules.judgeItem(byName('Neue Klasse'));
  assert.deepEqual(codes(j), ['h264_10bit']);
});

test('MPEG-4 ASP in AVI, Dolby Vision 5, H.264 4:2:2, interlaced MPEG-2 with VobSub, AV1', () => {
  const avi = rules.judgeItem(byName('Kinderfest am See'));
  assert.equal(avi.level, 'hint');
  assert.deepEqual(avi.reasons.map((r) => r.label), ['MPEG-4 ASP', 'AVI']);
  assert.deepEqual(avi.devices, { phone: 'maybe', tv: 'maybe', windows: 'no' });
  assert.equal(avi.estimate.kind, 'encode');

  const dv = rules.judgeItem(byName('Nachtfalter'));
  assert.equal(dv.level, 'convert');
  assert.equal(dv.reasons[0].code, 'dovi');
  assert.equal(dv.reasons[0].label, 'Dolby Vision 5');
  assert.deepEqual(dv.reasons[0].devices, { phone: 'maybe', tv: 'yes', windows: 'no' });

  const c422 = rules.judgeItem(byName('Hafenfest'));
  assert.deepEqual(c422.reasons.map((r) => [r.code, r.label]), [['chroma', 'H.264 4:2:2']]);
  assert.equal(c422.level, 'convert');

  const dvd = rules.judgeItem(byName('Die Brücke am Kanal'));
  assert.deepEqual(codes(dvd), ['legacy_video', 'audio_ac3', 'image_subs', 'interlaced']);
  assert.equal(dvd.level, 'hint');
  assert.deepEqual(dvd.reasons.map((r) => r.label), ['MPEG-2', 'AC3', 'VobSub', 'Interlaced']);

  const av1 = rules.judgeItem(byName('Polarlicht über Tromsø'));
  assert.equal(av1.level, 'hint');
  assert.deepEqual(av1.devices, { phone: 'maybe', tv: 'yes', windows: 'yes' });
});

test('a remux only (H.264 8 bit in AVI): about a minute, size unchanged', () => {
  const s = { Container: 'avi', Size: 700e6, RunTimeTicks: 60 * 60 * 1e7, MediaStreams: [{ Type: 'Video', Codec: 'h264', Profile: 'High', BitDepth: 8, PixelFormat: 'yuv420p' }] };
  const r = rules.reasonsOf(s);
  assert.deepEqual(r.map((x) => x.code), ['container']);
  assert.deepEqual(rules.estimateOf(s, r), { kind: 'remux', size: 700e6, minutes: 1 });
});

test('several versions: the best one counts (a film with an 8-bit version is not listed)', () => {
  const j = rules.judgeItem(byName('Zwei Ufer'));
  assert.equal(j.level, null);
  assert.match(j.source.path, / - 1080p\.mkv$/);
});

test('items without media sources are not judged; TranscodeReasons from an array or a string', () => {
  assert.equal(rules.judgeItem({ Id: 'x', MediaSources: [] }), null);
  assert.equal(rules.judgeItem({ Id: 'x' }), null);
  assert.deepEqual(rules.transcodeReasons(['VideoBitDepthNotSupported', 'bad value!']), ['VideoBitDepthNotSupported']);
  assert.deepEqual(rules.transcodeReasons('VideoCodecNotSupported, AudioCodecNotSupported'), ['VideoCodecNotSupported', 'AudioCodecNotSupported']);
});
