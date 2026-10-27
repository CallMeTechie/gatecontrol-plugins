'use strict';

// Work after the answer (NAS and Drive uploads may take minutes): one chain, errors logged. idle() for tests.

let chain = Promise.resolve();

function queue(fn, gc) {
  chain = chain.then(fn).catch((e) => { try { gc.log.warn('background delivery failed', (e && (e.code || e.message)) || 'error'); } catch { /* no log */ } });
  return chain;
}

const idle = () => chain;

module.exports = { queue, idle };
