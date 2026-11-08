'use strict';

// Texts of the server (pushes, default names) and of the portal (texts.json "de" / "en"; {{name}} placeholders).

const texts = require('./texts.json');

function t(lang, key, params) {
  const l = lang === 'en' ? 'en' : 'de';
  let s = texts[l][key] != null ? texts[l][key] : texts.de[key] != null ? texts.de[key] : key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.split('{{' + k + '}}').join(String(v == null ? '' : v));
  return s;
}

module.exports = { t, texts };
