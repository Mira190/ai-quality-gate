'use strict';
// Stage 8a/8b: rule → implementing code, rule → tests.
// Code builds the candidates (BM25 over source files; tests that carry the rule ID or its search terms) and the
// model picks among them. Every pick is checked: the path must exist, the line must be in the file, a test must be in
// the test index. Tests that carry the rule ID (a tag) are always linked, whatever the model says.
const path = require('node:path');
const { readText, linesOf, need, mode } = require('./util');
const { CODE_EXT, isTestFile } = require('./tests-index');
const { STYLE, obj, arr, str } = require('./judge');

const tokens = (s) => String(s).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || [];
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'shall', 'must', 'should', 'when', 'from', 'are', 'not', 'any', 'all', 'its', 'has', 'have', 'will', 'can', 'into', 'than', 'then', 'each', 'one', 'system', 'return', 'const', 'import', 'export', 'function', 'async', 'await', 'new']);

function bm25(docs) {
  const N = docs.length, df = new Map(), avg = docs.reduce((s, d) => s + d.toks.length, 0) / (N || 1);
  for (const d of docs) for (const t of new Set(d.toks)) df.set(t, (df.get(t) || 0) + 1);
  const tfs = docs.map((d) => { const tf = new Map(); for (const t of d.toks) tf.set(t, (tf.get(t) || 0) + 1); return tf; });
  return (query) => {
    const q = [...new Set(tokens(query).filter((t) => !STOP.has(t)))];
    return docs.map((d, k) => {
      const tf = tfs[k];
      let s = 0;
      for (const t of q) { const f = tf.get(t); if (!f) continue; const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5)); s += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * d.toks.length / avg)); }
      return { path: d.path, score: s };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const termRe = (t) => new RegExp(escapeRe(t).replace(/\\ /g, '[\\s_-]*'), 'i');

function candidates(root, files, testIndex, rule, testSearch) {
  return { code: rule._code || [], tests: testCandidates(testIndex, rule, testSearch) };
}

// Test candidates, best first: the rule ID in the test, the rule's search terms, an import of a code candidate, then
// similar case names. The model's terms are often document phrases a test never contains, so the last two sources keep
// a real test from being missed (a missed test becomes a false "No test").
function testCandidates(testIndex, rule, testSearch) {
  const out = [], codePaths = new Set((rule._code || []).map((c) => c.path));
  for (const t of testIndex.tests) {
    const tag = new RegExp(`\\b${escapeRe(rule.id)}\\b`).test(t.text);
    const hits = rule.terms.filter((term) => termRe(term).test(t.text));
    const imp = t.imports.find((i) => codePaths.has(i.resolved));
    if (tag || hits.length || imp) out.push({ path: t.path, tag, hits, imports: imp?.resolved || null, level: t.level, cases: t.cases.length });
  }
  out.sort((a, b) => (b.tag - a.tag) || b.hits.length - a.hits.length || Boolean(b.imports) - Boolean(a.imports));
  const top = out.slice(0, 10);
  if (testSearch) for (const x of testSearch(`${rule.title} ${rule.text} ${rule.terms.join(' ')}`).slice(0, 3)) {
    if (top.length >= 12 || top.some((t) => t.path === x.path)) continue;
    const t = testIndex.tests.find((y) => y.path === x.path);
    top.push({ path: t.path, tag: false, hits: [], imports: null, level: t.level, cases: t.cases.length });
  }
  return top;
}

