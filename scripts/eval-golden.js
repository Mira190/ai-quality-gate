#!/usr/bin/env node
'use strict';
// eval-golden: does the report find what it should, and only that? Two tracks, one scorecard.
//   node scripts/eval-golden.js [--track seeded|real-ci|all] [--mode offline|live|record|replay] [--case <id>]...
//     [--model claude-haiku-5-5] [--votes 3] [--max-usd 2] [--dir <cache>] [--out <scorecard.md>] [--json <file>]
//
// seeded   bench/golden/seeded: a clean repository plus one case per seeded defect (and negative cases that must
//          stay clean). Every case says which issues it must produce; anything else reported is a false alarm.
//          offline: only what code decides (section 5, Specific, Traceable, critical tags) is scored; the rest of
//          each case is marked "not evaluable". live/record/replay score everything; record saves each case's model
//          replies to bench/golden/seeded/cassettes/<case>.json so later runs replay them for free.
// real-ci  bench/golden/real-ci/labels.json: real open-source repositories at pinned commits, whose CI was labelled by
//          hand, check by check. Code only (no model). Each repository is fetched at its commit; nothing is run.
//
// A "positive" is an issue (a defect reported). Recall = seeded or labelled defects reported; precision = reported
// issues that are real. Both are given per check, so a check that cannot be trusted is visible on its own line.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const argv = process.argv.slice(2);
const opt = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const opts = (k) => argv.flatMap((a, i) => (a === `--${k}` ? [argv[i + 1]] : []));
const track = opt('track', 'all'), mode = opt('mode', 'offline'), only = new Set(opts('case'));
const cache = opt('dir') || path.join(os.tmpdir(), 'aqg-golden');
const ROOT = path.join(__dirname, '..');

const key = (i) => (i.section === 5 ? `S5 ${i.check} ${i.kind || ''}`.trim() : `S${i.section} ${i.rule.id} ${i.measure || i.check}`);
// the check a key belongs to, without the rule: "S3 Covers stated limits", "S5 Secret scan secret-missing"
const checkOf = (k) => (k.startsWith('S5 ') ? k : k.replace(/^(S\d) \S+ /, '$1 '));
const CODE_DECIDED = /^S5 | (Specific|Traceable)$/;
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '–');

function loadEnv() {
  if (!fs.existsSync(path.join(ROOT, '.env'))) return;
  for (const l of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(l);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

// ---- seeded track ----------------------------------------------------------------------------------------------
async function seeded({ mode = 'offline', only = new Set() } = {}) {
  const { run } = require('../src/pipeline');
  const { LLM } = require('../src/llm');
  const { CASES, filesOf } = require('../bench/golden/seeded/cases');
  const tapes = path.join(ROOT, 'bench/golden/seeded/cassettes');
  const results = [];
  for (const c of CASES.filter((x) => !only.size || only.has(x.id))) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `golden-${c.id}-`));
    for (const [p, text] of Object.entries(filesOf(c))) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), text); }
    const cassette = mode === 'record' || mode === 'replay' ? path.join(tapes, `${c.id}.json`) : null;
    if (mode === 'replay' && !fs.existsSync(cassette)) { results.push({ c, skipped: 'no cassette' }); continue; }
    if (cassette) fs.mkdirSync(tapes, { recursive: true });
    const llm = new LLM({ model: opt('model', 'claude-haiku-5-5'), mode, cassette, maxUsd: Number(opt('max-usd', 2)), votes: Number(opt('votes', 3)) });
    let out;
    try { out = await run({ root: dir, repo: `golden/${c.id}`, sha: 'seeded', date: '2026-11-04', llm }); }
    catch (e) { results.push({ c, error: e.message }); continue; }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
    if (mode === 'record') llm.save();
    const L = out.ledger;
    const modelUsed = mode !== 'offline';
    const evaluable = (k) => modelUsed || CODE_DECIDED.test(k);
    const expect = (modelUsed ? c.expect : c.codeExpect || c.expect).filter(evaluable);
    const notEvaluable = c.expect.filter((k) => !evaluable(k) && !(c.codeExpect || []).includes(k));
    const allow = new Set(c.allow || []);
    const reported = [...new Set(L.issues.map(key))].filter(evaluable);
    const hit = expect.filter((k) => reported.includes(k)), missed = expect.filter((k) => !reported.includes(k));
    const falseAlarms = reported.filter((k) => !expect.includes(k) && !allow.has(k));
    const falseP0 = [...new Set(L.issues.filter((i) => i.priority === 'P0').map(key))].filter((k) => falseAlarms.includes(k));
    const critical = c.critical ? Object.entries(c.critical).map(([id, areas]) => {
      const r = L.rules.find((x) => x.id === id), got = r?.critical?.area || null;
      return { id, want: areas, got, ok: areas.length ? areas.includes(got) : got === null };
    }) : null;
    results.push({ c, expect, hit, missed, falseAlarms, falseP0, notEvaluable, critical, usd: L.meta.usage.usd, calls: L.meta.usage.calls, failed: L.meta.llmLog.filter((x) => x.error !== 'offline').length });
  }
  return results;
}

