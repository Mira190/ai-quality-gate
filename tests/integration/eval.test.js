'use strict';
// The scorecard: plant one defect at a time in the fixture repository and compare what the gate reports with what it
// should. Precision and recall must both be 1, the same findings must come out of a second run, and none of it may
// cost a model call.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { build } = require('../fixtures/shop');
const scenarios = require('../fixtures/scenarios');
const { loadConfig } = require('../../src/config');
const { runPipeline } = require('../../src/pipeline');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aqg-eval-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const { config } = loadConfig(null, { ai: { provider: 'none' } });
const review = async (dir, cacheDir) => {
  const ledger = await runPipeline({ root: dir, config, cacheDir });
  return { map: new Map(ledger.findings.map((f) => [`${f.check}:${f.subject}`, f.priority])), ledger };
};

test('GATE-23 scorecard: every planted defect is found, nothing else is reported, and a second run agrees', async () => {
  const base = await review(build(path.join(tmp, 'base')).dir, path.join(tmp, 'cache-base'));
  let tp = 0, fp = 0, fn = 0, unstable = 0;
  const wrong = [];
  for (const [i, sc] of scenarios.entries()) {
    const repo = build(path.join(tmp, `s${i}`));
    sc.apply(repo.dir);
    const cacheDir = path.join(tmp, `cache-${i}`);
    const got = await review(repo.dir, cacheDir);
    const again = await review(repo.dir, cacheDir);
    if (JSON.stringify([...got.map]) !== JSON.stringify([...again.map])) unstable++;
    assert.equal(got.ledger.ai.stats.requests, 0);
    const delta = [];
    for (const [k, p] of got.map) if (!base.map.has(k)) delta.push(`+${k}:${p}`); else if (base.map.get(k) !== p) delta.push(`~${k}:${base.map.get(k)}→${p}`);
    for (const [k, p] of base.map) if (!got.map.has(k)) delta.push(`-${k}:${p}`);
    const want = [...(sc.added || []).map((x) => `+${x}`), ...(sc.removed || []).map((x) => `-${x}`), ...(sc.changed || []).map((x) => `~${x}`)];
    const hit = delta.filter((d) => want.includes(d)).length;
    tp += hit; fp += delta.length - hit; fn += want.length - hit;
    if (delta.length !== hit || want.length !== hit) wrong.push({ scenario: sc.name, unexpected: delta.filter((d) => !want.includes(d)), missed: want.filter((w) => !delta.includes(w)) });
  }
  const precision = tp / (tp + fp || 1), recall = tp / (tp + fn || 1);
  console.log(`scorecard: ${scenarios.length} scenarios · precision ${precision.toFixed(2)} · recall ${recall.toFixed(2)} · unstable ${unstable} · model calls 0`);
  assert.deepEqual(wrong, []);
  assert.deepEqual([precision, recall, unstable], [1, 1, 0]);
});
