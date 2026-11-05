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

// ---- what code decides: the anchors a rule gives itself ------------------------------------------------------------
// A rule that names its code (`src/gateway.js`, `RefundService.refund`) or is named by a test (its ID) needs no model
// to find its implementation or those tests. Code decides these links; the model only adds links for tests that
// exercise the rule without importing its file (an e2e test) and traces the rules that name nothing.
const IDENT = /^[A-Za-z_$][\w$]*(?:[.#][A-Za-z_$][\w$]*)*(?:\(\))?$/;
const KEYWORD = /^\s*(if|for|while|switch|return|catch|else|await|new|throw)\b/;
function defLine(text, name) {
  const re = new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:static\\s+)?(?:function\\*?\\s+${escapeRe(name)}\\b|class\\s+${escapeRe(name)}\\b|(?:const|let|var)\\s+${escapeRe(name)}\\s*=|def\\s+${escapeRe(name)}\\b|func\\s+(?:\\([^)]*\\)\\s*)?${escapeRe(name)}\\b|(?:(?:public|private|protected|readonly|override|get|set)\\s+)*${escapeRe(name)}\\s*(?:<[^>]*>)?\\s*\\([^)]*\\)\\s*(?::\\s*[^{=;]+)?\\{)`);
  const i = linesOf(text).findIndex((l) => re.test(l) && !KEYWORD.test(l));
  return i < 0 ? 0 : i + 1;
}
function anchorsOf(r, src, texts) {
  const quoted = [...`${r.title} ${r.text}`.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim().replace(/^\.\//, ''));
  const plain = (`${r.title} ${r.text}`.match(/\b[\w-]+(?:\/[\w.-]+)+\.\w+\b/g) || []);
  const paths = [...new Set([...quoted, ...plain])].filter((p) => texts.has(p));
  // identifiers only: not a path, not a constant or a value (PENDING, PAYMENT_UNAVAILABLE), at least 4 characters
  const symbols = quoted.filter((q) => IDENT.test(q) && !q.includes('/') && !/^[A-Z0-9_]+$/.test(q) && q.replace(/\(\)$/, '').length >= 4 && !texts.has(q)).map((q) => q.replace(/\(\)$/, ''));
  let impl = null;
  for (const sym of symbols) {
    const parts = sym.split(/[.#]/), name = parts.at(-1), owner = parts.length > 1 ? parts[0] : null;
    // a method: in the file that defines its class; else the named file first, then any source file
    const homes = owner ? src.filter((f) => defLine(texts.get(f), owner)) : [];
    // the owner's file only, when the owner is found: a same-named method elsewhere (a simulator) is not it
    const order = homes.length ? homes : [...paths, ...src];
    const f = order.find((x) => texts.has(x) && defLine(texts.get(x), name));
    if (f) { impl = { path: f, line: defLine(texts.get(f), name), symbol: sym }; break; }
    if (homes.length === 1) { impl = { path: homes[0], line: defLine(texts.get(homes[0]), owner), symbol: sym }; break; }
  }
  if (!impl && paths.length === 1) {
    const lines = linesOf(texts.get(paths[0]));
    const i = lines.findIndex((l) => /^\s*(export\s+)?(async\s+)?(function|class|def|func)\b/.test(l));
    impl = { path: paths[0], line: i + 1 || 1, symbol: i >= 0 ? (/(?:function\*?|class|def|func)\s+(?:\([^)]*\)\s*)?([\w$]+)/.exec(lines[i]) || [])[1] || '' : '' };
  }
  return { paths, symbols, impl };
}

// Tests code links to a rule: those that carry its ID, and those that import its implementing (or named) file directly
// and, for a decision with a symbol, name that symbol.
function codeLinks(r, a, testIndex) {
  const out = [];
  const targets = new Set([...(a.impl ? [a.impl.path] : []), ...a.paths]);
  for (const t of testIndex.tests) {
    if (new RegExp(`\\b${escapeRe(r.id)}\\b`).test(t.text)) { out.push({ path: t.path, source: 'tag' }); continue; }
    if (targets.size && t.imports.some((i) => targets.has(i.resolved)) && (!a.impl || touchesImpl({ ...r, impl: a.impl }, t))) out.push({ path: t.path, source: 'code' });
  }
  return out;
}

async function traceRules(llm, rules, { root, files, testIndex }) {
  const src = files.filter((f) => CODE_EXT.some((e) => f.endsWith(e)) && !isTestFile(f) && !/\.config\.|\.d\.ts$/.test(f));
  const texts = new Map(src.map((f) => [f, readText(root, f) || '']));
  const search = bm25(src.map((f) => ({ path: f, toks: [...tokens(f), ...tokens(texts.get(f))] })));
  const testSearch = bm25(testIndex.tests.map((t) => ({ path: t.path, toks: [...tokens(t.path), ...t.cases.flatMap((c) => tokens(c.name))] })));
  for (const r of rules) {
    r._anchor = anchorsOf(r, src, texts);
    // the rule's own identifiers are search terms too (the model adds terms only when it answers)
    r.terms = [...new Map([...r.terms, ...r._anchor.symbols.map((x) => x.split(/[.#]/).at(-1))].map((t) => [t.toLowerCase(), t])).values()].slice(0, 8);
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
    // code's implementation (the rule named it) wins over the model's pick
    const a = r._anchor;
    r.impl = a.impl || (p ? { path: p.impl_path, line: p.impl_line, symbol: p.impl_symbol } : null);
    const byCode = codeLinks(r, a, testIndex);
    const tagged = byCode.filter((t) => t.source === 'tag');
    const named = files.filter((f) => r.text.includes(f));
    const votes = new Map();
    for (const x of ps) for (const t of new Set(x.tests || [])) votes.set(t, (votes.get(t) || 0) + 1);
    const linked = [...votes].filter(([t, n]) => {
      const tt = testIndex.tests.find((x) => x.path === t);
      if (!tt || n < need(ps.length) || tagged.some((x) => x.path === t)) return false;
      return tt.level === 'e2e' || !r.impl || reaches(tt, new Set([r.impl.path, ...named]), testIndex.srcImports) && touchesImpl(r, tt);
    }).map(([t]) => ({ path: t, source: c.tests.some((x) => x.path === t) ? 'name' : 'AI' }));
    // traced by the model, or by code when the rule is anchored (names its code, or a test names its ID); with neither,
    // its test links are unknown, not absent
    const anchored = !!a.impl || tagged.length > 0;
    r.traced = ps.length > 0 || anchored;
    r.tracedBy = ps.length > 0 ? (anchored ? 'model+code' : 'model') : anchored ? 'code' : null;
    // With the model's reply, a test is linked when it tests this behaviour (the model's call, voted) or names the rule's
    // ID (code). Without one, code links what it can prove: the ID, or a direct import of the rule's own code. A test
    // that only calls the code is not proof it tests this behaviour (a test that charges a card is not a test that
    // a second charge is refused), so the import links stand in only when the model is not there.
    r.links = ps.length ? [...tagged, ...linked.filter((l) => !tagged.some((x) => x.path === l.path))] : byCode;
    // "No test" without the model is a claim code makes, so code checks it (design constraint 4): a test that names the
    // rule's ID or its implementing symbol is a link, not an absence
    if (!r.links.length && r.traced && !ps.length) {
      const names = [r.id, ...(r.impl?.symbol ? [String(r.impl.symbol).split(/[.#]/).at(-1)] : []), ...a.symbols.map((x) => x.split(/[.#]/).at(-1))].filter((n) => n.length >= 5);
      for (const t of testIndex.tests) if (names.some((n) => new RegExp(`\\b${escapeRe(n)}\\b`).test(t.text))) r.links.push({ path: t.path, source: 'code' });
    }
    // Without the model, code reports what it can prove: the tests that carry the rule's ID (they say what they test),
    // or that no test touches the rule's code at all. A test that only imports or names the code exercises it, but
    // whether it asserts this rule is the model's call; until then the rule's test evidence is unknown, not good.
    if (!ps.length && !tagged.length && r.links.length) { r.traced = false; r.tracedBy = null; }
    r.searched = [...new Set([...r.terms, r.id])];
    delete r._code; delete r._anchor;
  }
}

module.exports = { traceRules, bm25, tokens, termRe, testCandidates, reaches, anchorsOf, codeLinks, defLine };
