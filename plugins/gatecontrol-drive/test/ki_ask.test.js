'use strict';

// Questions to the documents (1.14.0, server/ask.js) against the mock host's gc.ai: the question alone for the terms,
// the search without AI in the files one reads (areas with AI for documents on, never the trash), excerpts to the AI, an
// answer only with a real quote, not_found, a deadline of a source the answer names, 30 questions an hour, the errors.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, LENA, BOB } = require('./helpers');

const POLICY = 'Musterversicherung AG\nVersicherungsschein Kfz\nVertragslaufzeit: 01.01.2026 bis 31.12.2026, Verlängerung um jeweils ein Jahr.\nBeitrag 312,50 EUR';
const TERMS = 'Allgemeine Bedingungen Kfz-Versicherung\n' + 'Lorem ipsum dolor sit amet. '.repeat(120) + '\nKündigung spätestens einen Monat vor Ablauf.\n' + 'Weiterer Text. '.repeat(100);
const BILL = 'Stadtwerke Musterstadt\nRechnung Strom Oktober\nGesamtbetrag 84,20 EUR';

/** The AI: documents (a deadline on the policy), terms of a question, an answer from the excerpts. */
function ai(o = {}) {
  return {
    ...o,
    extract: async (req) => {
      if (req.task === 'drive_document') {
        const text = req.input.find((x) => x.label === 'Document text').text;
        if (/Versicherungsschein/.test(text)) {
          return { kind: 'insurance', title: 'Kfz-Versicherung', date: '2026-01-02', sender: 'Musterversicherung AG', amount: null, currency: null, folder: null, name: null,
            deadlines: [{ kind: 'renewal', date: '2026-11-30', label: 'Kfz-Versicherung kündigen' }] };
        }
        return { kind: 'other', title: null, date: null, sender: null, amount: null, currency: null, folder: null, name: null, deadlines: [] };
      }
      if (req.task === 'drive_ask_terms') {
        if (o.terms) return o.terms(req);
        return { terms: ['Kfz', 'Versicherung', 'Kündigung', 'Laufzeit'], kind: 'insurance', sender: null, year: null };
      }
      if (req.task === 'drive_ask_answer') {
        if (o.answer) return o.answer(req);
        const ex = req.input.filter((x) => /^Excerpt /.test(x.label));
        const policy = ex.findIndex((x) => /Versicherungsschein/.test(x.text));
        const terms = ex.findIndex((x) => /Kündigung spätestens/.test(x.text));
        return {
          found: true, answer: 'Die Kfz-Versicherung läuft bis 31.12.2026 und verlängert sich jeweils um ein Jahr. Kündigen kannst du bis 30.11.2026.',
          sources: [{ doc: policy + 1, quote: '„Vertragslaufzeit: 01.01.2026 bis 31.12.2026, Verlängerung um jeweils ein Jahr“' }, { doc: terms + 1, quote: 'Kündigung spätestens einen Monat vor Ablauf' }],
        };
      }
      throw new Error('unexpected task ' + req.task);
    },
  };
}

async function setup(host, c) {
  const mine = await c.area(ANNA, 'mine');
  const fam = await c.area(ANNA, 'family');
  const ins = (await c.as(ANNA)('POST', 'nodes', { parentId: mine.rootId, name: 'Versicherungen' })).json.node;
  const policy = (await c.put(ANNA, ins.id, 'Versicherungsschein Kfz 2026.pdf', 'p1', { mime: 'application/pdf', text: POLICY })).json.node;
  const terms = (await c.put(ANNA, ins.id, 'Versicherungsbedingungen Kfz.pdf', 'p2', { mime: 'application/pdf', text: TERMS })).json.node;
  const bill = (await c.put(ANNA, fam.rootId, 'Stadtwerke.pdf', 'p3', { mime: 'application/pdf', text: BILL })).json.node;
  await host.tick();
  await host.tick();
  host.aiRequests.length = 0;
  return { mine, fam, ins, policy, terms, bill };
}

