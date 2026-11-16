'use strict';
// Re-records tests/fixtures/shop.answers.json: the answers of the stand-in model to every prompt the gate writes for
// the fixture repository. Run it after a change to the prompts or to the fixture:  node tests/fixtures/record.js
//
// The "model" here is the table below: one judgment per rule, written by whoever stands in for the model. The script
// only turns those judgments into replies in the shape each prompt asks for, keyed by the prompt's hash.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { build } = require('./shop');
const { loadConfig } = require('../../src/config');
const { runPipeline } = require('../../src/pipeline');
const { sha } = require('../../src/util');

const JUDGMENTS = {
  'REQ-5': { testable: true, proof: 'full', cite: [1, 6], level: 'unit' },
  'REQ-6': { testable: true, proof: 'partial', cite: [1, 5], missing: 'the 12-character boundary: the test only tries 8 characters, never 11 and 12', level: 'unit' },
  'REQ-7': { testable: true, proof: 'none', missing: 'no test exports an order history as CSV', level: 'unit' },
  'REQ-8': { testable: false, proof: 'none', missing: '"fast" has no number; state a time limit such as p95 under <N> ms', level: 'integration' },
  'REQ-9': { testable: true, proof: 'none', missing: 'no test rejects a gift card payment above $500', level: 'unit' },
  'REQ-10': { testable: true, proof: 'none', missing: 'rounding half up to whole cents; the test only checks the currency sign', level: 'unit' },
  'D-6383E1': { testable: false, proof: 'none', missing: 'readability is not behaviour of the software', level: 'unit' },
  'D-F72D1A': { testable: true, proof: 'full', cite: [1, 5], level: 'unit' },
};

function answer(prompt) {
  const rules = [...prompt.matchAll(/^RULE (R\d+) (\S+)/gm)].map((m) => ({ n: m[1], j: JUDGMENTS[m[2]], id: m[2] }));
  for (const r of rules) if (!r.j) throw new Error(`no judgment recorded for ${r.id}`);
  if (prompt.includes('"finds"')) return { finds: rules.map((r) => (r.j.cite ? { rule: r.n, test: `${r.n}.T${r.j.cite[0]}`, line: r.j.cite[1] } : { rule: r.n, test: null })) };
  return { verdicts: rules.map((r) => ({ rule: r.n, testable: r.j.testable, proof: r.j.proof, cites: r.j.cite ? [{ test: `${r.n}.T${r.j.cite[0]}`, line: r.j.cite[1] }] : [], missing: r.j.missing || '', level: r.j.level })) };
}

async function record() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aqg-record-'));
  const out = { _model: 'stand-in (recorded answers)', _note: 'Answers to the prompts the gate writes for tests/fixtures/shop.js, keyed by prompt hash. Written by tests/fixtures/record.js from the judgments in that file.' };
  const file = path.join(tmp, 'answers.json');
  const scenarios = [[build(path.join(tmp, 'a')), 'all'], [build(path.join(tmp, 'b'), { change: true }), 'all'], [build(path.join(tmp, 'c')), 'critical']];
  for (const [repo, scope] of scenarios) {
    for (let round = 0; round < 5; round++) {
      fs.writeFileSync(file, JSON.stringify(out));
      const { config } = loadConfig(null, { ai: { provider: 'handoff', scope } });
      const outDir = path.join(tmp, `out-${round}`);
      const ledger = await runPipeline({ root: repo.dir, config, answersFile: file, outDir, cacheDir: path.join(tmp, `cache-${scope}-${path.basename(repo.dir)}`) });
      if (!ledger.ai.stats.pending) break;
      for (const { prompt } of JSON.parse(fs.readFileSync(path.join(outDir, 'ai-requests.json'), 'utf8'))) out[sha(prompt, 12)] = answer(prompt);
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.writeFileSync(path.join(__dirname, 'shop.answers.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(`recorded ${Object.keys(out).length - 2} answers`);
}

record();
