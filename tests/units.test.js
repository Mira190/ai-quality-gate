'use strict';
// Unit tests for the stages code decides alone: no model, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { globMatch, wrap } = require('../src/util');
const { parseDoc, extractRules, normId } = require('../src/rules');
const { tagText } = require('../src/critical');
const { statusOf } = require('../src/judge');
const { buildIssues } = require('../src/issues');
const { discover } = require('../src/discover');
const { analyzeCI } = require('../src/ci');
const { runLine } = require('../src/render');
const { costUsd } = require('../src/llm');

function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aqg-'));
  for (const [p, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), text);
  }
  return { root, files: Object.keys(files) };
}

test('globMatch handles **, extglob and classes', () => {
  assert.ok(globMatch('**/*.?(c|m)[jt]s?(x)', 'e2e/quote.spec.ts'));
  assert.ok(globMatch('**/*.?(c|m)[jt]s?(x)', 'a/b.mjs'));
  assert.ok(!globMatch('**/*.?(c|m)[jt]s?(x)', 'a/b.py'));
  assert.ok(globMatch('src/pricing/**', 'src/pricing/rates/x.ts'));
  assert.ok(!globMatch('src/pricing/**', 'src/payment/x.ts'));
});

test('wrap keeps lines within the width', () => {
  const s = wrap('word '.repeat(60).trim(), 30);
  for (const l of s.split('\n')) assert.ok(l.length <= 30, l);
});

test('parseDoc reads heading, bold and plain ID items', () => {
  const items = parseDoc({ path: 'r.md', text: '# Reqs\n\n## REQ-1: Discount cap\n\nDiscounts never exceed 20%.\n\n- **DEC-3 Retry.** Retry 3 times.\n- FR-12: The system shall log in.\n' });
  assert.deepEqual(items.map((i) => [i.id, i.kind, i.line]), [['REQ-01', 'requirement', 5], ['DEC-03', 'decision', 7], ['FR-12', 'requirement', 8]]);
  assert.equal(items[0].text, 'Discounts never exceed 20%.');
  assert.equal(normId('req_7'), 'REQ-07');
});

test('parseDoc reads OpenSpec requirements, an ADR decision and Gherkin scenarios without IDs', () => {
  const os1 = parseDoc({ path: 'openspec/specs/a/spec.md', text: '# A\n\n### Requirement: Validate names\nThe system SHALL reject empty names.\n\n#### Scenario: empty\n- WHEN x\n' });
  assert.deepEqual(os1.map((i) => [i.title, i.text, i.line, i.id]), [['Validate names', 'The system SHALL reject empty names.', 4, null]]);
  const adr = parseDoc({ path: 'docs/adr/0001-db.md', text: '# ADR 1: Use Postgres\n\nStatus: Accepted\n\n## Decision\n\nWe store quotes in Postgres.\n' });
  assert.deepEqual(adr.map((i) => [i.kind, i.title, i.line]), [['decision', 'Use Postgres', 7]]);
  const feat = parseDoc({ path: 'f/login.feature', text: 'Feature: Login\n  Scenario: bad password\n    Given a user\n    When the password is wrong\n    Then login fails\n' });
  assert.deepEqual(feat.map((i) => [i.title, i.line]), [['bad password', 2]]);
});

test('extractRules numbers unnumbered items after the highest ID and drops duplicates', async () => {
  const { rules, dropped } = await extractRules([
    { path: 'a.md', text: '## REQ-04: A\n\nThe system shall do A.\n\n## REQ-04: Again\n\nDup.\n' },
    { path: 'b/spec.md', text: '### Requirement: B\nThe system SHALL do B.\n' },
  ]);
  assert.deepEqual(rules.map((r) => [r.id, r.hasSourceId]), [['REQ-04', true], ['REQ-05', false]]);
  assert.equal(dropped.length, 1);
});

test('tagText picks the earliest strong word', () => {
  assert.deepEqual(tagText('Admin may issue a refund. Refund is pro rata'), { area: 'access control', word: 'admin' });
  assert.deepEqual(tagText('Refund posted to the gateway'), { area: 'money', word: 'refund' });
  assert.equal(tagText('Show the page title'), null);
});

test('statusOf follows the blocking measures', () => {
  assert.equal(statusOf({ fails: [{ measure: 'Testable', part: '' }] }), 'Blocked');
  assert.equal(statusOf({ fails: [{ measure: 'Complete', part: 'the stacking case' }] }), 'Partly blocked');
  assert.equal(statusOf({ fails: [{ measure: 'Specific', part: '' }] }), 'Test now, fix later');
  assert.equal(statusOf({ fails: [] }), 'Ready');
});

