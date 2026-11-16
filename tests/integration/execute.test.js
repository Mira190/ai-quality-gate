'use strict';
// Executed evidence against a repository whose tests really run (node:test, no dependencies): the gate moves a
// rule's limit in the code and runs the linked tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadConfig } = require('../../src/config');
const { runPipeline } = require('../../src/pipeline');
const { renderReport } = require('../../src/report/markdown');
const { findSite } = require('../../src/execute');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aqg-exec-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const FILES = {
  'docs/requirements.md': '# Requirements\n\n- **REQ-1 Discount cap.** Discounts never exceed 20% of the order total.\n- **REQ-2 Refund window.** A refund can be requested within 30 days of delivery.\n- **REQ-3 Retry.** A failed payment is retried at most 3 times.\n',
  'src/discount.js': "'use strict';\nconst MAX_PERCENT = 20;\nconsole.log('cap is 20');\nexports.applyDiscount = (total, percent) => total - (total * Math.min(percent, MAX_PERCENT)) / 100;\n",
  'src/refund.js': "'use strict';\nexports.canRefund = (days) => days <= 30;\n",
  'src/retry.js': "'use strict';\nexports.attempts = () => 3;\n",
  // guards the limit: 21% must still give the 20% price
  'tests/discount.test.js': "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\nconst { applyDiscount } = require('../src/discount');\n\ntest('REQ-1 caps the discount at 20%', () => {\n  assert.equal(applyDiscount(100, 20), 80);\n  assert.equal(applyDiscount(100, 21), 80);\n});\n",
  // names the rule, uses the number, asserts something, and would not notice 31 days being accepted
  'tests/refund.test.js': "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\nconst { canRefund } = require('../src/refund');\n\ntest('REQ-2 allows a refund within 30 days', () => {\n  assert.equal(canRefund(30), true);\n  assert.equal(canRefund(5), true);\n});\n",
  'tests/retry.test.js': "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\nconst { attempts } = require('../src/retry');\n\ntest('REQ-3 retries at most 3 times', () => {\n  assert.equal(attempts(), 3);\n});\n",
};
function build(name) {
  const dir = path.join(tmp, name);
  for (const [p, text] of Object.entries(FILES)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), text); }
  const git = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.email=f@example.com', '-c', 'user.name=f', '-c', 'commit.gpgsign=false', ...a], { stdio: 'pipe' });
  git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'base');
  return dir;
}
const run = (dir, over = {}, cacheDir = path.join(tmp, `cache-${Math.random().toString(36).slice(2)}`)) => {
  const { config } = loadConfig(null, { ai: { provider: 'none' }, execute: { enabled: true, test_command: `${process.execPath} --test {files}`, ...over } });
  return runPipeline({ root: dir, config, cacheDir });
};

test('GATE-26 the limit is moved in the code and the linked tests are run: a test that would not notice is a P0, executed', async () => {
  const dir = build('a');
  const before = Object.fromEntries(Object.keys(FILES).map((p) => [p, fs.readFileSync(path.join(dir, p), 'utf8')]));
  const ledger = await run(dir);
  const p = Object.fromEntries(ledger.proofs.map((x) => [x.rule.id, x]));
  assert.deepEqual([p['REQ-1'].status, p['REQ-1'].basis, p['REQ-1'].executed.outcome], ['proven', 'E', 'killed']);
  assert.deepEqual([p['REQ-2'].status, p['REQ-2'].executed.outcome], ['weak', 'survived']);
  assert.equal(p['REQ-3'].executed.outcome, 'killed');
  const f = ledger.findings.find((x) => x.check === 'proof.survived');
  assert.deepEqual([f.subject, f.priority, f.basis, f.blocking], ['REQ-2', 'P0', 'E', true]);
  assert.match(f.title, /moving its limit in the code fails no test \(`src\/refund\.js:2`: 30 → 31\)/);
  assert.match(f.detail, /With `exports\.canRefund = \(days\) => days <= 30;` changed to use 31, `tests\/refund\.test\.js` still passed/);
  assert.match(f.fix, /Add cases at 29, 30 and 31 that fail when the limit moves/);
  // reading alone could not tell these two tests apart: without the stage both rules are simply "proven"
  const { config } = loadConfig(null, { ai: { provider: 'none' } });
  const read = await runPipeline({ root: dir, config, cacheDir: path.join(tmp, 'c-read') });
  assert.deepEqual(read.proofs.map((x) => x.status), ['proven', 'proven', 'proven']);
  // every file is back as it was
  for (const [file, text] of Object.entries(before)) assert.equal(fs.readFileSync(path.join(dir, file), 'utf8'), text, file);
  assert.match(renderReport(ledger), /Executed: for 3 rules with a limit, the limit was moved in the code and the linked tests run \(3 runs now, 0 from the cache\): 2 caught it, 1 did not/);
  assert.equal(ledger.ai.stats.requests, 0);
});

test('GATE-26 one mutant per rule, where the number decides something; results are cached; the budget holds', async () => {
  const dir = build('b');
  // the constant, not the log line that also says 20
  assert.deepEqual((({ file, line, from, to }) => [file, line, from, to])(findSite(dir, ['src/discount.js'], [{ value: '20', unit: '%' }])), ['src/discount.js', 2, '20', '21']);
  assert.equal(findSite(dir, ['src/discount.js'], [{ value: '77', unit: '' }]), null);
  const cacheDir = path.join(tmp, 'c-b');
  const first = await run(dir, {}, cacheDir);
  const second = await run(dir, {}, cacheDir);
  assert.deepEqual([first.executed.ran, first.executed.cached, second.executed.ran, second.executed.cached], [3, 0, 0, 3]);
  assert.deepEqual(second.findings.map((f) => [f.check, f.subject, f.basis]), first.findings.map((f) => [f.check, f.subject, f.basis]));
  const capped = await run(dir, { max_mutants: 1 });
  assert.deepEqual([capped.executed.ran, capped.executed.over], [1, 2]);
});

test('GATE-26 nothing is concluded when the tests are red before any change, and work in progress is never written over', async () => {
  const dir = build('c');
  fs.writeFileSync(path.join(dir, 'tests/refund.test.js'), FILES['tests/refund.test.js'].replace('canRefund(5), true', 'canRefund(5), false'));
  execFileSync('git', ['-C', dir, '-c', 'user.email=f@example.com', '-c', 'user.name=f', '-c', 'commit.gpgsign=false', 'commit', '-qam', 'red'], { stdio: 'pipe' });
  // an uncommitted edit in the file a mutant would touch
  fs.appendFileSync(path.join(dir, 'src/retry.js'), '// work in progress\n');
  const ledger = await run(dir);
  const p = Object.fromEntries(ledger.proofs.map((x) => [x.rule.id, x]));
  assert.match(p['REQ-2'].executed.why, /do not pass before any change/);
  assert.match(p['REQ-3'].executed.why, /uncommitted changes/);
  assert.ok(!ledger.findings.some((f) => f.check === 'proof.survived'));
  assert.match(fs.readFileSync(path.join(dir, 'src/retry.js'), 'utf8'), /work in progress/);
});