// A design decision says how the code is built, so a unit, component or integration test of it must name the
// implementing symbol or mock its file (a test of computeRefund in the same file is not a test of RefundService.post).
// End-to-end tests drive the app from outside and pass; a test that carries the rule ID is linked by its tag before this.
function touchesImpl(r, t) {
  if (r.kind !== 'decision' || !r.impl?.symbol || t.level === 'e2e' || t.mocks.some((m) => m.resolved === r.impl.path)) return true;
  const parts = String(r.impl.symbol).split(/[.#:\s]+/).filter((s) => s.length >= 4);
  return !parts.length || parts.some((s) => new RegExp(`\\b${escapeRe(s)}\\b`).test(t.text));
}

// A unit, component or integration test exercises code it imports or mocks, directly or through the modules those
// import. A test whose import closure never reaches the implementing file tests something else (a simulator, a sibling
// helper); end-to-end tests drive the app from outside, so they cannot be checked this way. A file the rule names
// (`config/payment.json`) is a target too: a test that loads the configured limits tests the decision that sets them.
// Unchecked (passes) when the imports cannot be followed: a language without a resolver here, or a path alias
// ("@/lib/x", "src/x") that only the build config resolves. Go tests sit in the package they test.
function reaches(t, targets, srcImports) {
  if (/_test\.go$/.test(t.path)) return [...targets].some((f) => path.posix.dirname(f) === path.posix.dirname(t.path));
  if (!t.imports.some((i) => i.resolved) || t.imports.some((i) => !i.resolved && /^(@\/|~\/|#|src\/|app\/|lib\/)/.test(i.spec))) return true;
  const seen = new Set(), todo = [...t.imports, ...t.mocks].map((m) => m.resolved).filter(Boolean);
  while (todo.length) {
    const f = todo.pop();
    if (targets.has(f)) return true;
    if (seen.has(f)) continue;
    seen.add(f); todo.push(...(srcImports.get(f) || []));
  }
  return false;
}

async function traceRules(llm, rules, { root, files, testIndex }) {
  const src = files.filter((f) => CODE_EXT.some((e) => f.endsWith(e)) && !isTestFile(f) && !/\.config\.|\.d\.ts$/.test(f));
  const texts = new Map(src.map((f) => [f, readText(root, f) || '']));
  const search = bm25(src.map((f) => ({ path: f, toks: [...tokens(f), ...tokens(texts.get(f))] })));
  const testSearch = bm25(testIndex.tests.map((t) => ({ path: t.path, toks: [...tokens(t.path), ...t.cases.flatMap((c) => tokens(c.name))] })));
  for (const r of rules) {
    const top = search(`${r.title} ${r.text} ${r.terms.join(' ')}`).slice(0, 5);
    const q = new Set([...tokens(`${r.title} ${r.text} ${r.terms.join(' ')}`)].filter((t) => !STOP.has(t)));
    r._code = top.map((c) => {
      const lines = linesOf(texts.get(c.path));
      const hits = lines.map((l, i) => ({ n: i + 1, l })).filter((x) => tokens(x.l).some((t) => q.has(t)) || /^\s*(export\s+)?(async\s+)?(function|class|const|def)\b/.test(x.l)).slice(0, 14);
      return { path: c.path, lines: hits };
    });
  }
  const batches = [];
  for (let i = 0; i < rules.length; i += 12) batches.push(rules.slice(i, i + 12));
  const picks = (await Promise.all(batches.map((b, i) => llm.votes(`trace:${i}`, {
    system: STYLE,
    prompt: `For each rule, pick (1) where the code implements it: the file, the line of the function or statement that does it, and the symbol name, or null fields ("" and 0) if no candidate implements it; (2) which candidate test files exercise this rule's behaviour at all, even partly or poorly (a browser test that shows a premium on a page counts for a premium rule; a test that calls the implementing function counts). Later checks judge whether those tests assert the rule, cover its limits and run on PR, so do not leave a test out because it is weak; leave it out only when it tests a different behaviour. Pick only from the candidates shown.\n\n${b.map((r) => {
      const c = candidates(root, files, testIndex, r, testSearch);
      return `<rule id="${r.id}">${r.title}. ${r.text}\n<code-candidates>\n${c.code.map((x) => `${x.path}\n${x.lines.map((l) => `  ${l.n}: ${l.l.trim().slice(0, 160)}`).join('\n')}`).join('\n')}\n</code-candidates>\n<test-candidates>\n${c.tests.map((t) => `${t.path} (${t.level}, ${t.cases} cases; ${t.tag ? 'names the rule ID' : t.hits.length ? `contains ${t.hits.map((h) => `"${h}"`).join(', ')}` : t.imports ? `imports ${t.imports}` : 'similar case names'})\n${testIndex.tests.find((x) => x.path === t.path).cases.slice(0, 12).map((k) => `  ${k.line}: ${k.name}`).join('\n')}`).join('\n') || '(none)'}\n</test-candidates>\n</rule>`;
    }).join('\n')}`,
    schema: obj({ rules: arr(obj({ id: str, impl_path: str, impl_line: { type: 'integer' }, impl_symbol: str, tests: arr(str) })) }),
    maxTokens: 8000,
  })))).flat().flatMap((o) => o?.rules || []);
  for (const r of rules) {
    // votes: the implementation most replies name (a reply with a line outside the file does not count). A test link
    // needs most replies too, and a non-e2e test must reach the implementation through its imports: on the live runs
    // every right link had all the votes, and the links one reply added were wrong.
    const ps = picks.filter((x) => x.id === r.id);
    const valid = ps.filter((p) => texts.has(p.impl_path) && p.impl_line >= 1 && p.impl_line <= linesOf(texts.get(p.impl_path)).length);
    const top = mode(valid.map((p) => p.impl_path));
    const p = valid.filter((x) => x.impl_path === top).length >= need(ps.length) ? valid.find((x) => x.impl_path === top) : null;
    const c = candidates(root, files, testIndex, r, testSearch);
    r.impl = p ? { path: p.impl_path, line: p.impl_line, symbol: p.impl_symbol } : null;
    const tagged = c.tests.filter((t) => t.tag).map((t) => ({ path: t.path, source: 'tag' }));
    const named = files.filter((f) => r.text.includes(f));
    const votes = new Map();
    for (const x of ps) for (const t of new Set(x.tests || [])) votes.set(t, (votes.get(t) || 0) + 1);
    const linked = [...votes].filter(([t, n]) => {
      const tt = testIndex.tests.find((x) => x.path === t);
      if (!tt || n < need(ps.length) || tagged.some((x) => x.path === t)) return false;
      return tt.level === 'e2e' || !r.impl || reaches(tt, new Set([r.impl.path, ...named]), testIndex.srcImports) && touchesImpl(r, tt);
    }).map(([t]) => ({ path: t, source: c.tests.some((x) => x.path === t) ? 'name' : 'AI' }));
    r.traced = ps.length > 0; // no model reply for this rule: its test links are unknown, not absent
    r.links = [...tagged, ...linked];
    r.searched = r.terms;
    delete r._code;
  }
}

module.exports = { traceRules, bm25, tokens, termRe, testCandidates, reaches };
