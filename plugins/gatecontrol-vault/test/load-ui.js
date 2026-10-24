'use strict';

// Loads the portal tab's browser scripts (ui/vendor/noble.js, ui/crypto.js, ui/logic.js) into this Node process the
// way the frame runs them: plain scripts on a global object (window.VaultNoble, window.VaultCrypto,
// window.VaultLogic). Node 22 has globalThis.crypto.getRandomValues, TextEncoder and TextDecoder like a browser.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const UI = path.join(__dirname, '..', 'ui');
let loaded = null;

function loadUi() {
  if (loaded) return loaded;
  for (const f of ['vendor/noble.js', 'crypto.js', 'logic.js']) {
    vm.runInThisContext(fs.readFileSync(path.join(UI, f), 'utf8'), { filename: path.join(UI, f) });
  }
  loaded = { N: globalThis.VaultNoble, VC: globalThis.VaultCrypto, L: globalThis.VaultLogic };
  return loaded;
}

module.exports = { loadUi, UI };
