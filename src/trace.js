'use strict';
// Stage 8a/8b: rule → implementing code, rule → tests.
// Code builds the candidates (BM25 over source files; tests that carry the rule ID or its search terms) and the
// model picks among them. Every pick is checked: the path must exist, the line must be in the file, a test must be in
// the test index. Tests that carry the rule ID (a tag) are always linked, whatever the model says.
const { readText, linesOf } = require('./util');
const { SOURCE_EXT, isTestFile } = require('./tests-index');
const { STYLE, obj, arr, str } = require('./judge');

const tokens = (s) => String(s).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || [];
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'shall', 'must', 'should', 'when', 'from', 'are', 'not', 'any', 'all', 'its', 'has', 'have', 'will', 'can', 'into', 'than', 'then', 'each', 'one', 'system', 'return', 'const', 'import', 'export', 'function', 'async', 'await', 'new']);

function bm25(docs) {
  const N = docs.length, df = new Map(), avg = docs.reduce((s, d) => s + d.toks.length, 0) / (N || 1);
  for (const d of docs) for (const t of new Set(d.toks)) df.set(t, (df.get(t) || 0) + 1);
  return (query) => {
    const q = [...new Set(tokens(query).filter((t) => !STOP.has(t)))];
    return docs.map((d) => {
      const tf = new Map(); for (const t of d.toks) tf.set(t, (tf.get(t) || 0) + 1);
      let s = 0;
      for (const t of q) { const f = tf.get(t); if (!f) continue; const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5)); s += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * d.toks.length / avg)); }
      return { path: d.path, score: s };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const termRe = (t) => new RegExp(escapeRe(t).replace(/\\ /g, '[\\s_-]*'), 'i');

function candidates(root, files, testIndex, rule) {
  return { code: rule._code || [], tests: testCandidates(testIndex, rule) };
}

function testCandidates(testIndex, rule) {
  const out = [];
  for (const t of testIndex.tests) {
    const tag = new RegExp(`\\b${escapeRe(rule.id)}\\b`).test(t.text);
    const hits = rule.terms.filter((term) => termRe(term).test(t.text));
    if (tag || hits.length) out.push({ path: t.path, tag, hits, level: t.level, cases: t.cases.length });
  }
  return out.sort((a, b) => (b.tag - a.tag) || b.hits.length - a.hits.length).slice(0, 10);
}

async function traceRules(llm, rules, { root, files, testIndex }) {
  const src = files.filter((f) => SOURCE_EXT.some((e) => f.endsWith(e)) && !isTestFile(f) && !/\.config\.|\.d\.ts$/.test(f));
  const texts = new Map(src.map((f) => [f, readText(root, f) || '']));
  const search = bm25(src.map((f) => ({ path: f, toks: [...tokens(f), ...tokens(texts.get(f))] })));
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
  const picks = (await Promise.all(batches.map((b, i) => llm.ask(`trace:${i}`, {
    system: STYLE,
    prompt: `For each rule, pick (1) where the code implements it: the file, the line of the function or statement that does it, and the symbol name, or null fields ("" and 0) if no candidate implements it; (2) which candidate test files test this rule's behaviour (not just the same module). Pick only from the candidates shown.\n\n${b.map((r) => {
      const c = candidates(root, files, testIndex, r);
      return `<rule id="${r.id}">${r.title}. ${r.text}\n<code-candidates>\n${c.code.map((x) => `${x.path}\n${x.lines.map((l) => `  ${l.n}: ${l.l.trim().slice(0, 160)}`).join('\n')}`).join('\n')}\n</code-candidates>\n<test-candidates>\n${c.tests.map((t) => `${t.path} (${t.level}, ${t.cases} cases; ${t.tag ? 'names the rule ID' : `contains ${t.hits.map((h) => `"${h}"`).join(', ')}`})\n${testIndex.tests.find((x) => x.path === t.path).cases.slice(0, 12).map((k) => `  ${k.line}: ${k.name}`).join('\n')}`).join('\n') || '(none)'}\n</test-candidates>\n</rule>`;
    }).join('\n')}`,
    schema: obj({ rules: arr(obj({ id: str, impl_path: str, impl_line: { type: 'integer' }, impl_symbol: str, tests: arr(str) })) }),
    maxTokens: 8000,
  })))).flatMap((o) => o?.rules || []);
  const testPaths = new Set(testIndex.tests.map((t) => t.path));
  for (const r of rules) {
    const p = picks.find((x) => x.id === r.id);
    const c = candidates(root, files, testIndex, r);
    const n = p && texts.has(p.impl_path) ? linesOf(texts.get(p.impl_path)).length : 0;
    r.impl = p && n && p.impl_line >= 1 && p.impl_line <= n ? { path: p.impl_path, line: p.impl_line, symbol: p.impl_symbol } : null;
    const tagged = c.tests.filter((t) => t.tag).map((t) => ({ path: t.path, source: 'tag' }));
    const named = (p?.tests || []).filter((t) => testPaths.has(t) && !tagged.some((x) => x.path === t)).map((t) => ({ path: t, source: c.tests.some((x) => x.path === t) ? 'name' : 'AI' }));
    r.traced = !!p; // no model reply for this rule: its test links are unknown, not absent
    r.links = [...tagged, ...named];
    r.searched = r.terms;
    delete r._code;
  }
}

module.exports = { traceRules, bm25, tokens, termRe, testCandidates };
