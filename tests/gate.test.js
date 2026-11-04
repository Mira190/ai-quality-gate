'use strict';
// The v0.2 precision layer: verdict memo, seams for Placement, execution evidence, and the gate.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aqg-gate-'));
  for (const [p, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), text);
  }
  return { root, files: Object.keys(files) };
}

test('memo: an unchanged item gets its earlier replies back; only changed items are asked, and votes are permuted', async () => {
  const { LLM } = require('../src/llm');
  const memo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aqg-memo-')), 'memo.json');
  const asked = [];
  const make = () => {
    const llm = new LLM({ mode: 'offline', votes: 3 });
    llm.mode = 'live'; llm.memoPath = memo; // live without a client: votes are stubbed
    if (fs.existsSync(memo)) llm.memo = JSON.parse(fs.readFileSync(memo, 'utf8'));
    llm.votes = async (key, opts) => [0, 1, 2].map((k) => { const o = opts(k); asked.push({ key, prompt: o.prompt }); return { rules: o.items.map((it) => ({ id: it.id, verdict: `${it.text}:v` })) }; });
    return llm;
  };
  const build = (b, i, k) => ({ prompt: b.map((x) => x.id).join(k ? ',' : ' '), items: b });
  const items = [{ id: 'REQ-01', text: 'a' }, { id: 'REQ-02', text: 'b' }];
  const one = make();
  const r1 = await one.batchVotes('t', items, { size: 12, hashOf: (x) => x.text, build });
  one.save();
  assert.equal(r1.length, 6);
  assert.notEqual(asked[0].prompt, asked[1].prompt, 'vote 2 sees another order');
  asked.length = 0;
  // REQ-02 renumbered to REQ-03 with the same text, REQ-01's text edited
  const two = make();
  const r2 = await two.batchVotes('t', [{ id: 'REQ-01', text: 'a2' }, { id: 'REQ-03', text: 'b' }], { size: 12, hashOf: (x) => x.text, build });
  assert.deepEqual(asked.map((a) => a.prompt.replace(',', ' ')), ['REQ-01', 'REQ-01', 'REQ-01'], 'only the edited rule is asked');
  assert.deepEqual(r2.filter((x) => x.id === 'REQ-03').map((x) => x.verdict), ['b:v', 'b:v', 'b:v'], 'the renumbered rule keeps its verdict');
  assert.deepEqual(two.memoStats, { hits: 1, misses: 1 });
});

test('seams: pure helper, fake-able dependency, import-time I/O, not exported', () => {
  const { findSeam, placementFor, misplaced } = require('../src/placement');
  const { root } = repo({
    'src/repo.ts': "import { Client } from 'pg';\nexport const DAYS = 30;\nexport class Repo {\n  constructor(private db: Client) {}\n  async find(id: string, now: Date) {\n    const { rows } = await this.db.query('select', [id]);\n    return rows[0] && !isPast(rows[0].at, now) ? rows[0] : null;\n  }\n}\nexport function isPast(at: Date, now: Date): boolean {\n  return now.getTime() - at.getTime() > DAYS * 86400000;\n}\n",
    'src/gw.ts': "export class Gw {\n  async charge(c: number) {\n    for (let i = 0; i <= 2; i++) { const r = await fetch('/x'); if (r.ok) return true; }\n    return false;\n  }\n}\n",
    'src/areas.ts': "import { readFileSync } from 'node:fs';\nconst areas = new Set(readFileSync('a.csv', 'utf8').split('\\n'));\nexport function ok(p: string) {\n  return areas.has(p);\n}\n",
    'src/hidden.ts': 'function calc(a: number) {\n  return a * 2;\n}\n',
    'src/wired.ts': "import { Client } from 'pg';\nexport async function load(id: string) {\n  const c = new Client();\n  return c.query('x', [id]);\n}\n",
  });
  const r = (impl, o = {}) => ({ impl, limits: [], ...o });
  assert.deepEqual(['pure', 'isPast'], ((s) => [s.kind, s.symbol])(findSeam(r({ path: 'src/repo.ts', line: 5, symbol: 'Repo.find' }), root)), 'a pure helper the method calls');
  assert.equal(findSeam(r({ path: 'src/gw.ts', line: 2, symbol: 'Gw.charge' }), root).kind, 'fake', 'only global fetch: a fake server or stub');
  assert.match(findSeam(r({ path: 'src/areas.ts', line: 3, symbol: 'ok' }), root).why, /when it is imported/);
  assert.match(findSeam(r({ path: 'src/hidden.ts', line: 1, symbol: 'calc' }), root).why, /not exported/);
  assert.equal(findSeam(r({ path: 'src/wired.ts', line: 2, symbol: 'load' }), root).kind, 'none', 'a connection built inside');
  assert.equal(findSeam(r(null), root).why, 'no implementation located');
  const idx = { tests: [{ path: 'test/a.test.ts', level: 'unit' }] };
  const ideal = { level: 'unit', by: 'date rule' };
  const p = placementFor(r({ path: 'src/areas.ts', line: 3, symbol: 'ok' }), root, idx, ideal);
  assert.equal(p.level, null, 'no seam, no unit advice');
  assert.equal(misplaced(p, [{ level: 'e2e' }]), false);
  const q = placementFor(r({ path: 'src/repo.ts', line: 10, symbol: 'isPast' }), root, { tests: [] }, ideal);
  assert.equal(q.level, 'unit');
  assert.equal(q.infra, false, 'no unit tests yet: the advice costs a test setup');
  assert.equal(misplaced(q, [{ level: 'integration' }]), true);
});