test('buildIssues: priority table, rerank to P0/P1 in sections 1-4, contiguous numbers', () => {
  const ev = (fails, level) => ({ fails, level, tests: [] });
  const crit = { area: 'money', word: 'fee' };
  const rules = [
    { id: 'REQ-01', kind: 'requirement', critical: crit, fails: [{ measure: 'Testable' }, { measure: 'Specific' }], evidence: ev([{ check: 'No test' }], 'None') },
    { id: 'REQ-02', kind: 'requirement', critical: null, fails: [{ measure: 'Testable' }], evidence: ev([{ check: 'No test' }], 'None') },
    { id: 'DEC-01', kind: 'decision', critical: crit, addsBehaviour: true, fails: [], evidence: ev([{ check: 'Placement' }], 'Checked nightly') },
    { id: 'DEC-02', kind: 'decision', critical: crit, addsBehaviour: true, traced: false, fails: [], evidence: ev([{ check: 'No test' }], 'None') },
  ];
  const ci = { checks: [{ label: 'Secret scan', key: 'secret', issues: [{ kind: 'secret-missing', priority: 'P0', text: 'x' }] }, { label: 'Format', key: 'format', issues: [{ kind: 'f', priority: 'P3', text: 'y' }] }] };
  const out = buildIssues(rules, ci);
  const row = (id, m) => out.find((i) => i.rule?.id === id && (i.measure === m || i.check === m));
  assert.equal(row('REQ-01', 'Testable').priority, 'P1');
  assert.equal(row('REQ-01', 'Specific').priority, 'P3');
  assert.equal(row('REQ-01', 'No test').priority, 'P0');
  assert.equal(row('REQ-02', 'No test').priority, 'P2');
  assert.equal(row('DEC-01', 'Placement').priority, 'P1');
  assert.equal(row('DEC-02', 'No test'), undefined, 'an untraced rule gets no test rows');
  const shown = out.filter((i) => i.shown);
  assert.deepEqual(shown.map((i) => i.n), shown.map((_, k) => k + 1));
  assert.ok(shown.every((i) => i.section === 5 || ['P0', 'P1'].includes(i.priority)));
  assert.ok(shown.some((i) => i.priority === 'P3' && i.section === 5), 'section 5 shows every row');
});

test('discover: content decides, archived skipped, fixtures and agent files ignored, budget ranked', async () => {
  const spec = (n) => `# Spec ${n}\n\n### Requirement: R${n}\nThe system SHALL do ${n}.\n`;
  const files = { 'README.md': '# Hello\nRun npm start.\n', 'notes/rules.md': '- REQ-1: The system shall a.\n- REQ-2: The system must b.\n- REQ-3: The system must c.\n', 'openspec/changes/archive/old/spec.md': spec('old'), 'test/fixtures/x/spec.md': spec('fx'), 'skills/x/SKILL.md': spec('sk'), 'openspec/changes/add-y/spec.md': spec('chg') };
  const small = repo(files);
  const d0 = await discover({ root: small.root, files: small.files });
  assert.deepEqual(d0.read.map((x) => x.path).sort(), ['notes/rules.md', 'openspec/changes/add-y/spec.md'], 'found by content, not folder; README, fixtures and SKILL.md ignored');
  assert.deepEqual(d0.skipped, [{ path: 'openspec/changes/archive/old/spec.md', reason: 'archived' }]);
  for (let i = 0; i < 62; i++) files[`openspec/specs/s${String(i).padStart(2, '0')}/spec.md`] = spec(i);
  const { root, files: list } = repo(files);
  const d = await discover({ root, files: list });
  assert.equal(d.read.length, 60);
  assert.ok(d.notRead.some((x) => x.path === 'openspec/changes/add-y/spec.md'), 'an in-flight change falls to the budget before a current spec');
});

test('analyzeCI: the 7 checks, PR workflows first, continue-on-error cannot gate', () => {
  const pr = 'on: pull_request\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run lint\n      - run: npx tsc --noEmit\n      - run: npx vitest run\n      - run: npm audit --audit-level=high\n        continue-on-error: true\n';
  const { root, files } = repo({ '.github/workflows/z-pr.yml': pr, '.github/workflows/a-nightly.yml': 'on:\n  schedule:\n    - cron: "0 1 * * *"\njobs:\n  e:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npx playwright test\n', 'package.json': '{"scripts":{"lint":"eslint ."}}', 'unit/a.test.ts': '' });
  const ci = analyzeCI(root, files, { tests: [{ path: 'unit/a.test.ts', level: 'unit' }] });
  const by = Object.fromEntries(ci.checks.map((c) => [c.key, c]));
  assert.equal(ci.checks.length, 7);
  assert.equal(by.secret.issues[0].priority, 'P0');
  assert.match(by.secret.issues[0].text, /`z-pr.yml` or `a-nightly.yml`.*to `z-pr.yml`$/);
  assert.equal(by.dependency.issues[0].priority, 'P2');
  assert.match(by.dependency.issues[0].text, /continue-on-error/);
  assert.ok(by.lint.ok && by.typecheck.ok && by.tests.ok);
  assert.equal(by.format.issues[0].priority, 'P3');
});

