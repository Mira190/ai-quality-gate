'use strict';
// Stage 6: read the CI configuration (GitHub Actions) and the test-runner configs it calls. No AI, nothing is run.
// Gives: the 7 CI checks (section 5) and, for every test file, whether a PR-triggered job runs it ("Runs on PR").
//
// A CI line is judged by what it really runs: package.json scripts, Makefile targets, repository shell scripts, tox
// and nox sessions and pre-commit hooks are followed a few levels; local reusable workflows and composite actions one
// level. A line that cannot fail the PR (continue-on-error, `|| true`, `if: false`) does not count as a gate.
const { parseDocument, LineCounter } = require('yaml');
const { readText, linesOf, globMatch, base } = require('./util');

const WF = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const TOOLS = {
  secret: /\b(gitleaks|trufflehog|detect-secrets|ggshield|secretlint|git-secrets|talisman)\b|\btrivy\b[^\n]*\bsecret\b/i,
  dependency: /\b(npm audit|yarn audit|yarn npm audit|pnpm audit|bun audit|osv-scanner|snyk test|dependency-review-action|pip-audit|safety check|safety scan|trivy|govulncheck|audit-ci|bundler-audit|cargo audit|cargo deny)\b/i,
  format: /\b(prettier\b[^&|;\n]*--(check|list-different|l\b)|black\b[^&|;\n]*--(check|diff)|ruff format\b[^&|;\n]*--(check|diff)|gofmt\b|gofumpt\b|goimports\b[^&|;\n]*-l\b|dprint check|biome (format|ci|check)\b(?![^&|;\n]*--(write|apply|fix))|rustfmt\b[^&|;\n]*--check|cargo fmt\b[^&|;\n]*--check|deno fmt\b[^&|;\n]*--check|(?<=^\s*|[;&|(]\s*|\b(?:npx|bunx|pnpm exec|yarn exec|exec)\s+)(standard|neostandard|ts-standard)(?=\s|$|[;&|)])(?![^&|;\n]*--fix)|isort\b[^&|;\n]*--(check|diff)|clang-format\b[^&|;\n]*--dry-run|oxfmt\b[^&|;\n]*--check)/im,
  lint: /\b(eslint|ruff check|ruff\s+\.|flake8|pylint|golangci-lint|biome (lint|ci|check)|clippy|rubocop|stylelint|oxlint|tslint|deno lint|staticcheck|go vet|revive)\b|(?<=^\s*|[;&|(]\s*|\b(?:npx|bunx|pnpm exec|yarn exec|exec)\s+)(xo|standard|neostandard|ts-standard)(?=\s|$|[;&|)])/im,
  typecheck: /\b(tsc\b(?![^&|;\n]*--(init|version|help|watch))|vue-tsc|mypy|pyright|basedpyright|flow check|tsd|tstyche|vitest\b[^&|;\n]*--typecheck)\b/i,
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

// ---- what a command runs ---------------------------------------------------------------------------------------
// Expand npm/yarn/pnpm scripts (two levels) so "npm run lint" is judged by what it runs.
function expand(cmd, scripts, depth = 0) {
  if (depth > 2) return cmd;
  return cmd.replace(/\b(?:npm(?: run(?:-script)?)?|yarn(?: run)?|pnpm(?: run)?|bun run|nub run)\s+([\w:.-]+)((?:\s+--\s+[^&|;\n]*)?)/g, (all, name, extra) => {
    const s = scripts[name] ?? (name === 'test' ? scripts.test : undefined);
    if (s == null || ['install', 'ci', 'i', 'exec', 'npx'].includes(name)) return all;
    return `${expand(s, scripts, depth + 1)}${extra ? ' ' + extra.replace(/^\s*--\s*/, '') : ''}`;
  });
}

// Makefile: target → its prerequisites' recipes, then its own recipe lines.
function parseMakefile(text) {
  const targets = new Map(); let cur = null, first = null;
  for (const l of linesOf(text || '')) {
    const m = /^([A-Za-z0-9_.\/%-][^:=#\s]*(?:\s+[^:=#\s]+)*)\s*::?(?!=)\s*([^#;]*)/.exec(l);
    if (m && !l.startsWith('\t')) {
      cur = { deps: m[2].trim().split(/\s+/).filter(Boolean), recipe: [] };
      for (const t of m[1].split(/\s+/)) { if (t === '.PHONY' || t.startsWith('.')) continue; targets.set(t, cur); first ||= t; }
      if (m[1].startsWith('.')) cur = null;
      continue;
    }
    if (cur && l.startsWith('\t')) cur.recipe.push(l.trim().replace(/^[@+-]+/, ''));
    else if (l.trim() && !l.startsWith('#')) cur = null;
  }
  return { targets, first };
}

// tox: commands of the named environments (all when none is named); nox: the session.run(...) calls.
function toxCommands(text, envs) {
  const out = []; let section = null, inCmd = false;
  const src = String(text || '').replace(/\\\r?\n\s*/g, ' ');
  // no -e: tox runs its envlist (names with {a,b} factors expanded); with no envlist, only [testenv]
  if (!envs) {
    const m = /^\s*env_?list\s*=\s*((?:.*)(?:\n[ \t]+.*)*)/m.exec(src);
    envs = m ? m[1].split(/[\n,](?![^{]*\})/).map((x) => x.trim()).filter(Boolean).flatMap(braceExpand) : [];
  }
  for (const l of linesOf(src)) {
    const s = /^\s*\[([^\]]+)\]/.exec(l);
    if (s) { section = s[1].trim(); inCmd = false; continue; }
    const names = section?.startsWith('testenv:') ? braceExpand(section.slice(8)) : [];
    const want = section === 'testenv' || names.some((n) => envs.includes(n));
    const c = /^\s*commands\s*=\s*(.*)$/.exec(l);
    if (c) { inCmd = want; if (want && c[1].trim()) out.push(c[1].trim()); continue; }
    if (inCmd && /^\s+#/.test(l)) continue;
    if (inCmd && /^\s+\S/.test(l)) out.push(l.trim()); else if (!/^\s*$/.test(l)) inCmd = false;
  }
  return out;
}
// "{,ci-}py{311,312}" → ["py311", "py312", "ci-py311", "ci-py312"]
function braceExpand(s) {
  const m = /\{([^{}]*)\}/.exec(s);
  if (!m) return [s.trim()];
  return m[1].split(',').flatMap((alt) => braceExpand(s.slice(0, m.index) + alt + s.slice(m.index + m[0].length)));
}

// tox in pyproject.toml ([tool.tox.env_run_base], [tool.tox.env.<name>]): commands are lists of string lists
function toxTomlCommands(text, envs) {
  const out = []; let section = null;
  const lines = linesOf(text);
  for (let i = 0; i < lines.length; i++) {
    const s = /^\s*\[([^\]]+)\]\s*$/.exec(lines[i]);
    if (s) { section = s[1]; continue; }
    if (!section?.startsWith('tool.tox')) continue;
    const env = /^tool\.tox\.env\.(.+)$/.exec(section)?.[1]?.replace(/^"|"$/g, '');
    const want = section === 'tool.tox.env_run_base' ? !envs || envs.some((e) => !lines.join('\n').includes(`[tool.tox.env.${e}]`)) : env ? !envs || envs.includes(env) : false;
    if (!want || !/^\s*commands\s*=/.test(lines[i])) continue;
    let block = lines[i], depth = (block.match(/\[/g) || []).length - (block.match(/\]/g) || []).length;
    while (depth > 0 && i + 1 < lines.length) { block += '\n' + lines[++i]; depth += (lines[i].match(/\[/g) || []).length - (lines[i].match(/\]/g) || []).length; }
    for (const inner of block.replace(/\{[^{}]*\}/g, '').replace(/^\s*commands\s*=\s*\[/, '').matchAll(/\[([^\[\]]*)\]/g)) out.push([...inner[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]).join(' '));
  }
  return out;
}
const noxCommands = (text) => [...String(text || '').matchAll(/session\.run\(([^)]*)\)/g)].map((m) => [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]).join(' '));

// pre-commit hooks run in check mode (a hook that changes a file fails the run), so each id maps to its check form.
const HOOK = { prettier: 'prettier --check', black: 'black --check', 'ruff-format': 'ruff format --check', ruff: 'ruff check', 'ruff-check': 'ruff check', isort: 'isort --check', gofmt: 'gofmt', 'go-fmt': 'gofmt', 'go-vet': 'go vet', 'golangci-lint': 'golangci-lint', biome: 'biome check', 'biome-check': 'biome check', 'biome-format': 'biome format', 'biome-lint': 'biome lint', 'detect-secrets': 'detect-secrets', gitleaks: 'gitleaks', trufflehog: 'trufflehog', eslint: 'eslint', flake8: 'flake8', pylint: 'pylint', mypy: 'mypy', pyright: 'pyright', 'rustfmt': 'rustfmt --check', clippy: 'clippy', 'cargo-check': 'cargo check' };
function preCommitHooks(root) {
  const text = readText(root, '.pre-commit-config.yaml') || readText(root, '.pre-commit-config.yml') || '';
  const ids = [...text.matchAll(/^\s*-\s*id:\s*['"]?([\w.-]+)/gm)].map((m) => HOOK[m[1]] || m[1]);
  // local hooks give their command as `entry:`; a formatter there fails the run when it changes a file, like --check
  const entries = [...text.matchAll(/^\s*entry:\s*['"]?(.+?)['"]?\s*$/gm)].map((m) => m[1]);
  const asCheck = entries.flatMap((e) => [[/\bruff format\b/, 'ruff format --check'], [/\bblack\b/, 'black --check'], [/\bprettier\b/, 'prettier --check'], [/\bbiome\b/, 'biome check'], [/\bisort\b/, 'isort --check']].filter(([re]) => re.test(e)).map(([, c]) => c));
  return [...ids, ...entries, ...asCheck];
}
const PRE_COMMIT = /\bpre-commit(?:\/action|\s+run)|\bprek\b|pre-commit-ci\/lite-action|\bpre-commit\b[^\n]*--all-files/;

// a tool name in command position: at the start of a command, or after a runner prefix (uv run, python -m, npx …)
// whose flags may take values; not as an argument (`pip install tox`, `--group tox`)
const AT_CMD = String.raw`(?<=(?:^|[;&|(]|\b(?:uv run|uvx|pipx run|poetry run|pdm run|hatch run|rye run|python[\d.]* -m|npx|bunx|pnpm exec|yarn exec|exec|time|env(?:\s+\w+=\S+)*))\s*(?:--?[\w-]+(?:[= ](?!-)[^\s;&|]+)?\s+)*)`;
// workspace fan-out: the named script in every package of the repository
const FAN_OUT = /\b(?:pnpm(?:\s+(?:-r|--recursive|--filter[\s=]\S+|-F\s+\S+|--parallel|--stream|--workspace-concurrency[\s=]\S+))+\s+(?:run\s+)?|yarn workspaces (?:foreach\s+(?:-\S+\s+)*)?run\s+|lerna run\s+|turbo(?:\s+run)?\s+|nx run-many\s+(?:-t|--target)[\s=]|npm run\s+(?=[\w:.-]+\s+(?:--workspaces|-ws)\b))([\w:.-]+)/g;
const SCRIPT_DIR = /^(scripts?|bin|ci|tools|hack|\.github|\.ci)\//;
/** Resolves a CI command into the text of everything it runs, so tool and runner patterns see through wrappers. */
function resolver(root, files, dir = '') {
  const fileSet = new Set(files), at = (p) => (dir ? `${dir.replace(/^\.\/|\/$/g, '')}/${p}` : p);
  const scripts = (readJson(root, at('package.json')) || {}).scripts || {};
  const mk = ['Makefile', 'makefile', 'GNUmakefile'].map(at).find((f) => fileSet.has(f));
  const make = mk ? parseMakefile(readText(root, mk)) : null;
  const toxIni = fileSet.has(at('tox.ini')) ? readText(root, at('tox.ini')) : null, pyproject = fileSet.has(at('pyproject.toml')) ? readText(root, at('pyproject.toml')) : '';
  const tox = toxIni ? (envs) => toxCommands(toxIni, envs) : /^\[tool\.tox/m.test(pyproject) ? (envs) => toxTomlCommands(pyproject, envs) : null;
  const nox = fileSet.has(at('noxfile.py')) ? readText(root, at('noxfile.py')) : null;
  const makeTarget = (t, seen, d) => {
    const x = make?.targets.get(t);
    if (!x || seen.has(t)) return '';
    seen.add(t);
    return [...x.deps.map((p) => makeTarget(p, seen, d)), ...x.recipe.map((r) => resolve(r, d + 1))].filter(Boolean).join('\n');
  };
  function resolve(cmd, d = 0) {
    if (d > 4 || cmd.length > 20000) return cmd;
    let out = expand(cmd, scripts).replace(FAN_OUT, (all, name) => {
      const bodies = files.filter((f) => /(^|\/)package\.json$/.test(f) && f !== 'package.json' && !/node_modules\//.test(f)).slice(0, 200)
        .map((f) => ({ dir: f.replace(/\/?package\.json$/, ''), s: ((readJson(root, f) || {}).scripts || {})[name] })).filter((x) => x.s).slice(0, 12);
      return bodies.length && d < 3 ? `${all}\n${bodies.map((b) => resolver(root, files, b.dir)(b.s, d + 1)).join('\n')}\n` : all;
    });
    if (make) out = out.replace(/(?:^|(?<=[\s;&|(]))(?:make|\$\(MAKE\)|\$\{MAKE\}|gmake)((?:[ \t]+(?:-[\w-]+(?:=\S+)?|[\w.\/-]+))*)/g, (all, args) => {
      const ts = args.trim().split(/\s+/).filter((a) => a && !a.startsWith('-') && !a.includes('='));
      if (args.includes('-C ') || args.includes('-f ')) return all;
      const body = (ts.length ? ts : [make.first]).map((t) => makeTarget(t, new Set(), d)).join('\n');
      return body ? `${all}\n${body}\n` : all;
    });
    if (tox) out = out.replace(new RegExp(`${AT_CMD}tox\\b(?:\\s+(?:run|r|run-parallel|p))?((?:\\s+(?:-e|--env)[\\s=]*[\\w,.\${}-]+)?)`, 'gm'), (all, e) => `${all}\n${tox(e ? e.replace(/^\s*(-e|--env)[\s=]*/, '').trim().split(',') : null).map((c) => resolve(c, d + 1)).join('\n')}\n`);
    if (nox) out = out.replace(new RegExp(`${AT_CMD}nox\\b`, 'gm'), (all) => `${all}\n${noxCommands(nox).join('\n')}\n`);
    if (PRE_COMMIT.test(out) && d < 3) out += `\n${resolve(preCommitHooks(root).join('\n'), d + 1)}`;
    // a repository script (scripts/test, ./ci/check.sh, bash hack/lint.sh): its lines are what runs
    out = out.replace(/(?:^|(?<=[\s;&|(]))(?:(?:bash|sh|zsh)\s+)?(\.\/)?([\w.\/-]+)/g, (all, dot, p) => {
      const rel = at(p.replace(/^\.\//, ''));
      if (!fileSet.has(rel) || /\.(js|cjs|mjs|ts|py|rb|go|json|ya?ml|toml|md|txt|lock)$/.test(rel) || !(dot || /\.(sh|bash)$/.test(rel) || SCRIPT_DIR.test(rel))) return all;
      const body = (readText(root, rel) || '').split('\n').filter((l) => !/^\s*(#|$)/.test(l)).join('\n');
      return `${all}\n${resolve(body, d + 1)}\n`;
    });
    return out;
  }
  return resolve;
}

// ---- which tests a command runs --------------------------------------------------------------------------------
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
const JS_TEST = /\.(c|m)?[jt]sx?$/;

// Runners whose test set is read from their config, and runners whose test set is the paths they are given (or every
// test file of their language when given none).
const RUNNERS = [
  ['vitest', /\bvitest\b|\bvp test\b/],
  ['jest', /\bjest\b/],
  ['playwright', /\bplaywright test\b/],
  ['pytest', /\b(py\.?test|pytest)\b/],
  ['unittest', /\bpython[\d.]*\s+-m\s+unittest\b/],
  ['go', /(?:\bgo|\brichgo|\$\(?GO\)?|\$\{GO\})\s+test\b|\bgotestsum\b/],
  ['mocha', /\bmocha\b/],
  ['node', /\bnode\b[^&|;\n]*\s--test\b|\btsx\s+--test\b/],
  ['js-paths', /\b(ava|borp|jasmine|uvu|tape|lab)\b(?!\.)|(?:^|\s)tap\s/],
];
const COVERAGE = /--coverage\b|--cov\b|--cov=|\bcoverage run\b|-coverprofile|\s-cover\b|-covermode|--experimental-test-coverage|\bc8\s|\bnyc\s|--check-coverage/;
const VALUE_FLAGS = /^(-r|--require|-R|--reporter|--reporter-options|-c|--config|-t|--timeout|-g|--grep|--ignore|--exclude|-o|--import|--loader|--test-reporter|--test-reporter-destination|--test-timeout|--project|-p|-m|-k|--tags|-run|-covermode|-coverprofile|--numprocesses|-n|--cov|--cov-report|--max-workers|-j|--parallel)$/;

// The paths a command names after its runner: files, directories or globs, not flag values.
function pathArgs(seg, runnerRe) {
  const m = runnerRe.exec(seg);
  // arguments start after the whole word that names the runner (`./node_modules/jest/bin/jest.js` is the runner)
  const end = seg.slice(m.index).search(/\s|$/) + m.index;
  const toks = seg.slice(Math.max(end, m.index + m[0].length)).trim().split(/\s+/).map((t) => t.replace(/^['"]|['"]$/g, ''));
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!t) continue;
    if (t.startsWith('-')) { if (VALUE_FLAGS.test(t)) i++; continue; }
    if (/node_modules\//.test(t)) continue;
    if (/[/*]|\.(c|m)?[jt]sx?$|\.py$/.test(t) || /^(tests?|spec|__tests__)$/.test(t)) out.push(t.replace(/^\.\//, ''));
  }
  return out;
}
const under = (p, f) => f === p || f.startsWith(p.replace(/\/$/, '') + '/') || (/[*?{]/.test(p) && globMatch(p, f));

// Which test files one runner invocation runs, and its coverage setup.
const INSTALL = /\b(pip3?|uv pip|pipx|poetry|pdm|npm|pnpm|yarn|bun|brew|apt(-get)?|go)\s+(install|add|i|get)\b|\buv (sync|add|tool install)\b/;
function runOf(root, files, testFiles, seg) {
  if (INSTALL.test(seg)) return null;
  const hit = RUNNERS.find(([, re]) => re.test(seg));
  if (!hit) return null;
  const [runner, re] = hit;
  const cfgArg = (seg.match(/(?:--config|-c)[ =](\S+)/) || [])[1];
  const pick = (names) => cfgArg ? cfgArg.replace(/^\.\//, '') : names.find((n) => files.includes(n));
  let include, exclude = [], cfgPath = null, coverage = null, filters = [];
  if (runner === 'vitest' || runner === 'jest') {
    cfgPath = pick(runner === 'vitest' ? ['vitest.config.ts', 'vitest.config.mts', 'vitest.config.js', 'vitest.config.mjs', 'vite.config.ts', 'vite.config.js', 'vite.config.mts'] : ['jest.config.ts', 'jest.config.js', 'jest.config.cjs', 'jest.config.mjs']);
    const text = cfgPath ? readText(root, cfgPath) || '' : '';
    const inc = arrayEntries(text, runner === 'vitest' ? 'include' : 'testMatch');
    const exc = arrayEntries(text, runner === 'vitest' ? 'exclude' : 'testPathIgnorePatterns');
    const cov = blockOf(text, 'coverage');
    const outside = (e) => !cov || e.line - 1 < cov[0] || e.line - 1 > cov[1];
    include = (inc || []).filter(outside).map((e) => e.value);
    exclude = (exc || []).filter(outside);
    if (!include.length) include = runner === 'vitest' ? DEFAULT_VITEST : DEFAULT_JEST;
    // positional arguments filter the configured set by path (vitest and jest match them as substrings)
    filters = pathArgs(seg, re);
    const covOn = COVERAGE.test(seg) || /enabled\s*:\s*true/.test(cov ? linesOf(text).slice(cov[0], cov[1] + 1).join('\n') : '') || /collectCoverage\s*:\s*true/.test(text);
    if (covOn) coverage = coverageOf(text, cfgPath, cov);
  } else if (runner === 'playwright') {
    cfgPath = pick(['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs']);
    const dir = ((readText(root, cfgPath || '') || '').match(/testDir\s*:\s*['"]([^'"]+)['"]/) || [])[1] || 'tests';
    include = [`${dir.replace(/^\.\//, '')}/**/*.{spec,test}.?(c|m)[jt]s?(x)`];
  } else {
    const lang = runner === 'pytest' || runner === 'unittest' ? (f) => f.endsWith('.py') : runner === 'go' ? (f) => f.endsWith('_test.go') : (f) => JS_TEST.test(f);
    const paths = runner === 'go' ? [] : pathArgs(seg, re);
    const set = testFiles.filter((f) => lang(f) && (!paths.length || paths.some((p) => under(p, f))));
    if (COVERAGE.test(seg)) coverage = { exclusions: [], globalOnly: null, cfgPath: null };
    return { runner, cfgPath: null, files: set, excludedHits: [], coverage };
  }
  const excluded = (f) => exclude.some((e) => globMatch(e.value, f) || f === e.value.replace(/^\.\//, ''));
  const set = testFiles.filter((f) => include.some((g) => globMatch(g, f)) && !excluded(f) && (!filters.length || filters.some((p) => f.includes(p.replace(/\*.*$/, '')))));
  const excludedHits = testFiles.filter((f) => include.some((g) => globMatch(g, f)) && excluded(f)).map((f) => ({ file: f, line: exclude.find((e) => globMatch(e.value, f) || f === e.value).line, cfgPath }));
  return { runner, cfgPath, files: set, excludedHits, coverage };
}

/** The test files a resolved command runs (every runner it calls), and the coverage setup of the first that measures it. */
function testSetOf(root, files, testFiles, cmd) {
  const runs = String(cmd).split(/\n|&&|\|\||;/).map((seg) => runOf(root, files, testFiles, seg)).filter(Boolean);
  if (!runs.length) return null;
  const fileSet = new Set(runs.flatMap((r) => r.files));
  return { runner: runs[0].runner, cfgPath: runs[0].cfgPath, files: testFiles.filter((f) => fileSet.has(f)), excludedHits: runs.flatMap((r) => r.excludedHits), coverage: runs.find((r) => r.coverage)?.coverage || null };
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

// ---- workflows -------------------------------------------------------------------------------------------------
const OFF = (v) => v === false || /^\s*(\$\{\{\s*)?false(\s*\}\})?\s*$/.test(String(v ?? 'x'));
// a line that cannot fail its step: `cmd || true`, `cmd || echo ...`, `cmd || :`, `cmd || exit 0`
const SOFT_LINE = /\|\|\s*(true|:|echo\b|exit\s+0\b|\/bin\/true)|\|\|\s*$/;
const DEFAULT_BRANCH = /^(main|master|develop|trunk|dev)$/;

// Does this `on:` run for pull requests into the default branch?
function prTrigger(on) {
  for (const k of ['pull_request', 'pull_request_target', 'merge_group']) {
    if (!(k in on)) continue;
    const f = on[k] || {};
    const br = f.branches, ignore = f['branches-ignore'];
    if (Array.isArray(br) && !br.some((b) => DEFAULT_BRANCH.test(b) || /[*]/.test(b))) continue;
    if (Array.isArray(ignore) && ignore.some((b) => DEFAULT_BRANCH.test(b))) continue;
    return true;
  }
  return false;
}

// Logical lines of a run block: `\` continuations joined, blanks and comments dropped.
const runLines = (raw) => String(raw).replace(/\\\r?\n\s*/g, ' ').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

function readWorkflows(root, files, testFiles) {
  const fileSet = new Set(files), resolvers = new Map();
  // `working-directory` (on the step, or the job's defaults): scripts and Makefiles are read from that folder
  const resolverIn = (dir) => resolvers.get(dir) || resolvers.set(dir, resolver(root, files, dir)).get(dir);
  const parsed = [];
  for (const f of files.filter((x) => WF.test(x))) {
    const src = readText(root, f) || '', lc = new LineCounter();
    let doc;
    try { doc = parseDocument(src, { lineCounter: lc }); } catch { continue; }
    const js = doc.toJS() || {};
    const on = typeof js.on === 'string' ? { [js.on]: null } : Array.isArray(js.on) ? Object.fromEntries(js.on.map((k) => [k, null])) : js.on || {};
    parsed.push({ path: f, doc, lc, js, on, pr: prTrigger(on), calls: [] });
  }
  // a local reusable workflow runs on PRs when a PR workflow calls it
  const byPath = new Map(parsed.map((w) => [w.path, w]));
  for (const w of parsed) for (const [, job] of Object.entries(w.js.jobs || {})) {
    const u = typeof job?.uses === 'string' && /^\.\/(\.github\/workflows\/[^@]+\.ya?ml)/.exec(job.uses);
    if (u && byPath.has(u[1]) && !OFF(job.if)) w.calls.push(u[1]);
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const w of parsed) if (w.pr) for (const c of w.calls) if (!byPath.get(c).pr) { byPath.get(c).pr = true; changed = true; }
  }

  const workflows = [];
  for (const w of parsed) {
    const { doc, lc, path: f, pr } = w;
    const steps = [];
    for (const [jobName, job] of Object.entries(w.js.jobs || {})) {
      if (OFF(job?.if)) continue;
      const jobSoft = job?.['continue-on-error'] === true, jobDir = job?.defaults?.run?.['working-directory'] || w.js.defaults?.run?.['working-directory'] || '';
      const items = doc.getIn(['jobs', jobName, 'steps'], true)?.items || [];
      const raw = items.map((s) => ({ node: s, js: s.toJSON?.() || {} }));
      raw.forEach(({ node: s, js: sj }, k) => {
        if (OFF(sj.if)) return;
        const runNode = s.get?.('run', true), usesNode = s.get?.('uses', true), node = runNode || usesNode;
        if (!node) return;
        const line = lc.linePos(node.range[0]).line;
        const wd = String(sj['working-directory'] || jobDir || '');
        const resolve = resolverIn(/\$\{\{/.test(wd) ? '' : wd);
        // continue-on-error, unless a later step fails the job on this step's outcome
        const rescued = sj.id && raw.slice(k + 1).some((x) => new RegExp(`steps\\.${sj.id}\\.(outcome|conclusion)`).test(String(x.js.if || '')) && /\bexit\s+[1-9]/.test(String(x.js.run || '')));
        const soft = jobSoft || (sj['continue-on-error'] === true && !rescued);
        const base = { workflow: f, job: jobName, name: sj.name || null, line, pr };
        if (usesNode) {
          const uses = String(usesNode.value ?? '');
          const withText = sj.with ? Object.entries(sj.with).map(([a, b]) => `${a}=${b}`).join(' ') : '';
          steps.push({ ...base, raw: uses, cmd: `${uses} ${withText}${PRE_COMMIT.test(uses) ? `\n${resolve(preCommitHooks(root).join('\n'))}` : ''}`.trim(), uses: true, continueOnError: soft });
          // a local composite action: its run steps, one level
          const local = /^\.\/(.+?)\/?$/.exec(uses);
          const action = local && ['action.yml', 'action.yaml'].map((n) => `${local[1]}/${n}`).find((p) => fileSet.has(p));
          if (action) {
            let a; try { a = parseDocument(readText(root, action) || '').toJS() || {}; } catch { a = {}; }
            for (const st of a.runs?.steps || []) if (st.run && !OFF(st.if)) for (const l of runLines(st.run)) steps.push({ ...base, raw: l, cmd: resolverIn(st['working-directory'] || '')(l), uses: false, continueOnError: soft || st['continue-on-error'] === true || SOFT_LINE.test(l), via: action });
          }
          return;
        }
        // one entry per logical line, so `npm audit || true` does not soften the `npm test` under it
        // NODE_V8_COVERAGE on the step or its job makes every node process write coverage
        const v8cov = /NODE_V8_COVERAGE/.test(Object.keys({ ...(job?.env || {}), ...(sj.env || {}) }).join(' '));
        for (const l of runLines(runNode.value ?? '')) steps.push({ ...base, raw: l, cmd: resolve(l), uses: false, continueOnError: soft || SOFT_LINE.test(l), v8cov });
      });
    }
    workflows.push({ path: f, pr, scheduled: 'schedule' in w.on, steps });
  }
  // PR workflows first: they are the gate a reader cares about
  workflows.sort((a, b) => Number(!a.pr) - Number(!b.pr) || a.path.localeCompare(b.path));
  for (const s of workflows.flatMap((x) => x.steps)) if (!s.uses) s.tests = testSetOf(root, files, testFiles, s.cmd);
  return { workflows };
}

// golangci-lint runs formatters when its config enables them (v2 `formatters:`, or gofmt/gofumpt/goimports as linters)
function golangciFormats(root, files) {
  const cfg = files.find((f) => /^\.golangci\.(ya?ml|toml|json)$/.test(f));
  const text = cfg ? readText(root, cfg) || '' : '';
  return /^formatters\s*:/m.test(text) || /\b(gofmt|gofumpt|goimports|gci)\b/.test(text);
}
// xo formats when its config turns on prettier
function xoFormats(root) {
  const pkg = readJson(root, 'package.json') || {};
  return pkg.xo?.prettier === true || /prettier\s*:\s*true/.test(readText(root, 'xo.config.js') || readText(root, 'xo.config.mjs') || '');
}
// eslint enforces formatting when its config pulls in a formatting preset (neostandard/standard, prettier, @stylistic)
function eslintFormats(root, files) {
  const cfg = files.filter((f) => /^(eslint\.config\.[mc]?[jt]s|\.eslintrc(\.(json|js|cjs|ya?ml))?)$/.test(f)).map((f) => readText(root, f) || '').join('\n');
  const pkg = readJson(root, 'package.json') || {};
  return /\b(neostandard|eslint-config-standard|eslint-plugin-prettier|plugin:prettier|@stylistic)\b|['"]standard['"]/.test(cfg + JSON.stringify(pkg.eslintConfig || {}));
}
// a compiled, statically typed language checks types when it builds: Go, Rust, Java, Kotlin, C# (mostly no TS or Python)
function compiledOnly(files) {
  const typedBuild = files.some((f) => /(^|\/)(go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|[^/]+\.csproj)$/.test(f));
  const src = files.filter((f) => !/(^|\/)(node_modules|vendor|testdata|examples?|docs?)\//.test(f));
  const typed = src.filter((f) => /\.(go|rs|java|kt|cs)$/.test(f)).length, dynamic = src.filter((f) => /\.(ts|tsx|mts|cts|py)$/.test(f)).length;
  // a helper script or two in another language does not change what the code base is
  return typedBuild && typed >= 10 * dynamic && typed > 0;
}
// vitest type-checks when its config enables typecheck
const vitestTypecheck = (root, files) => files.filter((f) => /^vite(st)?\.config\.[mc]?[jt]s$/.test(f)).some((f) => /typecheck\s*:\s*\{[^}]*enabled\s*:\s*true|typecheck\s*:\s*true/s.test(readText(root, f) || ''));

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
  const golangciFmt = golangciFormats(root, files), xoFmt = xoFormats(root), vitestTc = vitestTypecheck(root, files), eslintFmt = eslintFormats(root, files);
  const EXTRA = {
    format: (s) => (golangciFmt && /golangci-lint/.test(s.cmd)) || (xoFmt && /(?<=^\s*|[;&|(]\s*|\bnpx\s+)xo(?=\s|$|[;&|)])/m.test(s.cmd)) || (eslintFmt && /\beslint\b(?![^&|;\n]*--fix)/.test(s.cmd)),
    typecheck: (s) => vitestTc && s.tests?.runner === 'vitest',
  };
  const tool = (key) => prSteps.filter((s) => TOOLS[key].test(s.cmd) || EXTRA[key]?.(s));
  // Secret scan
  const sec = tool('secret').filter((s) => !s.continueOnError);
  checks.push(sec.length ? { key: 'secret', ok: true, cite: cite(sec[0]) } : { key: 'secret', ok: false, issues: [{ kind: 'secret-missing', priority: 'P0', text: `No secret-scan step in ${wfList}. Add one (for example gitleaks) to ${prName}` }] });
  // Coverage
  const covSteps = prSteps.filter((s) => s.tests?.coverage);
  // coverage collected outside the runner flags: NODE_V8_COVERAGE, or a report step over coverage data (c8/nyc report,
  // coverage report/xml/combine); the configuration is not known, so only "measured" is credited
  const covReport = prSteps.find((s) => !s.continueOnError && (s.v8cov && s.tests || /\b(c8|nyc) report\b|\bcoverage (report|xml|combine|json|lcov)\b|\bgo tool cover\b/.test(s.cmd)));
  if (!covSteps.length && covReport) checks.push({ key: 'coverage', ok: true, cite: cite(covReport) });
  else if (!covSteps.length) checks.push({ key: 'coverage', ok: false, issues: [{ kind: 'coverage-missing', priority: 'P2', text: `No PR job measures coverage. Add coverage to the test step in ${prName}` }] });
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
  const compiled = compiledOnly(files) && files.find((f) => /(^|\/)(go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|[^/]+\.csproj)$/.test(f));
  for (const [key, what] of [['format', 'format check'], ['lint', 'lint step'], ['typecheck', 'type check']]) {
    if (key === 'typecheck' && compiled) { checks.push({ key, ok: true, cite: `compiled language (\`${base(compiled)}\`): the build checks types` }); continue; }
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

module.exports = { analyzeCI, expand, resolver, testSetOf, arrayEntries, parseMakefile, CHECKS, TOOLS };
