'use strict';
// The whole run: stages 1-12. Returns the ledger (every fact behind the report) and the report itself.
const { listFiles } = require('./inventory');
const { discover, reverseLookup, ID } = require('./discover');
const { extractRules } = require('./rules');
const { tagRules } = require('./critical');
const { indexTests } = require('./tests-index');
const { analyzeCI } = require('./ci');
const { classifyDocs, atomize, judgeRules, statusOf } = require('./judge');
const { traceRules } = require('./trace');
const { judgeAsserts, judgeBuilt, evaluate } = require('./evidence');
const { buildIssues } = require('./issues');
const { planTests, buildActions } = require('./actions');
const { writeCells, writeActions } = require('./write');
const { render } = require('./render');
const { readText, numbersIn, linesOf, base, compareRules } = require('./util');

// Sources the pipeline never reads in this version; the run line names them so a reader knows what the answer cannot cover.
const NEVER_READ = ['Jira', 'Confluence', 'PR history'];

async function run({ root, repo, sha, date, llm, external = [], budgetKb = 60, maxDocs, include = [], exclude = [], branchProtection = 'not readable', progress = () => {} }) {
  const files = listFiles(root), fileSet = new Set(files);
  progress(`files: ${files.length}`);
  const docsIn = external.filter((e) => e.kindHint !== 'test' && e.text);
  const testDocs = external.filter((e) => e.kindHint === 'test' && e.text);
  const disc = await discover({ root, files, external: docsIn, budgetKb, maxDocs, include, exclude, classify: (c) => classifyDocs(llm, c) });
  const testIndex = indexTests(root, files);
  // ID reverse lookup: IDs that code or tests mention, defined in a file the content scan did not admit
  const mentioned = new Set(testIndex.tests.flatMap((t) => t.text.match(ID) || []).map((id) => id.toUpperCase()));
  let extracted = await extractRules(disc.read, { atomize: (d) => atomize(llm, d) });
  const extra = reverseLookup({ root, files, mentioned, defined: new Set(extracted.rules.map((r) => r.id)), already: new Set([...disc.read, ...disc.notRead, ...disc.skipped].map((d) => d.path)) });
  if (extra.length) { disc.read.push(...extra.map((p) => ({ path: p, text: readText(root, p), score: 0, reverse: true }))); extracted = await extractRules(disc.read, { atomize: (d) => atomize(llm, d) }); }
  const rules = extracted.rules.sort(compareRules);
  progress(`documents read: ${disc.read.length}; rules: ${rules.length}; tests: ${testIndex.caseCount} in ${testIndex.tests.length} files`);

  const ci = analyzeCI(root, files, testIndex);
  await judgeRules(llm, rules, { root, fileSet });
  for (const r of rules) r.status = statusOf(r);
  tagRules(rules);
  progress('sections 1-2 judged');

  await traceRules(llm, rules, { root, files, testIndex });
  linkFromTestDocs(rules, testDocs, testIndex);
  const [asserts, built] = await Promise.all([judgeAsserts(llm, rules, testIndex), judgeBuilt(llm, rules, root)]);
  evaluate(rules, { testIndex, ci, srcImports: testIndex.srcImports, asserts, built });
  progress('sections 3-4 judged');

  const issues = buildIssues(rules, ci);
  const tests = await planTests(llm, issues);
  const actions = buildActions(issues, tests, rules);
  const byId = new Map(rules.map((r) => [r.id, r]));
  const actionOfTest = new Map(actions.flatMap((a) => (a.tests || []).map((t) => [t.key, a.n])));
  const testsByIssue = new Map();
  for (const t of tests) for (const n of t.issues) testsByIssue.set(n, [...(testsByIssue.get(n) || []), t]);
  const docsAction = actions.find((a) => a.kind === 'docs')?.n || null;
  const ctx = {
    root, files, fileSet, rules, byId, issues, actions, tests, actionOfTest, testsByIssue, docsAction, dropped: [...extracted.dropped], branchProtection,
    docNumbers: new Set(disc.read.flatMap((d) => [...numbersIn(d.text)])),
    waitingTests: (id) => tests.filter((t) => t.rules.includes(id)).map((t) => ({ test: t.key, level: t.level, action: actionOfTest.get(t.key) })),
  };
  ctx.cells = await writeCells(llm, ctx);
  const texts = await writeActions(llm, ctx);
  actions.forEach((a, k) => { a.text = texts[k]; });
  progress('report text written');

  const reqs = rules.filter((r) => r.kind === 'requirement'), decs = rules.filter((r) => r.kind === 'decision'), own = decs.filter((d) => d.addsBehaviour);
  const noTests = !testIndex.tests.length;
  // Scores count only the rules the model judged (1-2) or traced (3-4); the run line names the rest.
  const judged = (rs) => rs.filter((r) => r.judged), traced = (rs) => rs.filter((r) => r.traced !== false);
  const ratio = (rs, all, ok, na) => (all.length && !rs.length ? { n: 0, na } : { x: rs.filter(ok).length, n: rs.length });
  const NOT_JUDGED = 'Not judged: no model reply', NOT_TRACED = 'Not traced: no model reply';
  const scores = {
    s1: ratio(judged(reqs), reqs, (r) => r.status === 'Ready', NOT_JUDGED),
    s2: ratio(judged(decs), decs, (r) => r.status === 'Ready', NOT_JUDGED),
    s3: noTests ? { n: 0, na: 'No tests found' } : ratio(traced(reqs), reqs, (r) => r.evidence.level === 'Meets', NOT_TRACED),
    s4: noTests ? { n: 0, na: 'No tests found' } : ratio(traced(own), own, (r) => r.evidence.level === 'Meets', NOT_TRACED),
    s5: { x: ci.checks.filter((c) => c.ok).length, n: ci.checks.length },
  };
  const ledger = {
    meta: { repo, sha, date, model: llm.model, aiu: llm.aiu, usage: llm.usage, llmLog: llm.log },
    sources: {
      // documents with requirements first, then design documents, each by path
      read: disc.read.map((d) => ({ path: d.path, ...(extracted.perDoc.get(d.path) || { requirements: 0, decisions: 0 }) })).filter((d) => d.requirements + d.decisions).sort((a, b) => (b.requirements > 0) - (a.requirements > 0) || a.path.localeCompare(b.path)),
      notRead: [...disc.notRead, ...external.filter((e) => e.error).map((e) => ({ path: e.path, reason: e.error }))],
      never: NEVER_READ, skipped: disc.skipped,
    },
    tests: { files: testIndex.tests.length, cases: testIndex.caseCount },
    ci: { workflowCount: ci.workflowCount, checks: ci.checks, workflows: ci.workflows.map((w) => ({ path: w.path, pr: w.pr, scheduled: w.scheduled })) },
    branchProtection, rules, issues, testPlan: tests, actions, scores, cells: Object.fromEntries(ctx.cells), dropped: ctx.dropped,
  };
  checkInvariants(ledger);
  return { ledger, report: render(ledger), details: details(ledger) };
}