test('an answer from my files: the question alone for the terms, excerpts, sources with quotes, the deadline it names', async () => {
  await withHost({ ai: ai() }, async (host, c) => {
    const x = await setup(host, c);
    const a = c.as(ANNA);
    const me = (await a('GET', 'me')).json;
    assert.ok(me.features.includes('docAsk'));
    const r = await a('POST', 'ask', { q: 'Bis wann kann ich die Kfz-Versicherung kündigen?' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.status, 'answered');
    assert.match(r.json.answer, /30\.11\.2026/);
    assert.deepEqual(r.json.terms, ['kfz', 'versicherung', 'kündigung', 'laufzeit']);
    assert.deepEqual(r.json.areas, ['Meine Dateien', 'Familie Berg']);
    assert.deepEqual(r.json.sources.map((s) => [s.nodeId, s.name, s.path, s.areaId, s.page]), [
      [x.policy.id, 'Versicherungsschein Kfz 2026.pdf', 'Versicherungen/Versicherungsschein Kfz 2026.pdf', x.mine.id, null],
      [x.terms.id, 'Versicherungsbedingungen Kfz.pdf', 'Versicherungen/Versicherungsbedingungen Kfz.pdf', x.mine.id, null],
    ]);
    assert.equal(r.json.sources[0].quote, 'Vertragslaufzeit: 01.01.2026 bis 31.12.2026, Verlängerung um jeweils ein Jahr', 'quotation marks cut');
    // the deadline the answer names (30.11.2026) of the policy
    assert.deepEqual([r.json.deadline.kind, r.json.deadline.date, r.json.deadline.nodeId, r.json.deadline.calendar], ['renewal', '2026-11-30', x.policy.id, null]);

    // what went to the AI: first the question alone, then excerpts of the hits only
    const [t, ans] = host.aiRequests;
    assert.deepEqual([t.task, t.user], ['drive_ask_terms', ANNA.id]);
    assert.deepEqual(t.input.map((i) => i.label), ['Question', 'Today']);
    assert.equal(ans.task, 'drive_ask_answer');
    const ex = ans.input.filter((i) => /^Excerpt /.test(i.label));
    assert.equal(ex.length, 2, 'the electricity bill is no hit');
    const long = ex.find((i) => /bedingungen/.test(i.label)).text;
    assert.ok(long.length <= 2100, 'about 2 000 characters: the start and the part around the hits');
    assert.match(long, /^Allgemeine Bedingungen Kfz-Versicherung/);
    assert.match(long, /Kündigung spätestens/);
    assert.match(ex.find((i) => /Versicherungsschein/.test(i.label)).text, /^Titel: Kfz-Versicherung · Absender: Musterversicherung AG/);
  });
});

test('nothing found: no hit (no second request), a made-up quote, the AI says so — "Gesucht nach"', async () => {
  let answer = null;
  await withHost({ ai: ai({ answer: (req) => answer(req), terms: (req) => (/Hund/.test(req.input[0].text) ? { terms: ['Hund', 'Impfpass'], kind: null, sender: null, year: null } : { terms: ['Kfz'], kind: null, sender: null, year: null }) }) }, async (host, c) => {
    await setup(host, c);
    const a = c.as(ANNA);
    let r = await a('POST', 'ask', { q: 'Wann muss der Hund geimpft werden?' });
    assert.deepEqual(r.json, { ok: true, status: 'not_found', answer: null, sources: [], terms: ['hund', 'impfpass'], areas: ['Meine Dateien', 'Familie Berg'], deadline: null });
    assert.equal(host.aiRequests.length, 1, 'only the terms');
    answer = () => ({ found: true, answer: 'Am 1. Mai.', sources: [{ doc: 1, quote: 'Ein Satz, der nirgends steht' }] });
    r = await a('POST', 'ask', { q: 'Was steht zur Kfz?' });
    assert.equal(r.json.status, 'not_found', 'an answer without a real quote is none');
    answer = () => ({ found: false, answer: null, sources: [] });
    r = await a('POST', 'ask', { q: 'Was steht zur Kfz?' });
    assert.equal(r.json.status, 'not_found');
    answer = () => ({ found: true, answer: 'Ja.', sources: [{ doc: 7, quote: 'Kfz' }] });
    assert.equal((await a('POST', 'ask', { q: 'Was steht zur Kfz?' })).json.status, 'not_found', 'a source that is no excerpt');
  });
});

test('rights: only files one reads, areas with AI for documents on, never the trash; area narrows it', async () => {
  await withHost({ ai: ai() }, async (host, c) => {
    const x = await setup(host, c);
    // Bob reads none of these
    let r = await c.as(BOB)('POST', 'ask', { q: 'Bis wann kann ich die Kfz-Versicherung kündigen?' });
    assert.equal(r.json.status, 'not_found');
    // Lena's folder (AI off by default) is not searched, even by Lena
    const child = await c.area(LENA, 'child');
    await c.put(LENA, child.rootId, 'Kfz.pdf', 'p', { mime: 'application/pdf', text: POLICY });
    r = await c.as(LENA)('POST', 'ask', { q: 'Kfz-Versicherung?' });
    assert.deepEqual(r.json.areas, ['Meine Dateien', 'Familie Berg'], 'her own files and the family\'s, not "Kinder · Lena"');
    assert.equal(r.json.status, 'not_found');
    // Marc: the family's files only — and only the family area when asked so
    r = await c.as(MARC)('POST', 'ask', { q: 'Kfz-Versicherung?', area: x.fam.id });
    assert.deepEqual([r.json.status, r.json.areas], ['not_found', ['Familie Berg']]);
    assert.equal((await c.as(MARC)('POST', 'ask', { q: 'Kfz?', area: x.mine.id })).status, 404);
    // the trash is never searched
    await c.as(ANNA)('DELETE', `nodes/${x.policy.id}`);
    await c.as(ANNA)('DELETE', `nodes/${x.terms.id}`);
    r = await c.as(ANNA)('POST', 'ask', { q: 'Bis wann kann ich die Kfz-Versicherung kündigen?' });
    assert.equal(r.json.status, 'not_found');
    // the question
    assert.equal((await c.as(ANNA)('POST', 'ask', { q: 'a' })).status, 400);
    assert.equal((await c.as(ANNA)('POST', 'ask', { q: 'x'.repeat(301) })).status, 400);
  });
});

test('30 questions an hour, AI off or failing', async () => {
  await withHost({ ai: ai() }, async (host, c) => {
    await setup(host, c);
    const a = c.as(ANNA);
    for (let i = 0; i < 30; i++) assert.equal((await a('POST', 'ask', { q: 'Kfz?' })).status, 200);
    const r = await a('POST', 'ask', { q: 'Kfz?' });
    assert.deepEqual([r.status, r.json.code], [429, 'rate_limited']);
    // others may still ask; an hour later Anna too
    assert.equal((await c.as(MARC)('POST', 'ask', { q: 'Kfz?' })).status, 200);
    c.clock.add(3600001);
    assert.equal((await a('POST', 'ask', { q: 'Kfz?' })).status, 200);
    // the budget is used up
    host.ai.budgetLeftCents = 0;
    const b = await a('POST', 'ask', { q: 'Kfz?' });
    assert.deepEqual([b.status, b.json.code], [409, 'ai_budget']);
  });
  await withHost({ ai: ai(), settings: { doc_ai: false } }, async (host, c) => {
    const me = (await c.as(ANNA)('GET', 'me')).json;
    assert.ok(!me.features.includes('docAsk') && !me.features.includes('scanDocs'));
    const r = await c.as(ANNA)('POST', 'ask', { q: 'Kfz?' });
    assert.deepEqual([r.status, r.json.code], [403, 'feature_off']);
  });
  await withHost({}, async (host, c) => {
    assert.equal((await c.as(ANNA)('POST', 'ask', { q: 'Kfz?' })).json.code, 'feature_off');
  });
});