test('runLine groups long source lists by folder', () => {
  const L = {
    meta: { date: '2026-01-01' }, tests: { cases: 3, files: 1 }, ci: { workflowCount: 1 }, branchProtection: 'not readable',
    rules: [{ hasSourceId: true, judged: true }],
    sources: {
      read: Array.from({ length: 9 }, (_, i) => ({ path: `specs/s${i}/spec.md`, requirements: 2, decisions: 0 })),
      notRead: Array.from({ length: 6 }, (_, i) => ({ path: `docs/big${i}.md`, reason: `${70 + i} KB, over the 60 KB read budget` })),
      never: ['Jira'], skipped: [],
    },
  };
  const line = runLine(L).replace(/\n/g, ' ');
  assert.match(line, /`specs\/` \(18 requirements in 9 files\)/);
  assert.match(line, /`docs\/` \(6 files, over the 60 KB read budget\)/);
});

test('indexTests: multi-line ESM imports resolve .js to .ts; CLI-process tests are e2e', () => {
  const { indexTests } = require('../src/tests-index');
  const { root, files } = repo({
    'src/utils/interactive.ts': 'export function isInteractive() { return true; }\n',
    'test/utils/interactive.test.ts': "import { describe, it, expect } from 'vitest';\nimport {\n  isInteractive,\n} from '../../src/utils/interactive.js';\nit('x', () => { expect(isInteractive()).toBe(true); });\n",
    'test/commands/validate.test.ts': "import { runCLI } from '../helpers/run-cli.js';\nit('y', async () => { expect((await runCLI(['validate'])).exitCode).toBe(0); });\n",
    'test/cli-e2e/basic.test.ts': "it('z', () => { expect(1).toBe(1); });\n",
  });
  const t = Object.fromEntries(indexTests(root, files).tests.map((x) => [x.path, x]));
  assert.ok(t['test/utils/interactive.test.ts'].imports.some((i) => i.resolved === 'src/utils/interactive.ts'));
  assert.equal(t['test/utils/interactive.test.ts'].level, 'unit');
  assert.equal(t['test/commands/validate.test.ts'].level, 'e2e');
  assert.equal(t['test/cli-e2e/basic.test.ts'].level, 'e2e');
});

test('costUsd uses the Haiku 5.5 card', () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
  near(costUsd('claude-haiku-5-5', { input_tokens: 50000, output_tokens: 1e6 }), 0.505);
  near(costUsd('claude-haiku-5-5', { input_tokens: 200000, output_tokens: 0 }), 0.1); // long-prompt card above 100K
});

test('numbers of one unit: code decides the conflict', () => {
  const { numericConflict, quantities } = require('../src/judge');
  const R = (text) => ({ text });
  assert.equal(numericConflict(R('Discounts never exceed 20%.'), R('Discounts stack, up to 25% in total.')), 'conflict');
  assert.equal(numericConflict(R('Concession card holders get 10% off.'), R('Discounts never exceed 20%.')), 'ok');
  assert.equal(numericConflict(R('A saved quote shall be kept for 30 days.'), R('A nightly job deletes rows older than 30 days.')), 'ok');
  assert.equal(numericConflict(R('Sessions expire after 2 hours.'), R('Tokens are valid for at least 3 hours.')), 'conflict');
  assert.equal(numericConflict(R('Refund minus a $50 fee.'), R('Discounts never exceed 20%.')), null);
  assert.deepEqual(quantities('choose an excess from $500 to $5,000').map((q) => [q.value, q.role]), [[500, 'floor'], [5000, 'cap']]);
});