function seededReport(results) {
  const ok = results.filter((r) => !r.skipped && !r.error);
  const lines = [`## Seeded track (${ok.length} cases, mode ${mode})`, ''];
  const tp = ok.reduce((s, r) => s + r.hit.length, 0), fn = ok.reduce((s, r) => s + r.missed.length, 0), fp = ok.reduce((s, r) => s + r.falseAlarms.length, 0);
  const cleanCases = ok.filter((r) => !r.c.expect.length);
  const cleanFp = cleanCases.filter((r) => r.falseAlarms.length).length;
  const ne = ok.reduce((s, r) => s + r.notEvaluable.length, 0);
  lines.push(`**Seeded defects found: ${tp} of ${tp + fn} (recall ${pct(tp, tp + fn)})** · **Issues reported that were seeded: ${tp} of ${tp + fp} (precision ${pct(tp, tp + fp)})** · Cases that should be clean but got a false alarm: ${cleanFp} of ${cleanCases.length}${ne ? ` · Not evaluable without the model: ${ne} expected issues` : ''}`, '');
  // "hard" cases were written from real-world CI setups without looking at the tool's word lists; the rest were
  // written knowing them, so their score is an upper bound
  const groups = [['written knowing the tool', ok.filter((r) => r.c.group !== 'hard')], ['hard: written from real-world setups', ok.filter((r) => r.c.group === 'hard')]];
  lines.push('| Group | Cases | Recall | Precision | False alarms | Clean cases with a false alarm |', '| --- | :-: | :-: | :-: | :-: | :-: |');
  for (const [name, rs] of groups) {
    if (!rs.length) continue;
    const a = rs.reduce((s, r) => s + r.hit.length, 0), b = rs.reduce((s, r) => s + r.missed.length, 0), c = rs.reduce((s, r) => s + r.falseAlarms.length, 0), cl = rs.filter((r) => !r.c.expect.length);
    lines.push(`| ${name} | ${rs.length} | ${pct(a, a + b)} (${a}/${a + b}) | ${pct(a, a + c)} | ${c} | ${cl.filter((r) => r.falseAlarms.length).length} of ${cl.length} |`);
  }
  lines.push('');
  const falseP0 = ok.flatMap((r) => r.falseP0.map((k) => `${k} (${r.c.id})`));
  lines.push(`False P0 issues (the report's most urgent rows, wrong): ${falseP0.length ? falseP0.join('; ') : 'none'}.`, '');
  // per check
  const per = new Map();
  const row = (k) => per.get(k) || per.set(k, { seeded: 0, found: 0, fa: 0, faCases: [] }).get(k);
  for (const r of ok) {
    for (const k of r.expect) { const x = row(checkOf(k)); x.seeded++; if (r.hit.includes(k)) x.found++; }
    for (const k of r.falseAlarms) { const x = row(checkOf(k)); x.fa++; x.faCases.push(r.c.id); }
  }
  lines.push('| Check | Seeded | Found | Recall | False alarms | Precision | False alarms in |', '| --- | :-: | :-: | :-: | :-: | :-: | --- |');
  for (const [k, x] of [...per].sort((a, b) => a[0].localeCompare(b[0]))) lines.push(`| ${k} | ${x.seeded} | ${x.found} | ${pct(x.found, x.seeded)} | ${x.fa} | ${pct(x.found, x.found + x.fa)} | ${[...new Set(x.faCases)].join(', ') || '–'} |`);
  lines.push('');
  const crit = ok.flatMap((r) => r.critical || []);
  if (crit.length) lines.push(`Critical tags on the clean base: ${crit.filter((x) => x.ok).length} of ${crit.length} right${crit.some((x) => !x.ok) ? ` (wrong: ${crit.filter((x) => !x.ok).map((x) => `${x.id} got ${x.got || 'none'}, want ${x.want.join(' or ') || 'none'}`).join('; ')})` : ''}.`, '');
  lines.push('| Case | What was seeded | Expected | Found | Missed | False alarms |', '| --- | --- | :-: | :-: | --- | --- |');
  for (const r of results) {
    if (r.skipped || r.error) { lines.push(`| ${r.c.id} | ${r.c.what} | – | – | ${r.skipped || `error: ${r.error}`} | – |`); continue; }
    lines.push(`| ${r.c.id} | ${r.c.what} | ${r.expect.length}${r.notEvaluable.length ? ` (+${r.notEvaluable.length} n/e)` : ''} | ${r.hit.length} | ${r.missed.join('; ') || '–'} | ${r.falseAlarms.join('; ') || '–'} |`);
  }
  const usd = ok.reduce((s, r) => s + r.usd, 0), calls = ok.reduce((s, r) => s + r.calls, 0), failed = ok.reduce((s, r) => s + r.failed, 0);
  lines.push('', `Model: ${calls} calls, US$${usd.toFixed(3)}${failed ? `, ${failed} failed calls` : ''}.`, '');
  return { md: lines.join('\n'), summary: { cases: ok.length, tp, fn, fp, cleanFp, cleanCases: cleanCases.length, notEvaluable: ne } };
}

