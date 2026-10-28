'use strict';
// Stage 9: one issue per (rule, failing measure or check) and per failing CI check; priority by a fixed table; only
// P0 and P1 rows are shown in sections 1-4 (section 5 is a fixed checklist and shows all). Issue numbers run in the
// order the report shows them.
//
//   P0  critical rule with no test, or a suspected defect in a critical rule; no secret scan; no PR test job
//   P1  critical rule: a blocking document problem, or a test that is weak, blocked, nightly only or at the wrong level
//   P2  the same for a non-critical rule; a coverage gap; a dependency scan that is missing or cannot fail
//   P3  a non-blocking wording problem; format, lint or type check missing
const { BLOCKING } = require('./judge');
const { CHECK_ORDER } = require('./evidence');
const { compareRules } = require('./util');

const P0_CHECKS = new Set(['No test', 'Suspected not built']);
const REQ_M = ['Clear', 'One behaviour', 'Testable', 'Specific', 'Complete', 'Consistent', 'Feasible'];
const DEC_M = ['Traceable', 'Trade-off', 'Simple', 'Failure behaviour', 'Verifiable'];

function docPriority(r, f) {
  if (!BLOCKING.has(f.measure)) return 'P3';
  return r.critical ? 'P1' : 'P2';
}
function testPriority(r, f) {
  if (!r.critical) return 'P2';
  return P0_CHECKS.has(f.check) ? 'P0' : 'P1';
}
const rank = (p) => Number(p.slice(1));

function buildIssues(rules, ci) {
  const out = [];
  const reqs = rules.filter((r) => r.kind === 'requirement'), decs = rules.filter((r) => r.kind === 'decision');
  const docRows = (rs, section, measures) => rs.flatMap((r) => r.fails.map((f) => ({ section, rule: r, measure: f.measure, part: f.part, conflictWith: f.conflictWith, why: f.why, priority: docPriority(r, f), order: measures.indexOf(f.measure) })));
  // a rule the model did not trace has no test rows: "No test" would be a guess from missing data
  const testRows = (rs, section) => rs.filter((r) => r.traced !== false).flatMap((r) => r.evidence.fails.map((f) => ({ section, rule: r, check: f.check, facts: f.facts, ai: f.ai, priority: testPriority(r, f), order: CHECK_ORDER.indexOf(f.check) })));
  const sort = (rows) => rows.sort((a, b) => rank(a.priority) - rank(b.priority) || compareRules(a.rule, b.rule) || a.order - b.order);
  out.push(...sort(docRows(reqs, 1, REQ_M)), ...sort(docRows(decs, 2, DEC_M)));
  out.push(...sort(testRows(reqs, 3)), ...sort(testRows(decs.filter((d) => d.addsBehaviour), 4)));
  const ciRows = ci.checks.flatMap((c, k) => (c.issues || []).map((i, j) => ({ section: 5, check: c.label, checkKey: c.key, kind: i.kind, text: i.text, priority: i.priority, order: k * 10 + j })));
  out.push(...ciRows.sort((a, b) => rank(a.priority) - rank(b.priority) || a.order - b.order));
  for (const i of out) i.shown = i.section === 5 || rank(i.priority) <= 1;
  let n = 0;
  for (const i of out) if (i.shown) i.n = ++n;
  return out;
}

module.exports = { buildIssues, docPriority, testPriority, rank };
