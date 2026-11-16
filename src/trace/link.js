'use strict';
// Stage 4a, trace: rule → tests, by code alone.
//   explicit   a test names the rule's ID (in its name, a comment, a tag). A fact; never needs the model.
//   candidate  a test shares enough of the rule's distinctive words. A lead, not a link: the model reads the
//              few nearest candidates and decides (trace/judge.js). Without a model it stays a lead.
// The candidate search is an inverted index over test-case words, so cost grows with the tests that mention a
// rule's words, not with rules × tests.
const { tokenize, uniq, ideaOf } = require('../util');

/** How many different things of the rule a test speaks of: its words, and its ideas not already counted by a word. */
function breadthOf(shared, inName = new Set(shared)) {
  const words = shared.filter((w) => !w.startsWith('='));
  const said = new Set(words.map(ideaOf).filter(Boolean));
  // what a test's name says counts in full; a word that only turns up somewhere in its body counts half
  const worth = (w) => (inName.has(w) ? 1 : 0.5);
  // an idea shared without a word shared is a hint, and counts as half of what a word would
  return words.reduce((n, w) => n + worth(w), 0) + shared.filter((w) => w.startsWith('=') && !said.has(w)).reduce((n, w) => n + worth(w) / 2, 0);
}

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

/**
 * Words that keep company with a word in this repository: "crowd" with "walker", "fare" with "wallet". Counted over
 * the test cases and the rules themselves, so the vocabulary is the project's own and costs nothing to learn.
 * A rule that says "walkers" then also reaches the check that says "the crowd keeps out of each other".
 */
