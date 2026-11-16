'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { decide } = require('../../src/gate');
const { make, boundaryValues, ciFindings, proofFindings } = require('../../src/findings');
const { loadConfig } = require('../../src/config');
const { parseDiff } = require('../../src/git');

const config = (over = {}) => loadConfig(null, over).config;
const finding = (o = {}) => make({ section: 'proof', check: 'proof.unproven', priority: 'P0', basis: 'S', subject: 'REQ-1', title: 't', detail: 'd', anchors: [{ path: 'docs/req.md', from: 10, to: 10 }], ...o });
const diff = (text) => parseDiff(text);
const DIFF = 'diff --git a/docs/req.md b/docs/req.md\n--- a/docs/req.md\n+++ b/docs/req.md\n@@ -9,0 +10,1 @@\n+- REQ-1 new rule\n';

test('GATE-16 the review is of the whole repository: a finding blocks wherever it is, change or no change', () => {
  const inChange = finding(), elsewhere = finding({ subject: 'REQ-2', anchors: [{ path: 'docs/other.md', from: 3, to: 3 }] });
  const g = decide({ findings: [inChange, elsewhere], config: config(), changes: diff(DIFF), baseline: null });
  assert.deepEqual([inChange.blocking, elsewhere.blocking], [true, true]);
  assert.deepEqual([g.verdict, g.blocking], ['fail', 2]);
  // the change is still recorded on each finding, for the report
  assert.deepEqual([inChange.touchesChange, elsewhere.touchesChange], [true, false]);
});

test('GATE-16 with the ratchet on, a finding already in the baseline does not block; a new one does', () => {
  const known = finding(), fresh = finding({ subject: 'REQ-2' });
  const g = decide({ findings: [known, fresh], config: config({ gate: { new_only: true } }), changes: null, baseline: { fingerprints: [known.fingerprint] } });
  assert.deepEqual([known.blocking, known.why, fresh.blocking, g.verdict], [false, 'in the baseline', true, 'fail']);
  // without the ratchet the baseline only labels findings as new or known
  const k2 = finding();
  decide({ findings: [k2], config: config(), changes: null, baseline: { fingerprints: [k2.fingerprint] } });
  assert.deepEqual([k2.blocking, k2.isNew], [true, false]);
  // ratchet, no baseline yet, a change given (a local hook): what the change touches stands in for "new"
  const touched = finding(), untouched = finding({ subject: 'REQ-3', anchors: [{ path: 'docs/req.md', from: 3, to: 3 }] });
  decide({ findings: [touched, untouched], config: config({ gate: { new_only: true } }), changes: diff(DIFF), baseline: null });
  assert.deepEqual([touched.blocking, untouched.blocking, untouched.why], [true, false, 'not touched by the change']);
});

// covers: DEC-8
test('GATE-16 advice never blocks, and neither does a priority below the gate', () => {
  const advice = finding({ basis: 'A', priority: 'P1' }), low = finding({ subject: 'REQ-2', priority: 'P2' }), verified = finding({ subject: 'REQ-3', basis: 'V', priority: 'P1' });
  decide({ findings: [advice, low, verified], config: config(), changes: null, baseline: null });
  assert.deepEqual([advice.blocking, low.blocking, verified.blocking], [false, false, true]);
  assert.equal(advice.why, 'advice');
  // advice is never P0
  assert.equal(finding({ basis: 'A', priority: 'P0' }).priority, 'P1');
});

test('GATE-16 the gate can be lowered, raised or switched off', () => {
  assert.equal(decide({ findings: [finding({ priority: 'P2' })], config: config({ gate: { fail_on: 'P2' } }), changes: null, baseline: null }).verdict, 'fail');
  assert.equal(decide({ findings: [finding()], config: config({ gate: { fail_on: 'never' } }), changes: null, baseline: null }).verdict, 'pass');
});

test('GATE-17 a suppression needs a reason, and an expired one is no longer applied', () => {
  const ok = loadConfig(null, { suppress: [{ id: 'REQ-1', reason: 'accepted until the rewrite', until: '2999-01-01' }] });
  const f = finding();
  decide({ findings: [f], config: ok.config, changes: null, baseline: null });
  assert.deepEqual([f.blocking, f.suppressed], [false, 'accepted until the rewrite']);

  const noReason = loadConfig(null, { suppress: [{ id: 'REQ-1' }] });
  assert.equal(noReason.config.suppress.length, 0);
  assert.match(noReason.errors.join(), /needs a reason/);

  const expired = loadConfig(null, { suppress: [{ id: 'REQ-1', reason: 'old', until: '2020-01-01' }] });
  assert.equal(expired.config.suppress.length, 0);
  assert.match(expired.errors.join(), /expired on 2020-01-01/);
  const g = finding();
  decide({ findings: [g], config: expired.config, changes: null, baseline: null });
  assert.equal(g.blocking, true);
});

test('a suppression can name a check or a path', () => {
  const c = loadConfig(null, { suppress: [{ check: 'ci.', reason: 'handled by the platform team' }, { path: 'legacy/**', reason: 'frozen' }] }).config;
  const ci = finding({ check: 'ci.lint', subject: 'lint' }), legacy = finding({ subject: 'x', anchors: [{ path: 'legacy/a/b.test.js' }] }), other = finding({ subject: 'y' });
  decide({ findings: [ci, legacy, other], config: c, changes: null, baseline: null });
  assert.deepEqual([Boolean(ci.suppressed), Boolean(legacy.suppressed), Boolean(other.suppressed)], [true, true, false]);
});

