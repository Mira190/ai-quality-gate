'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assessPlacement } = require('../../src/placement');
const { analyzeChange } = require('../../src/change');
const { parseDiff } = require('../../src/git');

const file = (path, level, o = {}) => ({ path, level, declared: o.declared ?? level, observed: o.observed ?? level, why: o.why || null, mock: o.mock || null, fs: false, imports: o.imports || [], lang: 'js', cases: [], ...o });
const kase = (f, o = {}) => { const c = { name: 'c', line: 1, end: 5, skipped: false, params: 0, asserts: 1, nt: [], pure: false, shape: null, waitMs: 0, crosses: 1, file: f, ...o }; f.cases.push(c); return c; };
const rule = (id, o = {}) => ({ id, title: id, critical: false, tags: [], limits: [], nature: 'logic', lowest: 'unit', ...o });
const proof = (r, cases, o = {}) => ({ rule: r, status: 'proven', links: cases.map((c) => ({ case: c, by: 'id' })), impl: [], modelLevel: null, ...o });
const CI = { testSteps: [{ state: 'enforced', e2e: false, command: 'npm test', dirs: [] }], hasCI: true };
const kinds = (r) => r.issues.map((i) => `${i.kind}:${i.rule ? i.rule.id : i.level || i.files[0]?.path || 'suite'}:${i.basis}`).sort();