function associates(index, units) {
  const memo = new Map();
  const byWord = new Map();
  units.forEach((u, i) => { for (const t of u) { if (!byWord.has(t)) byWord.set(t, []); byWord.get(t).push(i); } });
  const n = Math.max(1, units.length);
  return (t) => {
    if (memo.has(t)) return memo.get(t);
    const mine = byWord.get(t) || [];
    const out = [];
    if (mine.length >= 2 && mine.length <= n * 0.2) {
      const co = new Map();
      for (const i of mine.slice(0, 400)) for (const u of units[i]) if (u !== t && !/^\d/.test(u)) co.set(u, (co.get(u) || 0) + 1);
      for (const [u, c] of co) {
        const df = byWord.get(u).length;
        if (c < 2 || df > n * 0.2) continue;
        const strength = c / Math.sqrt(mine.length * df);
        if (strength >= 0.3) out.push({ w: u, strength });
      }
      out.sort((a, b) => b.strength - a.strength || (a.w < b.w ? -1 : 1));
    }
    memo.set(t, out.slice(0, 3));
    return memo.get(t);
  };
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
  const assoc = associates(index, [...tests.cases.map((c) => [...c.nt, ...c.bt]), ...rules.map((r) => uniq(tokenize(`${r.title} ${r.text}`)))]);
  const out = new Map();
  const k = config.trace.candidates, minOverlap = config.trace.min_overlap;
  for (const rule of rules) {
    const explicit = byId.get(rule.id) || [];
    const q = queryOf(rule, index);
    const allWords = uniq(tokenize(`${rule.title} ${rule.text}`));
    const total = q.reduce((s, x) => s + x.idf, 0) || 1;
    const scores = new Map(), shared = new Map(), extra = new Map(), named = new Map();
    if (!explicit.length) {
      // the rule's own words, then the words that keep company with them here, at a fraction of the weight
      const own = new Set(q.map((x) => x.w));
      /** @type {any[]} */
      const wide = [];
      for (const { w } of q) for (const a of assoc(w)) if (!own.has(a.w) && !wide.some((x) => x.w === a.w)) wide.push({ w: a.w, idf: index.idf(a.w) * 0.4 * Math.min(1, a.strength * 2), via: w });
      // the rule's commoner words are left out of the candidate test (they match too much to decide anything)
      // and still help order the wider circle: "walk" is common here, and it is what the rule is about
      const rest = allWords.filter((w) => !own.has(w) && !/^\d/.test(w)).map((w) => ({ w, idf: index.idf(w), via: 'rule' }));
      for (const { w, idf, via } of /** @type {any[]} */ ([...q, ...wide.slice(0, 8), ...rest])) {
        const seen = new Set();
        for (const p of index.postings.get(w) || []) {
          const ci = p >> 1, inName = p & 1;
          if (seen.has(ci)) continue;
          seen.add(ci);
          // Associated words never make a candidate: what is a candidate must not depend on what else is in the
          // suite. They only order the wider circle that the model's second reading is shown.
          if (via) { extra.set(ci, (extra.get(ci) || 0) + idf * (inName ? 1 : 0.7)); if (!scores.has(ci)) scores.set(ci, 0); continue; }
          scores.set(ci, (scores.get(ci) || 0) + idf * (inName ? 1 : 0.7));
          if (!shared.has(ci)) shared.set(ci, []);
          shared.get(ci).push(w);
          if (inName) { if (!named.has(ci)) named.set(ci, new Set()); named.get(ci).add(w); }
        }
      }
    }
    const scored = [...scores].map(([ci, s]) => {
      const c = tests.cases[ci];
      // a test in the rule's own package is the likelier proof; a small, bounded nudge
      const near = preferPkg && rule.pkg !== undefined && c.file.pkg === rule.pkg ? 1.1 : 1;
      const sh = shared.get(ci) || [];
      return { case: c, score: Math.min(1, (s / total) * near), shared: sh, breadth: breadthOf(sh, named.get(ci) || new Set()), reach: (s + (extra.get(ci) || 0)) / total };
      // A test that speaks of three things the rule speaks of is a better lead than one that shares its single rarest
      // word: "sends a message once" for "never the same message twice", before "can be stopped twice".
    }).sort((a, b) => b.breadth - a.breadth || b.score - a.score || (a.case.key < b.case.key ? -1 : 1));
    /** @type {any[]} */
    // a candidate: enough of the rule's distinctive words by weight, or three of them by count (three shared words
    // are a lead whatever their weight in this suite: "send", "message" and the idea of "once")
    let candidates = scored.filter((c) => (c.score >= minOverlap && c.breadth >= Math.min(2, q.length)) || c.breadth >= 3);
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
          // importing the file is a reason to look at a test, not a reason to look at all of its cases: in a file
          // of many, only the ones that also share words with the rule
          if ((casesBySource.get(src).length > 5 || c.script) && !(lexical && lexical.shared.length >= 2)) continue;
          byImport.push({ case: c, score: lexical ? lexical.score : 0, shared: lexical ? lexical.shared : [w], via: src });
        }
      }
      byImport.sort((a, b) => b.score - a.score || (a.case.key < b.case.key ? -1 : 1));
      // found by structure, not by wording: these replace "weak" candidates, and join real ones
      if (byImport.length) candidates = [...candidates.filter((c) => !c.weak), ...byImport.slice(0, 2)];
    }
    // How many candidates to show is a budget of lines, not a count: a test of thirty lines is one candidate, and a
    // one-line check that says what it checks costs a thirtieth of that, so a dozen of them fit where one test
    // did. More candidates at the same price is how the right one gets seen, and a wrong "no test" avoided.
    // Of ordinary tests, at most two per file: five near-identical cases of one table tell the model nothing new.
    const perFile = new Map();
    let lines = 0;
    const budget = config.trace.excerpt_lines || 30;
    candidates = candidates.filter((c) => {
      const size = Math.min(budget, Math.max(1, (c.case.end || c.case.line || 1) - (c.case.line || 1) + 1));
      const small = size <= 3;
      const n = (perFile.get(c.case.file.path) || 0) + 1;
      if (!small && n > 2) return false;
      if (lines && lines + size > budget * k / 2) return false;
      perFile.set(c.case.file.path, n); lines += size;
      return true;
    }).slice(0, k * 3);
    // The next nearest, beyond the budget: named, not shown. When the first reading finds no proof, the second one
    // is given these as well, so a "no test" is said only after a wider look (trace/judge.js).
    const taken = new Set(candidates.map((c) => c.case));
    const ranked = explicit.length ? [] : scored.filter((c) => !taken.has(c.case) && !c.case.whole).sort((a, b) => b.breadth - a.breadth || b.reach - a.reach || (a.case.key < b.case.key ? -1 : 1));
    // the wider circle is a budget of lines too: two dozen one-line checks, or a handful of ordinary tests
    let room = 20;
    const wider = ranked.filter((c) => { const size = Math.min(5, Math.max(1, (c.case.end || 1) - (c.case.line || 1) + 1)); if (room < size) return false; room -= size; return true; }).slice(0, 20);
    out.set(rule.id, { explicit, candidates, wider, terms: q.map((x) => x.w) });
  }
  return out;
}

module.exports = { linkRules, buildIndex, queryOf };
