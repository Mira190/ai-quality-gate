'use strict';
// Stage 6: read the CI configuration (GitHub Actions) and the test-runner configs it calls. No AI, nothing is run.
// Gives: the 7 CI checks (section 5) and, for every test file, whether a PR-triggered job runs it ("Runs on PR").
const { parseDocument, LineCounter } = require('yaml');
const { readText, linesOf, globMatch, base } = require('./util');

const WF = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const TOOLS = {
  secret: /\b(gitleaks|trufflehog|detect-secrets|ggshield|secretlint|git-secrets)\b/i,
  dependency: /\b(npm audit|yarn audit|pnpm audit|osv-scanner|snyk test|dependency-review-action|pip-audit|safety check|trivy|govulncheck|audit-ci|bundler-audit)\b/i,
  format: /\b(prettier\b[^&|;]*--(check|list-different)|black\b[^&|;]*--check|gofmt\b|ruff format\b[^&|;]*--check|dprint check|biome (format|ci)|rustfmt\b[^&|;]*--check|cargo fmt\b[^&|;]*--check)/i,
  lint: /\b(eslint|ruff check|ruff\s+\.|flake8|pylint|golangci-lint|biome (lint|ci)|clippy|rubocop|stylelint|oxlint)\b/i,
  typecheck: /\b(tsc\b[^&|;]*--noEmit|tsc -p|vue-tsc|mypy|pyright|tsc --build|flow check)\b/i,
};
const CHECKS = [
  { key: 'secret', label: 'Secret scan' },
  { key: 'coverage', label: 'Coverage' },
  { key: 'dependency', label: 'Dependency scan' },
  { key: 'format', label: 'Format' },
  { key: 'lint', label: 'Lint' },
  { key: 'typecheck', label: 'Type check' },
  { key: 'tests', label: 'Unit and component tests' },
];

function readJson(root, rel) { try { return JSON.parse(readText(root, rel)); } catch { return null; } }

// Expand npm/yarn/pnpm scripts (two levels) so "npm run lint" is judged by what it runs.
function expand(cmd, scripts, depth = 0) {
  if (depth > 2) return cmd;
  return cmd.replace(/\b(?:npm(?: run(?:-script)?)?|yarn(?: run)?|pnpm(?: run)?|bun run)\s+([\w:.-]+)((?:\s+--\s+[^&|;\n]*)?)/g, (all, name, extra) => {
    const s = scripts[name] ?? (name === 'test' ? scripts.test : undefined);
    if (s == null || ['install', 'ci', 'i', 'exec', 'npx'].includes(name)) return all;
    return `${expand(s, scripts, depth + 1)}${extra ? ' ' + extra.replace(/^\s*--\s*/, '') : ''}`;
  });
}

