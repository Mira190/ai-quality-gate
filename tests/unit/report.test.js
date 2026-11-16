'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderReport, renderComment, summarize } = require('../../src/report/markdown');
const { toSarif, annotations } = require('../../src/report/sarif');
const { make } = require('../../src/findings');
const { decide } = require('../../src/gate');
const { loadConfig } = require('../../src/config');

function ledger() {
  const { config } = loadConfig(null);
  const rule = (id, critical) => ({ id, title: `Rule ${id}`, text: 't', path: 'docs/req.md', line: 3, critical, tags: critical ? [{ area: 'money', word: 'fee' }] : [], limits: [], lowest: 'unit' });
  const file = { path: 'tests/a.test.js', level: 'unit' };
  const proofs = [
    { rule: rule('REQ-1', true), status: 'proven', basis: 'S', links: [{ case: { name: 'a', line: 4, file, skipped: false }, by: 'id' }], holes: [], candidates: [], terms: [], impl: [], placement: { expected: 'unit' } },
    { rule: rule('REQ-2', true), status: 'unproven', basis: 'S', links: [], holes: [], candidates: [], terms: ['fee'], impl: [] },
    { rule: rule('REQ-3', false), status: 'inactive', basis: 'S', links: [], holes: [], candidates: [], terms: [], impl: [] },
  ];
  const findings = [
    make({ section: 'proof', check: 'proof.unproven', priority: 'P0', basis: 'S', subject: 'REQ-2', title: 'REQ-2 has no test', detail: 'a | b', fix: 'write it', critical: true, loc: { path: 'docs/req.md', line: 3 }, anchors: [{ path: 'docs/req.md', from: 3, to: 3 }] }),
    make({ section: 'placement', check: 'placement.mislabelled', priority: 'P2', basis: 'S', subject: 'tests/a.test.js', title: 'misfiled', detail: 'd', fix: 'move it', anchors: [{ path: 'tests/a.test.js' }] }),
  ];
  const gate = decide({ findings, config, changes: null, baseline: null });
  const levels = { unit: { files: 1, cases: 4, pr: 1 }, component: { files: 0, cases: 0, pr: 0 }, integration: { files: 0, cases: 0, pr: 0 }, e2e: { files: 0, cases: 0, pr: 0 } };
  const l = {
    config, gate, findings, proofs, placement: { issues: [], levels }, change: null,
    ci: { hasCI: true, systems: ['github'], errors: [], checks: [{ id: 'tests', title: 'Tests', state: 'enforced', where: [{ file: '.github/workflows/ci.yml', line: 9, job: 'check' }], command: 'npm test' }, { id: 'lint', title: 'Lint', state: 'missing', where: [] }] },
    ai: { provider: 'none', note: 'switched off', stats: { needed: 0, cached: 0, locked: 0, confirmed: 0, asked: 0, requests: 0, pending: 0, failed: 0, overBudget: 0, chars: 0, errors: [] } },
    run: { name: 'acme/shop', sha: 'abc1234', changedFiles: 0, files: { listed: 10, ignored: 1 }, docs: [{ path: 'docs/req.md', rules: 3 }], notRead: [], testFiles: 1, testCases: 4, ciFiles: 1, rules: { total: 3, withId: 3, inferred: 0 }, degraded: ['Stage "ci" failed and was skipped: boom'], configErrors: [], timings: { scan: 1 } },
  };
  l.summary = summarize(l);
  return l;
}

