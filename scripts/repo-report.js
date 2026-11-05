#!/usr/bin/env node
'use strict';
// repo-report: one repository health report in the report-summary shape.
//   node scripts/repo-report.js --repo https://github.com/owner/name [--ref main]
//     [--requirement-url URL]... [--design-url URL]... [--test-doc-url URL]...
//     [--include GLOB]... [--exclude GLOB]... [--budget-kb 60] [--model claude-haiku-5-5] [--max-usd 2]
//     [--max-docs 60] [--votes 3] [--out out/] [--cassette file.json --record | --replay | --fill] [--offline]
//     [--config .quality-gate.yml] [--memo .quality-gate/memo.json] [--baseline baseline.json] [--write-baseline]
//     [--changed-files changed.txt] [--fail-on P1] [--basis E,S,V] [--all-findings] [--execute] [--test-command CMD]
//     [--report-url URL] [--gate] [--history DIR] [--commit SHA] [--diff changes.diff] [--batch-api]
//   --repo may also be a local directory (then --name and --sha name it in the title).
// Gate outputs (always written): out/gate.json, out/results.sarif, out/comment.md, out/baseline.json. With --gate the
// exit code is 1 when the gate fails (3 for a config error), so a workflow step can block the merge.
// Env: ANTHROPIC_API_KEY (live runs), TARGET_REPO_PAT (private repositories, branch protection; never printed).
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('../src/pipeline');
const { LLM } = require('../src/llm');
const { clone, fetchDoc, branchProtection, defaultBranch } = require('../src/acquire');
const { loadConfig, policyOf } = require('../src/config');
const { decide, toBaseline, toSarif, toComment } = require('../src/gate');
const VERSION = require('../package.json').version;

function args(argv) {
  const multi = new Set(['requirement-url', 'design-url', 'test-doc-url', 'include', 'exclude']), o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2), flag = ['record', 'replay', 'offline', 'fill', 'write-baseline', 'all-findings', 'execute', 'gate', 'batch-api'].includes(k);
    const v = flag ? true : argv[++i];
    if (multi.has(k)) (o[k] ||= []).push(...String(v).split(/[\n,]/).map((s) => s.trim()).filter(Boolean)); else o[k] = v;
  }
  return o;
}

