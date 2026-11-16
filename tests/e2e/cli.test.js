'use strict';
// The gate as its users run it: the command line, from outside, against a repository on disk.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { build } = require('../fixtures/shop');

const BIN = path.join(__dirname, '../../bin/aqg.js');
const ANSWERS = path.join(__dirname, '../fixtures/shop.answers.json');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aqg-e2e-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const repo = build(path.join(tmp, 'shop'), { change: true });
const aqg = (args, env = {}) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '', GITHUB_OUTPUT: '', COPILOT_GITHUB_TOKEN: '', ...env } });

test('GATE-19 the exit code is zero unless enforcement was asked for and the gate failed', () => {
  const out = path.join(tmp, 'o1');
  const common = ['run', '--repo', repo.dir, '--base', repo.base, '--out', out, '--cache', path.join(tmp, 'c1'), '--provider', 'none'];
  const report = aqg(common);
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /^FAIL {2}blocking 2/);
  assert.equal(aqg([...common, '--enforce']).status, 1);
  assert.equal(aqg([...common, '--enforce', '--fail-on', 'never']).status, 0);
  assert.equal(aqg(['run', '--repo', path.join(tmp, 'nowhere')]).status, 2);
  assert.equal(aqg(['run', '--bogus']).status, 2);
});

test('the run writes the report, the comment, the findings and SARIF, and the outputs the action reads', () => {
  const out = path.join(tmp, 'o2'), ghOut = path.join(tmp, 'gh-output');
  fs.writeFileSync(ghOut, '');
  const r = aqg(['run', '--repo', repo.dir, '--base', repo.base, '--out', out, '--cache', path.join(tmp, 'c2'), '--provider', 'handoff', '--answers', ANSWERS, '--ai-scope', 'all', '--name', 'acme/shop'], { GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: ghOut });
  assert.equal(r.status, 0, r.stderr);
  for (const f of ['report.md', 'comment.md', 'findings.json', 'results.sarif']) assert.ok(fs.statSync(path.join(out, f)).size > 0, f);
  assert.ok(!fs.existsSync(path.join(out, 'ai-requests.json')), 'every prompt had a recorded answer');
  const outputs = Object.fromEntries(fs.readFileSync(ghOut, 'utf8').trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
  assert.deepEqual([outputs.verdict, outputs.blocking, outputs.pending], ['fail', '2', '0']);
  assert.match(r.stdout, /^::error file=docs\/requirements\.md,line=11,title=P0 proof\.unproven::REQ-9 Gift card limit/m);
  const findings = JSON.parse(fs.readFileSync(path.join(out, 'findings.json'), 'utf8'));
  assert.equal(findings.rules.find((x) => x.id === 'REQ-9').status, 'unproven');
  assert.equal(findings.gate.verdict, 'fail');
  const sarif = JSON.parse(fs.readFileSync(path.join(out, 'results.sarif'), 'utf8'));
  assert.equal(sarif.version, '2.1.0');
  assert.ok(sarif.runs[0].results.some((x) => x.ruleId === 'proof.unproven' && x.level === 'error'));
  const comment = fs.readFileSync(path.join(out, 'comment.md'), 'utf8');
  assert.match(comment, /^<!-- ai-quality-gate -->/);
  assert.match(comment, /#### Blocks this change[\s\S]*REQ-9[\s\S]*#### Placement/);
});

test('handoff: without answers the prompts are written out, and the run still reports', () => {
  const out = path.join(tmp, 'o3');
  const r = aqg(['run', '--repo', repo.dir, '--out', out, '--cache', path.join(tmp, 'c3'), '--provider', 'handoff']);
  assert.equal(r.status, 0, r.stderr);
  const requests = JSON.parse(fs.readFileSync(path.join(out, 'ai-requests.json'), 'utf8'));
  assert.equal(requests.length, 1);
  assert.match(requests[0].prompt, /RULE R1 REQ-5/);
  assert.match(r.stdout, /await a model answer/);
});

test('shift left: `rules --file` lists the rules a file is bound by, before it is edited', () => {
  const r = aqg(['rules', '--repo', repo.dir, '--file', 'src/discount.ts', '--cache', path.join(tmp, 'c4')]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^REQ-1 {2}PROVEN {2}critical\(money\) {2}Discount cap/);
  assert.match(r.stdout, /test {2}tests\/unit\/discount\.test\.ts:4 {2}\(unit\)/);
  const json = JSON.parse(aqg(['rules', '--repo', repo.dir, '--json', '--cache', path.join(tmp, 'c4')]).stdout);
  assert.ok(json.some((x) => x.id === 'REQ-7' && x.status === 'unproven'));
});

test('shift left: --staged reviews what is about to be committed', () => {
  const dir = path.join(tmp, 'staged');
  const r0 = build(dir);
  fs.mkdirSync(path.join(dir, 'src/billing'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/billing/invoice.ts'), Array.from({ length: 8 }, (_, i) => `export const line${i} = ${i};`).join('\n') + '\n');
  spawnSync('git', ['-C', dir, 'add', '-A']);
  const r = aqg(['run', '--repo', dir, '--staged', '--out', path.join(tmp, 'o5'), '--cache', path.join(tmp, 'c5'), '--provider', 'none', '--enforce']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /P1 src\/billing\/invoice\.ts changed and no test reaches it/);
  assert.ok(r0.base);
});
