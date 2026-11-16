'use strict';
// The report. Code renders every number from the ledger; the model writes none of it. Same ledger, same bytes.
// Order is by what the reader must do first: the verdict, the three questions, P0 and P1, then the sections (proof,
// placement, CI) in full, then the lower priorities folded away.
const { clip, plural, count, groupBy } = require('../util');
const { LEVELS } = require('../index/tests');

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const BASIS = { S: 'code', V: 'model, verified', A: 'advice' };
const STATE = { enforced: '✅ enforced', unverified: '🟡 runs, trigger not read', path_filtered: '✅ enforced (path filter)', non_blocking: '❌ failures ignored', not_on_pr: '❌ not on pull requests', configured: '❌ set up, not run', missing: '❌ missing', na: '— not applicable' };
const table = (head, rows) => (rows.length ? [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`)].join('\n') : '');
const locOf = (f) => (f.loc ? `\`${f.loc.path}:${f.loc.line}\`` : '');
const more = (n, what) => (n > 0 ? `\n\n…and ${n} more ${what} (all of them are in \`findings.json\`).` : '');

function findingRows(list, max, { blocks = true } = {}) {
  return list.slice(0, max).map((f) => [f.n, f.priority, ...(blocks ? [f.blocking ? '**yes**' : `no (${f.why})`] : []), `**${f.title}**`, `${f.detail} _(${BASIS[f.basis]})_`, f.fix]);
}

function summarize(ledger) {
  const { proofs, findings, ci, placement } = ledger;
  const active = proofs.filter((p) => p.status !== 'inactive' && p.status !== 'not_a_rule');
  const crit = active.filter((p) => p.rule.critical);
  const st = (list, s) => count(list, (p) => p.status === s);
  const open = findings.filter((f) => !f.suppressed);
  const sec = (name, pri) => count(open, (f) => f.section === name && f.priority === pri);
  const applicable = ci.checks.filter((c) => c.state !== 'na');
  return {
    rules: active.length, proven: st(active, 'proven'), weak: st(active, 'weak'), unproven: st(active, 'unproven'), unverified: st(active, 'unverified'), untestable: st(active, 'untestable'),
    critical: crit.length, criticalProven: st(crit, 'proven'),
    placementFindings: count(open, (f) => f.section === 'placement'),
    levels: Object.fromEntries(LEVELS.map((l) => [l, placement.levels[l].cases])),
    ciEnforced: count(applicable, (c) => ['enforced', 'path_filtered'].includes(c.state)), ciApplicable: applicable.length,
    p: { proof: [sec('proof', 'P0') + sec('change', 'P0'), sec('proof', 'P1') + sec('change', 'P1')], placement: [sec('placement', 'P0'), sec('placement', 'P1')], ci: [sec('ci', 'P0'), sec('ci', 'P1')] },
  };
}

function header(ledger) {
  const { gate, run } = ledger;
  const s = ledger.summary;
  const blocking = ledger.findings.filter((f) => f.blocking);
  const bp = (p) => count(blocking, (f) => f.priority === p);
  const verdict = gate.verdict === 'fail'
    ? `**❌ Fail**: ${plural(gate.blocking, 'finding')} ${gate.blocking === 1 ? 'blocks' : 'block'} ${gate.mode === 'change' ? 'this change' : 'the gate'} (${['P0', 'P1', 'P2', 'P3'].filter((p) => bp(p)).map((p) => `${bp(p)} ${p}`).join(', ')}).`
    : `**✅ Pass**: nothing blocks ${gate.mode === 'change' ? 'this change' : 'the gate'}${gate.counts.P0 + gate.counts.P1 ? ` (${gate.counts.P0} P0 and ${gate.counts.P1} P1 ${gate.mode === 'change' ? 'exist and are not touched by it, or are advice' : 'are advice or suppressed'})` : ''}.`;
  const mode = gate.mode === 'change' ? `Change review: ${plural(run.changedFiles, 'changed file')}${run.base ? ` against \`${run.base.slice(0, 10)}\`` : ''}${gate.baseline ? ', compared with the default-branch baseline' : ''}.` : 'Full review of the repository.';
  const q = table(['Question', 'Answer', 'P0', 'P1'], [
    ['1. Is every requirement and design decision proven by a test?', s.rules ? `**${s.proven} of ${s.rules}** rules proven · ${s.weak} with a hole · ${s.unproven} with no test · ${s.unverified} unverified${s.untestable ? ` · ${s.untestable} not testable as written` : ''}. Critical rules: **${s.criticalProven} of ${s.critical}** proven.` : 'No rules were found in the documents read (see Run).', s.p.proof[0], s.p.proof[1]],
    ['2. Is each thing tested at the right level?', `${plural(s.placementFindings, 'placement finding')}. Cases: ${LEVELS.map((l) => `${l} ${s.levels[l]}`).join(' · ')}.`, s.p.placement[0], s.p.placement[1]],
    ['3. Does CI enforce the checks on pull requests?', ledger.ci.hasCI ? `**${s.ciEnforced} of ${s.ciApplicable}** checks enforced: ${ledger.ci.checks.filter((c) => c.state !== 'na').map((c) => `${c.title} ${['enforced', 'path_filtered'].includes(c.state) ? '✅' : c.state === 'unverified' ? '🟡' : '❌'}`).join(' · ')}.` : 'No CI configuration found.', s.p.ci[0], s.p.ci[1]],
  ]);
  return [`${verdict} ${mode}`, q];
}

function proofSection(ledger, max) {
  const active = ledger.proofs.filter((p) => p.status !== 'inactive' && p.status !== 'not_a_rule');
  const out = ['## 1. Proof: is every rule proven by a test?'];
  if (!active.length) { out.push('No requirement or design decision was found. Point `docs.include` in `.quality-gate.yml` at the documents that state them, or give rules an ID (`REQ-12`, `DEC-4`).'); return out; }
  const byDoc = [...groupBy(active, (p) => p.rule.path)].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const n = (l, s) => count(l, (p) => p.status === s);
  out.push(table(['Document', 'Rules', 'Critical', 'Proven', 'Hole in the proof', 'No test', 'Unverified', 'Reword'], byDoc.slice(0, max).map(([doc, l]) => [`\`${doc}\``, l.length, count(l, (p) => p.rule.critical), n(l, 'proven'), n(l, 'weak'), n(l, 'unproven'), n(l, 'unverified'), n(l, 'untestable')])) + more(byDoc.length - max, 'documents'));
  const ICON = { proven: '✅', weak: '🟡', unproven: '❌', unverified: '❔', untestable: '✏️' };
  const how = (p) => {
    if (p.links.length) return `${p.links.slice(0, 2).map((l) => `\`${l.case.file.path}:${l.line || l.case.line}\` (${l.case.file.level}${l.by === 'id' ? ', names the ID' : ', model-linked'}${l.case.skipped ? ', skipped' : ''})`).join(', ')}${p.links.length > 2 ? ` +${p.links.length - 2}` : ''}${p.holes.length ? `: ${p.holes.map((h) => h.text).join('; ')}` : ''}`;
    if (p.status === 'untestable') return `too vague to test${p.missing ? `: ${p.missing}` : ''}`;
    if (p.status === 'unverified') return `candidate \`${p.candidates[0]?.case.file.path}:${p.candidates[0]?.case.line}\`, not judged`;
    return p.basis === 'V' ? 'the model read the nearest tests: none asserts it' : 'no test names it or shares its words';
  };
  const order = { unproven: 0, weak: 1, untestable: 2, unverified: 3, proven: 4 };
  const sorted = [...active].sort((a, b) => (a.rule.critical ? 0 : 1) - (b.rule.critical ? 0 : 1) || order[a.status] - order[b.status] || (a.rule.id < b.rule.id ? -1 : 1));
  out.push(`<details><summary>All ${plural(active.length, 'rule')}, critical first</summary>\n\n${table(['Rule', 'Critical', 'Status', 'Evidence'], sorted.slice(0, max * 4).map((p) => [`**${p.rule.id}** ${clip(p.rule.title, 60)} (\`${p.rule.path}:${p.rule.line}\`)`, p.rule.critical ? p.rule.tags.map((t) => t.area).join(', ') : '', `${ICON[p.status]} ${p.status === 'weak' ? 'hole' : p.status === 'unproven' ? 'no test' : p.status === 'untestable' ? 'reword' : p.status}`, how(p)]))}${more(sorted.length - max * 4, 'rules')}\n\n</details>`);
  const dropped = ledger.proofs.filter((p) => p.status === 'not_a_rule').length, inactive = ledger.proofs.filter((p) => p.status === 'inactive').length;
  if (dropped || inactive) out.push(`Not counted: ${[inactive && `${plural(inactive, 'rule')} superseded, rejected or still a draft`, dropped && `${plural(dropped, 'sentence')} the model judged not to be testable behaviour`].filter(Boolean).join('; ')}.`);
  return out;
}

function placementSection(ledger, max) {
  const out = ['## 2. Placement: is each thing tested at the right level?'];
  const lv = ledger.placement.levels;
  const total = LEVELS.reduce((n, l) => n + lv[l].files, 0);
  if (!total) { out.push('No test files were found.'); return out; }
  out.push(table(['Level', 'What a test at this level needs', 'Files', 'Cases', 'Files a pull request runs'], [
    ['unit', 'one process, nothing real around it', lv.unit.files, lv.unit.cases, `${lv.unit.pr} of ${lv.unit.files}`],
    ['component', 'one rendered component or module slice', lv.component.files, lv.component.cases, `${lv.component.pr} of ${lv.component.files}`],
    ['integration', 'a real database, HTTP, queue or process', lv.integration.files, lv.integration.cases, `${lv.integration.pr} of ${lv.integration.files}`],
    ['e2e', 'the whole system, driven from outside', lv.e2e.files, lv.e2e.cases, `${lv.e2e.pr} of ${lv.e2e.files}`],
  ]));
  const fs = ledger.findings.filter((f) => f.section === 'placement' && !f.suppressed);
  const judged = ledger.proofs.filter((p) => p.placement);
  if (!fs.length) out.push(`No placement findings: ${judged.length ? `${plural(judged.length, 'rule')} with tests ${judged.length === 1 ? 'is' : 'are'} tested at the level ${judged.length === 1 ? 'it needs' : 'they need'}, and ` : ''}every test file needs what its folder says.`);
  else out.push(table(['#', 'Priority', 'Blocks', 'Finding', 'Evidence', 'Fix'], findingRows(fs, max)) + more(fs.length - max, 'placement findings'));
  return out;
}

function ciSection(ledger) {
  const out = ['## 3. CI: are the checks enforced on pull requests?'];
  const { ci } = ledger;
  if (!ci.hasCI) { out.push('No CI configuration was found.'); return out; }
  out.push(table(['Check', 'State', 'Where', 'Note'], ci.checks.map((c) => [c.title, STATE[c.state], c.where.length ? c.where.map((w) => `\`${w.file}:${w.line}\` (${w.job})`).join(', ') : c.configured ? `set up: ${c.configured}` : '', [c.command && `\`${clip(c.command, 60)}\``, c.detail].filter(Boolean).join(' · ')])));
  const notes = [];
  if (ci.systems.some((s) => s !== 'github')) notes.push(`${ci.systems.filter((s) => s !== 'github').join(', ')} files are read for their commands only: whether they run on pull requests is not checked.`);
  notes.push('Branch protection (which checks are required to merge) is a repository setting this run does not read.');
  if (ci.errors.length) notes.push(`Not parsed: ${ci.errors.map((e) => `\`${e}\``).join('; ')}.`);
  out.push(notes.map((n) => `- ${n}`).join('\n'));
  return out;
}

function runSection(ledger) {
  const { run, ai } = ledger;
  const lines = [];
  lines.push(`- Files: ${run.files.listed} listed, ${run.files.ignored} vendored or generated and skipped; read: ${plural(run.docs.length, 'rule document')}, ${plural(run.testFiles, 'test file')} (${plural(run.testCases, 'case')}), ${plural(run.ciFiles, 'CI file')}. Source files are not read, except the ones a change touches.`);
  if (run.docs.length) lines.push(`- Rules: ${run.rules.total} (${run.rules.withId} with an ID in the source, ${run.rules.inferred} inferred from normative sentences) from ${run.docs.slice(0, 6).map((d) => `\`${d.path}\` (${d.rules})`).join(', ')}${run.docs.length > 6 ? ` and ${run.docs.length - 6} more` : ''}.`);
  if (run.notRead.length) lines.push(`- Not read: ${run.notRead.slice(0, 5).map((d) => `\`${d.path}\` (${d.why})`).join(', ')}${run.notRead.length > 5 ? ` and ${run.notRead.length - 5} more` : ''}. Rules stated only there are not counted.`);
  const m = ai.stats;
  const modelLine = ai.provider === 'none'
    ? `- Model: none (${ai.note}). Only code-decided findings can block; ${plural(m.needed - m.cached, 'rule')} that need a judgment ${m.needed - m.cached === 1 ? 'is' : 'are'} listed as unverified.`
    : `- Model: ${ai.provider}${ai.model ? ` (${ai.model})` : ''}. ${plural(m.needed, 'rule')} needed a judgment: ${m.cached} from the verdict cache, ${m.asked} asked in ${plural(m.requests, 'call')} (${Math.round(m.chars / 1000)}k characters sent)${m.pending ? `, ${m.pending} awaiting an answer in \`ai-requests.json\`` : ''}${m.overBudget ? `, ${m.overBudget} over this run's budget` : ''}${m.failed ? `, ${m.failed} failed (${m.errors[0] || 'no usable reply'})` : ''}.`;
  lines.push(modelLine);
  lines.push('- Tests are read, not run. Evidence levels: _code_ is decided by parsing; _model, verified_ is a model answer whose citation code checked; _advice_ never blocks.');
  for (const d of run.degraded) lines.push(`- ⚠️ ${d}`);
  for (const e of run.configErrors) lines.push(`- ⚠️ Config: ${e}`);
  lines.push(`- Time: ${Object.entries(run.timings).map(([k, v]) => `${k} ${v} ms`).join(' · ')}.`);
  return ['## Run', lines.join('\n')];
}

function renderReport(ledger) {
  const max = ledger.config.report.max_rows;
  const top = ledger.findings.filter((f) => !f.suppressed && (f.priority === 'P0' || f.priority === 'P1'));
  const low = ledger.findings.filter((f) => !f.suppressed && (f.priority === 'P2' || f.priority === 'P3') && f.section !== 'placement');
  const sup = ledger.findings.filter((f) => f.suppressed);
  const parts = [`# Quality gate: ${ledger.run.name}${ledger.run.sha ? ` @ ${ledger.run.sha}` : ''}`, ...header(ledger)];
  parts.push('## Fix first: P0 and P1');
  parts.push(top.length ? table(['#', 'Priority', 'Blocks', 'Finding', 'Evidence', 'Fix'], findingRows(top, max)) + more(top.length - max, 'P0 and P1 findings') : 'None.');
  if (ledger.change?.affectedTests.length) parts.push(`**Run first for this change:** ${ledger.change.affectedTests.slice(0, 12).map((t) => `\`${t}\``).join(' ')}${ledger.change.affectedTests.length > 12 ? ` +${ledger.change.affectedTests.length - 12}` : ''}${ledger.change.touchedRules.length ? `. Rules this change touches: ${ledger.change.touchedRules.slice(0, 12).join(', ')}.` : ''}`);
  parts.push(...proofSection(ledger, max), ...placementSection(ledger, max), ...ciSection(ledger));
  if (low.length) parts.push(`## Lower priority: P2 and P3\n\n<details><summary>${plural(low.length, 'finding')}</summary>\n\n${table(['#', 'Priority', 'Finding', 'Evidence', 'Fix'], findingRows(low, max * 2, { blocks: false }))}${more(low.length - max * 2, 'findings')}\n\n</details>`);
  if (sup.length) parts.push(`Suppressed in \`.quality-gate.yml\`: ${sup.slice(0, 10).map((f) => `${f.subject} (${f.check}: ${f.suppressed})`).join('; ')}${sup.length > 10 ? ` and ${sup.length - 10} more` : ''}.`);
  parts.push(...runSection(ledger));
  return parts.filter(Boolean).join('\n\n') + '\n';
}

