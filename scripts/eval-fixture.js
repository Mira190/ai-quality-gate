#!/usr/bin/env node
'use strict';
// eval-fixture: compare a run's ledger with the gold answer (the fixture's replay ledger), issue by issue.
//   node scripts/eval-fixture.js <gold-ledger.json> <run-ledger.json> [more run ledgers...]
// Prints recall and precision of shown issues against gold, by section, and the false P0s; with several runs, also
// the run-to-run Jaccard of shown issues (how stable the model's findings are).
const key = (i) => (i.section === 5 ? `S5 ${i.check} ${i.kind || ''}` : `S${i.section} ${i.rule.id} ${i.measure || i.check}`);
const shown = (L) => new Map(L.issues.filter((i) => i.shown).map((i) => [key(i), i]));
const [goldPath, ...runPaths] = process.argv.slice(2);
if (!goldPath || !runPaths.length) { console.error('usage: eval-fixture <gold-ledger.json> <run-ledger.json>...'); process.exit(2); }
const G = shown(require(require('node:path').resolve(goldPath)));
const runs = runPaths.map((p) => shown(require(require('node:path').resolve(p))));

runs.forEach((R, n) => {
  console.log(`run ${n + 1} (${runPaths[n]})`);
  for (const s of [1, 2, 3, 4, 5, 'all']) {
    const g = [...G.keys()].filter((k) => s === 'all' || k.startsWith(`S${s} `)), r = [...R.keys()].filter((k) => s === 'all' || k.startsWith(`S${s} `));
    const hit = g.filter((k) => R.has(k)).length;
    console.log(`  section ${s}: gold ${g.length}, run ${r.length}, hit ${hit}, recall ${g.length ? (hit / g.length).toFixed(2) : '-'}, precision ${r.length ? (hit / r.length).toFixed(2) : '-'}`);
  }
  const p0 = [...R].filter(([k, i]) => i.priority === 'P0' && !G.has(k)).map(([k]) => k);
  console.log(`  false P0 (${p0.length}): ${p0.join('; ') || 'none'}`);
  console.log(`  missed: ${[...G.keys()].filter((k) => !R.has(k)).join('; ') || 'none'}`);
});
if (runs.length > 1) for (let a = 0; a < runs.length; a++) for (let b = a + 1; b < runs.length; b++) {
  const A = new Set(runs[a].keys()), B = new Set(runs[b].keys()), inter = [...A].filter((k) => B.has(k)).length;
  console.log(`Jaccard run ${a + 1} vs ${b + 1}: ${(inter / (A.size + B.size - inter)).toFixed(2)}`);
}
