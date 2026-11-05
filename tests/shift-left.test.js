'use strict';
// v0.3: cheaper votes (prompt caching, adaptive votes, per-stage votes, Message Batches), change impact on the diff,
// traceability by construction, and agent-time checks (MCP server, hook).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { LLM } = require('../src/llm');

function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aqg-sl-'));
  for (const [p, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), text);
  }
  return root;
}
const git = (root, ...a) => execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });

// a live LLM whose client is a stub that records requests
function stubLLM(reply, opts = {}) {
  const llm = new LLM({ mode: 'offline', ...opts });
  llm.mode = 'live';
  const seen = [];
  llm.client = { messages: { create: async (p) => { seen.push({ p, at: seen.length }); await new Promise((r) => setTimeout(r, 5)); return { stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: JSON.stringify(reply(p, seen.length)) }] }; } } };
  return { llm, seen };
}

test('prompt caching: the shared prefix goes first with cache_control, and the first vote goes alone', async () => {
  const order = [];
  const { llm, seen } = stubLLM(() => ({ rules: [{ id: 'R1', ok: true }] }));
  const create = llm.client.messages.create;
  llm.client.messages.create = async (p) => { order.push('start'); const r = await create(p); order.push('end'); return r; };
  await llm.votes('k', { system: 's', prefix: 'SHARED', prompt: 'ITEMS', schema: {} });
  const content = seen[0].p.messages[0].content;
  assert.deepEqual(content[0], { type: 'text', text: 'SHARED', cache_control: { type: 'ephemeral' } });
  assert.deepEqual(content[1], { type: 'text', text: 'ITEMS' });
  assert.deepEqual(order.slice(0, 2), ['start', 'end'], 'vote 1 finishes (writes the cache) before votes 2 and 3 start');
  assert.equal(seen.length, 3);
});

test('adaptive votes: two votes when they agree, the full count alone when they do not; per-stage votes', async () => {
  // R1 always agrees; R2 flips on the second vote of the batch
  let call = 0;
  const { llm, seen } = stubLLM((p) => {
    call++;
    const solo = p.messages[0].content.includes('SOLO');
    return { rules: (solo ? ['R2'] : ['R1', 'R2']).map((id) => ({ id, ok: id === 'R1' || solo || call !== 2 })) };
  });
  const build = (b, i, k) => ({ system: 's', prompt: b.length === 1 ? `SOLO ${b[0].id}` : b.map((x) => x.id).join(','), schema: {} });
  const out = await llm.batchVotes('asserts', [{ id: 'R1' }, { id: 'R2' }], { hashOf: (x) => x.id, signature: (x) => String(x.ok), build });
  assert.equal(seen.length, 2 + 3, 'two batch votes, then three solo votes for R2 only');
  assert.equal(out.filter((x) => x.id === 'R1').length, 2);
  assert.deepEqual(out.filter((x) => x.id === 'R2').map((x) => x.ok), [true, true, true]);
  assert.deepEqual(llm.voteStats, { calls: 2, saved: 1 });
  const one = stubLLM(() => ({ decisions: [{ id: 'D1', verdict: 'built' }] }), { votes: { default: 3, built: 1 } });
  await one.llm.batchVotes('built', [{ id: 'D1' }], { field: 'decisions', hashOf: (x) => x.id, signature: (x) => x.verdict, build: () => ({ prompt: 'x', schema: {} }) });
  assert.equal(one.seen.length, 1, 'a stage set to one vote asks once');
});