/** The pull-request comment: the verdict, the three answers, what blocks. Short on purpose. */
function renderComment(ledger, { marker = '<!-- ai-quality-gate -->', url = '' } = {}) {
  const blocking = ledger.findings.filter((f) => f.blocking);
  const advice = ledger.findings.filter((f) => !f.blocking && !f.suppressed && f.touchesChange && (f.priority === 'P0' || f.priority === 'P1'));
  const placement = ledger.findings.filter((f) => f.section === 'placement' && !f.suppressed && !f.blocking && !advice.includes(f));
  const parts = [marker, `### Quality gate${ledger.run.sha ? ` @ ${ledger.run.sha}` : ''}`, ...header(ledger)];
  const item = (f) => `- **${f.priority} ${f.title}**${f.loc ? ` (${locOf(f)})` : ''}\n  ${f.detail} _(${BASIS[f.basis]})_\n  **Fix:** ${f.fix}`;
  if (blocking.length) parts.push(`#### Blocks this change\n\n${blocking.slice(0, 10).map(item).join('\n')}${blocking.length > 10 ? `\n- …and ${blocking.length - 10} more` : ''}`);
  if (advice.length) parts.push(`#### Touched by this change, not blocking\n\n${advice.slice(0, 5).map(item).join('\n')}${advice.length > 5 ? `\n- …and ${advice.length - 5} more` : ''}`);
  if (placement.length) parts.push(`#### Placement\n\n${placement.slice(0, 5).map((f) => `- **${f.priority} ${f.title}**: ${f.detail} **Fix:** ${f.fix}`).join('\n')}${placement.length > 5 ? `\n- …and ${placement.length - 5} more` : ''}`);
  if (ledger.change?.affectedTests.length) parts.push(`**Run first:** ${ledger.change.affectedTests.slice(0, 8).map((t) => `\`${t}\``).join(' ')}`);
  const m = ledger.ai.stats;
  parts.push(`<sub>${ledger.ai.provider === 'none' ? 'No model: code-decided findings only' : `Model: ${ledger.ai.provider}, ${plural(m.requests, 'call')}, ${m.cached} cached`}${m.pending ? `, ${m.pending} awaiting answers` : ''}. ${url ? `[Full report](${url})` : 'Full report: job summary and the report artifact'}.</sub>`);
  return parts.join('\n\n') + '\n';
}

module.exports = { renderReport, renderComment, summarize };
