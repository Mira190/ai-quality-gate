'use strict';
// Placement, made realistic. "This rule belongs in a unit test" is only advice someone can act on when a unit test can
// reach the logic: a function it can import and call without starting a database, a browser or the network. That is a
// seam (Feathers, "Working Effectively with Legacy Code"). Google sizes tests by what they need (a small test: one
// process, no network, no disk), not by what they are called, and this module asks the same question of the code.
//
// For a rule whose ideal level is unit (pure logic: calculation, date, count, validation), code looks for the seam:
//   pure       the implementing function, or an exported function in its file that it calls or that holds the rule's
//              limit, does no I/O and is importable without side effects        → unit test that calls it directly
//   fake       the function does I/O only through something a test can swap in-process: a constructor or parameter
//              dependency (this.db, self.client) or the global fetch (a fake server or a stubbed fetch) → unit test
//              with a fake dependency
//   none       the I/O is wired in (a client built inside the function, file or process calls, I/O when the module
//              loads), or the function cannot be imported (not exported)       → no unit-level advice: moving the test
//              down needs a refactor first, which is a design note, not a test gap
// No located implementation: no advice (the claim cannot be checked, so it is not made).
// A repository with no unit tests in that language: the advice stands but costs a test setup, so it ranks lower.
const path = require('node:path');
const { readText, linesOf } = require('./util');

