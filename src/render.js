'use strict';
// Stage 12: the report, rendered by code from the ledger. The shape is fixed (report-summary-template.md); only values change.
const { wrap, cell, plural } = require('./util');
const { BLOCKING } = require('./judge');

const RUN_WIDTH = 115;
const color = (s) => (s >= 90 ? '🟢' : s >= 70 ? '🟡' : '🔴');
const score = (x, n) => Math.round((100 * x) / n);

function scoreboard(L) {
  const rows = [
    ['1. Requirement health', L.scores.s1, (s) => `${s.x} of ${s.n} requirements are clear enough to test`, 'No requirement found'],
    ['2. Design health', L.scores.s2, (s) => `${s.x} of ${s.n} design decisions are clear enough to test`, 'No design decision found'],
    ['3. Requirement coverage', L.scores.s3, (s) => `${s.x} of ${s.n} requirements meet the test standard with tests running in PR CI`, L.tests.files ? 'No requirement found' : 'No tests found'],
    ['4. Design coverage', L.scores.s4, (s) => `${s.x} of ${s.n} design decisions that add behaviour meet the test standard with tests running in PR CI`, 'No design decision that adds behaviour found'],
    ['5. CI gate', L.scores.s5, (s) => `${s.x} of the ${s.n} CI checks are set up`, 'No CI configuration found'],
  ];
  return ['| Area | Score (0–100) | What the score means |', '| --- | :-: | --- |',
    ...rows.map(([name, s, meaning, na], k) => s?.n ? `| [${name}](#s${k + 1}) | ${color(score(s.x, s.n))} ${score(s.x, s.n)} | ${meaning(s)} |` : `| [${name}](#s${k + 1}) | n/a | ${s?.na || na} |`)].join('\n');
}

function runLine(L) {
  const src = L.sources;
  const read = src.read.length > 5 ? byFolder(src.read) : src.read.map((d) => `\`${d.path}\` (${counts(d)})`);
  const parts = [
    `Run ${L.meta.date} · Read: ${[...(read.length ? read : ['requirements none found, design none found']), `${L.tests.cases} tests in ${L.tests.files} files`, L.ci.workflowCount ? plural(L.ci.workflowCount, 'CI workflow') : 'CI none found'].join(', ')}`,
    `**Rules found:** ${L.rules.length} (${L.rules.filter((r) => r.hasSourceId).length} with an ID in the source)`,
    ...unjudged(L),
    '**Tests: read, not run**',
    `**Branch protection: ${L.branchProtection}**`,
    `**Not read:** ${[...listed(src.notRead), ...src.never].join(', ') || 'none'}.${src.notRead.length || src.never.length ? ' Rules that appear only in those sources are not counted.' : ''}`,
  ];
  if (src.skipped.length) parts.push(`**Skipped:** ${listed(src.skipped).join(', ')}. Rules in them are not counted.`);
  return wrap(parts.join(' · '), RUN_WIDTH);
}
// More than 5 entries: one per folder and reason ("`docs/archive/` (12 files, archived)"), so the line stays readable.
const dirOf = (p) => (p.includes('/') ? p.replace(/\/[^/]+$/, '/') : './');
function listed(ds) {
  if (ds.length <= 5) return ds.map((d) => `\`${d.path}\` (${d.reason})`);
  const group = (key) => {
    const g = new Map();
    for (const d of ds) {
      const reason = d.reason.replace(/^\d+ KB, /, ''), k = `${key(d.path)}\0${reason}`;
      g.set(k, [...(g.get(k) || []), d]);
    }
    return [...g.entries()].map(([k, x]) => (x.length === 1 ? `\`${x[0].path}\` (${x[0].reason})` : `\`${k.split('\0')[0]}\` (${plural(x.length, 'file')}, ${k.split('\0')[1]})`));
  };
  const g = group(dirOf);
  return g.length > 8 ? group(top2) : g;
}
// one level up from the file's folder, at most two levels deep: specs/a/x.md → specs/, openspec/specs/a/x.md → openspec/specs/
const top2 = (p) => { const d = p.split('/').slice(0, -1); return d.length ? `${d.slice(0, Math.max(1, Math.min(2, d.length - 1))).join('/')}/` : './'; };
// Rules the model gave no reply for are left out of the scores; say how many, so a high score is not read as a pass.
// Documents read, one entry per folder; when that still gives more than 8 entries, per top-two-level folder.
function byFolder(docs) {
  const group = (key) => Object.entries(docs.reduce((m, d) => { const k = key(d.path); (m[k] ||= { requirements: 0, decisions: 0, files: 0 }); m[k].requirements += d.requirements; m[k].decisions += d.decisions; m[k].files++; return m; }, {}));
  let g = group(dirOf);
  if (g.length > 8) g = group(top2);
  return g.map(([dir, c]) => `\`${dir}\` (${counts(c)} in ${plural(c.files, 'file')})`);
}
function unjudged(L) {
  const j = L.rules.filter((r) => !r.judged).length, t = L.rules.filter((r) => r.traced === false).length;
  return [j && `**Not judged:** ${plural(j, 'rule')} (no model reply; left out of scores 1-2)`, t && `**Not traced:** ${plural(t, 'rule')} (no model reply; left out of scores 3-4)`].filter(Boolean);
}
const counts = (c) => [c.requirements && plural(c.requirements, 'requirement'), c.decisions && plural(c.decisions, 'decision')].filter(Boolean).join(', ') || 'no rules';