test('Specific and outside-call failure behaviour are code checks', () => {
  const { vagueTerm, failureGaps } = require('../src/judge');
  assert.equal(vagueTerm('Quotes should load fast.'), 'fast');
  assert.equal(vagueTerm('Payment should be retried where possible.'), 'where possible');
  assert.equal(vagueTerm('The premium shall be the base premium times the band factor.'), null);
  assert.deepEqual(failureGaps({ text: 'Calls to the CRM have a timeout. A CRM error is logged and returned to the caller.' }), []);
  assert.deepEqual(failureGaps({ text: 'RefundService.post sends the refund to the payment gateway.' }), ['timeout', 'failure']);
  assert.deepEqual(failureGaps({ text: 'Gateway calls retry three times.' }), ['timeout']);
});

test('a model fail counts only with its evidence and a majority of votes', async () => {
  const { judgeRules } = require('../src/judge');
  const rules = [
    { id: 'REQ-01', kind: 'requirement', path: 'r.md', line: 1, title: 'Refund', text: 'Refund is pro rata minus a $50 fee.' },
    { id: 'REQ-02', kind: 'requirement', path: 'r.md', line: 2, title: 'Discount cap', text: 'Discounts never exceed 20%.' },
    { id: 'REQ-03', kind: 'requirement', path: 'r.md', line: 3, title: 'Concession', text: 'Concession card holders get 10% off.' },
  ];
  const f = (measure, o = {}) => ({ why: 'w', readings: [], raised_by: '', conflict_with: '', part: '', measure, ...o });
  const reply = (fails) => ({ rules: rules.map((r) => ({ id: r.id, fails: fails[r.id] || [], logic_kind: 'calculation', limits: [], terms: [], restates: '', adds_behaviour: true, boundary: 'none' })) });
  const clear = f('Clear', { readings: ['by day', 'by month'] });
  const replies = [
    reply({ 'REQ-01': [clear, f('Complete')], 'REQ-03': [f('Consistent', { conflict_with: 'REQ-02' })] }),
    reply({ 'REQ-01': [clear, f('Testable')] }),
    reply({ 'REQ-01': [f('Clear'), f('Testable')] }),
  ];
  const llm = { votes: async () => replies };
  await judgeRules(llm, rules, { root: '.', fileSet: new Set() });
  // Clear: 2 of 3 with two readings (the third has none and does not count); Testable: 2 of 3; Complete: no raised_by
  assert.deepEqual(rules[0].fails.map((x) => x.measure), ['Clear', 'Testable']);
  // 10% under a 20% cap is no conflict, whatever the model says
  assert.deepEqual(rules[2].fails, []);
  assert.deepEqual(rules[1].fails, []);
});

test('a test link must reach the implementation through imports; Python and Go are followed, aliases pass', () => {
  const { indexTests } = require('../src/tests-index');
  const { reaches } = require('../src/trace');
  const { root, files } = repo({
    'app/pricing/premium.py': 'from .rates import RATES\ndef premium_for(age):\n    return RATES[age]\n',
    'app/pricing/rates.py': 'RATES = {}\n',
    'app/pricing/__init__.py': '',
    'tests/test_premium.py': 'from app.pricing.premium import premium_for\n\nasync def test_band():\n    assert premium_for(3) == 1\n',
    'pkg/calc.go': 'package pkg\n',
    'pkg/calc_test.go': 'package pkg\nfunc TestCalc(t *testing.T) {\n\tt.Errorf("bad")\n}\n',
    'src/refund/amount.ts': 'export const computeRefund = () => 0;\n',
    'src/refund/service.ts': "import { computeRefund } from './amount';\nexport class RefundService {}\n",
    'unit/refund.test.ts': "import { computeRefund } from '../src/refund/amount';\nit('a', () => { expect(computeRefund()).toBe(0); });\n",
    'unit/alias.test.ts': "import { x } from '@/refund/service';\nimport { y } from '../src/refund/amount';\nit('b', () => { expect(x).toBe(y); });\n",
  });
  const ti = indexTests(root, files), t = Object.fromEntries(ti.tests.map((x) => [x.path, x]));
  assert.deepEqual(t['tests/test_premium.py'].cases.map((c) => c.name), ['test_band']);
  assert.deepEqual(t['pkg/calc_test.go'].cases.map((c) => c.name), ['TestCalc']);
  assert.equal(t['pkg/calc_test.go'].asserts.length, 1);
  assert.ok(reaches(t['tests/test_premium.py'], new Set(['app/pricing/rates.py']), ti.srcImports)); // through premium.py
  assert.ok(reaches(t['pkg/calc_test.go'], new Set(['pkg/calc.go']), ti.srcImports));
  assert.ok(!reaches(t['pkg/calc_test.go'], new Set(['app/pricing/rates.py']), ti.srcImports));
  // a test of computeRefund does not reach RefundService (service imports amount, not the other way round)
  assert.ok(!reaches(t['unit/refund.test.ts'], new Set(['src/refund/service.ts']), ti.srcImports));
  assert.ok(reaches(t['unit/alias.test.ts'], new Set(['src/refund/service.ts']), ti.srcImports)); // alias: cannot follow, passes
});