test('Message Batches: requests made together go out as one batch, results are matched by custom_id, half price', async () => {
  const llm = new LLM({ mode: 'offline', batchPollMs: 1 });
  llm.mode = 'live'; llm.batchApi = true;
  let created;
  llm.client = { messages: { batches: {
    create: async ({ requests }) => { created = requests; return { id: 'b1', processing_status: 'in_progress' }; },
    retrieve: async () => ({ id: 'b1', processing_status: 'ended' }),
    results: async () => (async function* () {
      // any order, one failure
      for (const r of [...created].reverse()) yield r.custom_id === created[1].custom_id ? { custom_id: r.custom_id, result: { type: 'errored' } } : { custom_id: r.custom_id, result: { type: 'succeeded', message: { stop_reason: 'end_turn', usage: { input_tokens: 50000, output_tokens: 0 }, content: [{ type: 'text', text: JSON.stringify({ n: r.params.messages[0].content }) }] } } };
    })(),
  } } };
  const [a, b, c] = await Promise.all(['A', 'B', 'C'].map((x) => llm.ask(x, { system: 's', prompt: x, schema: {} })));
  assert.equal(created.length, 3);
  assert.ok(created.every((r) => /^[a-zA-Z0-9_-]{1,64}$/.test(r.custom_id)));
  assert.deepEqual([a, b, c], [{ n: 'A' }, null, { n: 'C' }]);
  assert.ok(Math.abs(llm.usage.usd - 2 * 0.05 * 0.1 * 0.5) < 1e-12, 'two succeeded requests of 50K input tokens at half the Haiku price');
});

test('diff: hunks with old and new line numbers; a range is touched by added lines or a pure deletion inside it', () => {
  const { parseDiff, touchesRange } = require('../src/diff');
  const d = parseDiff('diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -3 +3 @@ x\n-const N = 30;\n+const N = 45;\n@@ -10,2 +9,0 @@\n-a\n-b\ndiff --git a/new.ts b/new.ts\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,2 @@\n+x\n+y\n');
  const a = d.get('src/a.ts');
  assert.deepEqual(a.hunks[0].removed, [{ line: 3, text: 'const N = 30;' }]);
  assert.deepEqual(a.hunks[0].added, [{ line: 3, text: 'const N = 45;' }]);
  assert.equal(touchesRange(a, 1, 4), true);
  assert.equal(touchesRange(a, 8, 12), true, 'lines removed inside the range');
  assert.equal(touchesRange(a, 5, 7), false);
  assert.equal(d.get('new.ts').added, true);
});

test('impact: unguarded change, code drifts from spec, spec drifts from code, tests to run', () => {
  const { parseDiff } = require('../src/diff');
  const { analyzeImpact } = require('../src/impact');
  const root = repo({
    'docs/req.md': '# R\n- **REQ-01 Retention.** Quotes are kept for 60 days.\n- **REQ-02 Cap.** Discounts never exceed 20%.\n',
    'src/ret.ts': 'export const DAYS = 45;\nexport function past(d: number) {\n  return d > DAYS;\n}\n',
    'src/cap.ts': 'export function cap(x: number) {\n  return Math.min(x, 20);\n}\n',
    'test/ret.test.ts': "import { past } from '../src/ret';\n",
  });
  const rules = [
    { id: 'REQ-01', title: 'Retention', text: 'Quotes are kept for 60 days.', path: 'docs/req.md', line: 2, critical: { area: 'customer data' }, limits: [{ value: 60, unit: 'days' }], impl: { path: 'src/ret.ts', line: 2, symbol: 'past' }, links: [{ path: 'test/ret.test.ts', source: 'name' }], evidence: { level: 'Meets' } },
    { id: 'REQ-02', title: 'Cap', text: 'Discounts never exceed 20%.', path: 'docs/req.md', line: 3, critical: { area: 'money' }, limits: [{ value: 20, unit: '%' }], impl: { path: 'src/cap.ts', line: 1, symbol: 'cap' }, links: [], evidence: { level: 'None' } },
  ];
  const testIndex = { tests: [{ path: 'test/ret.test.ts' }] };
  // PR 1: the code changes 20 → 25 in the cap, and edits nothing else
  let diff = parseDiff('--- a/src/cap.ts\n+++ b/src/cap.ts\n@@ -2 +2 @@\n-  return Math.min(x, 20);\n+  return Math.min(x, 25);\n');
  let r = analyzeImpact(rules, diff, { root, testIndex });
  assert.deepEqual(r.findings.map((f) => [f.rule.id, f.check, f.priority, f.basis]), [['REQ-02', 'Unguarded change', 'P1', 'V'], ['REQ-02', 'Code drifts from spec', 'P1', 'V']]);
  assert.deepEqual([r.findings[1].facts.from, r.findings[1].facts.to], [20, 25]);
  // PR 2: the document changes 45 → 60, the code still says 45
  diff = parseDiff('--- a/docs/req.md\n+++ b/docs/req.md\n@@ -2 +2 @@\n-- **REQ-01 Retention.** Quotes are kept for 45 days.\n+- **REQ-01 Retention.** Quotes are kept for 60 days.\n');
  r = analyzeImpact(rules, diff, { root, testIndex });
  assert.deepEqual(r.findings.map((f) => [f.rule.id, f.check]), [['REQ-01', 'Spec drifts from code']]);
  assert.deepEqual([r.findings[0].facts.path, r.findings[0].facts.line, r.findings[0].facts.from, r.findings[0].facts.to], ['src/ret.ts', 1, 45, 60]);
  assert.deepEqual(r.testsToRun, ['test/ret.test.ts']);
  // the gate takes them in, with a fingerprint and the files they touch
  const { decide } = require('../src/gate');
  const g = decide({ meta: { date: '2026-11-05' }, rules, issues: [], impact: r }, {});
  assert.equal(g.findings[0].section, 6);
  assert.deepEqual(g.findings[0].files, ['docs/req.md', 'src/ret.ts']);
  assert.equal(g.findings[0].blocking, true);
});

