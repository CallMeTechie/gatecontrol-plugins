'use strict';

// Ported from GateControl tests/smarthome_rules_objects.test.js (built-in Smart Home).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const T = require('../server/translate');

const R = {
  12: { deconz_id: '12', deconz_type: 'sensors', kind: 'sensor', capabilities: {} },
  30: { deconz_id: '30', deconz_type: 'groups', kind: 'group', capabilities: { on: true } },
};
const resolve = (id) => R[id];

test('no delay → single rule object', () => {
  const def = { triggers: [{ kind: 'motion', resourceId: 12, event: 'detected' }], actions: [{ kind: 'group', resourceId: 30, set: { on: true } }] };
  const { objects } = T.buildRuleObjects(def, resolve, 'GC:1:test');
  assert.equal(objects.length, 1);
  assert.equal(objects[0].type, 'rule');
});

test('onRetrigger ignore → rule + schedule', () => {
  const def = { triggers: [{ kind: 'motion', resourceId: 12, event: 'ended' }], actions: [{ kind: 'group', resourceId: 30, set: { on: false } }], delay: { minutes: 5, onRetrigger: 'ignore' } };
  const { objects } = T.buildRuleObjects(def, resolve, 'GC:1:t');
  assert.deepEqual(objects.map((o) => o.type), ['schedule', 'rule']);
});

test('onRetrigger reset → rule + schedule + reset-rule', () => {
  const def = { triggers: [{ kind: 'motion', resourceId: 12, event: 'ended' }], actions: [{ kind: 'group', resourceId: 30, set: { on: false } }], delay: { minutes: 5, onRetrigger: 'reset' } };
  const { objects } = T.buildRuleObjects(def, resolve, 'GC:1:t');
  assert.deepEqual(objects.map((o) => o.type), ['schedule', 'rule', 'rule']);
});

test('onRetrigger cancel → clip + rule + cancel-rule when supported', () => {
  const def = { triggers: [{ kind: 'motion', resourceId: 12, event: 'ended' }], actions: [{ kind: 'group', resourceId: 30, set: { on: false } }], delay: { minutes: 5, onRetrigger: 'cancel' } };
  const { objects, effectiveOnRetrigger } = T.buildRuleObjects(def, resolve, 'GC:1:t');
  assert.equal(effectiveOnRetrigger, require('../server/caps').cancelSupported ? 'cancel' : 'reset');
  if (effectiveOnRetrigger === 'cancel') {
    assert.deepEqual(objects.map((o) => o.type), ['clip', 'schedule', 'rule', 'rule']);
    const arm = objects.find((o) => o.ref === 'arm');
    assert.ok(arm.payload.actions.some((a) => a.body && a.body.flag === true)); // arm setzt das CLIP-Flag
    const cancel = objects.find((o) => o.ref === 'cancel');
    assert.ok(cancel.payload.actions.some((a) => a.body && a.body.flag === false)); // cancel löscht das Flag
  }
});

test('cancel mode with only a button trigger is rejected (no binary-invertible trigger)', () => {
  const def = { triggers: [{ kind: 'button', resourceId: 12, button: 1, action: 'short' }], actions: [{ kind: 'group', resourceId: 30, set: { on: false } }], delay: { minutes: 5, onRetrigger: 'cancel' } };
  if (require('../server/caps').cancelSupported) {
    assert.throws(() => T.buildRuleObjects(def, resolve, 'GC:1:t'), (e) => e.code === 'SMARTHOME_RULE_INVALID' && e.detail === 'cancel_requires_binary_trigger');
  }
});