// ---- real-ci track ---------------------------------------------------------------------------------------------
const CHECK_KEYS = ['secret', 'coverage', 'dependency', 'format', 'lint', 'typecheck', 'tests'];
const git = (args, cwd) => execFileSync('git', ['-c', 'core.longpaths=true', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function fetchAt(repo, sha) {
  const dir = path.join(cache, repo.replace('/', '__'));
  try { if (git(['rev-parse', 'HEAD'], dir) === sha) return dir; } catch { /* not there yet */ }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q'], dir);
  git(['remote', 'add', 'origin', `https://github.com/${repo}.git`], dir);
  git(['fetch', '-q', '--depth', '1', '--filter=blob:limit=1m', 'origin', sha], dir);
  git(['checkout', '-q', 'FETCH_HEAD'], dir);
  return dir;
}

function realCi() {
  const { listFiles } = require('../src/inventory');
  const { indexTests } = require('../src/tests-index');
  const { analyzeCI } = require('../src/ci');
  const labels = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/golden/real-ci/labels.json'), 'utf8'));
  const rows = [];
  for (const l of labels.filter((x) => !only.size || only.has(x.repo))) {
    let ci;
    try {
      const root = fetchAt(l.repo, l.sha), files = listFiles(root);
      ci = analyzeCI(root, files, indexTests(root, files));
    } catch (e) { rows.push({ l, error: String(e.message).split('\n')[0] }); continue; }
    // the tool's "missing" for a check: any issue on it except the coverage-quality ones (an exclusion or a global
    // threshold means coverage is measured, so it is not a "missing" claim)
    const missing = Object.fromEntries(CHECK_KEYS.map((k) => {
      const c = ci.checks.find((x) => x.key === k);
      return [k, !c.ok && (c.issues || []).some((i) => !/coverage-(exclusion|global)/.test(i.kind))];
    }));
    rows.push({ l, missing, checks: ci.checks });
  }
  return rows;
}

function realCiReport(rows) {
  const ok = rows.filter((r) => !r.error);
  const lines = [`## Real-repository CI track (${ok.length} repositories, labelled by hand at pinned commits)`, ''];
  // positive = the check is missing (an issue). label false → truly missing.
  const per = Object.fromEntries(CHECK_KEYS.map((k) => [k, { tp: 0, fp: 0, fn: 0, tn: 0, na: 0, naFlagged: 0, errs: [] }]));
  for (const r of ok) for (const k of CHECK_KEYS) {
    const lab = r.l.labels[k], x = per[k], said = r.missing[k];
    if (lab === 'na' || lab == null) { x.na++; if (said) x.naFlagged++; continue; }
    const truly = lab === false;
    if (said && truly) x.tp++; else if (said && !truly) { x.fp++; x.errs.push(`${r.l.repo} (false alarm)`); } else if (!said && truly) { x.fn++; x.errs.push(`${r.l.repo} (missed)`); } else x.tn++;
  }
  const T = Object.values(per).reduce((s, x) => ({ tp: s.tp + x.tp, fp: s.fp + x.fp, fn: s.fn + x.fn, tn: s.tn + x.tn }), { tp: 0, fp: 0, fn: 0, tn: 0 });
  lines.push(`**Agreement with the hand labels: ${T.tp + T.tn} of ${T.tp + T.tn + T.fp + T.fn} checks (${pct(T.tp + T.tn, T.tp + T.tn + T.fp + T.fn)})** · "Missing" issues that are real: ${T.tp} of ${T.tp + T.fp} (precision ${pct(T.tp, T.tp + T.fp)}) · Real gaps reported: ${T.tp} of ${T.tp + T.fn} (recall ${pct(T.tp, T.tp + T.fn)})`, '');
  lines.push('| Check | Real gaps | Reported, real | False alarms | Missed | Precision | Recall | Wrong on |', '| --- | :-: | :-: | :-: | :-: | :-: | :-: | --- |');
  for (const k of CHECK_KEYS) {
    const x = per[k];
    lines.push(`| ${k} | ${x.tp + x.fn} | ${x.tp} | ${x.fp} | ${x.fn} | ${pct(x.tp, x.tp + x.fp)} | ${pct(x.tp, x.tp + x.fn)} | ${x.errs.join(', ') || '–'}${x.na ? ` (n/a for ${x.na}${x.naFlagged ? `, flagged anyway on ${x.naFlagged}` : ''})` : ''} |`);
  }
  lines.push('', '| Repository | Commit | ' + CHECK_KEYS.join(' | ') + ' |', '| --- | --- | ' + CHECK_KEYS.map(() => ':-:').join(' | ') + ' |');
  const cell = (r, k) => {
    const lab = r.l.labels[k];
    if (lab === 'na' || lab == null) return r.missing[k] ? 'n/a ⚠' : 'n/a';
    const said = r.missing[k], truly = lab === false;
    return said === truly ? (truly ? '✔ gap' : '✔') : (said ? '✘ FA' : '✘ miss');
  };
  for (const r of rows) lines.push(r.error ? `| ${r.l.repo} | \`${r.l.sha.slice(0, 7)}\` | ${CHECK_KEYS.map(() => '–').join(' | ')} |` + ` error: ${r.error}` : `| ${r.l.repo} | \`${r.l.sha.slice(0, 7)}\` | ${CHECK_KEYS.map((k) => cell(r, k)).join(' | ')} |`);
  lines.push('', '✔ gap = both say missing · ✔ = both say set up · ✘ FA = the report says missing, the label says set up · ✘ miss = the label says missing, the report says set up', '');
  return { md: lines.join('\n'), summary: T, per };
}

async function main() {
  loadEnv();
  if ((mode === 'live' || mode === 'record') && !process.env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY is not set'); process.exit(2); }
  const parts = [`# Golden set scorecard`, '', `Run ${new Date().toISOString().slice(0, 10)} · mode ${mode}${mode !== 'offline' ? ` · model ${opt('model', 'claude-haiku-5-5')}, ${opt('votes', 3)} votes` : ''}`, ''];
  const json = {};
  if (track === 'seeded' || track === 'all') { const r = seededReport(await seeded({ mode, only })); parts.push(r.md); json.seeded = r.summary; }
  if (track === 'real-ci' || track === 'all') { const r = realCiReport(realCi()); parts.push(r.md); json.realCi = { total: r.summary, per: r.per }; }
  const md = parts.join('\n');
  if (opt('out')) fs.writeFileSync(opt('out'), md);
  if (opt('json')) fs.writeFileSync(opt('json'), JSON.stringify(json, null, 1));
  console.log(md);
}

module.exports = { seeded, key, checkOf };
if (require.main === module) main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
