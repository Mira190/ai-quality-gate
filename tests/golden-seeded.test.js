'use strict';
// The seeded golden set, offline (no model): every case builds, and every check code decides finds exactly what was
// seeded in the cases written against its vocabulary. The "hard" cases (real-world CI setups) are known gaps,
// reported by scripts/eval-golden.js, not asserted here; when a fix closes one, move it out of the hard group.
const test = require('node:test');
const assert = require('node:assert');
const { CASES, filesOf } = require('../bench/golden/seeded/cases');
const { seeded } = require('../scripts/eval-golden');

test('every seeded case applies to the base', () => {
  for (const c of CASES) assert.doesNotThrow(() => filesOf(c), c.id);
  assert.strictEqual(new Set(CASES.map((c) => c.id)).size, CASES.length, 'case ids are unique');
});

test('offline: code-decided checks find every seeded defect and nothing else', async () => {
  const results = await seeded({ mode: 'offline' });
  for (const r of results.filter((x) => x.c.group !== 'hard')) {
    assert.ok(!r.error, `${r.c.id}: ${r.error}`);
    assert.deepStrictEqual(r.missed, [], `${r.c.id}: missed`);
    assert.deepStrictEqual(r.falseAlarms, [], `${r.c.id}: false alarms`);
    for (const x of r.critical || []) assert.ok(x.ok, `${r.c.id}: ${x.id} critical ${x.got}, want ${x.want.join(' or ') || 'none'}`);
  }
});
