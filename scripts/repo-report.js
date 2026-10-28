#!/usr/bin/env node
'use strict';
// repo-report: one repository health report in the report-summary shape.
//   node scripts/repo-report.js --repo https://github.com/owner/name [--ref main]
//     [--requirement-url URL]... [--design-url URL]... [--test-doc-url URL]...
//     [--include GLOB]... [--exclude GLOB]... [--budget-kb 60] [--model claude-haiku-5-5] [--max-usd 2]
//     [--max-docs 60] [--out out/] [--cassette file.json --record | --replay | --fill] [--offline]
//   --repo may also be a local directory (then --name and --sha name it in the title).
// Env: ANTHROPIC_API_KEY (live runs), TARGET_REPO_PAT (private repositories, branch protection; never printed).
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('../src/pipeline');
const { LLM } = require('../src/llm');
const { clone, fetchDoc, branchProtection, defaultBranch } = require('../src/acquire');

function args(argv) {
  const multi = new Set(['requirement-url', 'design-url', 'test-doc-url', 'include', 'exclude']), o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2), flag = ['record', 'replay', 'offline', 'fill'].includes(k);
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
  const want = [...(o['requirement-url'] || []).map((u) => [u, 'requirement']), ...(o['design-url'] || []).map((u) => [u, 'design']), ...(o['test-doc-url'] || []).map((u) => [u, 'test'])];
  const external = await Promise.all(want.map(async ([u, kindHint]) => ({ ...(await fetchDoc(u)), kindHint })));
  // fill: replay what the cassette has and write the other prompts to <cassette>.pending.json, to be answered by hand
  const mode = o.replay ? 'replay' : o.fill ? 'fill' : o.offline ? 'offline' : o.record ? 'record' : 'live';
  if ((mode === 'live' || mode === 'record') && !process.env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY is not set'); process.exit(2); }
  const llm = new LLM({ model: o.model || 'claude-haiku-5-5', mode, cassette: o.cassette || null, maxUsd: Number(o['max-usd'] || 2) });
  const date = o.date || new Date().toISOString().slice(0, 10);
  const { ledger, report, details } = await run({ root, repo: name, sha, date, llm, external, budgetKb: Number(o['budget-kb'] || 60), maxDocs: o['max-docs'] ? Number(o['max-docs']) : undefined, include: o.include || [], exclude: o.exclude || [], branchProtection: bp, progress: (m) => console.error(`[repo-report] ${m}`) });
  llm.save();
  fs.writeFileSync(path.join(out, 'report.md'), report);
  fs.writeFileSync(path.join(out, 'report-details.md'), details);
  fs.writeFileSync(path.join(out, 'ledger.json'), JSON.stringify(ledger, (k, v) => (k === 'artifacts' || k === 'text' && typeof v === 'string' && v.length > 2000 ? undefined : v), 1));
  console.error(`[repo-report] wrote ${out}/report.md (${ledger.issues.filter((i) => i.shown).length} issues shown, ${ledger.meta.usage.calls} model calls, ${ledger.meta.aiu.toFixed(2)} AIU)`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `report_path=${path.join(out, 'report.md')}\nledger_path=${path.join(out, 'ledger.json')}\np0_count=${ledger.issues.filter((i) => i.shown && i.priority === 'P0').length}\n`);
}

main().catch((e) => { console.error(`[repo-report] failed: ${e.stack || e.message}`); process.exit(1); });