test('execute: extreme and limit mutants against the linked tests; files are restored', () => {
  const { probeRules, verdictOf } = require('../src/execute');
  const src = 'const LIMIT = 30;\nfunction ok(days) {\n  return days <= LIMIT;\n}\nmodule.exports = { ok };\n';
  const { root } = repo({
    'src/ret.js': src,
    // a pseudo-test: it calls the code and checks nothing it does
    'test/weak.test.js': "const { ok } = require('../src/ret');\nrequire('node:test')('runs', () => { ok(3); });\n",
    // a boundary test: on and past the edge
    'test/edge.test.js': "const assert = require('node:assert');\nconst { ok } = require('../src/ret');\nrequire('node:test')('edge', () => { assert.equal(ok(30), true); assert.equal(ok(31), false); });\n",
  });
  const rule = (id, t) => ({ id, impl: { path: 'src/ret.js', line: 2, symbol: 'ok' }, limits: [{ value: 30, unit: 'days' }], links: [{ path: t }] });
  const testIndex = { tests: [{ path: 'test/weak.test.js', level: 'unit' }, { path: 'test/edge.test.js', level: 'unit' }] };
  const probes = probeRules([rule('REQ-01', 'test/weak.test.js'), rule('REQ-02', 'test/edge.test.js')], { root, testIndex, command: 'node --test {files}', timeoutS: 60 });
  assert.equal(fs.readFileSync(path.join(root, 'src/ret.js'), 'utf8'), src, 'restored');
  const weak = verdictOf(probes.get('REQ-01')), edge = verdictOf(probes.get('REQ-02'));
  assert.equal(weak.asserts, false, 'the extreme mutant survives a test that checks nothing');
  assert.equal(edge.asserts, true);
  assert.deepEqual(edge.edges, [], 'every limit and edge mutant is killed by the boundary test');
  assert.ok(probes.get('REQ-02').mutants.some((m) => m.kind === 'edge' && m.to.includes('< LIMIT')));
});

