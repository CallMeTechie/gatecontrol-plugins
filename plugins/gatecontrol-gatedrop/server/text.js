'use strict';

const texts = require('./texts.json');

/** The text `key` in `lang` with {{placeholders}}. */
function t(lang, key, params) {
  const l = lang === 'en' ? 'en' : 'de';
  let s = (texts[l] && texts[l][key]) || texts.de[key] || key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{{${k}}}`).join(String(v));
  return s;
}

module.exports = { t, texts };
