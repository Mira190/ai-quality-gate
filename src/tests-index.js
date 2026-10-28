'use strict';
// Stage 5: test files, their cases, skip markers, assertions, imports, mocks and level. All static: no test is run.
// Level comes from what the test imports first (a database client makes it integration wherever it sits), then the path.
const path = require('node:path');
const { readText, linesOf } = require('./util');

const TEST_FILE = /(^|\/)(__tests__|tests?|spec|e2e|integration|component|unit)\/.+\.(c|m)?[jt]sx?$|\.(test|spec)\.(c|m)?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$/;
const CASE = /^\s*(?:(it|test)(?:\.(skip|todo|only|fails|concurrent))?|(xit|xtest))\s*\(\s*(['"`])((?:\\.|(?!\4).)*)\4/;
const PY_CASE = /^\s*(@pytest\.mark\.skip[^\n]*\n\s*)?def\s+(test_\w+)/;
// one line of an import: a whole import/export-from, the closing line of a multi-line import, require(), import()
const IMPORT = /^\s*(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]|^\s*\}\s*from\s+['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]\s*\)|\bimport\(\s*['"]([^'"]+)['"]\s*\)/;
const specOf = (m) => m[1] || m[2] || m[3] || m[4];
// a test that starts the program as a process (child_process, execa, a run-cli helper) tests it end to end
const PROCESS = /['"](execa|node:child_process|child_process)['"]|['"][^'"]*\/run-?cli(\.[jt]s)?['"]/i;
const MOCK = /\b(?:vi|jest)\.mock\(\s*['"]([^'"]+)['"]/;
const FAKE_SERVER = /\b(msw|nock|wiremock|mockttp|http\.createServer|createServer\(|setupServer|testcontainers)\b/;
const ASSERT = /\bexpect\s*\(|\bassert[.(\s]|\bshould\.|\bt\.(is|deepEqual|equal|true)\(/;
const DB = /['"](pg|mysql2?|mongodb|mongoose|redis|ioredis|sqlite3|better-sqlite3|knex|@prisma\/client|typeorm|sequelize|testcontainers)['"]/;
const E2E = /['"](@playwright\/test|playwright|puppeteer|cypress|selenium-webdriver|webdriverio)['"]/;
const COMPONENT = /['"](supertest|@testing-library\/[\w-]+|msw|nock|light-my-request)['"]/;
const SOURCE_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];

const isTestFile = (f) => TEST_FILE.test(f) && !/\.d\.ts$/.test(f) && !/(^|\/)(fixtures?|mocks?|__mocks__|helpers?|support)\//.test(f) && !/\.config\.[jt]s$/.test(f);

function levelOf(file, text) {
  if (E2E.test(text) || PROCESS.test(text) || /(^|\/)[\w-]*e2e[\w-]*\//.test(file) || /\.e2e\./.test(file)) return 'e2e';
  if (DB.test(text) || /(^|\/)integration\//.test(file)) return 'integration';
  if (COMPONENT.test(text) || /(^|\/)component\//.test(file)) return 'component';
  return 'unit';
}

function resolveImport(from, spec, fileSet) {
  if (!spec.startsWith('.')) return null;
  const baseRel = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  const tries = [baseRel, ...SOURCE_EXT.map((e) => baseRel + e), ...SOURCE_EXT.map((e) => `${baseRel}/index${e}`)];
  if (/\.js$/.test(baseRel)) tries.push(...SOURCE_EXT.map((e) => baseRel.replace(/\.js$/, e)));
  return tries.find((t) => fileSet.has(t)) || null;
}

function indexFile(root, file, fileSet) {
  const text = readText(root, file) || '';
  const lines = linesOf(text), cases = [], asserts = [], imports = [], mocks = [];
  let fake = null;
  lines.forEach((l, i) => {
    const n = i + 1;
    let m;
    if ((m = CASE.exec(l))) cases.push({ name: m[5], line: n, skipped: !!(m[2] && /skip|todo/.test(m[2]) || m[3]), only: m[2] === 'only' });
    else if ((m = PY_CASE.exec(l))) cases.push({ name: m[2], line: n, skipped: /@pytest\.mark\.skip/.test(lines[i - 1] || '') });
    if (ASSERT.test(l)) asserts.push({ line: n, text: l.trim() });
    if ((m = IMPORT.exec(l))) { const spec = specOf(m); imports.push({ spec, line: n, resolved: resolveImport(file, spec, fileSet), text: l.trim() }); }
    if ((m = MOCK.exec(l))) mocks.push({ spec: m[1], line: n, resolved: resolveImport(file, m[1], fileSet) });
    if (!fake && FAKE_SERVER.test(l)) fake = { line: n, text: l.trim() };
  });
  // A case's body: lines from its declaration to the next case (good enough to match terms and find inputs).
  cases.forEach((c, k) => { c.end = (cases[k + 1]?.line || lines.length + 1) - 1; c.body = lines.slice(c.line - 1, c.end).join('\n'); });
  return { path: file, text, level: levelOf(file, text), cases, asserts, imports, mocks, fakeServer: fake };
}

function indexTests(root, files) {
  const fileSet = new Set(files);
  const tests = files.filter(isTestFile).map((f) => indexFile(root, f, fileSet));
  // Source import graph, one level, so "calls the code" can follow test → module → implementation.
  const srcImports = new Map();
  for (const f of files) {
    if (!SOURCE_EXT.some((e) => f.endsWith(e)) || isTestFile(f)) continue;
    const text = readText(root, f) || '';
    const deps = [];
    for (const l of linesOf(text)) { const m = IMPORT.exec(l); if (m) { const r = resolveImport(f, specOf(m), fileSet); if (r) deps.push(r); } }
    srcImports.set(f, deps);
  }
  return { tests, srcImports, caseCount: tests.reduce((s, t) => s + t.cases.length, 0) };
}

module.exports = { indexTests, isTestFile, levelOf, resolveImport, SOURCE_EXT };
