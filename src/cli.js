'use strict';
// Command line. The GitHub Action, a pre-push hook and a coding agent all go through here.
//
//   aqg run   [--repo .] [--base <sha> | --staged | --diff <file>] [--out out] [--enforce]
//   aqg rules [--repo .] [--file <path>] [--json]     the rules a file is bound by, for a person or an agent about to edit it
//
// Exit code: 0, unless --enforce is given and the gate fails (1). A crash of the gate itself is never a failed build.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sha } = require('./util');
const { loadConfig } = require('./config');
const { runPipeline, writeOutputs, serialise } = require('./pipeline');
const { annotations } = require('./report/sarif');

const FLAGS = {
  repo: 'path', config: 'path', out: 'path', base: 'value', diff: 'path', staged: 'bool', name: 'value', sha: 'value', cache: 'path', baseline: 'path', 'write-baseline': 'bool',
  answers: 'path', provider: 'value', model: 'value', 'fail-on': 'value', basis: 'value', 'all-findings': 'bool', 'ai-scope': 'value', 'max-requests': 'value', enforce: 'bool', 'report-url': 'value',
  file: 'value', json: 'bool', quiet: 'bool', help: 'bool',
};

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { args._.push(a); continue; }
    const [k, inline] = a.slice(2).split(/=(.*)/s);
    if (!(k in FLAGS)) throw new Error(`unknown option --${k}`);
    if (FLAGS[k] === 'bool') args[k] = inline === undefined ? true : inline !== 'false';
    else { args[k] = inline !== undefined ? inline : argv[++i]; if (args[k] === undefined) throw new Error(`--${k} needs a value`); }
  }
  return args;
}

const HELP = `ai-quality-gate

  aqg run   [--repo .] [--base <sha> | --staged | --diff <file>] [--out out] [--enforce]
  aqg rules [--repo .] [--file <path>] [--json]

run options
  --config <file>        gate config (default: <repo>/.quality-gate.yml)
  --base <sha>           review the change since this commit (a pull request)
  --staged               review the staged change (a pre-commit hook)
  --cache <dir>          where parsed files and model verdicts are kept between runs
  --baseline <file>      findings already on the default branch; --write-baseline writes it from this run
  --provider <name>      auto | copilot | command | handoff | none
  --answers <file>       handoff provider: answers to the prompts in <out>/ai-requests.json
  --fail-on <P0..P3|never>   --basis S,V   --all-findings   --ai-scope critical|all   --max-requests <n>
  --enforce              exit 1 when the gate fails
`;