// A test plan or test-strategy document that names a rule ID and a test file on one line links them (source: test doc).
function linkFromTestDocs(rules, docs, testIndex) {
  for (const d of docs) for (const line of linesOf(d.text)) {
    const ids = (line.match(ID) || []).map((x) => x.toUpperCase().replace(/^([A-Z]+)[-_]?(\d+)$/, (_, a, n) => `${a}-${n.padStart(2, '0')}`));
    const tests = testIndex.tests.filter((t) => line.includes(t.path) || line.includes(base(t.path)));
    for (const r of rules.filter((x) => ids.includes(x.id))) for (const t of tests) if (!r.links.some((l) => l.path === t.path)) r.links.push({ path: t.path, source: 'test doc' });
  }
}

function checkInvariants(L) {
  const fail = (m) => { throw new Error(`invariant broken: ${m}`); };
  const shown = L.issues.filter((i) => i.shown);
  shown.forEach((i, k) => { if (i.n !== k + 1) fail(`issue numbers not contiguous at I-${i.n}`); });
  for (const i of shown.filter((x) => x.section <= 4)) if (!L.cells[i.n]) fail(`I-${i.n} has no cell`);
  const reqs = L.rules.filter((r) => r.kind === 'requirement');
  if (L.scores.s1.n !== reqs.filter((r) => r.judged).length) fail('section 1 denominator');
  for (const i of shown.filter((x) => x.section === 1)) if (i.rule.status === 'Ready') fail(`${i.rule.id} is Ready but has a section 1 row`);
  const credited = L.actions.flatMap((a) => a.credits.map((c) => c.rule.id));
  if (new Set(credited).size !== credited.length) fail('a rule is credited twice');
  for (const id of credited) { const r = L.rules.find((x) => x.id === id); if (!r.critical) fail(`${id} credited but not critical`); }
  if (L.actions.length > 5) fail('more than 5 top actions');
}

// Every item, including the P2/P3 rows the report leaves out, so every score can be checked.
function details(L) {
  const row = (i) => `| ${i.n ? `I-${i.n}` : '–'} | ${i.priority} | ${i.section} | ${i.rule ? i.rule.id : i.check} | ${i.measure || i.check}${i.part ? ` (${i.part})` : ''} | ${i.shown ? 'yes' : 'no'} |`;
  const rules = L.rules.map((r) => `| ${r.id} | ${r.kind} | \`${r.path}:${r.line}\` | ${r.critical ? `${r.critical.area}${r.critical.inherited ? `, as ${r.critical.inherited}` : r.critical.word ? ` · "${r.critical.word}"` : ''}` : '–'} | ${r.status} | ${r.kind === 'decision' ? (r.addsBehaviour ? 'adds behaviour' : `restates ${r.restates}`) : '–'} | ${r.evidence.level} | ${r.links.map((l) => `${l.path} (${l.source})`).join(', ') || '–'} |`);
  return [`# Report details: ${L.meta.repo} @ \`${L.meta.sha}\``, '', 'Every rule and every issue, including the P2 and P3 rows the report leaves out. Generated with the report.', '',
    '## Rules', '', '| Rule | Kind | Source | Critical | Status | Decision | Test level | Linked tests |', '| --- | --- | --- | --- | --- | --- | --- | --- |', ...rules, '',
    '## Issues', '', '| Issue | Priority | Section | Rule or check | Fails on | In report |', '| --- | --- | --- | --- | --- | --- |', ...L.issues.map(row), '',
    '## Dropped model output', '', ...(L.dropped.length ? L.dropped.map((d) => `- ${d.issue || d.id}: ${d.reason}`) : ['None.']), '',
    `## AI usage`, '', `${L.meta.usage.calls} calls, ${L.meta.usage.input_tokens} input and ${L.meta.usage.output_tokens} output tokens, US$${L.meta.usage.usd.toFixed(4)} (${L.meta.aiu.toFixed(2)} AIU).${L.meta.llmLog.length ? ` Failed calls: ${L.meta.llmLog.map((x) => `${x.key} (${x.error})`).join('; ')}.` : ''}`, ''].join('\n');
}

module.exports = { run, checkInvariants };
