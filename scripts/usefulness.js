#!/usr/bin/env node
'use strict';
// usefulness: per check, how often a finding was acted on (Google Tricorder's "effective false positive"; ByteDance
// BitsAI-CR's "Outdated Rate": the flagged code was changed afterwards).
//   node scripts/usefulness.js --history .quality-gate-state/history --repo . [--min-actioned 0.25] [--min-findings 10]
// History entries are written by repo-report --history (the action keeps them for runs on the default branch). A
// finding first seen at commit A is acted on when it is gone from the latest run, or when one of its files changed
// between A and the latest commit. A check whose acted-on rate stays under --min-actioned (default 0.25, the rate
// BitsAI-CR holds its rules to; human comments run at 0.35–0.46) over at least --min-findings findings is suggested for
// probation: it keeps reporting but stops blocking. The proxy undercounts fixes made elsewhere, so it only suggests.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const dir = opt('history'), repo = opt('repo', '.'), minActioned = Number(opt('min-actioned', 0.25)), minFindings = Number(opt('min-findings', 10));
if (!dir || !fs.existsSync(dir)) { console.error('usage: usefulness --history <dir> [--repo .]'); process.exit(2); }
const runs = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))).filter((r) => r.commit).sort((a, b) => a.time.localeCompare(b.time));
if (runs.length < 2) { console.error('need at least two runs in the history'); process.exit(0); }
const latest = runs[runs.length - 1], now = new Set(latest.findings.map((f) => f.fingerprint));
const changedSince = new Map();
const changed = (sha) => {
  if (!changedSince.has(sha)) {
    let files = null;
    try { files = execFileSync('git', ['-C', repo, 'diff', '--name-only', sha, latest.commit], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean); } catch { /* commit gone (shallow clone, force push): unknown */ }
    changedSince.set(sha, files);
  }
  return changedSince.get(sha);
};
const first = new Map();
for (const r of runs.slice(0, -1)) for (const f of r.findings) if (!first.has(f.fingerprint)) first.set(f.fingerprint, { ...f, commit: r.commit });
const stats = new Map();
for (const f of first.values()) {
  const files = changed(f.commit);
  const gone = !now.has(f.fingerprint);
  if (!files && !gone) continue; // cannot tell
  const acted = gone || f.files.some((x) => files.some((c) => c === x || (x.endsWith('/') && c.startsWith(x))));
  const s = stats.get(f.check) || { n: 0, acted: 0 };
  s.n++; s.acted += acted ? 1 : 0; stats.set(f.check, s);
}
const probation = [];
console.log('| Check | Findings | Acted on | Rate | Suggestion |\n| --- | :-: | :-: | :-: | --- |');
for (const [c, s] of [...stats].sort((a, b) => a[1].acted / a[1].n - b[1].acted / b[1].n)) {
  const rate = s.acted / s.n, low = s.n >= minFindings && rate < minActioned;
  if (low) probation.push(c);
  console.log(`| ${c} | ${s.n} | ${s.acted} | ${(rate * 100).toFixed(0)}% | ${low ? 'probation' : s.n < minFindings ? 'too few to judge' : 'keep'} |`);
}
console.log(`\n# .quality-gate.yml\ngate:\n  probation: [${probation.join(', ')}]`);
