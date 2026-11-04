'use strict';
// Execution evidence (E), opt-in. "Does the test assert the rule?" is the noisiest model judgment in the pipeline; a
// mutant answers it without a model. For each rule with a located implementation and linked unit/component/integration
// tests, code makes a few rule-targeted mutants and runs only the linked tests against each:
//
//   extreme   the implementing function's body replaced by a default return (Descartes / "pseudo-tested methods",
//             Niedermayr et al.): if the linked tests still pass, they run the code but check nothing it does
//   limit     each literal of a stated limit in the implementation nudged by one (30 → 31, 29) and each comparison on
//             that line flipped at its edge (>= ↔ >): if no linked test fails, the edge is not pinned (ISO 29119-4
//             boundary values, measured instead of grepped)
//
// The tests first run unmutated; a red or timed-out baseline means no verdict for that rule (no flaky evidence).
// Results: killed → the tests are sensitive to the rule (positive evidence, overrides a model "does not assert");
// survived → a deterministic finding with the mutant as its witness.
//
// Safety: this runs the target repository's own tests, so it is only for the repository's own workflow (the action
// with `execute: true`), never for a third-party repository. The child process gets a scrubbed environment: no model
// key, no GitHub token. Every mutated file is restored in a finally block and checked byte for byte afterwards.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { linesOf } = require('./util');
const { bodyAt } = require('./placement');