test('a fingerprint depends on the check and its subject, not on line numbers or wording', () => {
  assert.equal(finding({ title: 'a', loc: { path: 'x', line: 1 } }).fingerprint, finding({ title: 'b', loc: { path: 'x', line: 99 } }).fingerprint);
  assert.notEqual(finding().fingerprint, finding({ subject: 'REQ-2' }).fingerprint);
});

test('GATE-15 tests that do not gate pull requests are P0; lint and type check not enforced are P1; the rest lower', () => {
  const inventory = { byKind: { ci: [{ path: '.github/workflows/ci.yml' }], test: [{ path: 'a.test.ts' }] }, langs: { js: 3, ts: 3 } };
  const check = (id, state, need = 'required') => ({ id, title: id, state, need, where: [{ file: '.github/workflows/ci.yml', line: 3, job: 'j' }], command: 'x', configured: 'tsconfig.json' });
  const ci = { hasCI: true, checks: [check('tests', 'non_blocking'), check('lint', 'configured'), check('typecheck', 'not_on_pr'), check('format', 'missing', 'optional'), check('sast', 'missing', 'optional'), check('deps', 'enforced', 'optional')] };
  const out = ciFindings(ci, inventory, config());
  assert.deepEqual(out.map((f) => [f.check, f.priority, f.basis]), [['ci.tests', 'P0', 'S'], ['ci.lint', 'P1', 'S'], ['ci.typecheck', 'P1', 'S'], ['ci.format', 'P2', 'S'], ['ci.sast', 'P3', 'S']]);
  assert.deepEqual(ciFindings({ hasCI: false, checks: [] }, inventory, config()).map((f) => [f.check, f.priority]), [['ci.none', 'P0']]);
});

test('GATE-6 GATE-7 the priority of a proof finding follows from the rule being critical', () => {
  const rule = (critical) => ({ id: 'REQ-1', title: 'T', text: 'x', path: 'd.md', line: 1, critical, tags: critical ? [{ area: 'money', word: 'fee' }] : [], limits: [], lowest: 'unit' });
  const kase = { name: 'n', line: 1, end: 2, skipped: true, file: { path: 't.test.js', level: 'unit' } };
  const skipped = (critical) => ({ rule: rule(critical), status: 'unproven', basis: 'S', links: [{ case: kase, by: 'id' }], holes: [], candidates: [], terms: [], impl: [] });
  const hole = (critical) => ({ rule: rule(critical), status: 'weak', basis: 'S', links: [{ case: { ...kase, skipped: false }, by: 'id' }], holes: [{ kind: 'limit', basis: 'S', text: 'no linked test uses the stated limit 20%', limits: [{ value: '20', unit: '%', raw: '20%' }] }], candidates: [], terms: [], impl: [] });
  assert.deepEqual(proofFindings([skipped(true), skipped(false)], config()).map((f) => [f.check, f.priority]), [['proof.skipped', 'P0'], ['proof.skipped', 'P1']]);
  const holes = proofFindings([hole(true), hole(false)], config());
  assert.deepEqual(holes.map((f) => [f.check, f.priority]), [['proof.limit', 'P1'], ['proof.limit', 'P2']]);
  assert.match(holes[0].title, /stated limit 20%/);
  assert.match(holes[0].fix, /19%, 20% and 21%/);
});

test('boundary values are the limit, one below and one above', () => {
  assert.equal(boundaryValues([{ value: '20', unit: '%' }]), '19%, 20% and 21%');
  assert.equal(boundaryValues([{ value: '500', unit: '$' }]), '$499, $500 and $501');
  assert.equal(boundaryValues([{ value: '0.5', unit: 's' }]), '0.4 s, 0.5 s and 0.6 s');
});

test('config: unknown keys and wrong types are reported and the defaults stay', () => {
  const { config: c, errors } = loadConfig(null, { gate: { fail_on: 'P9', basis: ['S', 'X'] }, ai: { provider: 'gpt' }, nonsense: 1, docs: { max_kb: 'big' } });
  assert.deepEqual([c.gate.fail_on, c.gate.basis, c.ai.provider, c.docs.max_kb], ['P1', ['S'], 'auto', 2048]);
  assert.equal(errors.length, 5);
});

test('a unified diff is parsed into added line ranges per file', () => {
  const d = diff('diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1,2 +1,3 @@\n+x\n@@ -10 +12,0 @@\n-y\ndiff --git a/n.js b/n.js\nnew file mode 100644\n--- /dev/null\n+++ b/n.js\n@@ -0,0 +1,2 @@\n+a\n+b\ndiff --git a/old.js b/old.js\n--- a/old.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-z\n');
  assert.deepEqual([...d].map(([p, c]) => [p, c.status, c.added, c.addedLines]), [['a.js', 'M', [[1, 3]], 3], ['n.js', 'A', [[1, 2]], 2], ['old.js', 'D', [], 0]]);
});

test('the documented example config is exactly the defaults', () => {
  const YAML = require('yaml');
  const example = YAML.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '../../examples/.quality-gate.yml'), 'utf8'));
  assert.deepEqual(example, require('../../src/config').DEFAULTS);
});
