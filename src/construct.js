'use strict';
// Traceability by construction. The trace stage asks the model, on every run, which test covers which rule; that is the
// least precise step of the pipeline. This module turns the model's answers into facts in the repository, so the next
// run does not need to ask:
//
//   tags      a link the model gave unanimously and code verified (the test reaches the implementation through its
//             imports) becomes a comment naming the rule ID above the test case. Once merged, the link is a tag:
//             code finds it, every run, with no model (basis S instead of V/M). The model's share of the work shrinks
//             with every accepted suggestion. Only rules whose ID is in the source document (a numbered ID moves when
//             a rule is inserted above it).
//   pending   a rule with no test gets a pending test named after it (it.todo / pytest skip / t.Skip), with its
//             boundary cases spelled out. Once merged, the "No test" finding becomes "Not skipped" on a tagged test:
//             the implementation pull request turns it green. Test-first, enforced by the gate.
//   boundary  a rule's stated limits → the on-and-past-the-edge cases (ISO/IEC/IEEE 29119-4) with the expected result
//             where the text says which side is allowed ("from $500 to $5,000": 499.99 rejected, 500 accepted, ...).
//             Code only, no model: a suggested table for a "Covers stated limits" finding.
//
// Output is a patch (git apply) and the files themselves; nothing is written into the repository unless asked.
const path = require('node:path');
const { readText, linesOf } = require('./util');
const { quantities } = require('./judge');
const { relevantCases } = require('./evidence');

const MONEY = /^(\$|€|£|¥|usd|eur|gbp|aud|cents?)$/i;
const LANG = (f) => (/\.py$/.test(f) ? 'py' : /\.go$/.test(f) ? 'go' : /\.[cm]?[jt]sx?$/.test(f) ? 'js' : null);
const round = (x) => Math.round(x * 100) / 100;

/** The rule's boundary cases: [{ value, expect: true|false|null, why }]. */
function boundaryCases(r) {
  if (!r.limits?.length) return [];
  const qs = quantities(`${r.title}. ${r.text}`);
  const out = [];
  for (const l of r.limits) {
    const step = MONEY.test(l.unit || '') || l.unit === '%' || qs.some((q) => q.value === l.value && /[$€£¥]/.test(q.unit)) || !Number.isInteger(l.value) ? 0.01 : 1;
    // the same number can appear twice ("Excess $500 to $5,000. ... from $500 to $5,000"): a floor or cap reading wins
    const q = qs.find((x) => x.value === l.value && x.role !== 'exact') || qs.find((x) => x.value === l.value);
    let role = q?.role || 'exact';
    // a range ("from $500 to $5,000") whose sentence also says anything else is rejected
    if (role === 'exact' && qs.some((x) => x.role === 'floor') && qs.some((x) => x.role === 'cap')) role = l.value === Math.min(...qs.map((x) => x.value)) ? 'floor' : 'cap';
    if (role === 'floor') out.push({ value: round(l.value - step), expect: false, why: `under the minimum ${l.value}` }, { value: l.value, expect: true, why: 'the minimum itself' });
    else if (role === 'cap') out.push({ value: l.value, expect: true, why: 'the maximum itself' }, { value: round(l.value + step), expect: false, why: `over the maximum ${l.value}` });
    else out.push({ value: round(l.value - step), expect: null, why: `just under ${l.value}` }, { value: l.value, expect: null, why: `on ${l.value}` }, { value: round(l.value + step), expect: null, why: `just over ${l.value}` });
  }
  return out.filter((c, k) => out.findIndex((x) => x.value === c.value) === k);
}

