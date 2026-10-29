'use strict';
// The report's sentences. Code gives the model only verified facts (citations already formatted); the model writes the
// "What fails, and the fix" cells and the Top-action cells. Code then checks every cell: each `path:line` must exist,
// each I-n and "action N" must exist, and a document rewrite may only use numbers the documents state (anything else
// must be a placeholder). A cell that fails is replaced by a plain cell built by code, and the drop is logged.
const { readText, linesOf, base, numbersIn } = require('./util');
const { STYLE, obj, arr, str } = require('./judge');

const SHORT = /\.(md|mdx|markdown|rst|adoc|txt|feature|ya?ml)$/i;
const disp = (p) => (SHORT.test(p) ? base(p) : p);
const at = (p, line) => `\`${disp(p)}:${line}\``;

function ruleFacts(r) {
  return { id: r.id, title: r.title, text: r.text, at: at(r.path, r.line), status: r.status, critical: r.critical ? r.critical.area : 'no', impl: r.impl ? `${at(r.impl.path, r.impl.line)} ${r.impl.symbol}` : 'not found', logic_kind: r.logicKind, limits: r.limits.map((l) => `${l.value}${l.unit ? ' ' + l.unit : ''}${l.source && l.source !== 'text' ? ` (from \`${l.source}\`)` : ''}`) };
}

function runFacts(t) {
  return { test: `\`${t.path}\``, level: t.level, runs_on_pr: t.pr.map((x) => `\`${x.workflow}:${x.line}\``), runs_elsewhere: t.other.map((x) => `\`${x.workflow}:${x.line}\``), excluded_from_pr_by: t.excluded.map((x) => `\`${x.cfgPath}:${x.line}\``), database_import: t.dbImport ? `\`${t.path}:${t.dbImport.line}\` (${t.dbImport.text})` : '' };
}

function checkFacts(i) {
  const f = i.facts || {};
  switch (i.check) {
    case 'No test': return { searched_test_files_for: f.searched, implementation: i.rule.impl ? `${at(i.rule.impl.path, i.rule.impl.line)} ${i.rule.impl.symbol}` : 'not found' };
    case 'Suspected not built': return { line: at(f.path, f.line), why: f.why };
    case 'Not skipped': return { skipped_cases: f.skipped.map((s) => `${at(s.path, s.line)} "${s.name}"`) };
    case 'Calls the code': return { implementation: `${at(f.impl.path, f.impl.line)} ${f.impl.symbol}`, test_imports: f.imports.map((t) => ({ test: `\`${t.path}\``, imports: t.imports.map((x) => `:${x.line} ${x.text}`) })) };
    case 'Asserts the rule': return { closest_assertion: at(f.path, f.line), it_checks_instead: f.what };
    case 'Covers stated limits': return { missing_limits: f.missing.map((l) => `${l.value}${l.unit ? ' ' + l.unit : ''}${l.source !== 'text' ? ` (from \`${l.source}\`)` : ''}`), tests: f.tests.map((t) => ({ test: `\`${t.path}\``, level: t.level, cases: t.cases, input_lines: t.numbers.map((x) => `:${x.line} ${x.text}`) })) };
    case 'Crosses the real boundary': return { mocked_at: f.mocked.map((m) => at(m.path, m.line)) };
    case 'Placement': return { logic_kind: i.rule.logicKind, belongs_at: f.belongsAt, because: f.because, tests: f.runs.map(runFacts) };
    case 'Runs on PR': return { logic_kind: i.rule.logicKind, tests: f.runs.map(runFacts) };
    default: return f;
  }
}

