'use strict';

// GateControl 1.225.0 in the tooling: ui.settingsPages (tabs of their own under Einstellungen › Plugins) and
// notifyTopics[].email (pushes also by e-mail) — optional keys an older GateControl ignores, checked here by the rules of
// docs/plugins.md and left out for the pinned validator.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withoutNewerKeys } = require('../validate');

const PAGES = [{ id: 'overview', title: 'Ü' }, { id: 'resources', title: 'R' }, { id: 'boxes', title: 'B' }, { id: 'settings', title: 'E' }];
const base = (ui, topics) => ({ ui: { pages: PAGES, settingsPage: 'settings', ...ui }, ...(topics ? { notifyTopics: topics } : {}) });

test('ui.settingsPages: up to 4 ids of ui.pages, never the first, never the settings page, none twice, none reserved', () => {
  const ok = withoutNewerKeys(base({ settingsPages: ['resources', 'boxes'] }), '1.219.0');
  assert.deepEqual([ok.errors, ok.removed, 'settingsPages' in ok.copy.ui], [[], ['ui.settingsPages (1.225.0)'], false]);
  for (const [v, err] of [[['overview'], 'invalid'], [['settings'], 'invalid'], [['nope'], 'invalid'], [['resources', 'resources'], 'invalid'], ['resources', 'invalid'],
    [['resources', 'boxes', 'x', 'y', 'z'], 'invalid']]) {
    assert.deepEqual(withoutNewerKeys(base({ settingsPages: v }), '1.219.0').errors, [`ui.settingsPages: ${err}`], JSON.stringify(v));
  }
  const reserved = withoutNewerKeys({ ui: { pages: [{ id: 'main' }, { id: 'log' }], settingsPages: ['log'] } }, '1.219.0');
  assert.deepEqual(reserved.errors, ['ui.settingsPages: reserved']);
  // the pinned GateControl knows it: nothing left out
  assert.deepEqual(withoutNewerKeys(base({ settingsPages: ['resources'] }), '1.225.0').removed, []);
});

test('notifyTopics[].email: a boolean, never on a chat topic; left out for an older validator, other topics untouched', () => {
  const w = withoutNewerKeys(base({}, [{ id: 'a', label: 'A', email: true }, { id: 'b', label: 'B' }]), '1.219.0');
  assert.deepEqual([w.errors, w.removed, w.copy.notifyTopics], [[], ['notifyTopics (1.225.0)'], [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]]);
  assert.deepEqual(withoutNewerKeys(base({}, [{ id: 'a', label: 'A' }]), '1.219.0').removed, [], 'no email: nothing to leave out');
  assert.deepEqual(withoutNewerKeys(base({}, [{ id: 'a', label: 'A', email: 'yes' }]), '1.219.0').errors, ['notifyTopics: invalid']);
  assert.deepEqual(withoutNewerKeys(base({}, [{ id: 'c', label: 'C', chat: true, email: true }]), '1.219.0').errors, ['notifyTopics: chat topic cannot be mailed']);
});