// .env in the working directory, for local runs; a variable already set wins. CI passes secrets as env instead.
function loadEnv(file = '.env') {
  if (!fs.existsSync(file)) return;
  for (const l of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(l);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

async function main() {
  loadEnv();
  const o = args(process.argv.slice(2));
  if (!o.repo) { console.error('usage: repo-report --repo <github url | directory> [options]'); process.exit(2); }
  const out = o.out || 'out';
  fs.mkdirSync(out, { recursive: true });
  let root, name, sha, bp = 'not readable';
  if (fs.existsSync(o.repo) && fs.statSync(o.repo).isDirectory()) {
    root = path.resolve(o.repo); name = o.name || path.basename(root); sha = o.sha || 'local';
  } else {
    const c = clone(o.repo, o.ref);
    root = c.root; name = c.name; sha = c.sha;
    bp = await branchProtection(c.name, o.ref || defaultBranch(root));
  }
  const cfgPath = o.config || path.join(root, '.quality-gate.yml');
  const { config, errors } = loadConfig(cfgPath);
  if (errors.length) { console.error(`[repo-report] ${cfgPath}:\n  ${errors.join('\n  ')}`); process.exit(3); }
  const want = [...(o['requirement-url'] || []).map((u) => [u, 'requirement']), ...(o['design-url'] || []).map((u) => [u, 'design']), ...(o['test-doc-url'] || []).map((u) => [u, 'test'])];
  const external = await Promise.all(want.map(async ([u, kindHint]) => ({ ...(await fetchDoc(u)), kindHint })));
  // fill: replay what the cassette has and write the other prompts to <cassette>.pending.json, to be answered by hand
  const mode = o.replay ? 'replay' : o.fill ? 'fill' : o.offline ? 'offline' : o.record ? 'record' : 'live';
  if ((mode === 'live' || mode === 'record') && !process.env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY is not set'); process.exit(2); }
  const llm = new LLM({ model: o.model || config.model?.name || 'claude-haiku-5-5', mode, cassette: o.cassette || null, maxUsd: Number(o['max-usd'] || config.model?.max_usd || 2), votes: o.votes || process.env.VOTES ? Number(o.votes || process.env.VOTES) : config.model?.votes ?? 3, memo: o.memo || null, adaptive: config.model?.adaptive ?? true, batchApi: !!o['batch-api'] });
  const { parseDiff } = require('../src/diff');
  const diff = o.diff && fs.existsSync(o.diff) ? parseDiff(fs.readFileSync(o.diff, 'utf8')) : null;
  const testCommand = o['test-command'] || config.execute?.test_command;
  const execute = o.execute && testCommand ? { command: testCommand, timeoutS: config.execute?.timeout_s, maxMutants: config.execute?.max_mutants, scope: config.execute?.scope } : null;
  if (o.execute && !testCommand) console.error('[repo-report] --execute needs --test-command or execute.test_command in the config; skipping execution');
  const date = o.date || new Date().toISOString().slice(0, 10);
  const { ledger, report, details } = await run({ root, repo: name, sha, date, llm, external, budgetKb: Number(o['budget-kb'] || config.documents?.budget_kb || 60), maxDocs: o['max-docs'] ? Number(o['max-docs']) : undefined, include: [...(o.include || []), ...(config.documents?.include || [])], exclude: [...(o.exclude || []), ...(config.documents?.exclude || [])], branchProtection: bp, critical: config.critical || null, execute, diff, progress: (m) => console.error(`[repo-report] ${m}`) });
  llm.save();
  fs.writeFileSync(path.join(out, 'report.md'), report);
  fs.writeFileSync(path.join(out, 'report-details.md'), details);
  fs.writeFileSync(path.join(out, 'ledger.json'), JSON.stringify(ledger, (k, v) => (k === 'artifacts' || k === 'text' && typeof v === 'string' && v.length > 2000 ? undefined : v), 1));
  // the gate: what may block this change (gate.js)
  const read = (f) => (f && fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
  const baseline = read(o.baseline) ? JSON.parse(read(o.baseline)) : null;
  const changed = read(o['changed-files']) ? read(o['changed-files']).split(/\r?\n/).map((x) => x.trim()).filter(Boolean) : null;
  const policy = policyOf(config, { failOn: o['fail-on'], basis: o.basis ? String(o.basis).split(',').map((x) => x.trim()) : undefined, newOnly: o['all-findings'] ? false : undefined });
  const gate = decide(ledger, { policy, baseline, changed, suppress: config.suppress || [], today: date });
  const cells = ledger.cells || {};
  fs.writeFileSync(path.join(out, 'gate.json'), JSON.stringify({ repo: name, sha, date, verdict: gate.verdict, splitVotes: llm.splitStats || null, votes: llm.voteStats || null, cacheReadTokens: llm.usage.cache_read_tokens || 0, memo: llm.memoPath ? llm.memoStats : null, counts: gate.counts, policy: gate.policy, problems: gate.problems, baseline: baseline ? { sha: baseline.sha, date: baseline.date } : null, changedFiles: changed ? changed.length : null, findings: gate.findings.map((f) => ({ fingerprint: f.fingerprint, priority: f.priority, basis: f.basis, agreement: f.agreement ?? null, section: f.section, rule: f.rule?.id || null, check: f.measure || f.check, part: f.part || '', isNew: f.isNew, inScope: f.inScope, suppressed: f.suppressed, blocking: f.blocking, why: f.why, files: f.files, issue: f.n || null })) }, null, 1));
  // traceability by construction: rule-ID tags for verified links, pending tests for untested rules (git apply)
  fs.writeFileSync(path.join(out, 'construct.patch'), ledger.construct.patch);
  fs.writeFileSync(path.join(out, 'construct.json'), JSON.stringify({ tags: ledger.construct.tags, pending: ledger.construct.pending && { path: ledger.construct.pending.path, rules: ledger.construct.pending.rules } }, null, 1));
  fs.writeFileSync(path.join(out, 'affected.json'), JSON.stringify({ rules: ledger.impact.affected, testsToRun: ledger.impact.testsToRun || [] }, null, 1));
  fs.writeFileSync(path.join(out, 'results.sarif'), JSON.stringify(toSarif(gate, ledger, { cells, version: VERSION }), null, 1));
  fs.writeFileSync(path.join(out, 'comment.md'), toComment(gate, ledger, { reportUrl: o['report-url'] || '', cells }) + '\n');
  fs.writeFileSync(path.join(out, 'baseline.json'), JSON.stringify(toBaseline(gate, ledger.meta), null, 1));
  // history for scripts/usefulness.js: one compact entry per run, the newest 100 kept
  if (o.history) {
    fs.mkdirSync(o.history, { recursive: true });
    const time = new Date().toISOString();
    fs.writeFileSync(path.join(o.history, `${time.replace(/[:.]/g, '-')}.json`), JSON.stringify({ time, commit: o.commit || sha, findings: gate.findings.map((f) => ({ fingerprint: f.fingerprint, check: f.measure || f.check, basis: f.basis, priority: f.priority, files: f.files })) }));
    const old = fs.readdirSync(o.history).filter((f) => f.endsWith('.json')).sort();
    for (const f of old.slice(0, Math.max(0, old.length - 100))) fs.unlinkSync(path.join(o.history, f));
  }
  if (o['write-baseline'] && o.baseline) fs.writeFileSync(o.baseline, JSON.stringify(toBaseline(gate, ledger.meta), null, 1));
  console.error(`[repo-report] gate: ${gate.verdict} (${gate.counts.blocking} blocking, ${gate.counts.newAdvisory} new advisory, ${gate.counts.existing} existing, ${gate.counts.suppressed} suppressed; evidence ${Object.entries(gate.counts.byBasis).map(([k, v]) => `${k}=${v}`).join(' ')})${ledger.meta.memo ? `; memo ${ledger.meta.memo.hits} hits / ${ledger.meta.memo.misses} misses` : ''}`);
  console.error(`[repo-report] wrote ${out}/report.md (${ledger.issues.filter((i) => i.shown).length} issues shown, ${ledger.meta.usage.calls} model calls, ${ledger.meta.aiu.toFixed(2)} AIU)`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `report_path=${path.join(out, 'report.md')}\nledger_path=${path.join(out, 'ledger.json')}\np0_count=${ledger.issues.filter((i) => i.shown && i.priority === 'P0').length}\nverdict=${gate.verdict}\nblocking=${gate.counts.blocking}\nsarif_path=${path.join(out, 'results.sarif')}\ncomment_path=${path.join(out, 'comment.md')}\naffected_tests=${(ledger.impact.testsToRun || []).join(' ')}\n`);
  if (o.gate && gate.verdict === 'fail') process.exitCode = 1;
}

main().catch((e) => { console.error(`[repo-report] failed: ${e.stack || e.message}`); process.exit(1); });
