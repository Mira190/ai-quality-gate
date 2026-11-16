'use strict';
// Stage 6, ci: which quality checks does CI enforce on a pull request? Entirely deterministic.
// A check counts only when a step runs it, the step's workflow runs on pull requests, and the step can fail the run.
// "The tool is configured" and "the tool runs somewhere" are both reported, as the gaps they are.
const path = require('node:path');
const { parseCI, loadScripts, expandCommand } = require('./workflows');
const { readText } = require('../util');

const PM = '(?:npm|yarn|pnpm|bun)\\s+(?:run\\s+)?';
const CHECKS = [
  {
    id: 'tests', title: 'Tests',
    cmd: new RegExp(`\\b(jest|vitest|mocha|ava|node\\s+(?:--\\S+\\s+)*--test|pytest|py\\.test|python3?\\s+-m\\s+(?:pytest|unittest)|go\\s+test|cargo\\s+(?:test|nextest)|mvnw?\\s+[^\\n]*\\b(?:test|verify|install)|gradlew?\\s+[^\\n]*\\b(?:test|check|build)|dotnet\\s+test|rspec|rake\\s+(?:test|spec)|rails\\s+test|phpunit|pest|swift\\s+test|xcodebuild\\s+[^\\n]*test|flutter\\s+test|dart\\s+test|tox|nox|ctest|bazel\\s+test|karma\\s+start|playwright\\s+test|cypress\\s+run|deno\\s+test|bun\\s+test|${PM}test[\\w:.-]*|make\\s+(?:test|check))\\b`),
  },
  {
    id: 'lint', title: 'Lint',
    cmd: new RegExp(`\\b(eslint|biome\\s+(?:lint|check|ci)|oxlint|tslint|ruff\\s+check|ruff\\s+(?!format)\\S|flake8|pylint|golangci-lint|go\\s+vet|staticcheck|cargo\\s+clippy|rubocop|ktlint|detekt|checkstyle|spotbugs|pmd|stylelint|shellcheck|hadolint|phpcs|swiftlint|actionlint|markdownlint|pre-commit\\s+run|trunk\\s+check|dart\\s+analyze|flutter\\s+analyze|${PM}lint[\\w:.-]*|make\\s+lint)\\b`),
    uses: /super-linter|golangci-lint-action|reviewdog\/|pre-commit\/action|ruff-action|eslint-action|rubocop/i,
    config: /^(\.?eslint(rc|\.config).*|biome\.jsonc?|ruff\.toml|\.ruff\.toml|\.flake8|\.pylintrc|\.golangci\.ya?ml|\.rubocop\.yml|clippy\.toml|\.stylelintrc.*|\.swiftlint\.yml|detekt\.ya?ml|checkstyle\.xml)$/,
    script: /^lint/, pyproject: /\[tool\.(ruff|pylint|flake8)/,
  },
  {
    id: 'typecheck', title: 'Type check',
    cmd: new RegExp(`\\b(tsc(?![\\w-])|vue-tsc|tsgo|mypy|pyright|pyre\\s+check|pytype|flow\\s+check|srb\\s+tc|steep\\s+check|phpstan|psalm|${PM}(?:type-?check|typecheck|tsc|check-types|check:types|lint:types|types)[\\w:.-]*)\\b`),
    uses: /pyright-action|mypy-action/i,
    config: /^(tsconfig.*\.json|mypy\.ini|\.mypy\.ini|pyrightconfig\.json|phpstan\.neon.*)$/,
    script: /^(type-?check|tsc|check-types|types$)/, pyproject: /\[tool\.(mypy|pyright)/,
  },
  {
    id: 'format', title: 'Format',
    cmd: new RegExp(`\\b(prettier\\s+[^\\n]*(?:--check|-c\\b|-l\\b|--list-different)|biome\\s+(?:format|check|ci)|black\\s+[^\\n]*--check|ruff\\s+format\\s+[^\\n]*--check|gofmt\\s+-l|gofumpt|cargo\\s+fmt\\s+[^\\n]*--check|dotnet\\s+format\\s+[^\\n]*--verify-no-changes|rubocop|ktlint|spotless(?:Check|:check)|clang-format\\s+[^\\n]*--dry-run|terraform\\s+fmt\\s+-check|pre-commit\\s+run|dart\\s+format\\s+[^\\n]*--set-exit-if-changed|${PM}(?:format:check|fmt:check|prettier:check|check:format|format-check|check-format)[\\w:.-]*)\\b`),
    config: /^(\.prettierrc.*|prettier\.config\..*|biome\.jsonc?|rustfmt\.toml|\.rubocop\.yml|\.clang-format)$/,
    script: /^(format|fmt|prettier)/, pyproject: /\[tool\.(black|ruff\.format)/,
  },
  {
    id: 'coverage', title: 'Coverage',
    cmd: /(--coverage\b|--cov\b|--cov=|-coverprofile|\bc8\b|\bnyc\b|jacoco|coverlet|tarpaulin|llvm-cov|simplecov|\bcoverage\s+(?:run|report|xml)|--collect:"XPlat|--experimental-test-coverage|--test-coverage)/,
    uses: /codecov|coveralls|sonar|code-coverage/i,
    config: /^(codecov\.ya?ml|\.codecov\.ya?ml|\.nycrc.*|\.c8rc.*|sonar-project\.properties)$/,
  },
  {
    id: 'deps', title: 'Dependency scan',
    cmd: /\b(npm\s+audit|yarn\s+(?:npm\s+)?audit|pnpm\s+audit|pip-audit|safety\s+(?:check|scan)|osv-scanner|snyk\s+test|trivy\s+(?:fs|repo|image)|govulncheck|cargo\s+(?:audit|deny)|bundler?-audit|dotnet\s+list\s+package\s+--vulnerable|grype|dependency-check)\b/,
    uses: /dependency-review-action|snyk\/actions|trivy-action|osv-scanner|ossf\/scorecard/i,
    config: /^(dependabot\.ya?ml|renovate\.json5?|\.renovaterc.*)$/, configEnforces: true,
  },
  {
    id: 'secrets', title: 'Secret scan',
    cmd: /\b(gitleaks|trufflehog|detect-secrets|ggshield|git-secrets)\b/,
    uses: /gitleaks|trufflehog|ggshield|secret-scan/i,
    config: /^(\.gitleaks\.toml|\.secrets\.baseline)$/,
  },
  {
    id: 'sast', title: 'Static security analysis',
    cmd: /\b(semgrep|bandit|gosec|brakeman|codeql|sonar-scanner)\b/,
    uses: /codeql-action|semgrep|sonarsource|sonarqube|snyk\/actions\/.*code|bandit/i,
    config: /^(\.semgrep\.ya?ml|sonar-project\.properties)$/,
  },
];
const THRESHOLD = /--cov-fail-under|coverageThreshold|--check-coverage|--fail-under|--test-coverage-(lines|branches|functions)|thresholds?\s*[:=]|minimum_coverage|violationRules|fail_under|target:\s*\d/;
const SOFT = /\|\|\s*(true|:|exit\s+0|echo\b)|;\s*true\s*$|--exit-zero|--passWithNoTests\s*\|\||set \+e/;
const E2E_CMD = /playwright|cypress|\be2e\b|wdio|detox|maestro|cucumber|behave|selenium/i;

// States, best first. A check takes the best state any of its steps reaches.
const ORDER = ['enforced', 'unverified', 'path_filtered', 'non_blocking', 'not_on_pr', 'configured', 'missing', 'na'];

function applicability(check, inv, facts) {
  const L = inv.langs;
  const anyCode = Object.keys(L).length > 0;
  switch (check.id) {
    case 'tests': return anyCode ? 'required' : 'na';
    case 'lint': return anyCode ? 'required' : 'na';
    case 'typecheck':
      if (L.ts || facts.configured.typecheck) return 'required';
      if (L.python) return 'optional';
      return 'na'; // compiled languages are type-checked by their build; plain JavaScript has nothing to check
    case 'format': case 'coverage': case 'deps': case 'secrets': case 'sast': return anyCode ? 'optional' : 'na';
    default: return 'na';
  }
}

/**
 * Returns {checks, steps, workflows, systems, testSteps, errors, hasCI}.
 * checks: [{id, title, state, where: [{file, line, job}], detail}]
 */
function analyzeCI({ root, inventory, config }) {
  const { steps, workflows, systems, errors } = parseCI({ root, inventory });
  const scripts = loadScripts({ root, inventory });
  const hasCI = workflows.length > 0;
  const configs = inventory.byKind.config || [];
  const pyproject = (inventory.byKind.manifest || []).filter((m) => /^(pyproject\.toml|setup\.cfg|tox\.ini)$/.test(m.name)).slice(0, 20).map((m) => readText(path.join(root, m.path), 1 << 18) || '').join('\n');
  const facts = { configured: {} };
  for (const c of CHECKS) {
    const by = configs.find((f) => c.config?.test(f.tool));
    const script = c.script && [...scripts.npm.keys()].find((n) => c.script.test(n));
    const tool = c.pyproject?.exec(pyproject)?.[0];
    facts.configured[c.id] = by ? by.path : script ? `package.json script "${script}"` : tool ? `pyproject ${tool}]` : null;
  }
  if ((inventory.byKind.test || []).length) facts.configured.tests ||= `${inventory.byKind.test.length} test files`;

  for (const s of steps) s.full = expandCommand(s.run, scripts, s.cwd);
  const stateOf = (s, matchedLine) => {
    if (s.pr === null) return 'unverified';
    if (!s.pr || s.notPr) return 'not_on_pr';
    if (s.nonBlocking || (matchedLine && SOFT.test(matchedLine))) return 'non_blocking';
    return s.paths ? 'path_filtered' : 'enforced';
  };

  const checks = [], testSteps = [];
  for (const c of CHECKS) {
    if (config.ci.ignore.includes(c.id)) continue;
    const hits = [];
    for (const s of steps) {
      const line = s.full.split('\n').find((l) => !/^\s*#/.test(l) && c.cmd.test(l));
      const viaUses = c.uses && (c.uses.test(s.uses) || (s.system !== 'github' && c.uses.test(s.run)));
      if (!line && !viaUses) continue;
      if (c.id === 'lint' && line && /^\s*(?:npx\s+)?prettier\b/.test(line)) continue;
      const hit = { step: s, state: stateOf(s, line), line: (line || s.uses).trim().slice(0, 120) };
      hits.push(hit);
      if (c.id === 'tests') {
        const command = s.full.split('\n').filter((l) => !/^\s*#/.test(l) && c.cmd.test(l)).join('\n');
        testSteps.push({ ...hit, e2e: E2E_CMD.test(command) || E2E_CMD.test(s.name), command });
      }
    }
    const need = applicability(c, inventory, facts);
    let state, detail = '';
    if (need === 'na' && !hits.length) state = 'na';
    else if (hits.length) {
      hits.sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state));
      state = hits[0].state;
    } else if (c.configEnforces && facts.configured[c.id]) { state = 'enforced'; detail = `by ${facts.configured[c.id]}`; } else state = facts.configured[c.id] ? 'configured' : 'missing';
    const best = hits.filter((h) => h.state === state);
    if (c.id === 'coverage' && hits.length) {
      const thresholdIn = hits.some((h) => THRESHOLD.test(h.step.full) || THRESHOLD.test(h.step.with || '')) || configs.filter((f) => /^(jest|vitest)\.config|\.nycrc|\.c8rc|codecov/.test(f.tool)).some((f) => THRESHOLD.test(readText(path.join(root, f.path), 1 << 18) || '')) || THRESHOLD.test(pyproject) || [...scripts.npm.values()].flat().some((d) => THRESHOLD.test(d.body));
      if (!thresholdIn) detail = 'measured, no minimum enforced';
      checks.push({ id: c.id, title: c.title, state, need, noThreshold: !thresholdIn, detail, configured: facts.configured[c.id], where: best.slice(0, 3).map(whereOf), command: best[0]?.line });
      continue;
    }
    if (c.id === 'secrets' && state === 'missing') detail = 'GitHub secret scanning is a repository setting this run cannot see';
    if (c.id === 'typecheck' && state === 'na') detail = inventory.langs.js && !inventory.langs.ts ? 'plain JavaScript, no type checker configured' : 'checked by the compiler';
    checks.push({ id: c.id, title: c.title, state, need, detail, configured: facts.configured[c.id], where: best.slice(0, 3).map(whereOf), command: best[0]?.line });
  }
  return { checks, steps, workflows, systems, testSteps, errors, hasCI, deps: scripts.deps };
}
const whereOf = (h) => ({ file: h.step.definedIn || h.step.file, line: h.step.line, job: h.step.job });

/**
 * Is this test file run by a step that gates pull requests? Deterministic, from the commands:
 *   - a browser-driven file needs a step that runs the browser suite;
 *   - a step that names directories runs only the files under them;
 *   - any other test step runs every file its runner would find.
 * Returns 'pr'|'soft'|'not_pr'|'never'|'unknown'.
 */
function runsOnPR(tf, ci) /** @type {string} */ {
  if (!ci.testSteps.length) return 'never';
  const browser = tf.observed === 'e2e' && tf.why;
  let best = 'never';
  const better = (s) => { const o = ['pr', 'unknown', 'soft', 'not_pr', 'never']; if (o.indexOf(s) < o.indexOf(best)) best = s; };
  for (const t of ci.testSteps) {
    if (browser && !t.e2e) continue;
    if (!browser && t.e2e && !/\.feature$/.test(tf.path) && tf.level !== 'e2e') continue;
    const dirs = t.dirs || [];
    if (dirs.length && !dirs.some((d) => tf.path === d || tf.path.startsWith(d + '/'))) continue;
    better(t.state === 'enforced' || t.state === 'path_filtered' ? 'pr' : t.state === 'unverified' ? 'unknown' : t.state === 'non_blocking' ? 'soft' : 'not_pr');
  }
  return best;
}

/** The directories a test command names. Only paths that really hold test files count: "-c config/jest.json" does not. */
function bindTestDirs(ci, testFiles) {
  for (const t of ci.testSteps) {
    const named = [...t.command.matchAll(/(?:^|[\s"'])((?:\.\/)?[\w@.-]+(?:\/[\w@.*-]+)*\/?)(?=$|[\s"'])/gm)].map((m) => m[1].replace(/^\.\//, '').replace(/\/?\*.*$/, '').replace(/\/$/, '')).filter(Boolean);
    t.dirs = [...new Set(named)].filter((d) => testFiles.some((f) => f.path === d || f.path.startsWith(d + '/')));
  }
}

module.exports = { analyzeCI, runsOnPR, bindTestDirs, CHECKS, ORDER };