function issueFacts(i, ctx) {
  const r = i.rule;
  const same = ctx.issues.filter((x) => x.n && x !== i && x.rule && x.rule.id === r.id).map((x) => `I-${x.n} (section ${x.section}, ${x.measure || x.check})`);
  const conflict = i.conflictWith && ctx.byId.get(i.conflictWith);
  const conflictIssue = conflict && ctx.issues.find((x) => x.n && x.rule?.id === conflict.id && x.conflictWith === r.id);
  const restating = ctx.rules.filter((d) => d.restates === r.id).map((d) => d.id);
  const tests = (ctx.testsByIssue.get(i.n) || []).map((t) => ({ test: t.key, level: t.level, in_action: ctx.actionOfTest.get(t.key), asserts_rules: t.rules, extends: t.after }));
  const base0 = { issue: `I-${i.n}`, rule: ruleFacts(r), other_issues_on_this_rule: same };
  if (i.section <= 2) return { ...base0, fails_on: i.measure, part: i.part || '', why: i.why, conflict: conflict ? { with: conflict.id, at: at(conflict.path, conflict.line), text: conflict.text, issue: conflictIssue ? `I-${conflictIssue.n}` : '' } : null, decisions_restating_it: restating, serves: r.servesIds?.[0] || r.restates || '', tests_waiting_for_this_fix: ctx.waitingTests(r.id) };
  return { ...base0, fails_on: i.check, level: r.evidence.level, ai_judgment: !!i.ai, evidence: checkFacts(i), current_tests: r.evidence.tests.map(runFacts), fix_tests: tests, blocked_until_action: r.status === 'Blocked' ? ctx.docsAction : null };
}

const EXAMPLES = {
  1: [
    ['Testable, no values in the documents', '"Payment should be retried where possible" (`requirements.md:13`): no count and no timing. Rewrite: "If the payment gateway returns `<which errors>`, the system shall retry up to `<N>` times, `<T>` s apart." The documents give no values, so the owner fills the placeholders'],
    ['Consistent, conflict with a decision', '`design.md:88` (DEC-11) allows 25%, so there are two expected results. Keep 20% or 25%, then edit the other document; this fixes DEC-11 too (I-7)'],
  ],
  2: [['Failure behaviour', '`design.md:101` says nothing about a refund the gateway rejects or does not answer. Rewrite: "If the gateway does not confirm a refund, the policy stays cancelled and the refund is retried up to `<N>` times, then `<next step>`." The documents give no values, so the owner fills the placeholders']],
  3: [
    ['Covers stated limits', '`unit/excess.test.ts` uses $1,000 and $10,000 (`:9`, `:15`), none at $500 or $5,000, so `>= 500` could become `> 500` unnoticed. Add cases: $500 and $5,000 accepted; $499.99 and $5,000.01 rejected'],
    ['Placement', '`integration/quote-repo.test.ts` checks the 30-day cut-off, a date rule, through a database, and `e2e/retrieve.spec.ts` checks it through the browser. They run only in `nightly.yml` (`:12`, `:30`). Test the cut-off with a unit test that calls the date check directly. Keep one case in each nightly test for the saved quote'],
  ],
  4: [
    ['Suspected not built', '`src/routes/admin.ts:12` checks the login only, not the admin role. A component test that a customer cannot change rates should fail today; then fix the code: check that the user is an admin on `/admin/rates`. If the test passes, drop the finding'],
    ['Calls the code', '`integration/payment-sim.test.ts` imports `PaymentSimulator` (`:3`), not the adapter. A component test with a fake gateway server runs the real adapter; if it shows no timeout, add one in `src/payment/gateway-adapter.ts`'],
  ],
};

const CELL_RULES = `Write the "What fails, and the fix" cell for each issue of one section of a repository review.
Rules:
- Plain, short English sentences. No final period at the end of the cell. No headings, no lists, no line breaks.
- First what fails, with its evidence: quote the document text or cite the line, as \`file:line\` in backticks exactly as the facts give it (a second line in the same file may be written \`:NN\`). Then the fix, concrete enough to act on: the rewrite, or which test to add at which level and what it checks, or the code to fix.
- A rewrite of a requirement uses the form "When <trigger>, the system shall <response>." or "If <condition>, the system shall <response>." Use only values the documents state. Where they give none, put a placeholder such as \`<N>\`, \`<T>\` or \`<day or month>\`, and end with "The documents give no values, so the owner fills the placeholders" (or "The documents give no limit, so the owner fills \`<T>\`").
- A suspected defect is never a fact: say which test should fail today, then the code fix, then "If the test passes, drop the finding" (or "If the cases pass, drop the finding").
- When a fix waits for a document answer, start with "After action N," using the action number in the facts.
- Refer to other issues only as (I-n) and to actions only as "action N", and only those in the facts. Name tests by what they check ("a unit test for the discount cap"), never by key.
- Do not repeat the priority, the level or the check name; the row shows them.`;

