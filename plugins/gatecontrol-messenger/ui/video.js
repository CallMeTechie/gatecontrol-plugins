/* Previews of files the portal sends (1.3.0): duration, size and a frame at about 1 s of an MP4 video,
   the first page of a PDF when the frame already has a PDF renderer (window.pdfjsLib) — else nothing.
   The frame CSP allows neither blob: nor data: media (media-src only /plugin-media/), so a <video> element
   cannot open the picked file: the MP4 is read here (moov box → sample table), the frame decoded with
   WebCodecs (VideoDecoder; H.264, HEVC, VP9, AV1 as the browser supports them) and drawn on a canvas.
   Previews: WebP (JPEG where the browser cannot write WebP), ≤ 640 px a side, ≤ 64 KB. Anything that does
   not work gives no preview (or no meta) — the file is sent anyway. window.MSVideo; module.exports for tests. */
(function (root) {
  'use strict';

  var THUMB_SIDE = 640;
  var THUMB_BYTES = 64 * 1024;
  var TARGET_MS = 1000;
  var MOOV_MAX = 32 * 1024 * 1024;
  var SAMPLES_MAX = 2000000;
  var FEED_MAX = 300;
  var READ_MAX = 32 * 1024 * 1024;
  var VIDEO_MAX_MS = 24 * 3600 * 1000;
  var VIDEO_MAX_SIDE = 16384;

  // ── reading ──
  function read(file, off, len) {
    var part = file.slice(off, off + len);
    if (typeof part.arrayBuffer === 'function') return part.arrayBuffer();
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error || new Error('read')); };
      fr.readAsArrayBuffer(part);
    });
  }
  function fourcc(dv, o) { return String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3)); }
  function u64(dv, o) { return dv.getUint32(o) * 4294967296 + dv.getUint32(o + 4); }

  /** The top-level box `moov` of an MP4/MOV file → ArrayBuffer (its payload starts at 8 or 16). */
  function readMoov(file) {
    var off = 0;
    function step() {
      if (off + 8 > file.size) return Promise.reject(new Error('no moov'));
      return read(file, off, 16).then(function (ab) {
        var dv = new DataView(ab);
        var size = dv.getUint32(0);
        var type = fourcc(dv, 4);
        var head = 8;
        if (size === 1) { if (dv.byteLength < 16) throw new Error('bad box'); size = u64(dv, 8); head = 16; } else if (size === 0) size = file.size - off;
        if (size < head) throw new Error('bad box');
        if (type === 'moov') {
          if (size > MOOV_MAX) throw new Error('moov too large');
          return read(file, off, size).then(function (m) { return { buf: m, head: head }; });
        }
        off += size;
        return step();
      });
    }
    return step();
  }

  /** The boxes in [start, end) → [{ type, start (payload), end }]. */
  function boxes(dv, start, end) {
    var out = [];
    var o = start;
    while (o + 8 <= end) {
      var size = dv.getUint32(o);
      var head = 8;
      if (size === 1) { if (o + 16 > end) break; size = u64(dv, o + 8); head = 16; } else if (size === 0) size = end - o;
      if (size < head || o + size > end) break;
      out.push({ type: fourcc(dv, o + 4), start: o + head, end: o + size });
      o += size;
    }
    return out;
  }
  function child(dv, box, type) {
    if (!box) return null;
    var l = boxes(dv, box.start, box.end);
    for (var i = 0; i < l.length; i++) if (l[i].type === type) return l[i];
    return null;
  }
  function children(dv, box, type) { return box ? boxes(dv, box.start, box.end).filter(function (b) { return b.type === type; }) : []; }
  function hex2(n) { return (n < 16 ? '0' : '') + n.toString(16); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function bytes(dv, b) { return new Uint8Array(dv.buffer, dv.byteOffset + b.start, b.end - b.start).slice(); }

  /** time scale and duration of an mvhd / mdhd box. */
  function timing(dv, b) {
    if (!b) return null;
    var v = dv.getUint8(b.start);
    var p = b.start + 4;
    return v === 1 ? { scale: dv.getUint32(p + 16), duration: u64(dv, p + 20) } : { scale: dv.getUint32(p + 8), duration: dv.getUint32(p + 12) };
  }

  /** tkhd: presentation size and the rotation of its matrix (0, 90, 180, 270 — clockwise). */
  function trackHeader(dv, b) {
    if (!b) return { width: 0, height: 0, rotation: 0 };
    var v = dv.getUint8(b.start);
    var m = b.start + (v === 1 ? 52 : 40);
    var a = dv.getInt32(m) / 65536;
    var bb = dv.getInt32(m + 4) / 65536;
    var deg = Math.round(Math.atan2(bb, a) * 180 / Math.PI);
    var rotation = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
    return { width: Math.round(dv.getUint32(m + 36) / 65536), height: Math.round(dv.getUint32(m + 40) / 65536), rotation: rotation };
  }

  /** WebCodecs codec string (+ description) from the first sample entry of stsd. */
  function codecOf(dv, stsd) {
    if (!stsd || dv.getUint32(stsd.start + 4) < 1) return null;
    var e = stsd.start + 8;
    var size = dv.getUint32(e);
    var type = fourcc(dv, e + 4);
    var p = e + 8;
    var entry = { type: type, codedWidth: dv.getUint16(p + 24), codedHeight: dv.getUint16(p + 26), codec: null, description: null };
    var inner = { start: p + 78, end: Math.min(e + size, stsd.end) };
    var c;
    if (type === 'avc1' || type === 'avc3') {
      c = child(dv, inner, 'avcC');
      if (!c) return entry;
      entry.codec = type + '.' + hex2(dv.getUint8(c.start + 1)) + hex2(dv.getUint8(c.start + 2)) + hex2(dv.getUint8(c.start + 3));
      entry.description = bytes(dv, c);
    } else if (type === 'hvc1' || type === 'hev1') {
      c = child(dv, inner, 'hvcC');
      if (!c) return entry;
      var b1 = dv.getUint8(c.start + 1);
      var compat = dv.getUint32(c.start + 2);
      var rev = 0;
      for (var i = 0; i < 32; i++) if (compat & (1 << i)) rev |= (1 << (31 - i));
      var cons = [];
      for (var k = 0; k < 6; k++) cons.push(dv.getUint8(c.start + 6 + k));
      while (cons.length && cons[cons.length - 1] === 0) cons.pop();
      entry.codec = type + '.' + ['', 'A', 'B', 'C'][b1 >> 6] + (b1 & 31) + '.' + (rev >>> 0).toString(16) + '.' + ((b1 & 32) ? 'H' : 'L') + dv.getUint8(c.start + 12)
        + cons.map(function (x) { return '.' + x.toString(16); }).join('');
      entry.description = bytes(dv, c);
    } else if (type === 'vp09') {
      c = child(dv, inner, 'vpcC');
      if (!c) return entry;
      entry.codec = 'vp09.' + pad2(dv.getUint8(c.start + 4)) + '.' + pad2(dv.getUint8(c.start + 5)) + '.' + pad2(dv.getUint8(c.start + 6) >> 4);
    } else if (type === 'av01') {
      c = child(dv, inner, 'av1C');
      if (!c) return entry;
      var x1 = dv.getUint8(c.start + 1);
      var x2 = dv.getUint8(c.start + 2);
      var depth = (x2 & 64) ? ((x2 & 32) ? 12 : 10) : 8;
      entry.codec = 'av01.' + (x1 >> 5) + '.' + pad2(x1 & 31) + ((x2 & 128) ? 'H' : 'M') + '.' + pad2(depth);
    }
    return entry;
  }

  /** The sample table of a track → { n, offset[], size[], dts[], cts[], sync (Uint8Array) } or null. */
  function sampleTable(dv, stbl) {
    var stsz = child(dv, stbl, 'stsz');
    var stz2 = child(dv, stbl, 'stz2');
    var stsc = child(dv, stbl, 'stsc');
    var stco = child(dv, stbl, 'stco');
    var co64 = child(dv, stbl, 'co64');
    var stts = child(dv, stbl, 'stts');
    if ((!stsz && !stz2) || !stsc || (!stco && !co64) || !stts) return null;
    var n;
    var size = [];
    var i;
    if (stsz) {
      var fixed = dv.getUint32(stsz.start + 4);
      n = dv.getUint32(stsz.start + 8);
      if (n > SAMPLES_MAX) return null;
      for (i = 0; i < n; i++) size.push(fixed || dv.getUint32(stsz.start + 12 + i * 4));
    } else {
      var field = dv.getUint8(stz2.start + 7);
      n = dv.getUint32(stz2.start + 8);
      if (n > SAMPLES_MAX || [4, 8, 16].indexOf(field) < 0) return null;
      for (i = 0; i < n; i++) {
        var q = stz2.start + 12;
        size.push(field === 16 ? dv.getUint16(q + i * 2) : (field === 8 ? dv.getUint8(q + i) : ((dv.getUint8(q + (i >> 1)) >> ((i & 1) ? 0 : 4)) & 15)));
      }
    }
    if (!n) return null;
    // offsets: chunks (stco / co64) × samples per chunk (stsc)
    var chunks = [];
    var co = stco || co64;
    var nc = dv.getUint32(co.start + 4);
    for (i = 0; i < nc; i++) chunks.push(stco ? dv.getUint32(co.start + 8 + i * 4) : u64(dv, co.start + 8 + i * 8));
    var runs = [];
    var nr = dv.getUint32(stsc.start + 4);
    for (i = 0; i < nr; i++) runs.push({ first: dv.getUint32(stsc.start + 8 + i * 12), per: dv.getUint32(stsc.start + 12 + i * 12) });
    var offset = [];
    var s = 0;
    for (var r = 0; r < runs.length && s < n; r++) {
      var last = r + 1 < runs.length ? runs[r + 1].first - 1 : nc;
      for (var ch = runs[r].first; ch <= last && s < n; ch++) {
        var o = chunks[ch - 1];
        if (o == null) break;
        for (var j = 0; j < runs[r].per && s < n; j++) { offset.push(o); o += size[s]; s++; }
      }
    }
    if (offset.length < n) return null;
    // times: stts (decode deltas), ctts (composition offsets; version 1 signed)
    var dts = [];
    var t = 0;
    var ne = dv.getUint32(stts.start + 4);
    for (i = 0; i < ne && dts.length < n; i++) {
      var cnt = dv.getUint32(stts.start + 8 + i * 8);
      var delta = dv.getUint32(stts.start + 12 + i * 8);
      for (var k = 0; k < cnt && dts.length < n; k++) { dts.push(t); t += delta; }
    }
    while (dts.length < n) dts.push(t);
    var cts = dts.slice();
    var ctts = child(dv, stbl, 'ctts');
    if (ctts) {
      var signed = dv.getUint8(ctts.start) === 1;
      var nct = dv.getUint32(ctts.start + 4);
      s = 0;
      for (i = 0; i < nct && s < n; i++) {
        var c2 = dv.getUint32(ctts.start + 8 + i * 8);
        var off = signed ? dv.getInt32(ctts.start + 12 + i * 8) : dv.getUint32(ctts.start + 12 + i * 8);
        for (var k2 = 0; k2 < c2 && s < n; k2++) { cts[s] += off; s++; }
      }
    }
    var sync = new Uint8Array(n);
    var stss = child(dv, stbl, 'stss');
    if (stss) {
      var nss = dv.getUint32(stss.start + 4);
      for (i = 0; i < nss; i++) { var idx = dv.getUint32(stss.start + 8 + i * 4) - 1; if (idx >= 0 && idx < n) sync[idx] = 1; }
    } else sync.fill(1);
    return { n: n, offset: offset, size: size, dts: dts, cts: cts, sync: sync };
  }

  /**
   * moov payload → { durationMs, width, height (as shown: rotation applied), video: { codec, description, codedWidth,
   * codedHeight, rotation, scale, samples } | null }.
   */
  function parseMoov(buf, head) {
    var dv = new DataView(buf);
    var moov = { start: head == null ? 8 : head, end: buf.byteLength };
    var mv = timing(dv, child(dv, moov, 'mvhd'));
    var out = { durationMs: null, width: null, height: null, video: null };
    var traks = children(dv, moov, 'trak');
    for (var i = 0; i < traks.length; i++) {
      var mdia = child(dv, traks[i], 'mdia');
      var hdlr = child(dv, mdia, 'hdlr');
      if (!hdlr || fourcc(dv, hdlr.start + 8) !== 'vide') continue;
      var md = timing(dv, child(dv, mdia, 'mdhd'));
      var th = trackHeader(dv, child(dv, traks[i], 'tkhd'));
      var stbl = child(dv, child(dv, mdia, 'minf'), 'stbl');
      var entry = codecOf(dv, child(dv, stbl, 'stsd'));
      var w = th.width || (entry && entry.codedWidth) || 0;
      var h = th.height || (entry && entry.codedHeight) || 0;
      if (th.rotation % 180) { var x = w; w = h; h = x; }
      out.width = w || null;
      out.height = h || null;
      if (md && md.scale && md.duration) out.durationMs = Math.round(md.duration * 1000 / md.scale);
      var samples = null;
      try { samples = sampleTable(dv, stbl); } catch (e) { samples = null; }
      if (entry && entry.codec && samples && md && md.scale) {
        out.video = { codec: entry.codec, description: entry.description, codedWidth: entry.codedWidth, codedHeight: entry.codedHeight, rotation: th.rotation, scale: md.scale, samples: samples };
      }
      break;
    }
    if (mv && mv.scale && mv.duration) out.durationMs = Math.round(mv.duration * 1000 / mv.scale);
    return out;
  }

  /** Which samples to decode for the frame at `targetMs`: from the last sync sample before it. */
  function pick(video, targetMs) {
    var s = video.samples;
    var i;
    // presentation starts at the lowest composition time (B-frames shift it, e.g. by two frames)
    var first = Infinity;
    for (i = 0; i < s.n; i++) if (s.cts[i] < first) first = s.cts[i];
    var target = first + targetMs / 1000 * video.scale;
    var key = -1;
    for (i = 0; i < s.n; i++) if (s.sync[i] && s.cts[i] <= target && (key < 0 || s.cts[i] >= s.cts[key])) key = i;
    if (key < 0) for (i = 0; i < s.n; i++) if (s.sync[i]) { key = i; break; }
    if (key < 0) return null;
    var list = [key];
    var slack = video.scale / 2;
    for (i = key + 1; i < s.n && list.length < FEED_MAX; i++) {
      if (s.sync[i] || s.dts[i] > target + slack) break;
      list.push(i);
    }
    return { key: key, list: list, target: Math.round(target * 1e6 / video.scale) };
  }

  /** The meta the server takes: integers in bounds, anything else left out. */
  function meta(info) {
    var v = {};
    if (info && Number.isInteger(info.durationMs) && info.durationMs >= 0 && info.durationMs <= VIDEO_MAX_MS) v.durationMs = info.durationMs;
    ['width', 'height'].forEach(function (k) { if (info && Number.isInteger(info[k]) && info[k] >= 1 && info[k] <= VIDEO_MAX_SIDE) v[k] = info[k]; });
    return Object.keys(v).length ? v : null;
  }

  // ── decoding, drawing ──
  function canDecode() { return typeof root.VideoDecoder === 'function' && typeof root.EncodedVideoChunk === 'function'; }

  /** Decode the picked samples → the VideoFrame nearest the target (the caller closes it). */
  function decodeFrame(file, video, sel) {
    var s = video.samples;
    var lo = Infinity;
    var hi = 0;
    sel.list.forEach(function (i) { lo = Math.min(lo, s.offset[i]); hi = Math.max(hi, s.offset[i] + s.size[i]); });
    if (!(hi > lo) || hi - lo > READ_MAX) return Promise.reject(new Error('range'));
    var cfg = { codec: video.codec, codedWidth: video.codedWidth, codedHeight: video.codedHeight };
    if (video.description) cfg.description = video.description;
    var frames = [];
    var failed = null;
    var dec = null;
    return root.VideoDecoder.isConfigSupported(cfg).then(function (r) {
      if (!r || !r.supported) throw new Error('unsupported codec');
      return read(file, lo, hi - lo);
    }).then(function (ab) {
      dec = new root.VideoDecoder({ output: function (f) { frames.push(f); }, error: function (e) { failed = e || new Error('decode'); } });
      dec.configure(cfg);
      sel.list.forEach(function (i) {
        dec.decode(new root.EncodedVideoChunk({ type: i === sel.key ? 'key' : 'delta', timestamp: Math.round(s.cts[i] * 1e6 / video.scale), data: new Uint8Array(ab, s.offset[i] - lo, s.size[i]) }));
      });
      return dec.flush();
    }).then(function () {
      if (failed) throw failed;
      var best = null;
      frames.forEach(function (f) { if (!best || Math.abs(f.timestamp - sel.target) < Math.abs(best.timestamp - sel.target)) best = f; });
      frames.forEach(function (f) { if (f !== best) f.close(); });
      if (!best) throw new Error('no frame');
      return best;
    }).then(function (f) { try { dec.close(); } catch (e) { /* closed */ } return f; }, function (e) {
      frames.forEach(function (f) { try { f.close(); } catch (x) { /* closed */ } });
      if (dec) try { dec.close(); } catch (x) { /* closed */ }
      throw e;
    });
  }

  function canvas(w, h) { var cv = root.document.createElement('canvas'); cv.width = Math.max(1, Math.round(w)); cv.height = Math.max(1, Math.round(h)); return cv; }

  /** A source (frame, canvas) on a canvas ≤ side px, turned by `rotation` degrees clockwise. */
  function draw(src, sw, sh, rotation, side) {
    var turned = rotation % 180 !== 0;
    var dw = turned ? sh : sw;
    var dh = turned ? sw : sh;
    var k = Math.min(1, side / Math.max(dw, dh));
    var cv = canvas(dw * k, dh * k);
    var g = cv.getContext('2d');
    g.translate(cv.width / 2, cv.height / 2);
    if (rotation) g.rotate(rotation * Math.PI / 180);
    var w = turned ? cv.height : cv.width;
    var h = turned ? cv.width : cv.height;
    g.drawImage(src, -w / 2, -h / 2, w, h);
    return cv;
  }

  function toBlob(cv, type, q) { return new Promise(function (resolve) { cv.toBlob(function (b) { resolve(b); }, type, q); }); }

  /** A canvas → { blob, w, h } as WebP (else JPEG), ≤ 64 KB — smaller and coarser until it fits; null when never. */
  function encode(cv) {
    var tries = [];
    [THUMB_SIDE, 480, 320].forEach(function (side) { [0.72, 0.55, 0.4].forEach(function (q) { tries.push({ side: side, q: q }); }); });
    function next(i) {
      if (i >= tries.length) return Promise.resolve(null);
      var t = tries[i];
      var src = Math.max(cv.width, cv.height) > t.side ? draw(cv, cv.width, cv.height, 0, t.side) : cv;
      return toBlob(src, 'image/webp', t.q).then(function (b) {
        return b && b.type === 'image/webp' ? b : toBlob(src, 'image/jpeg', t.q);
      }).then(function (b) {
        return b && b.size <= THUMB_BYTES ? { blob: b, w: src.width, h: src.height } : next(i + 1);
      });
    }
    return next(0);
  }

  function within(p, ms) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error('timeout')); }, ms);
      p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }

  /**
   * An MP4 video file → { meta: { durationMs, width, height } | null, thumb: { blob, w, h } | null };
   * opts.thumb false: no preview. Never rejects: what cannot be read is null.
   */
  function videoInfo(file, opts) {
    var o = opts || {};
    var out = { meta: null, thumb: null };
    return within(readMoov(file).then(function (m) {
      var info = parseMoov(m.buf, m.head);
      out.meta = meta(info);
      if (o.thumb === false || !info.video || !canDecode() || !root.document) return out;
      var target = info.durationMs ? Math.min(TARGET_MS, Math.floor(info.durationMs / 2)) : TARGET_MS;
      var sel = pick(info.video, target);
      if (!sel) return out;
      return decodeFrame(file, info.video, sel).then(function (frame) {
        var cv;
        try { cv = draw(frame, frame.displayWidth, frame.displayHeight, info.video.rotation, THUMB_SIDE); } finally { frame.close(); }
        return encode(cv);
      }).then(function (t) { out.thumb = t; return out; }, function () { return out; });
    }), o.timeoutMs || 15000).catch(function () { return out; });
  }

  /** The first page of a PDF → { blob, w, h } | null — only with a PDF renderer already in the frame. */
  function pdfThumb(file, opts) {
    var lib = root.pdfjsLib;
    if (!lib || typeof lib.getDocument !== 'function' || !root.document) return Promise.resolve(null);
    return within(read(file, 0, file.size).then(function (ab) {
      return lib.getDocument({ data: new Uint8Array(ab) }).promise;
    }).then(function (pdf) { return pdf.getPage(1); }).then(function (page) {
      var v1 = page.getViewport({ scale: 1 });
      var vp = page.getViewport({ scale: Math.min(2, THUMB_SIDE / Math.max(v1.width, v1.height)) });
      var cv = canvas(Math.floor(vp.width), Math.floor(vp.height));
      var g = cv.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, cv.width, cv.height);
      return page.render({ canvasContext: g, viewport: vp }).promise.then(function () { return encode(cv); });
    }), (opts && opts.timeoutMs) || 10000).catch(function () { return null; });
  }

  var api = { videoInfo: videoInfo, pdfThumb: pdfThumb, readMoov: readMoov, parseMoov: parseMoov, pick: pick, meta: meta, encode: encode, THUMB_SIDE: THUMB_SIDE, THUMB_BYTES: THUMB_BYTES };
  root.MSVideo = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
