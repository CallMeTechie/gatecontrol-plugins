'use strict';

// Builds test/fixtures/sample.nsx — a small Synology Note Station / DS Note export as DS Note writes it (a ZIP: config.json,
// one JSON entry per notebook and note, file_<md5> per attachment; stored and deflated entries). One note is protected
// with the password "geheim" in the CryptoJS / OpenSSL passphrase form ui/nsx.js reads. Deterministic (fixed salt, times).
//   node test/fixtures/build-nsx.js   (writes sample.nsx next to this file)

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6360f8cfc00000030101009c5c0dff0000000049454e44ae426082', 'hex');
const PDF = Buffer.from('%PDF-1.4\n% fixture\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');

function openssl(text, password, salt) {
  let d = Buffer.alloc(0);
  let prev = Buffer.alloc(0);
  while (d.length < 48) { prev = crypto.createHash('md5').update(Buffer.concat([prev, Buffer.from(password), salt])).digest(); d = Buffer.concat([d, prev]); }
  const c = crypto.createCipheriv('aes-256-cbc', d.subarray(0, 32), d.subarray(32, 48));
  return Buffer.concat([Buffer.from('Salted__'), salt, c.update(text, 'utf8'), c.final()]).toString('base64');
}

function entries() {
  const nb1 = 'NB1aaaa', nb2 = 'NB2bbbb';
  const img = 'MTU0OTU1NDk1NjQ3OXxpbWcx';
  const notes = {
    N1note1: { title: 'Gartenhaus Maße', parent_id: nb1, ctime: 1760000000, mtime: 1762500000, tag: ['garten', 'bauen'],
      content: `<div><h2>Maße</h2><p>Breite <b>2,40 m</b>, Tiefe <i>1,80 m</i> &amp; Dach 15&nbsp;°.</p><img class="syno-notestation-image-object" src="webman/3rdparty/NoteStation/images/transparent.gif" ref="${img}"></div>`,
      attachment: { a1: { md5: md5(PNG), name: 'skizze.png', type: 'image/png', size: PNG.length, ref: img }, a2: { md5: md5(PDF), name: 'Angebot.pdf', size: PDF.length } }, encrypt: false },
    N2note2: { title: 'Packliste Harz', parent_id: nb1, ctime: 1761000000, mtime: 1762400000, tag: [],
      content: '<ul class="syno-notestation-checklist"><li class="checked">Zahnbürste</li><li>Wanderschuhe</li></ul><table><tr><td>Tag</td><td>Ziel</td></tr><tr><td>Sa</td><td>Brocken</td></tr></table><p>Link: <a href="https://example.com/harz">Wetter</a></p>', encrypt: false },
    N3note3: { title: 'Lasagne (Oma)', parent_id: nb2, ctime: 1755000000, mtime: 1757000000, tag: ['rezept'], content: '<p>500 g Hack</p><ol><li>Soße</li><li>Schichten</li></ol>', encrypt: false },
    N4note4: { title: 'Versicherungen', parent_id: nb2, ctime: 1750000000, mtime: 1751000000, tag: [], encrypt: true,
      content: openssl('<p>Police <b>4711</b></p>', 'geheim', Buffer.from('0102030405060708', 'hex')) },
  };
  const out = [['config.json', JSON.stringify({ note: Object.keys(notes), notebook: [nb1, nb2], shortcut: {} })],
    [nb1, JSON.stringify({ title: 'Haushalt', ctime: 1750000000, mtime: 1760000000 })], [nb2, JSON.stringify({ title: 'Rezepte & Dokumente', ctime: 1750000000, mtime: 1760000000 })]];
  for (const [id, n] of Object.entries(notes)) out.push([id, JSON.stringify(n)]);
  out.push(['file_' + md5(PNG), PNG], ['file_' + md5(PDF), PDF]);
  return out;
}

function zip(list) {
  const parts = [];
  const central = [];
  let off = 0;
  list.forEach(([name, data], i) => {
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const deflate = i % 2 === 0;
    const body = deflate ? zlib.deflateRawSync(raw) : raw;
    const crc = zlib.crc32(raw);
    const nm = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(0, 10); lh.writeUInt32LE(crc >>> 0, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nm.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, nm, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8); ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt32LE(0, 12); ch.writeUInt32LE(crc >>> 0, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nm.length, 28);
    ch.writeUInt32LE(off, 42);
    central.push(ch, nm);
    off += 30 + nm.length + body.length;
  });
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(list.length, 8); end.writeUInt16LE(list.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}

if (require.main === module) fs.writeFileSync(path.join(__dirname, 'sample.nsx'), zip(entries()));
module.exports = { entries, zip, PNG, PDF };