async function writeCells(llm, ctx) {
  const cells = new Map();
  for (const section of [1, 2, 3, 4]) {
    const rows = ctx.issues.filter((i) => i.shown && i.section === section);
    if (!rows.length) continue;
    const out = await llm.ask(`write:s${section}`, {
      system: STYLE,
      prompt: `${CELL_RULES}\n\nExamples of the style (from another repository):\n${EXAMPLES[section].map(([k, v]) => `- ${k}: ${v}`).join('\n')}\n\nFacts, one object per issue:\n${JSON.stringify(rows.map((i) => issueFacts(i, ctx)), null, 1)}`,
      schema: obj({ cells: arr(obj({ issue: str, text: str })) }),
      maxTokens: 12000,
    });
    for (const i of rows) {
      const c = (out?.cells || []).find((x) => x.issue === `I-${i.n}`);
      const problem = c ? checkCell(c.text, i, ctx) : 'missing';
      if (problem) { ctx.dropped.push({ issue: `I-${i.n}`, reason: `cell ${problem}` }); cells.set(i.n, fallbackCell(i, ctx)); } else cells.set(i.n, c.text.trim().replace(/\.$/, ''));
    }
  }
  return cells;
}

const ACTION_EXAMPLES = [
  { do: '**Fix the unclear text in sections 1 and 2:** 8 issues, 6 on 5 requirements and 2 on 2 design decisions. Each row gives the rewrite. Where the documents give no value, the rewrite has a placeholder (`<N>`, `<T>`) for the document owner to fill.', risk: 'REQ-05, REQ-08, REQ-10, REQ-11, REQ-12, DEC-11, DEC-13: money and access rules have no clear expected result, so a test written now may lock in the wrong value' },
  { do: '**Close the critical CI gap: add a secret scan to `pr.yml`.** Today no secret scan runs. Branch protection is not readable, so check by hand that the new step is required.', risk: 'A committed secret goes unnoticed: `pr.yml` and `nightly.yml` have no secret-scan step' },
];

async function writeActions(llm, ctx) {
  const facts = ctx.actions.map((a) => ({
    action: a.n, kind: a.kind,
    issues: a.issues.map((n) => { const i = ctx.issues.find((x) => x.n === n); return { issue: `I-${n}`, section: i.section, rule: i.rule ? `${i.rule.id} ${i.rule.title}` : i.check, fails_on: i.measure || i.check, cell: ctx.cells.get(n) || i.text }; }),
    tests: (a.tests || []).map((t) => ({ test: t.key, level: t.level, asserts_rules: t.rules, extends: t.after.map((k) => `${k} (action ${ctx.actionOfTest.get(k)})`) })),
    counts: a.kind === 'docs' ? docCounts(a.issues.map((n) => ctx.issues.find((x) => x.n === n))) : { tests: (a.tests || []).length },
    critical_rules_protected: a.protects || a.credits.map((c) => c.rule.id).join(', '),
    branch_protection: ctx.branchProtection,
  }));
  const out = await llm.ask('write:actions', {
    system: STYLE,
    prompt: `Write the Top-actions table of a repository review: for each action, "do" (what to do, starting with one bold sentence, then the concrete steps; name each test by what it checks, in the order given) and "risk" (what is at risk if it is not done: per rule, "ID: the consequence" with the citation where the facts give one; or one line for the whole action). Use only facts given. Numbers you write must match the counts given. Refer to actions only as "action N". An action that confirms suspected defects must say the tests should fail today, to fix the code if one fails, and to drop the finding if it passes. A test that extends another action's test says so ("comes after action N").\n\nExamples of the style (from another repository):\n${JSON.stringify(ACTION_EXAMPLES, null, 1)}\n\nFacts:\n${JSON.stringify(facts, null, 1)}`,
    schema: obj({ actions: arr(obj({ action: { type: 'integer' }, do: str, risk: str })) }),
    maxTokens: 8000,
  });
  return ctx.actions.map((a) => {
    const w = (out?.actions || []).find((x) => x.action === a.n);
    const problem = w ? checkCell(`${w.do} ${w.risk}`, null, ctx) : 'missing';
    if (problem) { ctx.dropped.push({ issue: `action ${a.n}`, reason: `text ${problem}` }); return fallbackAction(a, ctx); }
    return { do: w.do.trim(), risk: w.risk.trim().replace(/\.$/, '') };
  });
}

