'use strict';
// Stage 8c: the test evidence standard (sections 3 and 4). Every check is code except two, which the model judges and
// code verifies: "Asserts the rule" (must cite an assertion line of a linked test) and "Suspected not built" (must cite
// a line of the implementing file; only for critical decisions that add behaviour).
// The first failing check sets the level: None → Blocked → Weak → Checked nightly → meets the standard.
const { readText, linesOf, numbersIn, need } = require('./util');
const { STYLE, obj, arr, str } = require('./judge');
const { termRe } = require('./trace');
const { isTestFile, CODE_EXT } = require('./tests-index');

const CHECK_ORDER = ['Suspected not built', 'No test', 'Not skipped', 'Calls the code', 'Asserts the rule', 'Covers stated limits', 'Crosses the real boundary', 'Placement', 'Runs on PR'];
const WEAK = new Set(['Suspected not built', 'Not skipped', 'Calls the code', 'Asserts the rule', 'Covers stated limits', 'Crosses the real boundary']);
const PURE = new Set(['calculation', 'date', 'count', 'validation']);
const LEVELS = ['unit', 'component', 'integration', 'e2e'];

// Shift left: the lowest test level that can observe the rule (the test pyramid). Code decides first, from what it can
// read: the units of the verified limits (money, percent and dates are arithmetic), counting words with a number
// ("a retry limit" set in config), and whether the implementing function does any I/O. The model's logic kind fills
// the rest. Pure logic belongs in a unit test; an access check or an outside call in a component test (a route with
// its middleware, the real adapter against a fake server), so only an e2e-only rule of those kinds is flagged.
const MONEY_OR_DATE = /^(%|\$|€|£|¥|usd|eur|gbp|aud|cents?|percent|days?|weeks?|months?|years?|hours?)$/i;
const COUNTING = /\b(retr(y|ies|ied)|attempts?|times|at most|up to|maximum|max|limits?|no more than)\b/i;
const IO = /\bawait\b|\bfetch\(|\baxios\b|\bhttps?\.|\.query\(|\.execute\(|\bfs\.|readFile|writeFile|\.save\(|\.send\(|\brequests\.|\bopen\(|subprocess|\bsocket\b|\bdb\.|\bthis\.(db|client|http|repo)\b|\bctx\.|\breq\.|\bres\./;

function implBody(root, impl) {
  const lines = linesOf(readText(root, impl.path) || ''), from = impl.line - 1;
  if (!lines[from]) return null;
  if (/\.py$/.test(impl.path)) {
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

function belongsAt(r, root) {
  if (PURE.has(r.logicKind)) return { level: 'unit', by: `${r.logicKind} rule` };
  if (r.limits.some((l) => MONEY_OR_DATE.test(l.unit || ''))) return { level: 'unit', by: 'its limits are amounts or dates' };
  if (r.limits.length && COUNTING.test(`${r.title} ${r.text}`)) return { level: 'unit', by: 'it counts to a stated limit' };
  const body = r.impl && root ? implBody(root, r.impl) : null;
  if (body && !IO.test(body) && /\b(function|def|func|=>)\b|=>/.test(body) && !/\b(class|router|app)\b/.test(body.split('\n')[0])) return { level: 'unit', by: `\`${r.impl.symbol}\` does no I/O` };
  if (r.logicKind === 'access' || r.logicKind === 'io') return { level: 'component', by: `${r.logicKind === 'io' ? 'outside call' : 'access check'}` };
  return null;
}

function relevantCases(t, rule) {
  const rel = t.cases.filter((c) => rule.terms.some((term) => termRe(term).test(c.body)) || new RegExp(`\\b${rule.id}\\b`).test(c.body));
  return rel.length ? rel : t.cases;
}

async function judgeAsserts(llm, rules, testIndex) {
  const subjects = rules.filter((r) => r.links.length);
  const batches = [];
  for (let i = 0; i < subjects.length; i += 10) batches.push(subjects.slice(i, i + 10));
  const out = (await Promise.all(batches.map((b, i) => llm.votes(`asserts:${i}`, {
    system: STYLE,
    prompt: `For each rule, decide whether any of its tests has an assertion that compares the rule's result or state to an expected value. "Was called", "does not throw", a snapshot, or an assertion about a different behaviour does not count. Cite the assertion line that proves it; if none does, cite the assertion line that comes closest and say in "what" what it checks instead.\n\n${b.map((r) => `<rule id="${r.id}">${r.title}. ${r.text}\n${r.links.map((l) => {
      const t = testIndex.tests.find((x) => x.path === l.path);
      const cases = relevantCases(t, r);
      const lines = new Set(cases.flatMap((c) => t.asserts.filter((a) => a.line >= c.line && a.line <= c.end).map((a) => a.line)));
      return `<test path="${t.path}">\n${cases.slice(0, 15).map((c) => `  case ${c.line}: ${c.name}${c.skipped ? ' (skipped)' : ''}`).join('\n')}\n${t.asserts.filter((a) => lines.has(a.line)).slice(0, 25).map((a) => `  ${a.line}: ${a.text.slice(0, 200)}`).join('\n')}\n</test>`;
    }).join('\n')}\n</rule>`).join('\n')}`,
    // reasoning fields before the verdict: the model writes what the line checks, then decides
    schema: obj({ rules: arr(obj({ id: str, cite_path: str, cite_line: { type: 'integer' }, what: str, asserts: { type: 'boolean' } })) }),
    maxTokens: 6000,
  })))).flat().flatMap((o) => o?.rules || []);
  const map = new Map();
  for (const r of subjects) {
    const vs = out.filter((x) => x.id === r.id);
    if (!vs.length) continue;
    // the citation must be an assertion line of a linked test; a reply that fails this does not count
    const ok = vs.filter((v) => testIndex.tests.find((x) => x.path === v.cite_path && r.links.some((l) => l.path === x.path))?.asserts.some((a) => a.line === v.cite_line));
    // "does not assert" only when most replies say so with a valid citation; otherwise the check passes as unknown
    const no = ok.filter((v) => !v.asserts);
    const v = no.length >= need(vs.length) ? no[0] : ok.find((x) => x.asserts);
    if (!v) { map.set(r.id, { dropped: true }); continue; }
    map.set(r.id, { asserts: v.asserts, path: v.cite_path, line: v.cite_line, what: v.what });
  }
  return map;
}

// Lines in other source files that use the implementing symbol: a decision such as "admin routes check the role" is
// often broken where the function is wired up (a route that mounts only the login check), not where it is defined.
function callSites(root, files, r, max = 8) {
  const sym = String(r.impl.symbol || '').split(/[.#:]/).filter((s) => s.length >= 4).pop();
  if (!sym) return [];
  const re = new RegExp(`\\b${sym.replace(/[$]/g, '\\$')}\\b`), out = [];
  for (const f of files) {
    if (f === r.impl.path || !CODE_EXT.some((e) => f.endsWith(e)) || isTestFile(f)) continue;
    linesOf(readText(root, f) || '').forEach((l, i) => { if (out.length < max && re.test(l) && !/^\s*import\b/.test(l)) out.push({ path: f, line: i + 1, text: l.trim().slice(0, 200) }); });
  }
  return out;
}

async function judgeBuilt(llm, rules, root, files = []) {
  const subjects = rules.filter((r) => r.kind === 'decision' && r.addsBehaviour && r.critical && r.impl);
  if (!subjects.length) return new Map();
  for (const r of subjects) r._uses = callSites(root, files, r);
  const outs = await llm.votes('built:0', {
    system: STYLE,
    prompt: `For each design decision, read the code that implements it and say whether the code does what the decision says. Answer "not_built" only when a specific line shows the behaviour is missing or different (for example a call with no timeout, a route that checks login but not the role); cite that line. Answer "built" when it does, citing the line that does it. The <used-at> lines show where other files use the implementing function; a decision can be broken there (a route that mounts the login check but no role check), so cite such a line when it is the one. Answer "unsure" when the code shown cannot tell. Write "why" first, then a verdict that agrees with it: a why that says the behaviour is there is "built".\n\n${subjects.map((r) => {
      const lines = linesOf(readText(root, r.impl.path) || '');
      const from = Math.max(1, r.impl.line - 25), to = Math.min(lines.length, r.impl.line + 45);
      const uses = r._uses.length ? `\n<used-at>\n${r._uses.map((u) => `${u.path}:${u.line}: ${u.text}`).join('\n')}\n</used-at>` : '';
      return `<decision id="${r.id}">${r.title}. ${r.text}\n<code path="${r.impl.path}">\n${lines.slice(from - 1, to).map((l, i) => `${from + i}: ${l}`).join('\n')}\n</code>${uses}\n</decision>`;
    }).join('\n')}`,
    schema: obj({ decisions: arr(obj({ id: str, path: str, line: { type: 'integer' }, why: str, verdict: { type: 'string', enum: ['built', 'not_built', 'unsure'] } })) }),
    maxTokens: 6000,
  });
  const map = new Map();
  for (const r of subjects) {
    const vs = outs.flatMap((o) => o?.decisions || []).filter((v) => v.id === r.id);
    if (!vs.length) continue;
    // "not built" is a P0 claim: it needs a cited line shown to the model, in most replies
    const shownPaths = new Set([r.impl.path, ...r._uses.map((u) => u.path)]);
    const cited = vs.filter((v) => v.verdict === 'not_built' && shownPaths.has(v.path) && linesOf(readText(root, v.path) || '')[v.line - 1]?.trim());
    if (cited.length >= need(vs.length)) { const v = cited[0]; map.set(r.id, { verdict: v.verdict, path: v.path, line: v.line, why: v.why }); continue; }
    if (vs.some((v) => v.verdict === 'not_built')) { map.set(r.id, { dropped: true }); continue; }
    const v = vs[0];
    map.set(r.id, { verdict: v.verdict, path: v.path, line: v.line, why: v.why });
  }
  return map;
}

function variants(limit) {
  const v = limit.value, u = (limit.unit || '').toLowerCase();
  const scales = /^(s|sec|secs|second|seconds)$/.test(u) ? [1, 1000] : /^(min|mins|minute|minutes)$/.test(u) ? [1, 60, 60000] : [1];
  return scales.map((k) => ({ on: v * k, past: [v * k + 1, v * k - 1, Math.round((v * k + 0.01) * 100) / 100, Math.round((v * k - 0.01) * 100) / 100] }));
}

function evaluate(rules, { testIndex, ci, srcImports, asserts, built, root }) {
  const byPath = new Map(testIndex.tests.map((t) => [t.path, t]));
  for (const r of rules) {
    const fails = [], tests = r.links.map((l) => byPath.get(l.path));
    const b = built.get(r.id);
    if (b?.verdict === 'not_built') fails.push({ check: 'Suspected not built', facts: { path: b.path, line: b.line, why: b.why } });
    if (!tests.length) {
      fails.push({ check: 'No test', facts: { searched: r.searched, impl: r.impl } });
      r.evidence = { fails, level: 'None', tests: [] };
      continue;
    }
    // Not skipped
    const skips = tests.flatMap((t) => { const rel = relevantCases(t, r); return rel.every((c) => c.skipped) ? rel.map((c) => ({ path: t.path, line: c.line, name: c.name })) : []; });
    if (skips.length && tests.every((t) => relevantCases(t, r).every((c) => c.skipped))) fails.push({ check: 'Not skipped', facts: { skipped: skips } });
    // Calls the code (end-to-end tests drive the real app, so they pass by construction)
    const nonE2e = tests.filter((t) => t.level !== 'e2e');
    const reaches = (t) => t.imports.some((i) => i.resolved && (i.resolved === r.impl.path || (srcImports.get(i.resolved) || []).includes(r.impl.path)));
    let calls = true;
    if (r.impl && nonE2e.length && !nonE2e.some(reaches)) {
      calls = false;
      fails.push({ check: 'Calls the code', facts: { impl: r.impl, imports: nonE2e.map((t) => ({ path: t.path, imports: t.imports.filter((i) => i.resolved).map((i) => ({ line: i.line, text: i.text })) })) } });
    }
    // Asserts the rule (AI, cited)
    const a = asserts.get(r.id);
    if (a && !a.dropped && !a.asserts) fails.push({ check: 'Asserts the rule', ai: true, facts: { path: a.path, line: a.line, what: a.what } });
    // Covers stated limits (boundary values, ISO/IEC/IEEE 29119-4)
    if (r.limits.length) {
      const nums = new Set(tests.flatMap((t) => [...numbersIn(t.text)]));
      const missing = r.limits.filter((l) => !variants(l).some((x) => nums.has(x.on) && x.past.some((p) => nums.has(p))));
      if (missing.length) {
        const inputs = tests.map((t) => ({ path: t.path, cases: t.cases.length, level: t.level, numbers: relevantCases(t, r).flatMap((c) => linesOf(c.body).map((l, i) => ({ line: c.line + i, l })).filter((x) => /\d/.test(x.l) && !/^\s*(it|test)\b/.test(x.l))).slice(0, 6).map((x) => ({ line: x.line, text: x.l.trim().slice(0, 120) })) }));
        fails.push({ check: 'Covers stated limits', facts: { missing, limits: r.limits, tests: inputs } });
      }
    }
    // Crosses the real boundary (design decisions about an outside call): the real adapter must run against a fake server
    if (r.kind === 'decision' && r.boundary === 'outside_call' && calls && r.impl) {
      const mocked = nonE2e.flatMap((t) => t.mocks.filter((m) => m.resolved === r.impl.path).map((m) => ({ path: t.path, line: m.line })));
      if (mocked.length && !tests.some((t) => t.fakeServer)) fails.push({ check: 'Crosses the real boundary', facts: { mocked } });
    }
    // Where the tests run
    const runs = tests.map((t) => ({ path: t.path, level: t.level, ...ci.runs.get(t.path), dbImport: t.imports.find((i) => /['"](pg|mysql2?|mongodb|mongoose|redis|knex|@prisma\/client|typeorm|sequelize)['"]/.test(i.text)) }));
    const onPr = runs.some((x) => x.pr.length);
    const want = belongsAt(r, root);
    const lowest = Math.min(...tests.map((t) => LEVELS.indexOf(t.level)));
    const placement = want && (want.level === 'unit' ? lowest > 0 : lowest === 3);
    if (placement) fails.push({ check: 'Placement', facts: { logicKind: r.logicKind, belongsAt: want.level, because: want.by, runs } });
    else if (!onPr) fails.push({ check: 'Runs on PR', facts: { runs } });
    const level = r.status === 'Blocked' ? 'Blocked' : fails.some((f) => WEAK.has(f.check)) ? 'Weak' : !onPr ? 'Checked nightly' : 'Meets';
    r.evidence = { fails, level, tests: runs, onPr };
  }
  for (const r of rules) r.evidence.fails.sort((a, b) => CHECK_ORDER.indexOf(a.check) - CHECK_ORDER.indexOf(b.check));
}

module.exports = { judgeAsserts, judgeBuilt, evaluate, belongsAt, CHECK_ORDER, relevantCases, variants };