// I/O that a unit test cannot run: network, disk, database, processes, sockets, the request/response objects of a server
const IO = /\bawait\b|\bfetch\(|\baxios\b|\bhttps?\.|\.query\(|\.execute\(|\bfs\.|readFile|writeFile|\.save\(|\.send\(|\brequests\.|\bopen\(|subprocess|\bsocket\b|\bdb\.|\bthis\.(db|client|http|repo)\b|\bctx\.|\breq\.|\bres\./;
// I/O wired in so that only a module mock or a real resource can stand in for it
const HARD = /\bnew\s+(Client|Pool|PrismaClient|MongoClient|Redis|IORedis|Sequelize|Kafka|S3Client|WebSocket)\b|\breadFileSync\b|\bwriteFileSync\b|\bfs\.|\bspawn(Sync)?\(|\bexec(Sync|File)?\(|\bsubprocess\b|\bos\.system\b|(?<![.\w])open\(|\bsqlite3\.connect\b|\bpsycopg2?\.connect\b|\bsql\.Open\b|\bhttp\.Get\b|\bos\.(ReadFile|Open)\b/;
const LANG = (f) => (/\.py$/.test(f) ? 'py' : /\.go$/.test(f) ? 'go' : /\.[cm]?[jt]sx?$/.test(f) ? 'js' : null);

/** The body of the function that starts at `line` (1-based): by braces for JS/TS/Go, by indentation for Python. */
function bodyAt(lines, line, file) {
  const from = line - 1;
  if (!lines[from]) return null;
  if (/\.py$/.test(file)) {
    const ind = /^\s*/.exec(lines[from])[0].length, out = [lines[from]];
    for (let j = from + 1; j < lines.length && j < from + 120 && (!lines[j].trim() || /^\s*/.exec(lines[j])[0].length > ind); j++) out.push(lines[j]);
    return out.join('\n');
  }
  let depth = 0, opened = false;
  const out = [];
  for (let j = from; j < lines.length && j < from + 120; j++) {
    out.push(lines[j]);
    for (const ch of lines[j].replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '')) { if (ch === '{') { depth++; opened = true; } else if (ch === '}') depth--; }
    if (opened && depth <= 0) break;
    if (!opened && /[;)]\s*$/.test(lines[j]) && j > from) break; // a one-line arrow or statement
  }
  return out.join('\n');
}
const implBody = (root, impl) => bodyAt(linesOf(readText(root, impl.path) || ''), impl.line, impl.path);

const NOT_A_METHOD = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'constructor', 'super', 'else']);
/** Function definitions in a file: { name, line, method, exported }. */
function functionsIn(text, file) {
  const lang = LANG(file), lines = linesOf(text), out = [];
  const exportedNames = new Set();
  if (lang === 'js') {
    for (const m of text.matchAll(/export\s*\{([^}]*)\}/g)) for (const n of m[1].split(',')) exportedNames.add(n.trim().split(/\s+as\s+/)[0]);
    for (const m of text.matchAll(/export\s+default\s+(\w+)/g)) exportedNames.add(m[1]);
    for (const m of text.matchAll(/(?:module\.)?exports\.(\w+)\s*=/g)) exportedNames.add(m[1]);
    for (const m of text.matchAll(/module\.exports\s*=\s*\{([^}]*)\}/g)) for (const n of m[1].split(',')) exportedNames.add(n.trim().split(':')[0].trim());
  }
  let cls = null;
  lines.forEach((l, i) => {
    let m;
    if (lang === 'js') {
      if ((m = /^(\s*)(export\s+)?(default\s+)?(abstract\s+)?class\s+(\w+)/.exec(l))) { cls = { name: m[5], exported: !!m[2] || exportedNames.has(m[5]), indent: m[1].length }; return; }
      if (cls && /^\S/.test(l) && /^\}/.test(l)) { cls = null; return; }
      if ((m = /^\s*(export\s+)?(default\s+)?(async\s+)?function\s*\*?\s*(\w+)/.exec(l))) out.push({ name: m[4], line: i + 1, method: false, exported: !!m[1] || exportedNames.has(m[4]) });
      else if ((m = /^\s*(export\s+)?(const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*(async\s+)?(\([^)]*\)|\w+)\s*(?::[^=]+)?=>/.exec(l))) out.push({ name: m[3], line: i + 1, method: false, exported: !!m[1] || exportedNames.has(m[3]) });
      else if (cls && (m = /^\s+(public\s+|private\s+|protected\s+|static\s+|readonly\s+)*(async\s+)?(#?\w+)\s*\([^)]*\)?\s*(:\s*[^{]+)?\{?\s*$/.exec(l)) && !NOT_A_METHOD.has(m[3])) {
        out.push({ name: `${cls.name}.${m[3]}`, line: i + 1, method: true, exported: cls.exported && !/private|protected/.test(m[1] || '') && !m[3].startsWith('#') });
      }
    } else if (lang === 'py') {
      if ((m = /^class\s+(\w+)/.exec(l))) { cls = { name: m[1] }; return; }
      if (/^\S/.test(l) && !/^(class|def|async|@)/.test(l)) cls = null;
      if ((m = /^(\s*)(async\s+)?def\s+(\w+)/.exec(l))) {
        const method = m[1].length > 0 && cls;
        const name = method ? `${cls.name}.${m[3]}` : m[3];
        if (!m[1].length) cls = null;
        out.push({ name, line: i + 1, method: !!method, exported: !m[3].startsWith('_') || m[3] === '__init__' });
      }
    } else if (lang === 'go') {
      if ((m = /^func\s+(?:\(\s*\w+\s+\*?(\w+)\s*\)\s*)?(\w+)/.exec(l))) out.push({ name: m[1] ? `${m[1]}.${m[2]}` : m[2], line: i + 1, method: !!m[1], exported: /^[A-Z]/.test(m[2]) });
    }
  });
  return out;
}

// I/O that runs when the module is imported: a unit test that imports it does that I/O too (`const areas =
// readFileSync(...)` at the top of the file). Only top-level statements outside functions count.
function importTimeIO(text, file) {
  const lines = linesOf(text);
  if (LANG(file) === 'py') return lines.find((l) => /^\S/.test(l) && !/^(def|class|async|import|from|@|#)/.test(l) && HARD.test(l)) || null;
  let depth = 0;
  for (const l of lines) {
    const code = l.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""').replace(/\/\/.*$/, '');
    if (depth === 0 && !/^\s*(import|export\s+(type|interface)|\/\/|\*)/.test(l) && HARD.test(l)) return l.trim();
    for (const ch of code) { if (ch === '{') depth++; else if (ch === '}') depth = Math.max(0, depth - 1); }
  }
  return null;
}

// How a function body reaches the outside world: 'none', 'fake' (only through something a test can swap in-process),
// or 'hard'. A method's this.x / self.x is injectable when the constructor takes it (or gives it a default a test can
// override); the global fetch is swappable with a fake server or a stubbed fetch.
function ioKind(body, fileText) {
  if (!body) return 'unknown';
  if (HARD.test(body)) return 'hard';
  if (!IO.test(body)) return 'none';
  const deps = [...body.matchAll(/\b(?:this|self)\.(\w+)\.\w+\(/g)].map((m) => m[1]);
  const ctor = /constructor\s*\(([^)]*)\)|def\s+__init__\s*\(([^)]*)\)/.exec(fileText || '');
  const params = ctor ? (ctor[1] || ctor[2] || '') : '';
  const injectable = deps.every((d) => new RegExp(`\\b${d}\\b`).test(params) || new RegExp(`(?:this|self)\\.${d}\\s*=\\s*\\w+`).test(fileText || ''));
  return injectable ? 'fake' : 'hard';
}

const hasLimit = (body, r) => r.limits.some((l) => new RegExp(`(?<![\\w.])${String(l.value).replace('.', '\\.')}(?![\\w])`).test(body));

/**
 * The unit seam for a rule, or why there is none: { kind: 'pure'|'fake'|'none', symbol, path, line, why }.
 */
function findSeam(r, root) {
  if (!r.impl) return { kind: 'none', why: 'no implementation located' };
  const text = readText(root, r.impl.path) || '', lines = linesOf(text);
  const fns = functionsIn(text, r.impl.path);
  const sym = String(r.impl.symbol || '');
  const self = fns.find((f) => f.line === r.impl.line) || fns.find((f) => f.name === sym || f.name.endsWith(`.${sym}`) || sym.endsWith(`.${f.name}`) || f.name === sym.split(/[.#:]/).pop());
  const loadIO = importTimeIO(text, r.impl.path);
  if (loadIO) return { kind: 'none', why: `\`${r.impl.path}\` does I/O when it is imported (${loadIO.slice(0, 80)})` };
  const body = self ? bodyAt(lines, self.line, r.impl.path) : bodyAt(lines, r.impl.line, r.impl.path);
  const kind = ioKind(body, text);
  const name = self?.name || sym;
  const exported = self ? self.exported : true;
  if (kind === 'none' && exported) return { kind: 'pure', symbol: name, path: r.impl.path, line: self?.line || r.impl.line, why: `\`${name}\` does no I/O` };
  // a pure exported helper in the same file that the implementation calls, or that holds the rule's limit
  const helpers = fns.filter((f) => f !== self && f.exported && !f.method);
  for (const f of helpers) {
    const b = bodyAt(lines, f.line, r.impl.path);
    if (ioKind(b, text) !== 'none') continue;
    const called = body && new RegExp(`\\b${f.name.split('.').pop()}\\s*\\(`).test(body);
    if (called || hasLimit(b, r)) return { kind: 'pure', symbol: f.name, path: r.impl.path, line: f.line, why: `\`${f.name}\` does no I/O${called ? ` and \`${name}\` calls it` : ' and holds the limit'}` };
  }
  if (kind === 'fake' && exported) return { kind: 'fake', symbol: name, path: r.impl.path, line: self?.line || r.impl.line, why: `\`${name}\` reaches the outside only through a dependency a test can replace (${/\bfetch\(/.test(body) ? 'fetch' : 'its constructor arguments'})` };
  if (!exported) return { kind: 'none', why: `\`${name}\` is not exported, so a unit test cannot call it` };
  return { kind: 'none', why: `\`${name}\` builds its own connection or reads files, so a unit test cannot run it without a refactor` };
}

/** Unit tests already exist for this language: a unit-level recommendation needs no new test setup. */
function hasUnitInfra(testIndex, file) {
  const lang = LANG(file || '');
  return testIndex.tests.some((t) => t.level === 'unit' && (!lang || LANG(t.path) === lang));
}

const LEVELS = ['unit', 'component', 'integration', 'e2e'];

/**
 * Where the rule's tests should be, realistically. `ideal` is the lowest level that can observe the rule (from
 * belongsAt); the answer is that level only when a seam makes it reachable, otherwise null (no advice).
 *   → { level, by, seam, ideal, infra } | null
 */
function placementFor(r, root, testIndex, ideal) {
  if (!ideal) return null;
  if (ideal.level !== 'unit') return { level: ideal.level, by: ideal.by, ideal: ideal.level, seam: null, infra: true };
  const seam = findSeam(r, root);
  if (seam.kind === 'none') return { level: null, by: ideal.by, ideal: ideal.level, seam, infra: true };
  const infra = hasUnitInfra(testIndex, seam.path);
  return { level: 'unit', by: seam.kind === 'pure' ? ideal.by : `${ideal.by}; ${seam.why}`, ideal: ideal.level, seam, infra };
}

/** True when the rule's lowest test sits above the realistic level (component advice only for e2e-only rules). */
function misplaced(want, tests) {
  if (!want?.level || !tests.length) return false;
  const lowest = Math.min(...tests.map((t) => LEVELS.indexOf(t.level)));
  return want.level === 'unit' ? lowest > 0 : lowest === 3;
}

module.exports = { placementFor, findSeam, functionsIn, importTimeIO, ioKind, implBody, bodyAt, hasUnitInfra, misplaced, IO, HARD, LEVELS };