test('construct: boundary cases, rule-ID tags as a patch that applies, pending tests for untested rules', () => {
  const { construct, boundaryCases, boundarySnippet } = require('../src/construct');
  const range = { id: 'REQ-02', title: 'Excess', text: 'The customer shall choose an excess from $500 to $5,000.', limits: [{ value: 500, unit: '$' }, { value: 5000, unit: '$' }], path: 'r.md', line: 2 };
  assert.deepEqual(boundaryCases(range).map((c) => [c.value, c.expect]), [[499.99, false], [500, true], [5000, true], [5000.01, false]]);
  assert.match(boundarySnippet({ ...range, impl: { symbol: 'validateExcess' } }, 'js'), /\[499\.99, false\][\s\S]*expect\(validateExcess\(value\)\)\.toBe\(ok\)/);
  assert.match(boundarySnippet({ ...range, impl: { symbol: 'excess_ok' } }, 'py'), /parametrize[\s\S]*\(5000\.01, False\)/);
  const root = repo({
    'test/excess.test.ts': "import { describe, it, expect } from 'vitest';\nimport { ok } from '../src/excess';\n\ndescribe('excess', () => {\n  it('accepts 1000', () => {\n    expect(ok(1000)).toBe(true);\n  });\n});\n",
    'src/excess.ts': 'export const ok = (x: number) => x >= 500 && x <= 5000;\n',
  });
  git(root, 'init', '-q'); git(root, 'add', '-A'); git(root, 'commit', '-qm', 'base');
  const testIndex = { tests: [{ path: 'test/excess.test.ts', level: 'unit', text: fs.readFileSync(path.join(root, 'test/excess.test.ts'), 'utf8'), cases: [{ name: 'accepts 1000', line: 5, end: 7, body: "it('accepts 1000', () => {\n    expect(ok(1000)).toBe(true);" }] }] };
  const rules = [
    { ...range, kind: 'requirement', hasSourceId: true, critical: { area: 'money' }, terms: ['excess'], links: [{ path: 'test/excess.test.ts', source: 'AI' }], linkVotes: { 'test/excess.test.ts': { votes: 3, of: 3 } }, evidence: { fails: [] } },
    { id: 'REQ-03', kind: 'requirement', title: 'Refund fee', text: 'A refund keeps a $50 fee.', limits: [{ value: 50, unit: '$' }], path: 'r.md', line: 3, hasSourceId: true, critical: { area: 'money' }, links: [], traced: true },
    { id: 'REQ-04', kind: 'requirement', title: 'Numbered', text: 'x', path: 'r.md', line: 4, hasSourceId: false, critical: { area: 'money' }, links: [], traced: true },
  ];
  const c = construct(rules, { root, testIndex });
  assert.deepEqual(c.tags.map((t) => [t.rule, t.path, t.line]), [['REQ-02', 'test/excess.test.ts', 5]]);
  assert.deepEqual(c.pending.rules, ['REQ-03'], 'an assigned (moving) ID gets no pending test');
  assert.equal(c.pending.path, 'test/spec-pending.test.ts');
  assert.match(c.pending.text, /import \{ describe, it \} from 'vitest'[\s\S]*it\.todo\('REQ-03 Refund fee: 49\.99/);
  fs.writeFileSync(path.join(root, 'c.patch'), c.patch);
  git(root, 'apply', '--check', 'c.patch');
  git(root, 'apply', 'c.patch');
  assert.match(fs.readFileSync(path.join(root, 'test/excess.test.ts'), 'utf8'), /\n {2}\/\/ covers REQ-02\n {2}it\('accepts 1000'/);
  assert.ok(fs.existsSync(path.join(root, 'test/spec-pending.test.ts')));
  // with a diff, only rules whose document line the change adds get pending tests
  const { parseDiff } = require('../src/diff');
  assert.equal(construct(rules, { root, testIndex, diff: parseDiff('--- a/r.md\n+++ b/r.md\n@@ -9 +9 @@\n-a\n+b\n') }).pending, null);
});

test('agent time: the MCP server answers initialize, tools/list and tools/call; the hook adds context after an edit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqg-agent-'));
  const ledger = path.join(dir, 'ledger.json');
  fs.writeFileSync(ledger, JSON.stringify({ rules: [{ id: 'REQ-12', title: 'Refund', kind: 'requirement', text: 'Refund minus $50.', path: 'docs/r.md', line: 27, critical: { area: 'money' }, impl: { path: 'src/refund.ts', line: 4, symbol: 'computeRefund' }, limits: [{ value: 50, unit: '$' }], links: [{ path: 'unit/refund.test.ts' }], evidence: { level: 'Weak' } }, { id: 'REQ-13', title: 'Fee', kind: 'requirement', text: 'x', path: 'docs/r.md', line: 28, impl: { path: 'src/refund.ts', line: 9, symbol: 'fee' }, limits: [], links: [], evidence: { level: 'None' } }], issues: [{ rule: { id: 'REQ-12' }, priority: 'P1', check: 'Placement' }] }));
  const msgs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'impact', arguments: { files: ['src/refund.ts'] } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} } },
  ];
  const r = spawnSync(process.execPath, [path.join(__dirname, '../agent/mcp-server.js'), '--ledger', ledger], { input: msgs.map((m) => JSON.stringify(m)).join('\n') + '\n', encoding: 'utf8' });
  const out = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(out.length, 4, 'no reply to a notification');
  assert.equal(out[0].result.protocolVersion, '2025-06-18');
  assert.deepEqual(out[1].result.tools.map((t) => t.name), ['rules_for_file', 'rule', 'impact']);
  assert.deepEqual(JSON.parse(out[2].result.content[0].text), { rules: [{ id: 'REQ-12', title: 'Refund', critical: true, test_level: 'Weak' }, { id: 'REQ-13', title: 'Fee', critical: false, test_level: 'None' }], tests_to_run: ['unit/refund.test.ts'] });
  assert.equal(out[3].error.code, -32602);
  const h = spawnSync(process.execPath, [path.join(__dirname, '../agent/after-edit-hook.js')], { input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/refund.ts') }, cwd: dir }), encoding: 'utf8', env: { ...process.env, AQG_LEDGER: ledger } });
  const ctx = JSON.parse(h.stdout).hookSpecificOutput;
  assert.equal(ctx.hookEventName, 'PostToolUse');
  assert.match(ctx.additionalContext, /REQ-12 Refund \[critical: money\].*limits 50 \$; tests: unit\/refund\.test\.ts \(level: Weak\); open: P1 Placement/);
  assert.match(ctx.additionalContext, /REQ-13 Fee.*NO TEST/);
  const none = spawnSync(process.execPath, [path.join(__dirname, '../agent/after-edit-hook.js')], { input: JSON.stringify({ tool_input: { file_path: path.join(dir, 'README.md') }, cwd: dir }), encoding: 'utf8', env: { ...process.env, AQG_LEDGER: ledger } });
  assert.equal(none.stdout, '', 'a file with no rules: no output');
  assert.equal(none.status, 0);
});
