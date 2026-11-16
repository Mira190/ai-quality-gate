'use strict';
// Stage 4a, trace: rule → tests, by code alone.
//   explicit   a test names the rule's ID (in its name, a comment, a tag). A fact; never needs the model.
//   candidate  a test shares enough of the rule's distinctive words. A lead, not a link: the model reads the
//              few nearest candidates and decides (trace/judge.js). Without a model it stays a lead.
// The candidate search is an inverted index over test-case words, so cost grows with the tests that mention a
// rule's words, not with rules × tests.
const { tokenize, uniq } = require('../util');

function buildIndex(cases) {
  const postings = new Map(); // token → [caseIndex, inName]
  cases.forEach((c, i) => {
    for (const t of c.nt) { if (!postings.has(t)) postings.set(t, []); postings.get(t).push(i * 2 + 1); }
    for (const t of c.bt) { if (!postings.has(t)) postings.set(t, []); postings.get(t).push(i * 2); }
  });
  const n = Math.max(1, cases.length);
  const idf = (t) => { const df = postings.get(t)?.length || 0; return Math.log(1 + (n - df + 0.5) / (df + 0.5)); };
  return { postings, idf, n };
}

/** The words that identify a rule: its 10 rarest across the test suite, with its limits always included. */
function queryOf(rule, index) {
  const limitWords = rule.limits.map((l) => l.value);
  const words = uniq([...tokenize(`${rule.title} ${rule.text}`), ...limitWords]).filter((w) => !/^\d+(\.\d+)?$/.test(w) || limitWords.includes(w));
  const weighted = words.map((w) => ({ w, idf: index.idf(w) })).sort((a, b) => b.idf - a.idf || (a.w < b.w ? -1 : 1));
  return weighted.slice(0, 10);
}

/**
 * Returns Map<ruleId, {explicit: case[], candidates: [{case, score, shared}], terms: string[]}>.
 */
function linkRules(rules, tests, config, { preferPkg = true } = {}) {
  const index = buildIndex(tests.cases);
  const byId = new Map();
  for (const c of tests.cases) for (const id of c.ids) { if (!byId.has(id)) byId.set(id, []); byId.get(id).push(c); }
  // A second way to a rule's tests, for when a test does not use the rule's words: the rule's words name a source
  // file ("discount" → src/discount.ts), and tests import that file. Paths only; no source file is read.
  const casesBySource = new Map(), sourcesByWord = new Map();
  for (const f of tests.files || []) for (const src of f.imports || []) {
    if (!casesBySource.has(src)) {
      casesBySource.set(src, []);
      for (const w of new Set(tokenize(src.slice(src.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '')))) { if (!sourcesByWord.has(w)) sourcesByWord.set(w, new Set()); sourcesByWord.get(w).add(src); }
    }
    casesBySource.get(src).push(...f.cases);
  }
  const out = new Map();
  const k = config.trace.candidates, minOverlap = config.trace.min_overlap;
  for (const rule of rules) {
    const explicit = byId.get(rule.id) || [];
    const q = queryOf(rule, index);
    const allWords = uniq(tokenize(`${rule.title} ${rule.text}`));
    const total = q.reduce((s, x) => s + x.idf, 0) || 1;
    const scores = new Map(), shared = new Map();
    if (!explicit.length) {
      for (const { w, idf } of q) {
        const seen = new Set();
        for (const p of index.postings.get(w) || []) {
          const ci = p >> 1, inName = p & 1;
          if (seen.has(ci)) continue;
          seen.add(ci);
          scores.set(ci, (scores.get(ci) || 0) + idf * (inName ? 1 : 0.7));
          if (!shared.has(ci)) shared.set(ci, []);
          shared.get(ci).push(w);
        }
      }
    }
    const scored = [...scores].map(([ci, s]) => {
      const c = tests.cases[ci];
      // a test in the rule's own package is the likelier proof; a small, bounded nudge
      const near = preferPkg && rule.pkg !== undefined && c.file.pkg === rule.pkg ? 1.1 : 1;
      return { case: c, score: Math.min(1, (s / total) * near), shared: shared.get(ci) };
    }).sort((a, b) => b.score - a.score || (a.case.key < b.case.key ? -1 : 1));
    /** @type {any[]} */
    let candidates = scored.filter((c) => c.score >= minOverlap && c.shared.length >= Math.min(2, q.length));
    // "No test" on a critical rule is the most expensive thing to get wrong. Before saying it, show the two nearest
    // tests to whoever judges (the model, or a person reading "unverified"), if they share at least two of the rule's
    // words. That count does not depend on the rest of the suite: adding an unrelated test cannot move a rule
    // between "no test" and "unverified".
    if (!candidates.length && rule.critical) {
      const all = new Set(allWords);
      const overlap = (c) => { let n = 0; for (const t of c.case.nt) if (all.has(t)) n++; for (const t of c.case.bt) if (all.has(t)) n++; return n; };
      candidates = scored.filter((c) => overlap(c) >= 2).slice(0, 2).map((c) => ({ ...c, weak: true }));
    }
    if (!explicit.length && candidates.length < k) {
      const have = new Set(candidates.map((c) => c.case));
      const byImport = [];
      for (const w of allWords) {
        const srcs = sourcesByWord.get(w);
        if (!srcs || srcs.size > 3 || /^\d/.test(w)) continue; // a word that names many files names none
        for (const src of [...srcs].sort()) for (const c of casesBySource.get(src)) {
          if (have.has(c)) continue;
          have.add(c);
          const lexical = scored.find((s) => s.case === c);
          byImport.push({ case: c, score: lexical ? lexical.score : 0, shared: lexical ? lexical.shared : [w], via: src });
        }
      }
      byImport.sort((a, b) => b.score - a.score || (a.case.key < b.case.key ? -1 : 1));
      // found by structure, not by wording: these replace "weak" candidates, and join real ones
      if (byImport.length) candidates = [...candidates.filter((c) => !c.weak), ...byImport.slice(0, 2)];
    }
    // at most two candidates per file: five near-identical cases of one table tell the model nothing new
    const perFile = new Map();
    candidates = candidates.filter((c) => { const n = (perFile.get(c.case.file.path) || 0) + 1; perFile.set(c.case.file.path, n); return n <= 2; }).slice(0, k);
    out.set(rule.id, { explicit, candidates, terms: q.map((x) => x.w) });
  }
  return out;
}

module.exports = { linkRules, buildIndex, queryOf };