const ident = (s) => String(s).split(/[.#:]/).pop();

/** A test table for the boundary cases, in the test language of the repository, calling the seam if there is one. */
function boundarySnippet(r, lang) {
  const cases = boundaryCases(r);
  if (!cases.length) return null;
  const fn = ident(r.placement?.seam?.symbol || r.impl?.symbol || 'subject');
  const exp = (c) => (c.expect === null ? `undefined /* ${c.why}: the documents do not say */` : String(c.expect));
  if (lang === 'py') return [`@pytest.mark.parametrize("value, ok", [`, ...cases.map((c) => `    (${c.value}, ${c.expect === null ? 'None' : c.expect ? 'True' : 'False'}),  # ${c.why}`), `])`, `def test_${r.id.toLowerCase().replace(/\W/g, '_')}_boundaries(value, ok):  # ${r.id}`, `    assert ${fn}(value) == ok  # adjust the call to the function's signature`].join('\n');
  if (lang === 'go') return [`// ${r.id}: boundary cases`, `for _, c := range []struct{ v float64; ok bool }{`, ...cases.map((c) => `\t{${c.value}, ${c.expect === null ? 'false /* not stated */' : c.expect}}, // ${c.why}`), `} {`, `\tif got := ${fn}(c.v); got != c.ok { t.Errorf("${fn}(%v) = %v, want %v", c.v, got, c.ok) }`, `}`].join('\n');
  return [`// ${r.id}: boundary cases from ${r.path}:${r.line}`, `it.each([`, ...cases.map((c) => `  [${c.value}, ${exp(c)}], // ${c.why}`), `])('${r.id} ${r.title.replace(/'/g, '')}: %s', (value, ok) => {`, `  expect(${fn}(value)).toBe(ok); // adjust the call to the function's signature`, `});`].join('\n');
}

// ---- tags --------------------------------------------------------------------------------------------------------
function tagSuggestions(rules, testIndex) {
  const out = [];
  for (const r of rules) {
    if (!r.hasSourceId) continue;
    // a test that does not reach the implementation is not cemented as this rule's test
    if ((r.evidence?.fails || []).some((f) => f.check === 'Calls the code')) continue;
    for (const l of r.links || []) {
      if (l.source === 'tag' || l.source === 'test doc') continue;
      const v = r.linkVotes?.[l.path];
      if (!v || v.votes < v.of || v.of < 1) continue; // unanimous only
      const t = testIndex.tests.find((x) => x.path === l.path);
      if (!t || new RegExp(`\\b${r.id}\\b`).test(t.text)) continue;
      const rel = relevantCases(t, r);
      const c = rel === t.cases ? t.cases[0] : rel[0];
      if (!c) continue;
      out.push({ rule: r.id, path: t.path, line: c.line, case: c.name });
    }
  }
  return out;
}

// One hunk per file covering every insertion, with three lines of context: valid for `git apply`.
function insertionPatch(file, oldText, inserts) {
  const lines = linesOf(oldText);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const sorted = [...inserts].sort((a, b) => a.line - b.line);
  const from = Math.max(1, sorted[0].line - 3), to = Math.min(lines.length, sorted[sorted.length - 1].line + 2);
  const body = [];
  let added = 0;
  for (let n = from; n <= to; n++) {
    for (const ins of sorted.filter((x) => x.line === n)) { body.push(`+${ins.text}`); added++; }
    body.push(` ${lines[n - 1]}`);
  }
  const oldLen = to - from + 1;
  return [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, `@@ -${from},${oldLen} +${from},${oldLen + added} @@`, ...body].join('\n');
}
const newFilePatch = (file, text) => { const ls = linesOf(text.replace(/\n$/, '')); return [`diff --git a/${file} b/${file}`, 'new file mode 100644', '--- /dev/null', `+++ b/${file}`, `@@ -0,0 +1,${ls.length} @@`, ...ls.map((l) => `+${l}`)].join('\n'); };

// ---- pending tests -----------------------------------------------------------------------------------------------
// The test language and folder the repository already uses most; the file sits next to its other tests.
function testHome(testIndex) {
  const count = new Map();
  for (const t of testIndex.tests.filter((x) => x.level === 'unit')) { const k = `${LANG(t.path)}|${path.posix.dirname(t.path)}`; count.set(k, (count.get(k) || 0) + 1); }
  const best = [...count].sort((a, b) => b[1] - a[1])[0];
  if (!best) return null;
  const [lang, dir] = best[0].split('|');
  const sample = testIndex.tests.find((t) => LANG(t.path) === lang && path.posix.dirname(t.path) === dir);
  const ext = lang === 'js' ? (sample.path.match(/\.(test|spec)\.([cm]?[jt]sx?)$/)?.[2] || 'ts') : lang;
  const goPkg = lang === 'go' ? (/^\s*package\s+(\w+)/m.exec(sample.text)?.[1] || 'main') : null;
  const vitest = lang === 'js' && /from ['"]vitest['"]/.test(sample.text);
  return { lang, dir, ext, goPkg, vitest };
}

function pendingFile(rules, home) {
  const name = (r) => `${r.id} ${r.title}`.replace(/['"`\\]/g, '');
  if (home.lang === 'py') return { path: `${home.dir}/test_spec_pending.py`, text: ['# Pending tests generated from the requirement and design documents (ai-quality-gate).', '# Each names its rule; the pull request that implements the rule replaces the skip with the test.', 'import pytest', '', ...rules.flatMap((r) => [`@pytest.mark.skip(reason="pending: ${name(r)}")`, `def test_${r.id.toLowerCase().replace(/\W/g, '_')}_pending():  # ${r.id} (${r.path}:${r.line})`, ...boundaryCases(r).map((c) => `    # ${c.value}: ${c.expect === null ? 'expected result not stated' : c.expect ? 'accepted' : 'rejected'} (${c.why})`), '    pass', ''])].join('\n') };
  if (home.lang === 'go') return { path: `${home.dir}/spec_pending_test.go`, text: [`package ${home.goPkg}`, '', '// Pending tests generated from the requirement and design documents (ai-quality-gate).', 'import "testing"', '', ...rules.flatMap((r) => [`// ${r.id} (${r.path}:${r.line})`, `func Test${r.id.replace(/\W/g, '')}Pending(t *testing.T) {`, ...boundaryCases(r).map((c) => `\t// ${c.value}: ${c.expect === null ? 'expected result not stated' : c.expect ? 'accepted' : 'rejected'} (${c.why})`), `\tt.Skip("pending: ${name(r)}")`, '}', ''])].join('\n') };
  return { path: `${home.dir}/spec-pending.test.${home.ext}`, text: ['// Pending tests generated from the requirement and design documents (ai-quality-gate).', '// Each names its rule; the pull request that implements the rule turns its todo into a test.', ...(home.vitest ? ["import { describe, it } from 'vitest';"] : []), '', "describe('pending rules', () => {", ...rules.flatMap((r) => { const cs = boundaryCases(r); return cs.length ? cs.map((c) => `  it.todo('${name(r)}: ${c.value} ${c.expect === null ? '(expected result not stated)' : c.expect ? 'is accepted' : 'is rejected'}');`) : [`  it.todo('${name(r)}');`]; }), '});', ''].join('\n') };
}

/**
 * → { tags: [...], pending: { path, text, rules } | null, patch: string }
 *   diff (optional): only rules whose document line the change adds get pending tests (the spec pull request)
 */
function construct(rules, { root, testIndex, diff = null }) {
  const tags = tagSuggestions(rules, testIndex);
  const home = testHome(testIndex);
  const isNew = (r) => !diff || diff.get(r.path)?.hunks.some((h) => h.added.some((a) => a.line === r.line));
  const untested = rules.filter((r) => r.hasSourceId && r.traced !== false && !(r.links || []).length && (r.critical || diff) && isNew(r) && (r.kind === 'requirement' || r.addsBehaviour));
  const pending = home && untested.length ? { ...pendingFile(untested, home), rules: untested.map((r) => r.id) } : null;
  const patches = [];
  const byFile = new Map();
  for (const t of tags) {
    const lines = linesOf(readText(root, t.path) || '');
    const ind = /^\s*/.exec(lines[t.line - 1] || '')[0];
    const text = `${ind}${LANG(t.path) === 'py' ? '#' : '//'} covers ${t.rule}`;
    (byFile.get(t.path) || byFile.set(t.path, []).get(t.path)).push({ line: t.line, text });
  }
  for (const [f, ins] of byFile) patches.push(insertionPatch(f, readText(root, f) || '', ins));
  if (pending && !readText(root, pending.path)) patches.push(newFilePatch(pending.path, pending.text));
  return { tags, pending, patch: patches.length ? patches.join('\n') + '\n' : '' };
}

module.exports = { construct, boundaryCases, boundarySnippet, tagSuggestions, testHome, insertionPatch, LANG };
