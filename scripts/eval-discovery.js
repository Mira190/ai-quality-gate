#!/usr/bin/env node
'use strict';
// eval-discovery: how well stage 2 finds requirement and design documents in real repositories.
//   node scripts/eval-discovery.js [--live] [--split tuned|held-out|held-out-large|test] [--dir <cache>] [--ablate f1,f2] [--quiet]
// Each repository in bench/discovery/repos.json is fetched at its pinned commit, documents only (sparse checkout:
// nothing else is downloaded and nothing is run). Gold labels are in bench/discovery/gold.json: [grade, kind, status]
// per path, grade 2 = a requirement or design document of the product, 1 = borderline (not counted either way); a
// path that is not listed is grade 0. Target = grade 2 that is not superseded.
// --live lets the model classify the borderline candidates (claude-haiku-5-5, a few cents); without it, code only.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { discover } = require('../src/discover');
const { listFiles } = require('../src/inventory');
const { classifyDocs } = require('../src/judge');
const { LLM } = require('../src/llm');

const argv = process.argv.slice(2), opt = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : null; };
const live = argv.includes('--live'), split = opt('split'), ablate = (opt('ablate') || '').split(',').filter(Boolean), quiet = argv.includes('--quiet'), cache = opt('dir') || path.join(os.tmpdir(), 'aqg-discovery-bench');
const repos = require('../bench/discovery/repos.json').filter((r) => !split || r.split === split);
const gold = require('../bench/discovery/gold.json');
const DOCS = ['*.md', '*.mdx', '*.markdown', '*.rst', '*.adoc', '*.asciidoc', '*.txt', '*.feature', '*.org'];
const git = (args) => execFileSync('git', ['-c', 'core.longpaths=true', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function fetchRepo({ repo, sha }) {
  const dir = path.join(cache, repo.replace('/', '__'));
  if (fs.existsSync(dir) && git(['-C', dir, 'rev-parse', 'HEAD']) === sha) return dir;
  fs.rmSync(dir, { recursive: true, force: true });
  git(['init', '-q', dir]);
  git(['-C', dir, 'remote', 'add', 'origin', `https://github.com/${repo}.git`]);
  git(['-C', dir, 'config', 'core.sparseCheckout', 'true']);
  git(['-C', dir, 'sparse-checkout', 'set', '--no-cone', ...DOCS]);
  git(['-C', dir, 'fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', sha]);
  git(['-C', dir, 'checkout', '-q', 'FETCH_HEAD']);
  return dir;
}

if (live) for (const l of fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8').split(/\r?\n/) : []) {
  const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(l);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
}

(async () => {
  const llm = live ? new LLM({ mode: 'live', maxUsd: 1 }) : null;
  const sum = {};
  for (const r of repos) {
    const root = fetchRepo(r), G = gold[r.repo] || {};
    const files = listFiles(root);
    let asked = [];
    const d = await discover({ root, files, ablate, classify: async (c) => { asked = c.map((x) => x.path); return live ? classifyDocs(llm, c) : []; } });
    const read = new Set(d.read.map((x) => x.path));
    const over = new Set(d.notRead.filter((x) => /budget/.test(x.reason) && !/classification/.test(x.reason)).map((x) => x.path));
    const target = Object.keys(G).filter((p) => G[p][0] === 2 && G[p][2] !== 'superseded');
    const hit = target.filter((p) => read.has(p)), fp = [...read].filter((p) => !G[p]);
    const miss = target.filter((p) => !read.has(p) && !over.has(p)), sup = [...read].filter((p) => G[p]?.[2] === 'superseded');
    const s = (sum[r.split] ||= { target: 0, hit: 0, over: 0, fp: 0, sup: 0, asked: 0, reach: 0, askedNeg: 0 });
    s.target += target.length; s.hit += hit.length; s.over += target.filter((p) => over.has(p)).length; s.fp += fp.length; s.sup += sup.length; s.asked += asked.length; s.reach += target.filter((p) => read.has(p) || asked.includes(p)).length; s.askedNeg += asked.filter((p) => !G[p]).length;
    if (!quiet) console.log(`${r.repo} [${r.split}]: target ${target.length}, read ${hit.length}, over budget ${target.filter((p) => over.has(p)).length}, missed ${miss.length}, false ${fp.length}, superseded read ${sup.length}, asked ${asked.length}`);
    if (!quiet && miss.length) console.log(`  missed: ${miss.slice(0, 6).join(', ')}${miss.length > 6 ? ` (+${miss.length - 6})` : ''}`);
    if (!quiet && fp.length) console.log(`  false: ${fp.slice(0, 6).join(', ')}${fp.length > 6 ? ` (+${fp.length - 6})` : ''}`);
  }
  for (const [k, s] of Object.entries(sum)) {
    console.log(`${k}: recall ${(s.hit / (s.target - s.over || 1)).toFixed(2)} of the targets within budget (${s.hit}/${s.target - s.over}; ${s.over} over budget), precision ${(s.hit / (s.hit + s.fp || 1)).toFixed(2)} (grade 1 not counted), superseded read ${s.sup}, model-classified ${s.asked} (${s.askedNeg} grade 0), read or classified ${(s.reach / (s.target - s.over || 1)).toFixed(2)}`);
  }
  if (llm) console.log(`model: ${llm.usage.calls} calls, US$${llm.usage.usd.toFixed(3)}`);
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
