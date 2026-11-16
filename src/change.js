'use strict';
// Shift left: what does this change (a pull request, a staged commit) put at risk? Deterministic, from the diff, the
// test index and the proofs.
//   - changed source that no test reaches, with no test changed alongside it;
//   - which rules the change touches (through the tests that import the changed files), and which tests to run first.
const path = require('node:path');
const { make } = require('./findings');
const { AREAS } = require('./extract/risk');
const { plural, uniq } = require('./util');

const TRIVIAL = /(^|\/)(index|types?|constants?|config|settings|__init__|version)\.[a-z]+$|\.(config|d)\.[cm]?[jt]s$|(^|\/)(migrations?|scripts?|tools?|docs?|examples?|bin)\//i;

function analyzeChange({ changes, inventory, tests, proofs, config }) {
  const testsBySource = new Map();
  for (const tf of tests.files) for (const src of tf.imports) { if (!testsBySource.has(src)) testsBySource.set(src, []); testsBySource.get(src).push(tf); }
  const changedTests = [...changes.keys()].filter((p) => inventory.byPath.get(p)?.kind === 'test');
  const changedTestStems = new Set(changedTests.map((p) => path.posix.basename(p).toLowerCase().replace(/\.[^.]+$/, '').replace(/^test_/, '').replace(/[._-]?(tests?|spec|it|e2e|int|integration|unit)$/i, '')));
  const rulesByImpl = new Map();
  for (const p of proofs) for (const f of p.impl || []) { if (!rulesByImpl.has(f)) rulesByImpl.set(f, []); rulesByImpl.get(f).push(p); }

  const findings = [], affectedTests = new Set(), touchedRules = new Set();
  for (const [file, ch] of [...changes].sort()) {
    const f = inventory.byPath.get(file);
    if (!f || ch.status === 'D') continue;
    if (f.kind === 'test') { affectedTests.add(file); continue; }
    if (f.kind !== 'source') continue;
    const reaching = testsBySource.get(file) || [];
    for (const tf of reaching) affectedTests.add(tf.path);
    for (const p of rulesByImpl.get(file) || []) touchedRules.add(p.rule.id);
    if (reaching.length || ch.addedLines < 5 || TRIVIAL.test(file)) continue;
    const stem = path.posix.basename(file).toLowerCase().replace(/\.[^.]+$/, '');
    if (changedTestStems.has(stem)) continue;
    const area = Object.entries(AREAS).find(([, re]) => re.test(file.replace(/[/_.-]/g, ' ')));
    findings.push(make({
      section: 'change', check: 'change.untested', priority: area ? 'P1' : 'P2', basis: 'S', subject: file, critical: Boolean(area),
      title: `${file} changed and no test reaches it`,
      detail: `${plural(ch.addedLines, 'line')} ${ch.status === 'A' ? 'added in a new file' : 'added'}; no test file imports it, and this change adds no test for it${area ? ` (the path says ${area[0]})` : ''}.`,
      fix: `Add a unit test next to it (${suggestTestPath(file, f.lang)}) for the behaviour this change adds.`,
      loc: { path: file, line: ch.added[0]?.[0] || 1 }, anchors: [{ path: file }],
    }));
  }
  void config;
  return { findings, affectedTests: [...affectedTests].sort(), touchedRules: uniq([...touchedRules]).sort(), changedFiles: changes.size };
}

function suggestTestPath(file, lang) {
  const dir = path.posix.dirname(file), base = path.posix.basename(file), ext = base.slice(base.lastIndexOf('.'));
  const stem = base.slice(0, -ext.length);
  const d = dir === '.' ? '' : dir + '/';
  if (lang === 'python') return `\`${d}test_${stem}.py\``;
  if (lang === 'go') return `\`${d}${stem}_test.go\``;
  if (lang === 'java') return `\`${stem}Test${ext}\``;
  if (lang === 'ruby') return `\`${stem}_spec.rb\``;
  return `\`${d}${stem}.test${ext}\``;
}

module.exports = { analyzeChange };