test('DEC-1 every number in the report is computed from the ledger, and the same ledger renders the same bytes', () => {
  const l = ledger();
  assert.deepEqual([l.summary.rules, l.summary.proven, l.summary.unproven, l.summary.critical, l.summary.criticalProven, l.summary.ciEnforced, l.summary.ciApplicable], [2, 1, 1, 2, 1, 1, 2]);
  const report = renderReport(l);
  assert.equal(report, renderReport(ledger()));
  assert.match(report, /^# Quality gate: acme\/shop @ abc1234\n\n\*\*❌ Fail\*\*: 1 finding blocks the gate \(1 P0\)\./);
  assert.match(report, /\*\*1 of 2\*\* rules proven · 0 with a hole · 1 with no test · 0 unverified\. Critical rules: \*\*1 of 2\*\* proven\./);
  assert.match(report, /\*\*1 of 2\*\* checks enforced: Tests ✅ · Lint ❌/);
  assert.match(report, /Not counted: 1 rule superseded/);
  // the sections come in a fixed order, and placement is always there
  const order = ['## Fix first', '## 1. Proof', '## 2. Placement', '## 3. CI', '## Run'].map((h) => report.indexOf(h));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.ok(order.every((i) => i > 0));
  assert.match(report, /\| unit \| one process, nothing real around it \| 1 \| 4 \| 1 of 1 \|/);
  // a pipe in a finding cannot break the table; a skipped stage is said out loud
  assert.match(report, /a \\\| b/);
  assert.match(report, /⚠️ Stage "ci" failed and was skipped: boom/);
});

test('the comment is short: the verdict, what blocks, placement; SARIF and annotations carry the same findings', () => {
  const l = ledger();
  const comment = renderComment(l, { url: 'https://example.test/run/1' });
  assert.match(comment, /^<!-- ai-quality-gate -->\n\n### Quality gate @ abc1234/);
  assert.match(comment, /#### Blocks the gate\n\n- \*\*P0 REQ-2 has no test\*\* \(`docs\/req\.md:3`\)/);
  assert.match(comment, /#### Placement\n\n- \*\*P2 misfiled\*\*/);
  assert.match(comment, /\[Full report\]\(https:\/\/example\.test\/run\/1\)/);
  const sarif = toSarif(l);
  assert.deepEqual(sarif.runs[0].results.map((r) => [r.ruleId, r.level, r.locations.length]), [['proof.unproven', 'error', 1], ['placement.mislabelled', 'warning', 0]]);
  assert.deepEqual(annotations(l), ['::error file=docs/req.md,line=3,title=P0 proof.unproven::REQ-2 has no test. write it']);
});

test('the fix brief turns a blocking finding into a task with the test already named, placed and given its boundary cases', () => {
  const { renderBrief, skeleton } = require('../../src/report/brief');
  const l = ledger();
  l.proofs[1].rule.limits = [{ value: '500', unit: '$', raw: '$500' }];
  l.proofs[1].rule.title = 'Gift card limit';
  l.tests = { files: [{ path: 'tests/unit/a.test.ts', level: 'unit', lang: 'js', pkg: '' }] };
  const brief = renderBrief(l);
  assert.match(brief, /^# Fix brief\n\n1 blocking finding in acme\/shop @ abc1234/);
  assert.match(brief, /## 1\. P0 REQ-2 has no test/);
  assert.match(brief, /\*\*Where:\*\* a new file next to `tests\/unit\/a\.test\.ts` \(`tests\/unit\/`\) \(unit level\)/);
  assert.match(brief, /it\.each\(\[\n {2}\[499, \/\* expected \*\/\], {2}\/\/ below the limit \(\$500\)\n {2}\[500, .*\n {2}\[501, .*\n\]\)\('REQ-2 Gift card limit: %s'/);
  assert.match(brief, /\*\*Done when:\*\* `proof\.unproven` for `REQ-2` is gone/);
  const rule = { id: 'REQ-7', title: 'Order export', limits: [] };
  assert.match(skeleton(rule, 'python'), /# covers: REQ-7\ndef test_req_7_order_export\(\):/);
  assert.match(skeleton({ ...rule, limits: [{ value: '3', unit: 'retries', raw: 'at most 3 retries' }] }, 'go'), /func TestREQ7\(t \*testing\.T\) \{\n\tcases := .*\n\t\t\{"below the limit \(at most 3 retries\)", 2\},/);
  assert.match(skeleton(rule, 'java'), /@DisplayName\("REQ-7 Order export"\)\nvoid orderExport\(\)/);
});

test('many rules of one document with the same gap are one row in the table, and stay separate findings', () => {
  const { grouped } = require('../../src/report/markdown');
  const mk = (n, o = {}) => ({ n, check: 'proof.unproven', priority: 'P0', blocking: true, basis: 'S', critical: true, subject: `REQ-${n}`, fingerprint: `f${n}`, loc: { path: 'docs/req.md', line: n }, title: `REQ-${n} has no test`, detail: 'd', fix: 'f', ...o });
  const list = [mk(1), mk(2), mk(3), mk(4), mk(5), mk(6, { loc: { path: 'docs/other.md', line: 1 } }), mk(7, { check: 'ci.lint', subject: 'lint' })];
  const rows = grouped(list);
  assert.deepEqual(rows.map((r) => r.title), ['5 critical rules in `docs/req.md` have no test', 'REQ-6 has no test', 'REQ-7 has no test']);
  assert.match(rows[0].detail, /^REQ-1, REQ-2, REQ-3, REQ-4, REQ-5\./);
  assert.equal(list.length, 7);
  // three of a kind are still shown one by one
  assert.equal(grouped([mk(1), mk(2), mk(3)]).length, 3);
});
