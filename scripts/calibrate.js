#!/usr/bin/env node
'use strict';
// calibrate: vote thresholds per check, from labelled runs (Learn then Test, src/calibrate.js).
//   node scripts/calibrate.js <gold-ledger.json> <run-ledger.json>... [--target 0.9] [--delta 0.1]
// A run's model-backed findings (they carry a vote agreement) are matched to gold by section, rule and check; a finding
// gold does not have is a false positive. Prints, per check, the precision at each agreement level and the loosest
// threshold that keeps precision above target with probability 1 − delta, then a .quality-gate.yml snippet.
// Several live runs of the same fixture give more pairs; real-repository labels give honest ones.
const path = require('node:path');
const { calibrate } = require('../src/calibrate');

const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? Number(argv.splice(i, 2)[1]) : d; };
const target = opt('target', 0.9), delta = opt('delta', 0.1);
const [goldPath, ...runPaths] = argv;
if (!goldPath || !runPaths.length) { console.error('usage: calibrate <gold-ledger.json> <run-ledger.json>... [--target 0.9] [--delta 0.1]'); process.exit(2); }
const key = (i) => (i.section === 5 ? `S5 ${i.check} ${i.kind || ''}` : `S${i.section} ${i.rule.id} ${i.measure || i.check}`);
const gold = new Set(require(path.resolve(goldPath)).issues.map(key));
const byCheck = new Map();
for (const p of runPaths) for (const i of require(path.resolve(p)).issues) {
  if (typeof i.agreement !== 'number') continue;
  const c = i.measure || i.check;
  (byCheck.get(c) || byCheck.set(c, []).get(c)).push({ agreement: i.agreement, correct: gold.has(key(i)) });
}
// even all-correct findings cannot reject H0 below this many: target^n > delta
const minN = Math.ceil(Math.log(delta) / Math.log(target));
const snippet = {};
for (const [check, pairs] of [...byCheck].sort()) {
  const { threshold, table } = calibrate(pairs, { target, delta });
  console.log(`${check}: ${pairs.length} findings`);
  for (const t of table) console.log(`  agreement ≥ ${t.threshold.toFixed(2)}: ${t.correct}/${t.n} correct (${(t.precision * 100).toFixed(0)}%), p = ${t.pValue.toFixed(3)}${t.rejected ? ' ✓' : ''}`);
  if (threshold === null && pairs.length < minN) { console.log(`  → too few findings to calibrate (need at least ${minN} at ${target} precision); label more`); continue; }
  console.log(`  → ${threshold === null ? 'no threshold reaches the target: put this check on probation' : `min_agreement ${threshold}`}`);
  snippet[check] = threshold;
}
console.log(`\n# .quality-gate.yml (precision ≥ ${target} with probability ≥ ${1 - delta})\ngate:\n  min_agreement:\n${Object.entries(snippet).filter(([, t]) => t !== null).map(([c, t]) => `    ${c}: ${t}`).join('\n') || '    {}'}\n  probation: [${Object.entries(snippet).filter(([, t]) => t === null).map(([c]) => c).join(', ')}]`);
