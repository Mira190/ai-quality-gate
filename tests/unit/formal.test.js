'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCfg } = require('../../src/extract/formal');
const { classify } = require('../../src/scan/inventory');
const { ciFindings } = require('../../src/findings');
const { loadConfig } = require('../../src/config');

test('GATE-31 the invariants and properties a TLA+ configuration names are read, whichever way they are laid out', () => {
  const cfg = '\\* two events are enough\nCONSTANTS\n    Events = {e1, e2}\n\nSPECIFICATION Spec\n\nINVARIANTS\n    TypeOK\n    StoredBeforeAck\n    LoggedOnce   \\* once\n\nPROPERTIES\n    NothingLost\n\nCHECK_DEADLOCK FALSE\n';
  assert.deepEqual(parseCfg(cfg), ['TypeOK', 'StoredBeforeAck', 'LoggedOnce', 'NothingLost']);
  assert.deepEqual(parseCfg('INVARIANT Safe\nPROPERTY Live Fair\nCONSTANT N = 3\n'), ['Safe', 'Live', 'Fair']);
  assert.deepEqual([classify('spec/Inbox.tla').kind, classify('spec/Inbox.cfg').kind, classify('config/app.cfg').kind], ['spec', 'spec', 'other']);
});

test('GATE-31 a model checker that is only run by hand is one finding that lists the properties it alone proves', () => {
  const { config } = loadConfig(null);
  const inventory = { byKind: { ci: [{ path: '.github/workflows/ci.yml' }], test: [{ path: 'a.test.ts' }] }, langs: { js: 3, ts: 3 } };
  const check = { id: 'specs', title: 'Formal models', state: 'configured', need: 'required', where: [], configured: '3 TLA+ models, checked by `npm run tla`' };
  const proofs = ['Inbox.StoredBeforeAck', 'Inbox.NothingLost'].map((id, i) => ({ rule: { id, formal: true, critical: i === 0 } }));
  const [f] = ciFindings({ hasCI: true, checks: [check] }, inventory, config, proofs);
  assert.deepEqual([f.check, f.priority, f.basis], ['ci.specs', 'P1', 'S']);
  assert.match(f.detail, /Formal models are set up \(3 TLA\+ models, checked by `npm run tla`\) and no CI step runs them.* 2 properties of the design are proven only by it \(1 critical\): Inbox\.StoredBeforeAck, Inbox\.NothingLost\./);
  assert.match(f.fix, /Run the model checker in a pull-request job/);
});
