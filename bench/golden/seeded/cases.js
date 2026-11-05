'use strict';
// The seeded golden set: the clean base (base.js) plus one case per seeded defect. Each case changes the base in one
// place and lists the issues that change must produce:
//   expect  issue keys a correct reviewer reports (missing one = a miss)
//   allow   issue keys that are also defensible for this change (reported or not, they do not count either way)
// Any other issue key the run reports is a false alarm. Keys are the ones scripts/eval-fixture.js uses:
//   sections 1-4: "S<n> <rule> <measure or check>", e.g. "S3 REQ-01 Covers stated limits"
//   section 5:    "S5 <check> <kind>",               e.g. "S5 Secret scan secret-missing"
// Negative cases ("neg-*") change the repository in a way that must NOT produce an issue (a different but valid tool,
// a script chain), so they measure false alarms on realistic variety, not only on the one base.
//
// `needs` says what the case can be judged with: 'code' (offline, no model), or 'model'. Offline, the scorer decides per
// issue key what code could have decided (section 5, Specific, Traceable, and the test-evidence rows of requirements
// code traced itself); the other expectations are marked "not evaluable" rather than missed.
const { BASE } = require('./base');

function edit(files, p, from, to) {
  if (!(p in files)) throw new Error(`seeded case edits a missing file: ${p}`);
  if (!files[p].includes(from)) throw new Error(`seeded case: text not found in ${p}: ${from.slice(0, 60)}`);
  files[p] = files[p].replace(from, to);
}
const S5 = (check, kind) => `S5 ${check} ${kind}`;

