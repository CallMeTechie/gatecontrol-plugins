'use strict';

// 1.19.1 — initials of the pages (ui/common.js): whole characters, letters and digits only. A WhatsApp chat named
// „Schatzimausi 💕“ showed „S“ and a replacement mark (half an emoji: the first UTF-16 unit of the heart).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function pages() {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'ui', 'common.js'), 'utf8'), { window, document: {} });
  return window.MS;
}

test('initials: never half an emoji, never an emoji, letters of any script', () => {
  const { initials } = pages();
  assert.equal(initials('Schatzimausi 💕'), 'S');
  assert.equal(initials('💕'), '', 'only emoji: none — the avatar shows the person symbol');
  assert.equal(initials('💕 ❤️ 👨‍👩‍👧'), '');
  assert.equal(initials('Ä Ö'), 'ÄÖ');
  assert.equal(initials('Ärger'), 'ÄR', 'a letter written with a combining mark stays whole');
  assert.equal(initials('van der Berg'), 'VB');
  assert.equal(initials('Kim'), 'KI');
  assert.equal(initials('💕Mama'), 'MA');
  assert.equal(initials('(Kim) Muster'), 'KM');
  assert.equal(initials('Οδυσσέας Ελύτης'), 'ΟΕ');
  assert.equal(initials('李 小龍'), '李小');
  assert.equal(initials('2 Pac'), '2P');
  assert.equal(initials(''), '');
  assert.equal(initials(null), '');
  const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  for (const s of ['Schatzimausi 💕', '💕 x', 'a 💕', '\u{1D49C}lice \u{1D505}ob']) assert.doesNotMatch(initials(s), LONE, `no half character of ${s}`);
  assert.equal(initials('\u{1D49C}lice \u{1D505}ob'), '\u{1D49C}\u{1D505}', 'letters outside the BMP: whole');
});
