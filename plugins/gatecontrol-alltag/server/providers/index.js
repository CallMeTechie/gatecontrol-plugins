'use strict';

// The online waste providers. Each adapter offers the guided lookup of the
// admin page (service → place → street → house number) and the dates of a
// configured plan; all of them only reach the hosts in plugin.json.

const regioit = require('./regioit');
const abfallio = require('./abfallio');
const awido = require('./awido');

const LIST = [regioit, abfallio, awido];
const BY_ID = new Map(LIST.map((p) => [p.id, p]));

function get(id) { return BY_ID.get(id) || null; }

/** Plain description for the admin page. */
function describe() {
  return LIST.map((p) => ({ id: p.id, title: p.title, services: p.services }));
}

/** Internet hosts all providers need (plugin.json must declare them). */
function hosts() { return [...new Set(LIST.flatMap((p) => p.hosts))]; }

module.exports = { LIST, get, describe, hosts };
