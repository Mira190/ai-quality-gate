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

test('costUsd uses the Haiku 5.5 card', () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
  near(costUsd('claude-haiku-5-5', { input_tokens: 50000, output_tokens: 1e6 }), 0.505);
  near(costUsd('claude-haiku-5-5', { input_tokens: 200000, output_tokens: 0 }), 0.1); // long-prompt card above 100K
});