const CASES = [
  // ---- the clean base ---------------------------------------------------------------------------------------------
  { id: 'clean', needs: 'model', what: 'the base repository, nothing seeded', expect: [], // critical: the acceptable areas per rule ([] = not critical). REQ-04 is about the fee and the admin role, DEC-01
    // may inherit money from REQ-01 if read as restating it; either area is right.
    critical: { 'REQ-01': ['money'], 'REQ-02': ['money'], 'REQ-03': [], 'REQ-04': ['access control', 'money'], 'DEC-01': ['outside calls', 'money'], 'DEC-02': ['money'], 'DEC-03': [] } },

  // ---- section 5: CI gate (code only) -----------------------------------------------------------------------------
  { id: 'ci-secret-missing', needs: 'code', what: 'no secret scan step', expect: [S5('Secret scan', 'secret-missing')],
    apply: (f) => edit(f, '.github/workflows/pr.yml', '      - uses: gitleaks/gitleaks-action@v2\n', '') },
  { id: 'ci-secret-nightly-only', needs: 'code', what: 'the secret scan runs only in the nightly workflow, not on PRs', expect: [S5('Secret scan', 'secret-missing')],
    apply: (f) => { edit(f, '.github/workflows/pr.yml', '      - uses: gitleaks/gitleaks-action@v2\n', ''); edit(f, '.github/workflows/nightly.yml', '      - run: npm ci\n', '      - uses: gitleaks/gitleaks-action@v2\n      - run: npm ci\n'); } },
  { id: 'ci-secret-soft', needs: 'code', what: 'the secret scan step has continue-on-error, so it cannot fail a PR', expect: [S5('Secret scan', 'secret-missing')],
    apply: (f) => edit(f, '.github/workflows/pr.yml', '      - uses: gitleaks/gitleaks-action@v2\n', '      - uses: gitleaks/gitleaks-action@v2\n        continue-on-error: true\n') },
  { id: 'ci-dependency-missing', needs: 'code', what: 'no dependency scan', expect: [S5('Dependency scan', 'dependency-missing')],
    apply: (f) => edit(f, '.github/workflows/pr.yml', '      - run: npm audit --audit-level=high\n', '') },
  { id: 'ci-dependency-soft', needs: 'code', what: 'npm audit with continue-on-error', expect: [S5('Dependency scan', 'dependency-soft')],
    apply: (f) => edit(f, '.github/workflows/pr.yml', '      - run: npm audit --audit-level=high\n', '      - run: npm audit --audit-level=high\n        continue-on-error: true\n') },
  { id: 'ci-coverage-missing', needs: 'code', what: 'tests run on PR without coverage', expect: [S5('Coverage', 'coverage-missing')],
    apply: (f) => { edit(f, 'package.json', '"vitest run --coverage"', '"vitest run"'); edit(f, 'vitest.config.js', 'enabled: true', 'enabled: false'); } },
  { id: 'ci-coverage-excludes-logic', needs: 'code', what: 'coverage excludes a logic folder (src/payments)', expect: [S5('Coverage', 'coverage-exclusion')],
    apply: (f) => edit(f, 'vitest.config.js', "      include: ['src/**'],\n", "      include: ['src/**'],\n      exclude: ['src/payments/**', 'src/**/*.d.ts'],\n") },
  { id: 'ci-coverage-global-only', needs: 'code', what: 'one global coverage threshold, no per-file or per-folder threshold', expect: [S5('Coverage', 'coverage-global')],
    apply: (f) => edit(f, 'vitest.config.js', '        perFile: true,\n', '') },
  { id: 'ci-format-missing', needs: 'code', what: 'no format check', expect: [S5('Format', 'format-missing')],
    apply: (f) => edit(f, '.github/workflows/pr.yml', '      - run: npm run format:check\n', '') },
  { id: 'ci-format-writes', needs: 'code', what: 'prettier runs with --write (fixes files, never fails), not --check', expect: [S5('Format', 'format-missing')],
    apply: (f) => edit(f, 'package.json', '"prettier --check ."', '"prettier --write ."') },
  { id: 'ci-lint-missing', needs: 'code', what: 'no lint step', expect: [S5('Lint', 'lint-missing')],
    apply: (f) => edit(f, '.github/workflows/pr.yml', '      - run: npm run lint\n', '') },
  { id: 'ci-lint-soft', needs: 'code', what: 'lint step with continue-on-error', expect: [S5('Lint', 'lint-missing')],
    apply: (f) => edit(f, '.github/workflows/pr.yml', '      - run: npm run lint\n', '      - run: npm run lint\n        continue-on-error: true\n') },
  { id: 'ci-typecheck-missing', needs: 'code', what: 'no type check', expect: [S5('Type check', 'typecheck-missing')],
    apply: (f) => edit(f, '.github/workflows/pr.yml', '      - run: npm run typecheck\n', '') },
  { id: 'ci-pr-trigger-missing', needs: 'model', what: 'the checks workflow runs on push to main only, not on pull requests',
    expect: ['Secret scan secret-missing', 'Coverage coverage-missing', 'Dependency scan dependency-missing', 'Format format-missing', 'Lint lint-missing', 'Type check typecheck-missing', 'Unit and component tests tests-missing'].map((k) => `S5 ${k}`)
      .concat(['REQ-01', 'REQ-02', 'REQ-03', 'REQ-04'].map((r) => `S3 ${r} Runs on PR`), ['DEC-01', 'DEC-02', 'DEC-03'].map((r) => `S4 ${r} Runs on PR`)),
    apply: (f) => edit(f, '.github/workflows/pr.yml', 'on:\n  pull_request:\n  push:', 'on:\n  push:') },

  // ---- section 5 negatives: valid variety that must not be flagged ------------------------------------------------
  { id: 'neg-ci-trufflehog', needs: 'code', what: 'trufflehog instead of gitleaks', expect: [],
    apply: (f) => edit(f, '.github/workflows/pr.yml', 'gitleaks/gitleaks-action@v2', 'trufflesecurity/trufflehog@v3.82.0') },
  { id: 'neg-ci-osv', needs: 'code', what: 'osv-scanner instead of npm audit', expect: [],
    apply: (f) => edit(f, '.github/workflows/pr.yml', '      - run: npm audit --audit-level=high\n', '      - uses: google/osv-scanner-action/osv-scanner-action@v2.0.0\n        with:\n          scan-args: --lockfile=package-lock.json\n') },
  { id: 'neg-ci-dependency-review', needs: 'code', what: 'GitHub dependency-review-action instead of npm audit', expect: [],
    apply: (f) => edit(f, '.github/workflows/pr.yml', '      - run: npm audit --audit-level=high\n', '      - uses: actions/dependency-review-action@v4\n') },
  { id: 'neg-ci-biome', needs: 'code', what: 'biome ci (format and lint in one) instead of prettier and eslint', expect: [],
    apply: (f) => { edit(f, 'package.json', '"eslint ."', '"biome ci ."'); edit(f, 'package.json', '"prettier --check ."', '"biome format ."'); } },
  { id: 'neg-ci-script-chain', needs: 'code', what: 'one `npm run check` script that chains format, lint and type check', expect: [],
    apply: (f) => {
      edit(f, '.github/workflows/pr.yml', '      - run: npm run format:check\n      - run: npm run lint\n      - run: npm run typecheck\n', '      - run: npm run check\n');
      edit(f, 'package.json', '"typecheck": "tsc --noEmit -p jsconfig.json"', '"typecheck": "tsc --noEmit -p jsconfig.json",\n    "check": "npm run format:check && npm run lint && npm run typecheck"');
    } },
  { id: 'neg-ci-separate-jobs', needs: 'code', what: 'the same checks split into separate jobs and a second PR workflow', expect: [],
    apply: (f) => {
      edit(f, '.github/workflows/pr.yml', '      - uses: gitleaks/gitleaks-action@v2\n', '');
      f['.github/workflows/security.yml'] = 'name: Security\non: [pull_request]\njobs:\n  secrets:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          fetch-depth: 0\n      - uses: gitleaks/gitleaks-action@v2\n';
    } },

  // ---- section 5, hard: common real-world setups written without looking at the tool's word lists ------------------
  // The cases above were written knowing which tools the CI parser recognises, so they measure the parser against its
  // own vocabulary. These were written from how real repositories set up CI; they are the honest part of section 5.
  { id: 'hard-neg-precommit', needs: 'code', group: 'hard', what: 'format, lint and the secret scan run as pre-commit hooks via pre-commit/action', expect: [],
    apply: (f) => {
      f['.pre-commit-config.yaml'] = "repos:\n  - repo: https://github.com/gitleaks/gitleaks\n    rev: v8.21.2\n    hooks:\n      - id: gitleaks\n  - repo: https://github.com/pre-commit/mirrors-prettier\n    rev: v3.1.0\n    hooks:\n      - id: prettier\n  - repo: https://github.com/pre-commit/mirrors-eslint\n    rev: v9.14.0\n    hooks:\n      - id: eslint\n";
      edit(f, '.github/workflows/pr.yml', '      - uses: gitleaks/gitleaks-action@v2\n', '      - uses: pre-commit/action@v3.0.1\n');
      edit(f, '.github/workflows/pr.yml', '      - run: npm run format:check\n      - run: npm run lint\n', '');
    } },
  { id: 'hard-neg-makefile', needs: 'code', group: 'hard', what: 'the PR workflow runs `make ci`; the Makefile runs audit, format check, lint, type check and tests', expect: [],
    apply: (f) => {
      f['Makefile'] = "ci: audit format lint typecheck test\n\naudit:\n\tnpm audit --audit-level=high\n\nformat:\n\tnpx prettier --check .\n\nlint:\n\tnpx eslint .\n\ntypecheck:\n\tnpx tsc --noEmit -p jsconfig.json\n\ntest:\n\tnpx vitest run --coverage\n";
      edit(f, '.github/workflows/pr.yml', '      - run: npm audit --audit-level=high\n      - run: npm run format:check\n      - run: npm run lint\n      - run: npm run typecheck\n      - run: npm test\n', '      - run: make ci\n');
    } },
  { id: 'hard-neg-reusable', needs: 'code', group: 'hard', what: 'pr.yml calls a reusable workflow (workflow_call) that holds all the steps', expect: [],
    apply: (f) => {
      const steps = f['.github/workflows/pr.yml'].slice(f['.github/workflows/pr.yml'].indexOf('jobs:'));
      f['.github/workflows/checks.yml'] = 'name: Checks\non:\n  workflow_call:\n' + steps;
      f['.github/workflows/pr.yml'] = 'name: PR checks\non:\n  pull_request:\n  push:\n    branches: [main]\njobs:\n  checks:\n    uses: ./.github/workflows/checks.yml\n';
    } },
  { id: 'hard-neg-xo-c8', needs: 'code', group: 'hard', what: 'lint with xo, coverage with c8 around vitest (no --coverage flag), type check with tsc -b', expect: [],
    apply: (f) => {
      edit(f, 'package.json', '"eslint ."', '"xo"');
      edit(f, 'package.json', '"vitest run --coverage"', '"c8 --check-coverage --lines 80 --per-file vitest run"');
      edit(f, 'vitest.config.js', 'enabled: true', 'enabled: false');
      edit(f, 'package.json', '"tsc --noEmit -p jsconfig.json"', '"tsc -b"');
    } },
  { id: 'hard-neg-node-test', needs: 'code', group: 'hard', what: 'tests run with the built-in node --test runner, with its coverage flag', expect: [],
    allow: ['S5 Coverage coverage-global'],
    apply: (f) => edit(f, 'package.json', '"vitest run --coverage"', '"node --test --experimental-test-coverage --test-coverage-lines=80 tests/"') },
  { id: 'hard-audit-or-true', needs: 'code', group: 'hard', what: '`npm audit || true`: the scan runs but can never fail the PR', expect: [S5('Dependency scan', 'dependency-soft')], allow: [S5('Dependency scan', 'dependency-missing')],
    apply: (f) => edit(f, '.github/workflows/pr.yml', '      - run: npm audit --audit-level=high\n', '      - run: npm audit --audit-level=high || true\n') },
  { id: 'hard-lint-or-true', needs: 'code', group: 'hard', what: '`npm run lint || echo ...`: lint runs but can never fail the PR', expect: [S5('Lint', 'lint-missing')],
    apply: (f) => edit(f, '.github/workflows/pr.yml', '      - run: npm run lint\n', '      - run: npm run lint || echo "lint failed, see log"\n') },
  { id: 'hard-tests-if-false', needs: 'code', group: 'hard', what: 'the test step is switched off with `if: false`', expect: [S5('Unit and component tests', 'tests-missing'), S5('Coverage', 'coverage-missing')],
    allow: ['REQ-01', 'REQ-02', 'REQ-03', 'REQ-04'].map((r) => `S3 ${r} Runs on PR`).concat(['DEC-01', 'DEC-02', 'DEC-03'].map((r) => `S4 ${r} Runs on PR`)),
    apply: (f) => edit(f, '.github/workflows/pr.yml', '      - run: npm test\n', '      - run: npm test\n        if: false\n') },
  { id: 'hard-secret-other-branch', needs: 'code', group: 'hard', what: 'the secret scan job runs only for pull requests into a `release` branch, never for PRs into main', expect: [S5('Secret scan', 'secret-missing')],
    apply: (f) => {
      edit(f, '.github/workflows/pr.yml', '      - uses: gitleaks/gitleaks-action@v2\n', '');
      f['.github/workflows/release-scan.yml'] = "name: Release scan\non:\n  pull_request:\n    branches: [release]\njobs:\n  scan:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: gitleaks/gitleaks-action@v2\n";
    } },

  // ---- section 5, regression: patterns the real-repository tracks caught (each case is one repository's pattern) ---
  { id: 'reg-neg-tox-envlist', needs: 'code', group: 'regression', what: 'tests run through `tox run` (no -e): tox runs its envlist, whose pytest has --cov (pluggy, black)', expect: [],
    apply: (f) => {
      f['tests/test_refund.py'] = 'from refund import refund_amount\n\n\ndef test_fee():\n    assert refund_amount(100) == 85\n';
      f['tox.ini'] = '[tox]\nenvlist = py{311,312}\n\n[testenv]\ncommands =\n    pytest tests \\\n        --cov\n\n[testenv:docs]\n# the standard sphinx command, not a linter\ncommands = sphinx-build docs build\n';
      edit(f, '.github/workflows/pr.yml', '      - run: npm test\n', '      - run: npm test\n      - run: python -m pip install --group dev tox\n      - run: tox run\n');
    } },
  { id: 'reg-pip-install-tox', needs: 'code', group: 'regression', what: '`pip install tox` installs tox but runs nothing; the lint tox env must not count', expect: [S5('Lint', 'lint-missing')],
    apply: (f) => {
      f['tox.ini'] = '[tox]\nenvlist = py312\n\n[testenv:lint]\ncommands = ruff check .\n';
      edit(f, '.github/workflows/pr.yml', '      - run: npm run lint\n', '      - run: python -m pip install --group lint tox\n');
    } },
  { id: 'reg-comment-word-standard', needs: 'code', group: 'regression', what: 'the word "standard" in a script comment is not the `standard` linter', expect: [S5('Lint', 'lint-missing')],
    apply: (f) => {
      f['scripts/docs.sh'] = '#!/bin/sh\n# build with the standard sphinx command\necho build the standard docs\n';
      edit(f, '.github/workflows/pr.yml', '      - run: npm run lint\n', '      - run: bash scripts/docs.sh\n');
    } },
  { id: 'reg-neg-runner-binary-path', needs: 'code', group: 'regression', what: 'jest called by its binary path (`node ./node_modules/jest/bin/jest.js`) still runs every test (react-router)', expect: [],
    allow: [S5('Coverage', 'coverage-missing')],
    apply: (f) => edit(f, 'package.json', '"vitest run --coverage"', '"node --experimental-vm-modules ./node_modules/vitest/vitest.mjs run --coverage"') },
  { id: 'reg-neg-workspace-fanout', needs: 'code', group: 'regression', what: '`pnpm -r run lint` runs each workspace package\'s lint script (typeorm)', expect: [],
    apply: (f) => {
      f['packages/core/package.json'] = JSON.stringify({ name: 'core', scripts: { lint: 'eslint src' } }, null, 2) + '\n';
      edit(f, 'package.json', '"eslint ."', '"pnpm -r run lint"');
    } },
  { id: 'reg-neg-working-directory', needs: 'code', group: 'regression', what: 'the type check runs in a sub-package via `working-directory` (axios)', expect: [],
    apply: (f) => {
      f['types/package.json'] = JSON.stringify({ name: 'types-test', scripts: { check: 'tsc --noEmit' } }, null, 2) + '\n';
      edit(f, '.github/workflows/pr.yml', '      - run: npm run typecheck\n', '      - run: npm run check\n        working-directory: types\n');
    } },
  { id: 'reg-neg-extglob-negation', needs: 'code', group: 'regression', what: 'node --test given `tests/!(fixtures)/**/*.test.js` runs the unit tests (execa)', expect: [],
    apply: (f) => edit(f, 'package.json', '"vitest run --coverage"', '"c8 --per-file --check-coverage node --test \\"tests/!(fixtures)/**/*.test.js\\""') },
  { id: 'reg-neg-v8-coverage', needs: 'code', group: 'regression', what: 'coverage collected with NODE_V8_COVERAGE on the test step and reported with `c8 report` (undici)', expect: [],
    apply: (f) => {
      edit(f, 'package.json', '"vitest run --coverage"', '"node --test tests/"');
      edit(f, '.github/workflows/pr.yml', '      - run: npm test\n', '      - run: npm test\n        env:\n          NODE_V8_COVERAGE: ./coverage/tmp\n      - run: npx c8 report --check-coverage --per-file\n');
    } },
  { id: 'reg-neg-compiled-typecheck', needs: 'code', group: 'regression', what: 'a Go service: the compiler checks types, so no separate type check is missing (cobra, gin)', expect: [],
    apply: (f) => {
      f['go.mod'] = 'module example.com/refund\n\ngo 1.23\n';
      for (const n of ['main', 'refund', 'fee', 'window', 'gateway', 'orders', 'admin', 'store', 'http', 'config']) f[`cmd/${n}.go`] = `package main\n\nfunc ${n}() {}\n`;
      for (const p of Object.keys(f)) if (/^(src|tests|e2e)\//.test(p) || /\.config\.js$|jsconfig/.test(p)) delete f[p];
      f['refund_test.go'] = 'package main\n\nimport "testing"\n\nfunc TestFee(t *testing.T) {}\n';
      f['.github/workflows/pr.yml'] = "name: PR\non: [pull_request]\njobs:\n  go:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: gitleaks/gitleaks-action@v2\n      - run: go test -race -coverprofile=cover.out ./...\n      - uses: golangci/golangci-lint-action@v6\n      - run: test -z \"$(gofmt -l .)\"\n      - run: govulncheck ./...\n";
      delete f['package.json'];
    } },

  // ---- sections 3 and 4: test evidence (need the model's links) ---------------------------------------------------
  { id: 'test-no-test', needs: 'model', what: 'the refund fee (REQ-02) has no test', expect: ['S3 REQ-02 No test'],
    apply: (f) => { const t = f['tests/unit/refund.test.js']; f['tests/unit/refund.test.js'] = t.slice(0, t.indexOf("describe('refund fee'")).replace(', refundAmount', '').trimEnd() + '\n'; } },
  { id: 'test-skipped', needs: 'model', what: 'the refund window cases (REQ-01) are all skipped', expect: ['S3 REQ-01 Not skipped'],
    apply: (f) => { edit(f, 'tests/unit/refund.test.js', "it('REQ-01", "it('REQ-01"); f['tests/unit/refund.test.js'] = f['tests/unit/refund.test.js'].replace(/it\('REQ-01/g, "it.skip('REQ-01"); } },
  { id: 'test-limits-missed', needs: 'model', what: 'the refund window test (REQ-01) uses days 10 and 45, never the edge at 30', expect: ['S3 REQ-01 Covers stated limits'],
    apply: (f) => {
      edit(f, 'tests/unit/refund.test.js', "it('REQ-01 accepts a request on day 30', () => {\n    expect(canRefund(bought, bought + 30 * DAY)).toBe(true);", "it('REQ-01 accepts a request on day 10', () => {\n    expect(canRefund(bought, bought + 10 * DAY)).toBe(true);");
      edit(f, 'tests/unit/refund.test.js', "it('REQ-01 rejects a request on day 31', () => {\n    expect(canRefund(bought, bought + 31 * DAY)).toBe(false);", "it('REQ-01 rejects a request on day 45', () => {\n    expect(canRefund(bought, bought + 45 * DAY)).toBe(false);");
      edit(f, 'tests/unit/refund.test.js', "it('REQ-01 accepts a request on day 29', () => {\n    expect(canRefund(bought, bought + 29 * DAY)).toBe(true);", "it('REQ-01 accepts a request on day 2', () => {\n    expect(canRefund(bought, bought + 2 * DAY)).toBe(true);");
    } },
  { id: 'test-weak-assert', needs: 'model', what: 'the idempotency test (DEC-02) only checks the gateway was called, not that a second refund pays nothing', expect: ['S4 DEC-02 Asserts the rule'],
    apply: (f) => edit(f, 'tests/unit/refund-service.test.js', '    const first = await svc.refund(order);\n    const second = await svc.refund(order);\n    expect(second).toEqual(first);\n    expect(post).toHaveBeenCalledTimes(1);\n', '    await svc.refund(order);\n    expect(post).toHaveBeenCalled();\n') },
  { id: 'test-simulator', needs: 'model', what: 'the refund fee test (REQ-02) calls a simulator copy of the formula, not src/refund.js', expect: ['S3 REQ-02 Calls the code'],
    allow: ['S3 REQ-01 Calls the code'],
    apply: (f) => {
      f['src/testing/refund-simulator.js'] = "// A copy of the fee formula for demos and tests.\nexport const refundAmount = (pricePaid, fee = 15) => Math.max(0, pricePaid - fee);\n";
      const t = f['tests/unit/refund.test.js'], at = t.indexOf("describe('refund fee'");
      f['tests/unit/refund.test.js'] = t.slice(0, at).replace(', refundAmount', '').trimEnd() + '\n';
      f['tests/unit/refund-fee.test.js'] = "import { describe, it, expect } from 'vitest';\nimport { refundAmount } from '../../src/testing/refund-simulator.js';\n\n" + t.slice(at);
    } },
  { id: 'test-mocked-boundary', needs: 'model', what: 'the gateway test (DEC-01) mocks fetch-level code instead of running the adapter against a fake server', expect: ['S4 DEC-01 Crosses the real boundary'],
    allow: ['S4 DEC-01 Covers stated limits', 'S4 DEC-01 Asserts the rule'],
    apply: (f) => { f['tests/component/gateway.test.js'] = "import { describe, it, expect, vi } from 'vitest';\nimport { postRefund } from '../../src/gateway.js';\n\nvi.mock('../../src/gateway.js', () => ({ postRefund: vi.fn(async () => ({ status: 'PENDING', reason: 'timeout' })) }));\n\ndescribe('payment gateway adapter', () => {\n  it('stores PENDING after a 5001 ms wait (timeout after 5 s, 4999 ms is fine)', async () => {\n    expect((await postRefund('http://gw', 'o-2', 10)).status).toBe('PENDING');\n  });\n});\n"; } },
  { id: 'test-nightly-only', needs: 'model', what: 'the refund window and fee tests (REQ-01, REQ-02) moved to a suite that only the nightly workflow runs', expect: ['S3 REQ-01 Runs on PR', 'S3 REQ-02 Runs on PR'],
    apply: (f) => {
      f['tests/slow/refund.test.js'] = f['tests/unit/refund.test.js']; delete f['tests/unit/refund.test.js'];
      f['vitest.nightly.config.js'] = "import { defineConfig } from 'vitest/config';\n\nexport default defineConfig({\n  test: {\n    include: ['tests/slow/**/*.test.js'],\n  },\n});\n";
      edit(f, '.github/workflows/nightly.yml', '      - run: npm run test:e2e\n', '      - run: npx vitest run --config vitest.nightly.config.js\n      - run: npm run test:e2e\n');
    } },
  { id: 'test-e2e-only', needs: 'model', what: 'the refund fee (REQ-02) is tested only through the browser, in an e2e test run on PR', expect: ['S3 REQ-02 Placement'],
    apply: (f) => {
      const t = f['tests/unit/refund.test.js'], at = t.indexOf("describe('refund fee'");
      f['tests/unit/refund.test.js'] = t.slice(0, at).replace(', refundAmount', '').trimEnd() + '\n';
      f['e2e/refund-fee.spec.js'] = "import { test, expect } from '@playwright/test';\n\ntest('the refund page takes the $15 fee off a $100 order', async ({ page }) => {\n  await page.goto('/orders/o-100');\n  await expect(page.getByTestId('refund-amount')).toHaveText('$85.00');\n});\ntest('the refund page shows $0 for a $15 order and $1 for a $16 order', async ({ page }) => {\n  await page.goto('/orders/o-15');\n  await expect(page.getByTestId('refund-amount')).toHaveText('$0.00');\n  await page.goto('/orders/o-16');\n  await expect(page.getByTestId('refund-amount')).toHaveText('$1.00');\n});\ntest('the refund page shows $0 for a $14 order', async ({ page }) => {\n  await page.goto('/orders/o-14');\n  await expect(page.getByTestId('refund-amount')).toHaveText('$0.00');\n});\n";
      edit(f, '.github/workflows/pr.yml', '      - run: npm test\n', '      - run: npm test\n      - run: npm run test:e2e\n');
    } },
  { id: 'code-no-timeout', needs: 'model', what: 'the gateway adapter (DEC-01) has no timeout, and its test has no timeout case', expect: ['S4 DEC-01 Suspected not built'],
    allow: ['S4 DEC-01 Covers stated limits'],
    apply: (f) => {
      edit(f, 'src/gateway.js', '      signal: AbortSignal.timeout(TIMEOUT_MS),\n', '');
      edit(f, 'src/gateway.js', 'const TIMEOUT_MS = 5000;\n\n', '');
      edit(f, 'tests/component/gateway.test.js', "  it('stores PENDING when the gateway takes 5001 ms (timeout after 5 s)', async () => {\n    delayMs = 5001; status = 200;\n    expect((await postRefund(url, 'o-2', 10)).status).toBe('PENDING');\n  }, 10000);\n", '');
      edit(f, 'tests/component/gateway.test.js', 'within 4999 ms', 'quickly');
      edit(f, 'tests/component/gateway.test.js', 'delayMs = 4999;', 'delayMs = 10;');
    } },
  { id: 'code-no-role-check', needs: 'model', what: 'the admin fee route (REQ-04) checks only that someone is logged in; its test covers only the admin', expect: ['S3 REQ-04 Asserts the rule'],
    allow: ['S3 REQ-04 Covers stated limits'],
    apply: (f) => {
      edit(f, 'src/admin.js', "  if (!req.user || req.user.role !== 'admin') return", '  if (!req.user) return');
      edit(f, 'tests/component/admin.test.js', "  it('answers 403 to a customer who tries to change the fee', async () => {\n    const res = await request(createApp({ user: { role: 'customer' } })).put('/admin/fee').send({ fee: 0 });\n    expect(res.status).toBe(403);\n  });\n", '');
    } },

  // ---- sections 1 and 2: document health (need the model, except Specific and Traceable) -------------------------
  { id: 'doc-vague-critical', needs: 'model', what: 'the refund window (REQ-01) says "within a reasonable time" instead of 30 days', expect: ['S1 REQ-01 Testable', 'S1 REQ-01 Specific'],
    allow: ['S1 REQ-01 Clear', 'S1 REQ-01 Consistent', 'S3 REQ-01 Covers stated limits'],
    apply: (f) => edit(f, 'docs/requirements.md', 'made within 30 days of purchase and reject a request made after day 30.', 'made within a reasonable time after purchase.') },
  { id: 'doc-vague-noncritical', needs: 'model', what: 'the page size (REQ-03) says "a reasonable number" instead of 50', expect: ['S1 REQ-03 Testable', 'S1 REQ-03 Specific'],
    allow: ['S1 REQ-03 Clear', 'S3 REQ-03 Covers stated limits'],
    apply: (f) => edit(f, 'docs/requirements.md', 'shall return at most 50 orders per page.', 'should return a reasonable number of orders per page.') },
  { id: 'doc-conflict', needs: 'model', what: 'a design decision allows refunds up to 45 days, against the 30 days of REQ-01', expect: ['S1 REQ-01 Consistent'],
    allow: ['S2 DEC-04 Trade-off', 'S2 DEC-04 Traceable', 'S2 DEC-04 Verifiable', 'S4 DEC-04 No test', 'S4 DEC-04 Covers stated limits'],
    apply: (f) => edit(f, 'docs/design.md', '## Orders\n', '### DEC-04 Long refund window for annual plans\nRefunds are accepted up to 45 days after purchase.\nServes: REQ-01\n\n## Orders\n') },
  { id: 'doc-ambiguous', needs: 'model', what: 'the refund fee (REQ-02) says "pro rata minus a $15 fee" without saying pro rata by what', expect: ['S1 REQ-02 Clear'],
    allow: ['S1 REQ-02 Testable', 'S1 REQ-02 Complete', 'S3 REQ-02 Asserts the rule'],
    apply: (f) => edit(f, 'docs/requirements.md', 'The refund amount shall be the price paid minus a $15 fee; when the price paid is $15 or less, the refund amount shall be $0.', 'The refund amount shall be the price paid, pro rata, minus a $15 fee.') },
  { id: 'doc-two-behaviours', needs: 'model', what: 'REQ-04 also requires an email to finance on every fee change', expect: ['S1 REQ-04 One behaviour'],
    allow: ['S3 REQ-04 Asserts the rule'],
    apply: (f) => edit(f, 'docs/requirements.md', 'the system shall answer HTTP 403 to any other user.', 'the system shall answer HTTP 403 to any other user, and shall email the finance team about every fee change.') },
  { id: 'doc-no-failure-behaviour', needs: 'model', what: 'the gateway decision (DEC-01) no longer says what happens on a timeout or an error', expect: ['S2 DEC-01 Failure behaviour'],
    allow: ['S2 DEC-01 Verifiable'],
    apply: (f) => edit(f, 'docs/design.md', 'Calls to the payment gateway in `src/gateway.js` time out after 5 seconds. On a timeout or a gateway error the refund is stored as `PENDING` and retried by the nightly job.', 'Refunds are posted to the payment gateway by `src/gateway.js` over HTTPS.') },
  { id: 'doc-untraceable', needs: 'code', what: 'DEC-02 has neither a Serves line nor a reason', expect: ['S2 DEC-02 Traceable'],
    apply: (f) => edit(f, 'docs/design.md', 'so a store failure never pays twice.\nServes: REQ-02\n', 'so a store failure never pays twice.\n') },
  { id: 'neg-doc-rewording', needs: 'model', what: 'REQ-01 reworded in EARS form with the same meaning', expect: [],
    apply: (f) => edit(f, 'docs/requirements.md', 'The system shall accept a refund request made within 30 days of purchase and reject a request made after day 30.', 'When a customer requests a refund, the system shall accept the request if it is made no later than 30 days after purchase, and shall reject it otherwise.') },
];

/** The files of one case: the base with the case's change applied. */
function filesOf(c) {
  const files = { ...BASE };
  if (c.apply) c.apply(files);
  return files;
}

module.exports = { CASES, filesOf, BASE };