test('gate: evidence basis, new only, scope, suppressions with expiry, fingerprints survive renumbering', () => {
  const { decide, fingerprint, checkSuppressions, toSarif } = require('../src/gate');
  const rule = (id, o = {}) => ({ id, title: 'Discount cap', text: `${id} Discounts never exceed 20%.`, path: 'docs/r.md', line: 3, kind: 'requirement', links: [], fails: [], evidence: { fails: [] }, ...o });
  const r1 = rule('REQ-01', { strongCandidates: 0 }), r2 = rule('REQ-02', { title: 'Refund', text: 'Refund minus a $50 fee.', strongCandidates: 3 }), r3 = rule('REQ-03', { title: 'Expiry', text: 'Sessions expire.', links: [{ path: 't.test.ts', source: 'AI' }], evidence: { fails: [{ check: 'Asserts the rule', basis: 'E', facts: {} }] } });
  const issues = [
    { section: 3, rule: r1, check: 'No test', priority: 'P0' }, // S: the search found no candidate at all
    { section: 3, rule: r2, check: 'No test', priority: 'P0' }, // M: the model turned candidates down
    { section: 3, rule: r3, check: 'Asserts the rule', priority: 'P1' }, // E: a mutant survived
    { section: 5, check: 'Lint', checkKey: 'lint', kind: 'missing', text: 'No lint step', priority: 'P3' },
  ];
  const ledger = { meta: { date: '2026-11-04', repo: 'a/b', sha: 'x', usage: { calls: 0 }, aiu: 0 }, rules: [r1, r2, r3], issues };
  let g = decide(ledger, {});
  const by = (r) => g.findings.find((f) => f.rule === r);
  assert.deepEqual([by(r1).basis, by(r2).basis, by(r3).basis], ['S', 'M', 'E']);
  assert.deepEqual([by(r1).blocking, by(r2).blocking, by(r3).blocking], [true, false, true], 'the model alone never blocks');
  assert.equal(g.findings.find((f) => f.section === 5).blocking, false, 'P3 is below fail-on P1');
  // the same rule renumbered keeps its fingerprint
  assert.equal(fingerprint({ section: 3, rule: { ...r1, id: 'REQ-09', text: 'REQ-09 Discounts never exceed 20%.' }, check: 'No test' }), by(r1).fingerprint);
  // baseline: existing debt does not block
  g = decide(ledger, { baseline: { fingerprints: [fingerprint(issues[0])] } });
  assert.equal(by(r1).blocking, false); assert.equal(by(r1).why, 'in the baseline');
  // scope: a change that touches none of the finding's files
  g = decide(ledger, { changed: ['src/other.ts'] });
  assert.equal(g.verdict, 'pass');
  g = decide(ledger, { changed: ['docs/r.md'] });
  assert.equal(g.verdict, 'fail');
  // suppressions need a reason and an expiry within a year; expired ones come back
  const { valid, problems } = checkSuppressions([{ rule: 'REQ-01', check: 'No test' }, { rule: 'REQ-01', check: 'No test', reason: 'covered in the contract repo', until: '2026-12-01' }, { rule: 'REQ-03', check: 'Asserts the rule', reason: 'known gap, ticket Q-12', until: '2026-01-01' }], '2026-11-04');
  assert.equal(problems.length, 1); assert.equal(valid.length, 2); assert.equal(valid[1].expired, true);
  g = decide(ledger, { suppress: valid.map(({ id, expired, ...s }) => s) });
  assert.equal(by(r1).blocking, false); assert.ok(by(r1).suppressed);
  assert.equal(by(r3).blocking, true, 'an expired suppression no longer applies'); assert.equal(by(r3).suppressionExpired, '2026-01-01');
  const sarif = toSarif(g, ledger);
  assert.equal(sarif.runs[0].results.length, 3, 'suppressed findings stay out of code scanning');
  assert.ok(sarif.runs[0].results.every((x) => x.partialFingerprints['aqgFingerprint/v1']));
});

test('config: unknown keys and bad values are errors, not silent defaults', () => {
  const { loadConfig, policyOf } = require('../src/config');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqg-cfg-'));
  const f = path.join(dir, '.quality-gate.yml');
  fs.writeFileSync(f, 'gate:\n  fail_on: P0\n  basis: [E, S]\n  fial: 1\ncritical:\n  money: [premium]\n');
  const { config, errors } = loadConfig(f);
  assert.deepEqual(errors, ['gate.fial: unknown key']);
  assert.deepEqual(policyOf(config), { failOn: 'P0', basis: ['E', 'S'], newOnly: true });
  fs.writeFileSync(f, 'gate:\n  fail_on: high\n  basis: [X]\n');
  assert.equal(loadConfig(f).errors.length, 2);
  const { tagRules } = require('../src/critical');
  const [r] = tagRules([{ id: 'REQ-01', kind: 'requirement', title: 'Tenant isolation', text: 'A tenant sees only its own rows.' }], { 'access control': ['tenant'] });
  assert.equal(r.critical.area, 'access control');
});