// Array of string literals for `key: [ ... ]` in a JS/TS config, with each entry's line.
function arrayEntries(text, key) {
  const lines = linesOf(text), out = [];
  const start = lines.findIndex((l) => new RegExp(`\\b${key}\\s*:\\s*\\[`).test(l));
  if (start < 0) return null;
  for (let i = start; i < lines.length; i++) {
    for (const m of lines[i].matchAll(/['"`]([^'"`]+)['"`]/g)) if (i > start || lines[i].indexOf(m[0]) > lines[i].indexOf('[')) out.push({ value: m[1], line: i + 1 });
    if (lines[i].includes(']')) break;
  }
  return out;
}

// The block of a `key: {` object in a JS/TS config (by brace depth), as [startLine, endLine].
function blockOf(text, key, from = 0) {
  const lines = linesOf(text);
  const s = lines.findIndex((l, i) => i >= from && new RegExp(`\\b${key}\\s*:\\s*\\{`).test(l));
  if (s < 0) return null;
  let depth = 0;
  for (let i = s; i < lines.length; i++) { depth += (lines[i].match(/\{/g) || []).length - (lines[i].match(/\}/g) || []).length; if (depth <= 0) return [s, i]; }
  return [s, lines.length - 1];
}

const DEFAULT_VITEST = ['**/*.{test,spec}.?(c|m)[jt]s?(x)'];
const DEFAULT_JEST = ['**/__tests__/**/*.[jt]s?(x)', '**/?(*.)+(spec|test).[jt]s?(x)'];

// Which test files a resolved command runs, and its coverage setup. Supports vitest, jest, playwright, pytest, go test.
function testSetOf(root, files, testFiles, cmd) {
  const runner = /\bvitest\b/.test(cmd) ? 'vitest' : /\bjest\b/.test(cmd) ? 'jest' : /\bplaywright test\b/.test(cmd) ? 'playwright' : /\bpytest\b/.test(cmd) ? 'pytest' : /\bgo test\b/.test(cmd) ? 'go' : null;
  if (!runner) return null;
  const cfgArg = (cmd.match(/(?:--config|-c)[ =](\S+)/) || [])[1];
  const pick = (names) => cfgArg ? cfgArg.replace(/^\.\//, '') : names.find((n) => files.includes(n));
  let include, exclude = [], cfgPath = null, coverage = null;
  if (runner === 'vitest' || runner === 'jest') {
    cfgPath = pick(runner === 'vitest' ? ['vitest.config.ts', 'vitest.config.mts', 'vitest.config.js', 'vite.config.ts', 'vite.config.js'] : ['jest.config.ts', 'jest.config.js', 'jest.config.cjs', 'jest.config.mjs']);
    const text = cfgPath ? readText(root, cfgPath) || '' : '';
    const inc = arrayEntries(text, runner === 'vitest' ? 'include' : 'testMatch');
    const exc = arrayEntries(text, runner === 'vitest' ? 'exclude' : 'testPathIgnorePatterns');
    const cov = blockOf(text, 'coverage');
    // include/exclude outside the coverage block belong to the test run
    const outside = (e) => !cov || e.line - 1 < cov[0] || e.line - 1 > cov[1];
    include = (inc || []).filter(outside).map((e) => e.value);
    exclude = (exc || []).filter(outside);
    if (!include.length) include = runner === 'vitest' ? DEFAULT_VITEST : DEFAULT_JEST;
    const covOn = /--coverage\b/.test(cmd) || /enabled\s*:\s*true/.test(cov ? linesOf(text).slice(cov[0], cov[1] + 1).join('\n') : '') || /collectCoverage\s*:\s*true/.test(text);
    if (covOn) coverage = coverageOf(text, cfgPath, cov);
  } else if (runner === 'playwright') {
    cfgPath = pick(['playwright.config.ts', 'playwright.config.js']);
    const dir = ((readText(root, cfgPath || '') || '').match(/testDir\s*:\s*['"]([^'"]+)['"]/) || [])[1] || 'tests';
    include = [`${dir.replace(/^\.\//, '')}/**/*.{spec,test}.?(c|m)[jt]s?(x)`];
  } else if (runner === 'pytest') {
    include = ['**/test_*.py', '**/*_test.py']; if (/--cov\b/.test(cmd)) coverage = { exclusions: [], globalOnly: null, cfgPath: null };
  } else { include = ['**/*_test.go']; if (/-cover/.test(cmd)) coverage = { exclusions: [], globalOnly: null, cfgPath: null }; }
  const excluded = (f) => exclude.some((e) => globMatch(e.value, f) || f === e.value.replace(/^\.\//, ''));
  const set = testFiles.filter((f) => include.some((g) => globMatch(g, f)) && !excluded(f));
  const excludedHits = testFiles.filter((f) => include.some((g) => globMatch(g, f)) && excluded(f)).map((f) => ({ file: f, line: exclude.find((e) => globMatch(e.value, f) || f === e.value).line, cfgPath }));
  return { runner, cfgPath, files: set, excludedHits, coverage };
}

function coverageOf(text, cfgPath, cov) {
  const lines = linesOf(text), out = { cfgPath, exclusions: [], globalOnly: null };
  if (!cov) return out;
  const inBlock = (e) => e.line - 1 >= cov[0] && e.line - 1 <= cov[1];
  const exc = (arrayEntries(lines.slice(cov[0]).join('\n'), 'exclude') || []).map((e) => ({ ...e, line: e.line + cov[0] })).filter(inBlock);
  // Logic folders only: test, type, mock and generated paths are fine to exclude.
  out.exclusions = exc.filter((e) => /^(\.\/)?(src|lib|app|packages\/[^/]+\/src)\//.test(e.value) && !/(test|spec|mock|fixture|\.d\.ts|types?|generated|stories)/i.test(e.value));
  const th = blockOf(text, 'thresholds', cov[0]) || blockOf(text, 'coverageThreshold');
  if (th) {
    const body = lines.slice(th[0] + 1, th[1]);
    const perPath = body.some((l) => /['"][^'"]*[/*][^'"]*['"]\s*:/.test(l)) || /perFile\s*:\s*true/.test(body.join('\n'));
    const g = body.map((l, i) => ({ l, line: th[0] + 2 + i })).find((x) => /\b(lines|statements|branches|functions)\s*:\s*\d+/.test(x.l));
    if (!perPath && g) out.globalOnly = { line: g.line, text: g.l.trim().replace(/,$/, '') };
  }
  return out;
}

function readWorkflows(root, files, testFiles) {
  const pkg = readJson(root, 'package.json') || {}, scripts = pkg.scripts || {};
  const workflows = [];
  // PR workflows first: they are the gate a reader cares about
  const wfFiles = files.filter((x) => WF.test(x)).sort((a, b) => Number(!/pull_request|merge_group/.test(readText(root, a) || '')) - Number(!/pull_request|merge_group/.test(readText(root, b) || '')) || a.localeCompare(b));
  for (const f of wfFiles) {
    const src = readText(root, f) || '', lc = new LineCounter();
    let doc;
    try { doc = parseDocument(src, { lineCounter: lc }); } catch { continue; }
    const js = doc.toJS() || {};
    const on = typeof js.on === 'string' ? { [js.on]: null } : Array.isArray(js.on) ? Object.fromEntries(js.on.map((k) => [k, null])) : js.on || {};
    const pr = 'pull_request' in on || 'pull_request_target' in on || 'merge_group' in on;
    const steps = [];
    for (const [jobName] of Object.entries(js.jobs || {})) {
      const seq = doc.getIn(['jobs', jobName, 'steps'], true);
      for (const s of seq?.items || []) {
        const runNode = s.get?.('run', true), usesNode = s.get?.('uses', true), node = runNode || usesNode;
        if (!node) continue;
        const raw = String(node.value ?? '');
        steps.push({ workflow: f, job: jobName, name: s.get('name') || null, raw, cmd: runNode ? expand(raw, scripts) : raw, uses: !!usesNode, line: lc.linePos(node.range[0]).line, continueOnError: s.get('continue-on-error') === true, pr });
      }
    }
    workflows.push({ path: f, pr, scheduled: 'schedule' in on, steps });
  }
  for (const s of workflows.flatMap((w) => w.steps)) if (!s.uses) s.tests = testSetOf(root, files, testFiles, s.cmd);
  return { workflows, scripts };
}

/** Section 5 and the per-test-file CI facts used by sections 3 and 4. */
function analyzeCI(root, files, testIndex) {
  const testFiles = testIndex.tests.map((t) => t.path);
  const { workflows } = readWorkflows(root, files, testFiles);
  const steps = workflows.flatMap((w) => w.steps);
  const prSteps = steps.filter((s) => s.pr);
  const names = workflows.map((w) => `\`${base(w.path)}\``);
  const wfList = names.length === 2 ? names.join(' or ') : names.length > 2 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names[0] || 'the CI configuration';
  // the fix goes where the PR tests already run; otherwise the first PR workflow
  const prWf = workflows.find((w) => w.pr && w.steps.some((s) => s.tests)) || workflows.find((w) => w.pr);
  const prName = prWf ? `\`${base(prWf.path)}\`` : 'a PR workflow';
  const cite = (s) => `\`${base(s.workflow)}:${s.line}\``;

  // Per test file: which PR / scheduled steps run it.
  const runs = new Map(testFiles.map((f) => [f, { pr: [], other: [], excluded: [] }]));
  for (const s of steps) {
    if (!s.tests) continue;
    for (const f of s.tests.files) runs.get(f)[s.pr ? 'pr' : 'other'].push({ workflow: base(s.workflow), line: s.line });
    for (const x of s.tests.excludedHits) if (s.pr) runs.get(x.file).excluded.push({ cfgPath: x.cfgPath, line: x.line });
  }

  const checks = [];
  const tool = (key) => prSteps.filter((s) => TOOLS[key].test(s.cmd));
  // Secret scan
  const sec = tool('secret').filter((s) => !s.continueOnError);
  checks.push(sec.length ? { key: 'secret', ok: true, cite: cite(sec[0]) } : { key: 'secret', ok: false, issues: [{ kind: 'secret-missing', priority: 'P0', text: `No secret-scan step in ${wfList}. Add one (for example gitleaks) to ${prName}` }] });
  // Coverage
  const covSteps = prSteps.filter((s) => s.tests?.coverage);
  if (!covSteps.length) checks.push({ key: 'coverage', ok: false, issues: [{ kind: 'coverage-missing', priority: 'P2', text: `No PR job measures coverage. Add coverage to the test step in ${prName}` }] });
  else {
    const c = covSteps[0].tests.coverage, issues = [];
    for (const e of c.exclusions) {
      const folder = e.value.replace(/\/\*\*.*$/, '').split('/').pop();
      issues.push({ kind: 'coverage-exclusion', priority: 'P2', text: `\`${c.cfgPath}:${e.line}\` excludes \`${e.value}\` from coverage, so the ${folder} logic is never measured. Remove the exclusion` });
    }
    if (c.globalOnly) issues.push({ kind: 'coverage-global', priority: 'P2', text: `\`${c.cfgPath}:${c.globalOnly.line}\` sets one global threshold (\`${c.globalOnly.text}\`). Add a threshold for changed files or per folder` });
    // most specific line first, as a reader fixes top-down: exclusions before thresholds, each by line
    issues.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'coverage-exclusion' ? -1 : 1) || lineOf(a) - lineOf(b));
    checks.push(issues.length ? { key: 'coverage', ok: false, issues } : { key: 'coverage', ok: true, cite: cite(covSteps[0]) });
  }
  // Dependency scan
  const dep = tool('dependency');
  if (!dep.length) checks.push({ key: 'dependency', ok: false, issues: [{ kind: 'dependency-missing', priority: 'P2', text: `No dependency scan in ${wfList}. Add one (for example \`npm audit --audit-level=high\` or osv-scanner) to ${prName}` }] });
  else if (dep.every((s) => s.continueOnError)) checks.push({ key: 'dependency', ok: false, issues: [{ kind: 'dependency-soft', priority: 'P2', text: `The step exists (${cite(dep[0])}) but has \`continue-on-error: true\`, so it cannot fail the PR. Remove that line` }] });
  else checks.push({ key: 'dependency', ok: true, cite: cite(dep.find((s) => !s.continueOnError)) });
  // Format, lint, type check
  for (const [key, what] of [['format', 'format check'], ['lint', 'lint step'], ['typecheck', 'type check']]) {
    const hit = tool(key).filter((s) => !s.continueOnError);
    checks.push(hit.length ? { key, ok: true, cite: cite(hit[0]) } : { key, ok: false, issues: [{ kind: `${key}-missing`, priority: 'P3', text: `No ${key === 'format' ? 'format' : key === 'lint' ? 'lint' : 'type-check'} step in ${wfList}. Add a ${what} to ${prName}` }] });
  }
  // Unit and component tests on PR
  const unitOnPr = prSteps.filter((s) => s.tests?.files.some((f) => ['unit', 'component'].includes(testIndex.tests.find((t) => t.path === f).level)) && !s.continueOnError);
  checks.push(unitOnPr.length ? { key: 'tests', ok: true, cite: cite(unitOnPr[0]) } : { key: 'tests', ok: false, issues: [{ kind: 'tests-missing', priority: testFiles.length ? 'P0' : 'P1', text: `No PR job runs the unit or component tests. Add a test step to ${prName}` }] });

  for (const c of checks) c.label = CHECKS.find((x) => x.key === c.key).label;
  return { workflows, checks, runs, workflowCount: workflows.length };
}
const lineOf = (i) => Number((i.text.match(/:(\d+)`/) || [0, 0])[1]);

module.exports = { analyzeCI, expand, testSetOf, arrayEntries, CHECKS, TOOLS };
