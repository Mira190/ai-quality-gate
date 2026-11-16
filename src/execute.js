'use strict';
// Stage "execute" (opt-in): the one kind of evidence that is not reading. For a rule that states a limit and has
// linked tests, move the limit in the code by one step, run only those tests, and see whether one fails.
//   a test fails    the tests guard the limit: the proof is executed evidence (E), the strongest there is
//   all still pass  the tests would not notice the rule being broken: a finding nobody can argue with
// This costs CPU, never tokens, and it catches what no reader can: a test that names the rule, mentions the number,
// asserts something, and still lets the rule be broken.
//
// Kept cheap and quiet the way mutation testing is made practical at scale: one mutant per rule, only where the rule's own number
// stands in code that decides something (not in a log line, a string, a comment or an import), only the linked
// tests are run, and a result is cached until the rule, the code or the tests change.
// The repository's tests run on this machine: the stage is off unless a test command is given.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sha, readText, by } = require('./util');

const ARID = /^\s*(\/\/|#|\*|\/\*|import\b|from\b|export\s+\*|package\b|use\b)|\bconsole\.|\blog(?:ger)?\.\w+\(|\bprint(?:ln|f)?\(|\bthrow\b|\braise\b|\bassert\b|\bexpect\(/;
const DECIDES = /[<>]=?|[!=]==?|\bMath\.(min|max)\b|\bmin\(|\bmax\(|\bconst\b|\bfinal\b|\bstatic\b|^\s*[A-Z][A-Z0-9_]+\s*[:=]|\breturn\b|\?/;

function formsOf(limit) {
  const n = Number(limit.value);
  if (!Number.isFinite(n)) return [];
  const step = limit.value.includes('.') ? Number((10 ** -limit.value.split('.')[1].length).toFixed(6)) : 1;
  const forms = [{ from: limit.value, to: String(+(n + step).toFixed(6)) }];
  if (limit.value.length > 3 && /^\d+$/.test(limit.value)) forms.push({ from: limit.value.replace(/\B(?=(\d{3})+$)/g, '_'), to: String(n + 1) });
  if (limit.unit === '%' || limit.unit === 'percent') { const f = n / 100; forms.push({ from: String(f), to: String(+(f + 0.01).toFixed(6)) }, { from: String(f).replace(/^0\./, '.'), to: String(+(f + 0.01).toFixed(6)) }); }
  return forms;
}

/** Where the rule's number decides something in the code: the best line of the files its tests import. */
function findSite(root, files, limits) {
  let best = null;
  for (const file of files) {
    const text = readText(path.join(root, file), 1 << 18);
    if (text === null) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.length > 300 || ARID.test(l)) continue;
      for (const limit of limits) for (const f of formsOf(limit)) {
        const m = new RegExp(`(?<![\\w.])${f.from.replace(/\./g, '\\.')}(?![\\w.]|\\s*[a-zA-Z%])`).exec(l);
        if (!m) continue;
        const before = l.slice(0, m.index);
        if (((before.match(/['"`]/g) || []).length) % 2) continue; // inside a string
        const score = (DECIDES.test(l) ? 2 : 0) + (f.from === limit.value ? 1 : 0);
        if (!best || score > best.score) best = { file, line: i + 1, col: m.index, from: f.from, to: f.to, score, text: l.trim().slice(0, 120), limit };
      }
    }
  }
  return best && best.score >= 2 ? best : null;
}

function runTests(root, command, files, timeoutS) {
  const cmd = command.includes('{files}') ? command.replace('{files}', files.map((f) => `'${f.replace(/'/g, "'\\''")}'`).join(' ')) : command;
  // a test runner started from inside another test runner must not think it is that runner's child
  const { NODE_TEST_CONTEXT: _ctx, ...env } = process.env;
  const r = spawnSync(cmd, { cwd: root, shell: true, encoding: 'utf8', timeout: timeoutS * 1000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, CI: '1' } });
  if (/** @type {any} */ (r.error)?.code === 'ETIMEDOUT' || r.signal) return 'timeout';
  return r.status === 0 ? 'pass' : 'fail';
}

/**
 * Sets p.executed on proofs: {outcome: 'killed'|'survived'|'skipped', site, why}. Returns stats.
 * A survived mutant adds a hole (kind "survived", evidence E) and turns a proven rule into a weak one.
 */
function executeRules({ root, proofs, inventory, cache, config }) {
  const x = config.execute;
  const stats = { ran: 0, killed: 0, survived: 0, cached: 0, skipped: 0, over: 0, notes: [] };
  if (!x.enabled || !x.test_command) return stats;
  const todo = proofs
    .filter((p) => (p.status === 'proven' || p.status === 'weak') && p.rule.limits.length && p.impl.length && (x.scope === 'all' || p.rule.critical))
    .sort(by((p) => (p.rule.critical ? 0 : 1), (p) => p.rule.id));
  const greenBefore = new Map();
  for (const p of todo) {
    const tests = [...new Set(p.links.filter((l) => !l.case.skipped).map((l) => l.case.file.path))].sort();
    if (!tests.length) continue;
    const site = findSite(root, p.impl, p.rule.limits);
    if (!site) { stats.skipped++; continue; }
    const src = inventory.byPath.get(site.file);
    // never write over work in progress: only a file that is exactly what git has
    if (!src?.sha) { stats.skipped++; p.executed = { outcome: 'skipped', why: `${site.file} has uncommitted changes` }; continue; }
    const key = sha(JSON.stringify([p.rule.text, site.file, src.sha, site.line, site.to, tests.map((t) => inventory.byPath.get(t)?.sha || t), x.test_command]), 20);
    let outcome = cache.get('mutants', key);
    if (outcome) stats.cached++;
    else {
      if (stats.ran >= x.max_mutants) { stats.over++; continue; }
      const tkey = tests.join(' ');
      if (!greenBefore.has(tkey)) greenBefore.set(tkey, runTests(root, x.test_command, tests, x.timeout_s));
      if (greenBefore.get(tkey) !== 'pass') { stats.skipped++; p.executed = { outcome: 'skipped', why: `its tests do not pass before any change (${greenBefore.get(tkey)})` }; if (stats.notes.length < 3) stats.notes.push(`${tests[0]}: ${greenBefore.get(tkey)} before any change`); continue; }
      const file = path.join(root, site.file);
      const original = fs.readFileSync(file, 'utf8');
      const lines = original.split('\n');
      const l = lines[site.line - 1];
      lines[site.line - 1] = l.slice(0, site.col) + site.to + l.slice(site.col + site.from.length);
      let result;
      try {
        fs.writeFileSync(file, lines.join('\n'));
        result = runTests(root, x.test_command, tests, x.timeout_s);
      } finally { fs.writeFileSync(file, original); }
      stats.ran++;
      if (result === 'timeout') { stats.skipped++; p.executed = { outcome: 'skipped', why: 'the test run timed out' }; continue; }
      outcome = result === 'fail' ? 'killed' : 'survived';
      cache.set('mutants', key, outcome);
    }
    p.executed = { outcome, site, tests };
    if (outcome === 'killed') { stats.killed++; if (!p.holes.length) p.basis = 'E'; } else {
      stats.survived++;
      p.holes.push({ kind: 'survived', basis: 'E', text: `moving its limit in the code fails no test (\`${site.file}:${site.line}\`: ${site.from} → ${site.to})`, site, tests, limits: [site.limit] });
      p.status = 'weak';
    }
  }
  return stats;
}

module.exports = { executeRules, findSite, formsOf };