test('GATE-10 a logic rule proven only by integration or end-to-end tests is tested too high', () => {
  const e2e = file('e2e/a.spec.js', 'e2e', { why: 'browser' }), unit = file('unit/a.test.js', 'unit');
  const high = proof(rule('R-1', { limits: [{ raw: '20%' }] }), [kase(e2e, { params: 5 })]);
  const both = proof(rule('R-2'), [kase(e2e), kase(unit)]);
  const flow = proof(rule('R-3', { nature: 'flow', lowest: 'e2e' }), [kase(e2e)]);
  const r = assessPlacement({ proofs: [high, both, flow], tests: { files: [e2e, unit] }, ci: CI });
  assert.deepEqual(kinds(r).filter((k) => k.startsWith('too-high')), ['too-high:R-1:S']);
  assert.match(r.issues.find((i) => i.kind === 'too-high').text, /logic with limits \(20%\).*only at e2e level \(5 cases/);
  assert.deepEqual([high.placement.ok, both.placement.ok, flow.placement.ok], [false, true, true]);
});

test('GATE-10 when the model names a lower level than the word lists, the finding is advice', () => {
  const it = file('integration/a.test.js', 'integration', { why: 'http' });
  const p = proof(rule('R-1', { nature: 'boundary', lowest: 'integration' }), [kase(it)], { modelLevel: 'unit' });
  assert.deepEqual(kinds(assessPlacement({ proofs: [p], tests: { files: [it] }, ci: CI })), ['too-high:R-1:A']);
});

test('GATE-11 a boundary rule proven only by tests that fake their collaborators is proven against fakes', () => {
  const mocked = file('unit/pay.test.js', 'unit', { mock: 'a fake' }), plain = file('unit/calc.test.js', 'unit'), real = file('integration/pay.test.js', 'integration', { why: 'http' });
  const boundary = (id) => rule(id, { nature: 'boundary', lowest: 'integration', tags: [{ area: 'external', word: 'gateway' }], critical: true });
  const r = assessPlacement({ proofs: [proof(boundary('R-1'), [kase(mocked)]), proof(boundary('R-2'), [kase(mocked), kase(real)]), proof(boundary('R-3'), [kase(plain)])], tests: { files: [mocked, plain, real] }, ci: CI });
  assert.deepEqual(kinds(r), ['boundary-mocked:R-1:S']);
  assert.match(r.issues[0].text, /real boundary \(gateway\).*`a fake`/);
});

test('GATE-12 a unit file that needs a network, and a slow-suite file that crosses nothing, are misfiled', () => {
  const net = file('tests/unit/geo.test.js', 'integration', { declared: 'unit', observed: 'integration', why: 'network' });
  const idle = file('tests/e2e/sum.test.js', 'e2e', { declared: 'e2e', observed: 'unit', imports: ['src/sum.js'] });
  const tmpdir = file('tests/integration/io.test.js', 'integration', { declared: 'integration', observed: 'unit', imports: ['src/io.js'], fs: true });
  const fine = file('tests/unit/sum.test.js', 'unit');
  for (const f of [net, idle, tmpdir, fine]) kase(f);
  kase(idle, { params: 6 });
  assert.deepEqual(kinds(assessPlacement({ proofs: [], tests: { files: [net, idle, tmpdir, fine] }, ci: CI })), ['mislabelled:tests/unit/geo.test.js:S', 'no-boundary:tests/e2e/sum.test.js:S']);
});

test('a top-heavy suite and a level no pull request runs are reported', () => {
  const e2e = file('e2e/a.spec.js', 'e2e', { why: 'browser' }), unit = file('unit/a.test.js', 'unit');
  for (let i = 0; i < 9; i++) kase(e2e);
  for (let i = 0; i < 3; i++) kase(unit);
  const r = assessPlacement({ proofs: [], tests: { files: [e2e, unit] }, ci: CI });
  assert.deepEqual(kinds(r), ['level-not-run:e2e:S', 'pyramid:suite:S']);
  assert.deepEqual([r.levels.unit.pr, r.levels.e2e.pr, r.levels.e2e.cases], [1, 0, 9]);
});

test('GATE-20 a changed source file no test reaches is reported, unless the change adds its test', () => {
  const diff = (files) => parseDiff(files.map((f) => `diff --git a/${f} b/${f}\n--- /dev/null\n+++ b/${f}\n@@ -0,0 +1,9 @@\n${'+x\n'.repeat(9)}`).join(''));
  const inv = (paths) => ({ byPath: new Map(paths.map((p) => [p, { path: p, kind: /\.test\./.test(p) ? 'test' : 'source', lang: 'js' }])) });
  const covered = file('tests/cart.test.js', 'unit', { imports: ['src/cart.js'] });
  const proofs = [{ rule: rule('R-1'), impl: ['src/cart.js'] }];
  const run = (files, tests = [covered]) => analyzeChange({ changes: diff(files), inventory: inv(files), tests: { files: tests }, proofs, config: {} });

  const a = run(['src/cart.js', 'src/payment/giftcard.js', 'src/report.js']);
  assert.deepEqual(a.findings.map((f) => [f.check, f.subject, f.priority]), [['change.untested', 'src/payment/giftcard.js', 'P1'], ['change.untested', 'src/report.js', 'P2']]);
  assert.deepEqual([a.affectedTests, a.touchedRules], [['tests/cart.test.js'], ['R-1']]);
  // the change brings the test with it
  assert.deepEqual(run(['src/report.js', 'tests/report.test.js'], []).findings, []);
  // a config file or a barrel file is not asked for a test
  assert.deepEqual(run(['src/index.js', 'vite.config.js']).findings, []);
});

const { tokenize } = require('../../src/util');
const named = (f, name, o = {}) => kase(f, { name, nt: [...new Set(tokenize(name))], ...o });

test('GATE-33 a case that crosses nothing in a slow suite is a unit test there, and a P1 when no pull request runs the suite', () => {
  const e2e = file('e2e/checkout.spec.js', 'e2e', { why: 'browser', imports: ['src/totals.js'] });
  named(e2e, 'adds the prices', { pure: true, crosses: 0, line: 4 });
  named(e2e, 'shows the cart', { line: 9 });
  named(e2e, 'skipped and pure', { pure: true, crosses: 0, skipped: true });
  const nightly = { testSteps: [{ state: 'enforced', e2e: false, command: 'npm test', dirs: ['unit'] }], hasCI: true };
  const r = assessPlacement({ proofs: [], tests: { files: [e2e] }, ci: nightly });
  const issue = r.issues.find((i) => i.kind === 'no-boundary');
  assert.deepEqual([issue.cases.length, issue.gates, issue.basis], [1, false, 'S']);
  assert.match(issue.text, /1 case of 3 in e2e\/checkout\.spec\.js \(e2e\) crosses no boundary.*line 4 "adds the prices"/);
  assert.match(issue.fix, /next to `src\/totals\.js`/);
  assert.deepEqual([r.plan.heavy, r.plan.movable, r.plan.pure], [3, 1, 1]);
  const { placementFindings } = require('../../src/findings');
  const [f] = placementFindings([issue]);
  assert.deepEqual([f.check, f.priority], ['placement.no-boundary', 'P1']);
  assert.match(f.detail, /today this check gates no change; as unit tests they would/);
  assert.match(f.title, /1 unit test in the e2e suite: e2e\/checkout\.spec\.js/);
  // when the suite does gate pull requests, moving the case is tidiness: P2
  const [g] = placementFindings([{ ...issue, gates: true }]);
  assert.equal(g.priority, 'P2');
});

test('GATE-33 cases that differ only in their data are a table at the top: one stays, the rest move', () => {
  const it = file('integration/fees.test.js', 'integration', { why: 'http' });
  for (const n of [10, 60, 99]) named(it, `fee for ${n}`, { shape: 'aaaa', waitMs: 2000, line: n });
  named(it, 'another thing', { shape: 'bbbb' });
  named(it, 'a real table', { params: 5, shape: 'cccc' });
  const r = assessPlacement({ proofs: [], tests: { files: [it] }, ci: CI });
  const issue = r.issues.find((i) => i.kind === 'table-at-top');
  assert.match(issue.text, /runs 5 parameter rows and 3 cases that differ only in their data \(lines 10, 60, 99\) at integration level.*They wait at least 6 s between them/);
  assert.match(issue.fix, /move the other 6 to a table in a unit test/);     // 4 of the 5 rows and 2 of the 3 copies
  assert.deepEqual([r.plan.movable, r.plan.variations], [6, 6]);
  // two alike are not a table
  const two = file('integration/two.test.js', 'integration', { why: 'http' });
  named(two, 'a', { shape: 'x' }); named(two, 'b', { shape: 'x' });
  assert.ok(!assessPlacement({ proofs: [], tests: { files: [two] }, ci: CI }).issues.some((i) => i.kind === 'table-at-top'));
});

test('GATE-33 a slow case that says what a unit test already says is advice, unless the unit test fakes what the slow one crosses', () => {
  const unit = file('unit/discount.test.js', 'unit'), mocked = file('unit/pay.test.js', 'unit', { mock: 'a fake' });
  named(unit, 'caps the discount at twenty percent of the total');
  named(mocked, 'retries a failed payment three times before giving up');
  const e2e = file('e2e/shop.spec.js', 'e2e', { why: 'browser' });
  named(e2e, 'caps the discount at twenty percent of the order total', { line: 7 });
  named(e2e, 'retries a failed payment three times before giving up', { line: 20 });
  named(e2e, 'shows the cart badge');
  const r = assessPlacement({ proofs: [], tests: { files: [unit, mocked, e2e] }, ci: CI });
  const issue = r.issues.find((i) => i.kind === 'duplicate-below');
  assert.deepEqual([issue.cases.map((c) => c.line), issue.basis, r.plan.twins], [[7], 'A', 1]);
  assert.match(issue.text, /line 7 .* and `unit\/discount\.test\.js:1`/);
});