function labeler() {
  const tagShown = new Set();
  let titled = new Set();
  return {
    section() { titled = new Set(); },
    label(r) {
      let s = r.id;
      if (!titled.has(r.id)) { titled.add(r.id); s += ` ${r.title}`; }
      if (r.critical && !tagShown.has(r.id)) {
        tagShown.add(r.id);
        s += r.critical.inherited ? ` (critical: ${r.critical.area}, as ${r.critical.inherited})` : r.critical.ai ? ` (critical: ${r.critical.area}, AI-tagged)` : ` (critical: ${r.critical.area} · "${r.critical.word}")`;
      }
      return s;
    },
  };
}

const LEVEL = { None: 'None', Blocked: 'Blocked', Weak: 'Weak', 'Checked nightly': 'Checked nightly', Meets: 'Meets the standard' };

function render(L) {
  const out = [], lab = labeler();
  const shown = (s) => L.issues.filter((i) => i.shown && i.section === s);
  const crit = L.rules.filter((r) => r.critical && r.addsBehaviour && r.traced !== false);
  const met = crit.filter((r) => r.evidence.level === 'Meets').map((r) => r.id);
  out.push(`# AI repository review: ${L.meta.repo} @ \`${L.meta.sha}\``, '', scoreboard(L), '');
  const untraced = L.rules.filter((r) => r.critical && r.addsBehaviour && r.traced === false).length;
  out.push(`Critical rules with tests that meet the standard and run in PR CI: **${met.length} of ${crit.length}${met.length && met.length <= 3 ? ` (${met.join(', ')})` : ''}**${untraced ? `, ${untraced} more not traced (no model reply)` : ''}.`, '');
  out.push(runLine(L), '', '---', '');
  out.push('## Top actions', '', '| # | Do this | What is at risk | Critical rules protected |', '| :-: | --- | --- | --- |');
  if (!L.actions.length) out.push('| – | No critical gap found. | – | – |');
  for (const a of L.actions) out.push(`| ${a.n} | ${cell(a.text.do)} | ${cell(a.text.risk)} | ${cell(a.protects)} |`);
  out.push('', '---', '');

  // 1. Requirement health
  // long ID lists are cut at 30; report-details.md has every rule
  const notCritical = (rs) => { const ids = rs.filter((r) => !r.critical).map((r) => r.id); const out = ids.length > 30 ? [...ids.slice(0, 30), `and ${ids.length - 30} more (see report-details.md)`] : ids; out.total = ids.length; return out; };
  // an empty table says why: nothing failed, or the model gave no reply for the critical rules
  const noRow = (rs, flag, text, what) => { const k = rs.filter((r) => r.critical && !flag(r)).length; return k ? `${text.replace(/^No critical|^Every critical/, (m) => `${m} ${what}`)}; ${plural(k, 'critical rule')} not ${what} (no model reply)` : text; };
  const reqs = L.rules.filter((r) => r.kind === 'requirement'), decs = L.rules.filter((r) => r.kind === 'decision');
  out.push('<a id="s1"></a>', '', '## 1. Requirement health', '');
  lab.section();
  if (!reqs.length) out.push('No requirement found.', '');
  else {
    out.push('| Issue number | Priority | Req | Fails on | Status | What fails, and the fix |', '| :-: | :-: | --- | --- | --- | --- |');
    for (const i of shown(1)) out.push(`| I-${i.n} | ${i.priority} | ${cell(lab.label(i.rule))} | ${failsOn(i)} | ${status(i.rule)} | ${cell(L.cells[i.n])} |`);
    if (!shown(1).length) out.push(`| – | – | – | – | – | ${noRow(reqs, (r) => r.judged, 'No critical requirement fails a measure', 'judged')} |`);
    const nc = notCritical(reqs);
    out.push('', `**Not critical (${nc.total}):** ${nc.join(', ') || 'none'}.`, '');
  }
  out.push('---', '');

  // 2. Design health
  out.push('<a id="s2"></a>', '', '## 2. Design health', '');
  lab.section();
  if (!decs.length) out.push('No design decision found.', '');
  else {
    out.push('| Issue number | Priority | Decision | Serves | Fails on | Status | What fails, and the fix |', '| :-: | :-: | --- | --- | --- | --- | --- |');
    for (const i of shown(2)) out.push(`| I-${i.n} | ${i.priority} | ${cell(lab.label(i.rule))} | ${i.rule.servesIds?.[0] || i.rule.restates || '–'} | ${failsOn(i)} | ${status(i.rule)} | ${cell(L.cells[i.n])} |`);
    if (!shown(2).length) out.push(`| – | – | – | – | – | – | ${noRow(decs, (r) => r.judged, 'No critical design decision fails a measure', 'judged')} |`);
    const nc = notCritical(decs);
    out.push('', `**Not critical (${nc.total}):** ${nc.join(', ') || 'none'}.`, '');
  }
  out.push('---', '');

  // 3. and 4. Coverage
  for (const [s, title, rs] of [[3, 'Requirement coverage', reqs], [4, 'Design coverage', decs.filter((d) => d.addsBehaviour)]]) {
    out.push(`<a id="s${s}"></a>`, '', `## ${s}. ${title}`, '');
    lab.section();
    if (!L.tests.files) out.push('No tests found. Every rule below needs a first test.', '');
    else if (!rs.length) out.push(s === 3 ? 'No requirement found.' : 'No design decision that adds behaviour found.', '');
    else {
      out.push('| Issue number | Priority | Rule | Level | Fails on | Why, and the fix |', '| :-: | :-: | --- | --- | --- | --- |');
      for (const i of shown(s)) {
        const lv = LEVEL[i.rule.evidence.level];
        out.push(`| I-${i.n} | ${i.priority} | ${cell(lab.label(i.rule))} | ${s === 3 && lv === 'None' ? '**None**' : lv} | ${s === 4 && i.check === 'Suspected not built' ? '**Suspected not built**' : i.check} | ${cell(L.cells[i.n])} |`);
      }
      if (!shown(s).length) out.push(`| – | – | – | – | – | ${noRow(rs, (r) => r.traced !== false, 'Every critical rule meets the test standard', 'traced')} |`);
      out.push('');
    }
    if (s === 4 && decs.length) {
      const own = decs.filter((d) => d.addsBehaviour).map((d) => d.id), re = decs.filter((d) => !d.addsBehaviour).map((d) => d.id), nc = notCritical(decs);
      out.push(`**Counted as rules of their own (${own.length}):** ${own.join(', ') || 'none'}. **Restate a requirement (${re.length}):** ${re.join(', ') || 'none'}. **Not critical (${nc.total}):** ${nc.join(', ') || 'none'}.`, '');
    }
    out.push('---', '');
  }

  // 5. CI gate
  out.push('<a id="s5"></a>', '', '## 5. CI gate', '');
  out.push('| Issue number | Priority | Check | Status | What is wrong, and the fix |', '| :-: | :-: | --- | :-: | --- |');
  for (const i of shown(5)) out.push(`| I-${i.n} | ${i.priority} | ${i.check} | ❌ | ${cell(i.text)} |`);
  for (const c of L.ci.checks.filter((x) => x.ok)) out.push(`| – | – | ${c.label} | ✅ | ${c.cite} |`);
  out.push('', '---', '');
  out.push(`**AI used:** model \`${L.meta.model}\` · **${L.meta.aiu.toFixed(2)} AIU** in total.`);
  return out.join('\n') + '\n';
}

function failsOn(i) {
  const name = BLOCKING.has(i.measure) ? `**${i.measure}**` : i.measure;
  return i.part ? `${name} (${i.part})` : name;
}
const status = (r) => (r.status === 'Blocked' ? '**Blocked**' : r.status);

module.exports = { render, runLine, scoreboard, RUN_WIDTH };