const SECRET_ENV = /^(NODE_TEST_CONTEXT$|ANTHROPIC_|OPENAI_|GITHUB_TOKEN$|GH_TOKEN$|TARGET_REPO_PAT$|ACTIONS_RUNTIME_TOKEN$|ACTIONS_ID_TOKEN)/;
const scrubbedEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !SECRET_ENV.test(k)));
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function runTests(root, command, files, timeoutS) {
  const cmd = command.includes('{files}') ? command.replace('{files}', files.map(shq).join(' ')) : `${command} ${files.map(shq).join(' ')}`;
  const r = spawnSync('sh', ['-c', cmd], { cwd: root, env: { ...scrubbedEnv(), CI: 'true' }, timeout: timeoutS * 1000, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return { pass: r.status === 0, timedOut: !!(r.error && r.error.code === 'ETIMEDOUT') || r.signal === 'SIGTERM', status: r.status };
}

// A default return for the language, so the extreme mutant still compiles: JS/TS `return undefined as any`,
// Python `return None`, Go cannot be done generically (typed zero values), so Go gets limit mutants only.
function extremeMutant(text, impl) {
  const lines = linesOf(text), body = bodyAt(lines, impl.line, impl.path);
  if (!body) return null;
  const n = linesOf(body).length, start = impl.line - 1, end = start + n - 1;
  if (/\.py$/.test(impl.path)) {
    const head = lines[start];
    if (!/:\s*$/.test(head) || n < 2) return null;
    const ind = /^\s*/.exec(lines[start + 1] || '')[0] || '    ';
    return [...lines.slice(0, start + 1), `${ind}return None`, ...lines.slice(end + 1)].join('\n');
  }
  if (!/\.[cm]?[jt]sx?$/.test(impl.path)) return null;
  const joined = lines.slice(start, end + 1).join('\n');
  const open = joined.indexOf('{'), close = joined.lastIndexOf('}');
  if (open < 0 || close <= open) return null;
  const isTs = /\.[cm]?tsx?$/.test(impl.path);
  const mutated = `${joined.slice(0, open + 1)} return undefined${isTs ? ' as any' : ''}; ${joined.slice(close)}`;
  return [...lines.slice(0, start), mutated, ...lines.slice(end + 1)].join('\n');
}

// Limit mutants: the literal of each stated limit inside the implementing function (or in a constant it names in the
// same file), nudged by one; and the first comparison operator on that line flipped at its edge.
function limitMutants(text, impl, limits) {
  const lines = linesOf(text), body = bodyAt(lines, impl.line, impl.path) || '';
  const bodyLines = linesOf(body).length;
  const consts = [...body.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)].map((m) => m[1]);
  const out = [];
  const litRe = (lim) => new RegExp(`(?<![\\w.])${String(lim.value).replace('.', '\\.')}(?![\\w.])`);
  const blank = (l) => l.replace(/\/\/.*$|#.*$/, (c) => ' '.repeat(c.length));
  // constants that hold a limit (`const LIMIT = 30`): a comparison against them is a comparison at the edge
  const limitConsts = consts.filter((c) => lines.some((l) => new RegExp(`\\b${c}\\b\\s*(?::[^=]+)?=`).test(l) && limits.some((lim) => litRe(lim).test(blank(l)))));
  lines.forEach((l, i) => {
    const inBody = i >= impl.line - 1 && i < impl.line - 1 + bodyLines;
    const constLine = consts.some((c) => new RegExp(`\\b${c}\\b\\s*(?::[^=]+)?=`).test(l));
    if (!inBody && !constLine) return;
    let atEdge = inBody && limitConsts.some((c) => new RegExp(`\\b${c}\\b`).test(l));
    for (const lim of limits) {
      const m = litRe(lim).exec(blank(l));
      if (!m) continue;
      if (inBody) atEdge = true;
      for (const v of [lim.value + 1, lim.value - 1]) {
        const ml = l.slice(0, m.index) + String(v) + l.slice(m.index + m[0].length);
        out.push({ kind: 'limit', line: i + 1, from: l.trim(), to: ml.trim(), text: [...lines.slice(0, i), ml, ...lines.slice(i + 1)].join('\n') });
      }
    }
    const cmp = atEdge && /(>=|<=|(?<![=>-])>(?!=)|(?<![<=])<(?![=<]))/.exec(l);
    if (cmp) {
      const flip = { '>=': '>', '<=': '<', '>': '>=', '<': '<=' }[cmp[1]];
      const ml = l.slice(0, cmp.index) + flip + l.slice(cmp.index + cmp[1].length);
      out.push({ kind: 'edge', line: i + 1, from: l.trim(), to: ml.trim(), text: [...lines.slice(0, i), ml, ...lines.slice(i + 1)].join('\n') });
    }
  });
  // one mutant per distinct change
  return out.filter((m, k) => out.findIndex((x) => x.to === m.to && x.line === m.line) === k);
}

/**
 * Probe each rule. → Map(ruleId → { baseline: 'pass'|'fail'|'timeout', mutants: [{kind, line, from, to, killed}] })
 *   opts: { command, timeoutS = 120, maxMutantsPerRule = 5, maxTotal = 60 }
 */
function probeRules(rules, { root, testIndex, command, timeoutS = 120, maxMutantsPerRule = 5, maxTotal = 60, log = () => {} }) {
  const out = new Map();
  if (!command) return out;
  let total = 0;
  for (const r of rules) {
    if (!r.impl || total >= maxTotal) continue;
    const tests = r.links.map((l) => testIndex.tests.find((t) => t.path === l.path)).filter((t) => t && t.level !== 'e2e').map((t) => t.path);
    if (!tests.length) continue;
    const file = path.join(root, r.impl.path);
    const original = fs.readFileSync(file, 'utf8');
    const base = runTests(root, command, tests, timeoutS);
    if (!base.pass) { out.set(r.id, { baseline: base.timedOut ? 'timeout' : 'fail', tests, mutants: [] }); log(`${r.id}: baseline ${base.timedOut ? 'timed out' : 'failed'}, no verdict`); continue; }
    const muts = [];
    const ex = extremeMutant(original, r.impl);
    if (ex && ex !== original) muts.push({ kind: 'extreme', line: r.impl.line, from: `${r.impl.symbol} body`, to: 'return default', text: ex });
    muts.push(...limitMutants(original, r.impl, r.limits || []));
    const results = [];
    try {
      for (const m of muts.slice(0, maxMutantsPerRule)) {
        if (total >= maxTotal) break;
        total++;
        fs.writeFileSync(file, m.text);
        const res = runTests(root, command, tests, timeoutS);
        // a timeout under a mutant counts as killed (the mutant changed behaviour enough to hang)
        results.push({ kind: m.kind, line: m.line, from: m.from, to: m.to, killed: !res.pass });
      }
    } finally {
      fs.writeFileSync(file, original);
    }
    if (fs.readFileSync(file, 'utf8') !== original) throw new Error(`could not restore ${r.impl.path} after mutation`);
    out.set(r.id, { baseline: 'pass', tests, mutants: results });
    log(`${r.id}: ${results.filter((x) => x.killed).length}/${results.length} mutants killed`);
  }
  return out;
}

/**
 * What a probe proves. → { asserts: true|false|null, edges: [mutants that survived at a limit] }
 *   asserts false: the extreme mutant survived (the tests check nothing the function does)
 *   asserts true:  the extreme mutant or any limit mutant was killed
 */
function verdictOf(p) {
  if (!p || p.baseline !== 'pass' || !p.mutants.length) return { asserts: null, edges: [] };
  const ex = p.mutants.find((m) => m.kind === 'extreme');
  const anyKilled = p.mutants.some((m) => m.killed);
  return {
    asserts: ex && !ex.killed && !anyKilled ? false : anyKilled ? true : null,
    edges: p.mutants.filter((m) => m.kind !== 'extreme' && !m.killed),
  };
}

module.exports = { probeRules, verdictOf, extremeMutant, limitMutants, runTests, scrubbedEnv };