function docCounts(rows) {
  const req = rows.filter((i) => i.section === 1), dec = rows.filter((i) => i.section === 2);
  return { issues: rows.length, on_requirements: req.length, requirements: new Set(req.map((i) => i.rule.id)).size, on_decisions: dec.length, decisions: new Set(dec.map((i) => i.rule.id)).size };
}

// ---- checks on model text -------------------------------------------------------------------------------------
function resolvePath(p, ctx) {
  if (ctx.fileSet.has(p)) return p;
  const hits = ctx.files.filter((f) => base(f) === p);
  return hits.length === 1 ? hits[0] : null;
}

function checkCell(text, issue, ctx) {
  if (!text || /\n/.test(text.trim())) return 'empty or multi-line';
  let last = null;
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    const span = m[1];
    const full = span.match(/^([\w@./-]+\.[a-z0-9]+):(\d+)$/i);
    const short = span.match(/^:(\d+)$/);
    const bare = span.match(/^([\w@.-]+\/[\w@./*-]+|[\w@-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|ya?ml|py|go))$/i);
    if (full) {
      const p = resolvePath(full[1], ctx);
      if (!p) return `cites a file that does not exist: ${span}`;
      const n = linesOf(readText(ctx.root, p) || '').length;
      if (Number(full[2]) < 1 || Number(full[2]) > n) return `cites a line past the end: ${span}`;
      last = p;
    } else if (short) {
      if (!last) continue;
      if (Number(short[1]) > linesOf(readText(ctx.root, last) || '').length) return `cites a line past the end: ${span}`;
    } else if (bare && !span.includes('*')) {
      const p = resolvePath(bare[1], ctx);
      // a path may name a file to create, but its folder must exist
      const dir = bare[1].includes('/') ? bare[1].replace(/\/[^/]*$/, '/') : null;
      if (!p && !ctx.files.some((f) => f.startsWith(bare[1].replace(/\/$/, '') + '/') || (dir && f.startsWith(dir)))) return `names a path that does not exist: ${span}`;
      if (p) last = p;
    }
  }
  for (const m of text.matchAll(/\bI-(\d+)\b/g)) if (!ctx.issues.some((i) => i.n === Number(m[1]))) return `refers to I-${m[1]}, which does not exist`;
  for (const m of text.matchAll(/\baction (\d+)\b/gi)) if (Number(m[1]) > ctx.actions.length) return `refers to action ${m[1]}, which does not exist`;
  if (issue && issue.section <= 2) {
    for (const m of text.matchAll(/Rewrite:\s*"([^"]+)"/g)) for (const v of numbersIn(m[1].replace(/`[^`]*`/g, ''))) if (!ctx.docNumbers.has(v)) return `rewrite uses ${v}, which no document states`;
  }
  return null;
}

function fallbackCell(i, ctx) {
  const r = i.rule;
  if (i.section <= 2) return `"${r.text.slice(0, 160)}" (${at(r.path, r.line)}) fails ${i.measure}${i.part ? ` (${i.part})` : ''}: ${i.why}`;
  const f = checkFacts(i);
  return `${i.check}: ${JSON.stringify(f).replace(/[{}"[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)}`;
}

function fallbackAction(a, ctx) {
  const labels = { confirm: 'Confirm the suspected defects, then fix them', docs: 'Fix the unclear text in sections 1 and 2', ci: 'Close the critical CI gaps', tests: 'Write the critical tests', unblocked: `After action ${ctx.docsAction}, write the tests it unblocks` };
  return { do: `**${labels[a.kind]}:** ${a.issues.map((n) => `I-${n}`).join(', ')}.`, risk: a.issues.map((n) => ctx.issues.find((x) => x.n === n)).map((i) => i.rule?.id || i.check).filter((v, k, s) => s.indexOf(v) === k).join(', ') };
}

module.exports = { writeCells, writeActions, checkCell, issueFacts, disp, at };
