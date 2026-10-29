'use strict';
// Stage 10: Top actions. The model proposes the deduplicated list of tests that fix the shown section 3 and 4 issues
// (one test can fix several rows); code checks it, groups tests into actions, orders them and credits rules:
//   1 confirm the suspected defects (tests that should fail today)   2 fix the document text that blocks tests
//   3 close the critical CI gaps   4 write the critical tests that need no answer   5 write the tests the answers unblock
// A rule is credited once, to the first action that writes a test asserting it; "X once action N is done" when it
// still needs a later action (or its document fix). Empty actions are dropped and the rest renumbered.
const { STYLE, obj, arr, str } = require('./judge');
const { compareRules } = require('./util');
const { AREA_RANK } = require('./critical');

async function planTests(llm, issues) {
  const rows = issues.filter((i) => i.shown && (i.section === 3 || i.section === 4));
  if (!rows.length) return [];
  const out = await llm.ask('plan-tests', {
    system: STYLE,
    prompt: `These are the test gaps found in a repository (sections 3 and 4 of a review). Propose the smallest list of new or changed tests that fixes all of them. One test may fix several rows (for example one component test with a fake server that covers a timeout case and an error case). For each test give:
- key: short kebab-case id
- level: unit, component, integration or e2e (a plain calculation, date or count rule belongs in a unit test; an outside call in a component test against a fake server)
- rules: the rule IDs whose expected result this test asserts
- issues: the issue numbers it fixes
- after: keys of tests it extends or that must exist first (for example a case added to a test file another test creates)

${rows.map((i) => `I-${i.n} ${i.priority} ${i.rule.id} "${i.rule.title}" status=${i.rule.status} level=${i.rule.evidence.level} fails on "${i.check}"${i.check === 'Suspected not built' ? ' (confirm with a test that should fail today)' : ''}${i.facts?.belongsAt ? ` (belongs in a ${i.facts.belongsAt} test: ${i.facts.because})` : ''}; tests now: ${i.rule.evidence.tests.map((t) => `${t.path} (${t.level})`).join(', ') || 'none'}`).join('\n')}`,
    schema: obj({ tests: arr(obj({ key: str, level: { type: 'string', enum: ['unit', 'component', 'integration', 'e2e'] }, rules: arr(str), issues: arr({ type: 'integer' }), after: arr(str) })) }),
    maxTokens: 6000,
  });
  const valid = new Set(rows.map((i) => i.n)), ruleIds = new Set(rows.map((i) => i.rule.id));
  const tests = (out?.tests || []).map((t) => ({ ...t, issues: t.issues.filter((n) => valid.has(n)), rules: t.rules.filter((r) => ruleIds.has(r)) })).filter((t) => t.issues.length && t.rules.length);
  for (const t of tests) t.after = t.after.filter((k) => tests.some((x) => x.key === k));
  // shift left: a test that fixes a Placement row is written at the level code says the rule belongs at, or lower
  const LEVELS = ['unit', 'component', 'integration', 'e2e'];
  for (const t of tests) for (const n of t.issues) {
    const want = rows.find((i) => i.n === n)?.facts?.belongsAt;
    if (want && LEVELS.indexOf(t.level) > LEVELS.indexOf(want)) t.level = want;
  }
  // every row must be fixed by some test: add one per uncovered rule
  for (const i of rows) if (!tests.some((t) => t.issues.includes(i.n))) {
    let t = tests.find((x) => x.key === `test-${i.rule.id.toLowerCase()}`);
    if (!t) tests.push(t = { key: `test-${i.rule.id.toLowerCase()}`, level: i.facts?.belongsAt || 'unit', rules: [i.rule.id], issues: [], after: [], fallback: true });
    t.issues.push(i.n);
  }
  return tests;
}

function buildActions(issues, tests, rules) {
  const byId = new Map(rules.map((r) => [r.id, r]));
  const rowOf = new Map(issues.filter((i) => i.n).map((i) => [i.n, i]));
  const suspected = new Set(issues.filter((i) => i.shown && i.check === 'Suspected not built').map((i) => i.n));
  const blocked = (t) => t.rules.some((id) => byId.get(id).status === 'Blocked');
  const used = new Set();
  const take = (pred) => tests.filter((t) => !used.has(t.key) && pred(t)).map((t) => (used.add(t.key), t));
  // the confirmation writes every test of a suspected rule (its other gaps are fixed by the same tests)
  const suspectedRules = new Set([...suspected].map((n) => rowOf.get(n).rule.id));
  const confirm = take((t) => t.issues.some((n) => suspected.has(n)) || t.rules.every((id) => suspectedRules.has(id)));
  const docs = issues.filter((i) => i.shown && (i.section === 1 || i.section === 2)).map((i) => i.n);
  const ciRows = issues.filter((i) => i.section === 5 && ['P0', 'P1'].includes(i.priority)).map((i) => i.n);
  const now = take((t) => !blocked(t));
  const later = take(() => true);
  const draft = [
    { kind: 'confirm', tests: confirm }, { kind: 'docs', issues: docs }, { kind: 'ci', issues: ciRows },
    { kind: 'tests', tests: now }, { kind: 'unblocked', tests: later },
  ].filter((a) => (a.tests || a.issues).length);
  draft.forEach((a, k) => { a.n = k + 1; });
  const actionOfTest = new Map(draft.flatMap((a) => (a.tests || []).map((t) => [t.key, a.n])));
  const docsN = draft.find((a) => a.kind === 'docs')?.n;
  for (const a of draft) if (a.tests) a.issues = [...new Set(a.tests.flatMap((t) => t.issues))].sort((x, y) => x - y);

  // credit
  const credited = new Map();
  for (const a of draft) for (const t of a.tests || []) for (const id of t.rules) if (!credited.has(id) && byId.get(id).critical) {
    const r = byId.get(id);
    const laterActions = tests.filter((x) => x.rules.includes(id)).map((x) => actionOfTest.get(x.key)).filter((n) => n > a.n);
    const wait = r.status === 'Partly blocked' && docsN ? docsN : laterActions.length ? Math.max(...laterActions) : null;
    credited.set(id, { action: a.n, wait });
  }
  for (const a of draft) {
    const mine = [...credited].filter(([, c]) => c.action === a.n).map(([id, c]) => ({ rule: byId.get(id), wait: c.wait }));
    if (a.kind === 'confirm') mine.sort((x, y) => AREA_RANK[x.rule.critical.area] - AREA_RANK[y.rule.critical.area] || compareRules(x.rule, y.rule));
    else mine.sort((x, y) => compareRules(x.rule, y.rule));
    a.credits = mine;
    if (a.kind === 'docs') {
      const whole = draft.filter((b) => b.kind === 'unblocked').map((b) => `action ${b.n}`);
      const partial = [...credited].filter(([, c]) => c.wait === a.n).map(([id, c]) => `${id} in action ${c.action}`);
      a.protects = whole.length || partial.length ? `None. It unblocks ${[...whole, ...partial].join(', and ')}` : 'None';
    } else if (a.kind === 'ci') a.protects = 'None. It closes a CI gap, not a rule';
    else {
      const now = mine.filter((m) => !m.wait).map((m) => m.rule.id), waits = mine.filter((m) => m.wait).map((m) => `${m.rule.id} once action ${m.wait} is done`);
      a.protects = [now.join(', '), ...waits].filter(Boolean).join('; ') || 'None';
    }
  }
  return draft;
}

module.exports = { planTests, buildActions };