test('discover: design docs by their parts, ADR status headings, superseded lines, templates and guides', () => {
  const { features, score, SUPERSEDED } = require('../src/discover');
  const sc = (file, t) => score(features(file, t), t.length);
  assert.ok(sc('docs/payments.md', '# Payments\n\n## Background\nx\n## Goals\ny\n## Detailed design\nz\n## Alternatives considered\nw\n') >= 3, 'a design doc with no "shall"');
  assert.ok(sc('a.md', '# 支付\n\n## 背景\n## 目标\n## 方案设计\n## 备选方案\n') >= 3, 'the same in Chinese');
  assert.ok(sc('doc/adr/0002-x.md', '# 2. Staged parser\n\nDate: 2021-04-04\n\n## Status\n\nProposed\n\n## Context\nx\n## Decision\ny\n') >= 3, 'ADR with a Status heading');
  assert.equal(sc('src/template.md', '# NUMBER. TITLE\n\nDate: DATE\n\n## Status\n\nSTATUS\n\n## Context\nx\n## Decision\ny\n'), 0, 'a template');
  assert.ok(sc('docs/tips.md', '# Tips\n\nWhen you call got twice, the cache is used.\nThen it returns.\n') < 1.5, 'prose that starts with When is not Gherkin');
  assert.ok(sc('docs/guide.md', '# Guide\n\n## Installation\n## Usage\nThe token must be set. It must not be empty.\n') < 3, 'a guide that says "must" is not admitted by code');
  assert.ok(SUPERSEDED.test('## Status\n\nProposed.\n\nSuperceded by [9. Atomic](0009-atomic.md)\n'));
  assert.ok(SUPERSEDED.test('## Status\n\nDeprecated\n'));
});

test('Placement: code decides the lowest level a rule belongs at (shift left)', () => {
  const { belongsAt } = require('../src/evidence');
  const { root } = repo({
    'src/session.ts': 'export function isExpired(at: number, now: number) {\n  return now - at > 30 * 60000;\n}\n',
    'src/pay.ts': 'export class Pay {\n  async charge(c) {\n    const r = await fetch(url);\n    return r.ok;\n  }\n}\n',
  });
  const r = (o) => ({ title: '', text: '', limits: [], logicKind: 'other', impl: null, ...o });
  assert.equal(belongsAt(r({ logicKind: 'date' }), root).level, 'unit');
  assert.equal(belongsAt(r({ logicKind: 'io', text: 'Gateway calls have a retry limit set in config.', limits: [{ value: 2, unit: '' }] }), root).level, 'unit', 'a counted limit inside an outside call');
  assert.equal(belongsAt(r({ impl: { path: 'src/session.ts', line: 1, symbol: 'isExpired' } }), root).by, '`isExpired` does no I/O');
  assert.equal(belongsAt(r({ logicKind: 'io', impl: { path: 'src/pay.ts', line: 2, symbol: 'Pay.charge' } }), root).level, 'component');
  assert.equal(belongsAt(r({ logicKind: 'ui' }), root), null);
});

test('discover: rst headings, genre titles, pip lists, and "must" alone goes to the model', () => {
  const { features, score } = require('../src/discover');
  const sc = (file, t) => score(features(file, t), t.length);
  const rst = 'Design for handling network errors\n==================================\n\nBackground\n----------\nx\n\nProposed solution\n-----------------\ny\n\nAlternatives considered\n-----------------------\nz\n';
  assert.ok(features('notes/net.rst', rst).parts >= 3, 'rst underlined headings are read');
  assert.ok(features('docs/data-model.md', '# Note Maps: Data Model\r\n\r\nA note map is a set of notes.\r\n').titled, 'a title that ends with the genre');
  const gov = '# Governance\n\nThe TSC must meet monthly. Members must vote. A quorum must be present. Decisions must be recorded. Minutes must be public. The lead must report.\n';
  const g = sc('docs/governance.md', gov);
  assert.ok(g >= 1.5 && g < 3, '"must" without spec structure is borderline, not admitted');
  const { NON_SPEC } = require('../src/discover');
  assert.ok(NON_SPEC.test('requirements-dev.txt') && NON_SPEC.test('minimum-constraints-install.txt'), 'pip dependency lists');
  assert.ok(!NON_SPEC.test('docs/requirements.md'));
});