async function main(argv) {
  let args;
  try { args = parseArgs(argv); } catch (e) { console.error(`ai-quality-gate: ${e.message}\n\n${HELP}`); return 2; }
  const cmd = args._[0] || 'run';
  if (args.help || cmd === 'help') { console.log(HELP); return 0; }
  const root = path.resolve(args.repo || '.');
  if (!fs.existsSync(root)) { console.error(`ai-quality-gate: ${root} does not exist`); return 2; }
  const overrides = { ai: {}, gate: {} };
  if (args.provider) overrides.ai.provider = args.provider;
  if (args.model) overrides.ai.model = args.model;
  if (args['ai-scope']) overrides.ai.scope = args['ai-scope'];
  if (args['max-requests']) overrides.ai.max_requests = Number(args['max-requests']);
  if (args['fail-on']) overrides.gate.fail_on = args['fail-on'];
  if (args.basis) overrides.gate.basis = args.basis.split(',').map((s) => s.trim()).filter(Boolean);
  if (args['all-findings']) overrides.gate.new_only = false;
  if (cmd === 'rules') overrides.ai.provider = 'none';
  const { config, errors } = loadConfig(args.config ? path.resolve(args.config) : path.join(root, '.quality-gate.yml'), overrides);
  const log = args.quiet ? () => {} : (m) => console.error(`[aqg] ${m}`);
  for (const e of errors) log(`config: ${e}`);

  const outDir = path.resolve(args.out || 'out');
  // outside the repository by default: a cache inside it would show up as untracked files
  const cacheDir = args.cache ? path.resolve(args.cache) : path.join(os.tmpdir(), `aqg-cache-${sha(root, 12)}`);
  const ledger = await runPipeline({
    root, config, configErrors: errors, name: args.name, sha: args.sha, base: args.base, staged: args.staged, diffFile: args.diff && path.resolve(args.diff),
    cacheDir, baselineFile: args.baseline && path.resolve(args.baseline), outDir: cmd === 'run' ? outDir : null,
    answersFile: args.answers ? path.resolve(args.answers) : path.join(outDir, 'ai-answers.json'), log,
  });

  if (cmd === 'rules') return printRules(ledger, args);
  if (cmd !== 'run') { console.error(`ai-quality-gate: unknown command "${cmd}"\n\n${HELP}`); return 2; }

  writeOutputs(ledger, outDir, { reportUrl: args['report-url'], writeBaseline: args['write-baseline'] && args.baseline ? path.resolve(args.baseline) : null });
  const g = ledger.gate, s = ledger.summary;
  if (process.env.GITHUB_ACTIONS) for (const a of annotations(ledger)) console.log(a);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, [`verdict=${g.verdict}`, `blocking=${g.blocking}`, `p0=${g.counts.P0}`, `p1=${g.counts.P1}`, `report=${path.join(outDir, 'report.md')}`, `sarif=${path.join(outDir, 'results.sarif')}`,
      `affected_tests=${(ledger.change?.affectedTests || []).join(' ')}`, `pending=${ledger.ai.stats.pending}`].join('\n') + '\n');
  }
  if (!args.quiet) {
    console.log(`${g.verdict === 'fail' ? 'FAIL' : 'PASS'}  blocking ${g.blocking}  P0 ${g.counts.P0}  P1 ${g.counts.P1}  P2 ${g.counts.P2}  P3 ${g.counts.P3}`);
    console.log(`rules ${s.proven}/${s.rules} proven (critical ${s.criticalProven}/${s.critical})  ·  CI ${s.ciEnforced}/${s.ciApplicable} enforced  ·  placement findings ${s.placementFindings}`);
    for (const f of ledger.findings.filter((x) => x.blocking).slice(0, 10)) console.log(`  ${f.priority} ${f.title}${f.loc ? `  (${f.loc.path}:${f.loc.line})` : ''}`);
    if (ledger.ai.stats.pending) console.log(`${ledger.ai.stats.pending} rule(s) await a model answer: ${path.join(outDir, 'ai-requests.json')} → write ${path.join(outDir, 'ai-answers.json')} and run again`);
    console.log(`report: ${path.join(outDir, 'report.md')}`);
  }
  return args.enforce && g.verdict === 'fail' ? 1 : 0;
}

/** Shift left as far as it goes: before the edit. Which rules does this file implement or test, and how well are they proven? */
function printRules(ledger, args) {
  const data = serialise(ledger).rules.filter((r) => r.status !== 'inactive' && r.status !== 'not_a_rule');
  const file = args.file && args.file.replace(/^\.\//, '');
  const list = file ? data.filter((r) => r.path === file || r.implementation.includes(file) || r.tests.some((t) => t.path === file)) : data;
  if (args.json) { console.log(JSON.stringify(list, null, 2)); return 0; }
  if (!list.length) { console.log(file ? `No known rule is implemented or tested by ${file}.` : 'No rules found.'); return 0; }
  for (const r of list) {
    console.log(`${r.id}  ${r.status.toUpperCase()}${r.critical ? `  critical(${r.tags.join(',')})` : ''}  ${r.title}  [${r.path}:${r.line}]`);
    for (const t of r.tests.slice(0, 3)) console.log(`    test  ${t.path}:${t.line}  (${t.level})`);
    if (!r.tests.length) console.log(`    no test: write a ${r.expectedLevel} test and name ${r.id} in it`);
  }
  return 0;
}

module.exports = { main, parseArgs };
