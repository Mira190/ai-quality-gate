'use strict';
// The run: scan → extract → index → trace → placement → ci → gate → report.
//
//   stage      input                         decided by           output
//   scan       git ls-files                  code                 inventory (kinds, packages, languages)
//   extract    documents                     code                 rules (requirements, decisions), risk, limits
//   index      test files                    code                 test cases, the level each file needs
//   ci         workflows, manifests          code                 checks and their enforcement on pull requests
//   trace      rules × tests                 code, then the model links; the model sees only what code could not link
//   placement  proofs, test levels           code                 placement findings
//   gate       findings, diff, baseline      code                 verdict
//   report     ledger                        code                 report.md, comment.md, findings.json, results.sarif
//
// Every stage is guarded: one that throws is recorded under "Run" and the stages that do not need it still report.
// The gate never fails a build because the gate itself broke; it says so and passes what it could not judge.
const fs = require('node:fs');
const path = require('node:path');
const git = require('./git');
const { buildInventory } = require('./scan/inventory');
const { extractRules, idPattern } = require('./extract/rules');
const { indexTests, LEVELS } = require('./index/tests');
const { analyzeCI, bindTestDirs } = require('./ci/checks');
const { linkRules } = require('./trace/link');
const { judgeRules } = require('./trace/judge');
const { assessRules } = require('./trace/evidence');
const { assessPlacement } = require('./placement');
const { proofFindings, placementFindings, ciFindings } = require('./findings');
const { analyzeChange } = require('./change');
const { decide } = require('./gate');
const { makeProvider } = require('./ai/provider');
const { Cache } = require('./cache');
const { renderReport, renderComment, summarize } = require('./report/markdown');
const { toSarif } = require('./report/sarif');
const { renderBrief } = require('./report/brief');
const { readJson, writeAtomic } = require('./util');

/**
 * Options:  root, config, name, sha, base, staged, diffFile, cacheDir, baselineFile, outDir, answersFile, log
 * @returns the ledger: every fact behind the report.
 */
async function runPipeline(o) {
  const { root, config } = o;
  const log = o.log || (() => {});
  const timings = {}, degraded = [];
  const stage = async (name, fallback, fn) => {
    const t = Date.now();
    try { return await fn(); } catch (e) {
      degraded.push(`Stage "${name}" failed and was skipped: ${String(e.message).split('\n')[0]}`);
      log(`stage ${name} failed: ${e.stack || e.message}`);
      return fallback;
    } finally { timings[name] = Date.now() - t; }
  };
  const cache = new Cache(o.cacheDir || null);

  // scan
  const listed = git.listFiles(root);
  const inventory = await stage('scan', buildInventory([], config), () => buildInventory(listed.files, config));
  if (listed.truncated) degraded.push(`${listed.truncated} files beyond the listing limit were not looked at.`);
  let changes = null;
  if (o.diffFile) changes = git.parseDiff(fs.readFileSync(o.diffFile, 'utf8'));
  else if (o.base || o.staged) {
    changes = listed.git ? git.changes(root, { base: o.base, staged: o.staged }) : null;
    if (!changes) {
      // Asked to review a change and unable to see it: report everything, block nothing. Failing a pull request for
      // the repository's whole history because of a shallow clone would be the gate breaking the build.
      degraded.push(`The change could not be read (${o.base ? `base ${o.base} is not in this clone; check out with fetch-depth: 0` : 'not a git repository'}): everything is reported and nothing blocks.`);
      changes = new Map();
    }
  }

  // extract
  const idp = idPattern(config);
  const extracted = await stage('extract', { rules: [], docs: [], notRead: [], duplicates: [], truncated: 0, idp }, () => {
    /** @type {any} */
    const idHits = listed.git ? git.grep(root, idp.grep) : [];
    idHits.grepRan = listed.git;
    return extractRules({ root, inventory, idHits, cache, config });
  });
  if (extracted.truncated) degraded.push(`${extracted.truncated} rules over the rules.max limit (${config.rules.max}) were left out, non-critical first.`);

  // index
  const tests = await stage('index', { files: [], cases: [], skippedFiles: [] }, () => indexTests({ root, inventory, cache, config, idp }));

  // ci
  const ci = await stage('ci', { checks: [], steps: [], workflows: [], systems: [], testSteps: [], errors: [], hasCI: false, failed: true }, () => {
    const r = analyzeCI({ root, inventory, config });
    bindTestDirs(r, tests.files);
    return r;
  });

  // trace
  const provider = await stage('model', { name: 'none', available: false, note: 'the provider could not start' }, () => makeProvider(config, { answersFile: o.answersFile, requestsFile: o.outDir && path.join(o.outDir, 'ai-requests.json') }));
  const links = await stage('link', new Map(extracted.rules.map((r) => [r.id, { explicit: [], candidates: [], terms: [] }])), () => linkRules(extracted.rules, tests, config));
  const emptyStats = { shown: { tests: 0, lines: 0, of: 0, cut: 0, helpers: 0 }, needed: 0, cached: 0, locked: 0, asked: 0, confirmed: 0, requests: 0, pending: 0, failed: 0, overBudget: 0, chars: 0, errors: [] };
  const lockFile = config.ai.lock ? path.join(root, config.ai.lock) : null;
  const lock = (lockFile && readJson(lockFile)?.verdicts) || {};
  const judged = await stage('judge', { verdicts: new Map(), stats: emptyStats }, () => judgeRules({ root, rules: extracted.rules, links, provider, cache, lock, config, log }));
  provider.flush?.();
  const { proofs } = await stage('assess', { proofs: [] }, () => assessRules({ root, rules: extracted.rules, links, verdicts: judged.verdicts, ci }));

  // placement
  const emptyLevels = Object.fromEntries(LEVELS.map((l) => [l, { files: 0, cases: 0, pr: 0, notRun: [] }]));
  const placement = await stage('placement', { issues: [], levels: emptyLevels }, () => assessPlacement({ proofs, tests, ci }));

  // findings and gate
  const change = changes ? await stage('change', null, () => analyzeChange({ changes, inventory, tests, proofs, config })) : null;
  const findings = [
    ...proofFindings(proofs, config, new Set(placement.issues.filter((i) => i.kind === 'level-not-run').map((i) => i.level))),
    ...placementFindings(placement.issues, proofs),
    ...(ci.failed ? [] : ciFindings(ci, inventory, config)),
    ...(change?.findings || []),
  ];
  const baseline = o.baselineFile ? readJson(o.baselineFile) : null;
  const gate = decide({ findings, config, changes, baseline: baseline?.fingerprints ? baseline : null });

  const ledger = {
    version: 1,
    run: {
      name: o.name || path.basename(path.resolve(root)), sha: o.sha || git.head(root), base: o.base || null,
      changedFiles: changes ? changes.size : 0, files: { listed: inventory.stats.listed, ignored: inventory.stats.ignored },
      docs: extracted.docs, notRead: [...extracted.notRead, ...tests.skippedFiles], testFiles: tests.files.length, testCases: tests.cases.length, ciFiles: (inventory.byKind.ci || []).length,
      rules: { total: extracted.rules.length, withId: extracted.rules.filter((r) => !r.inferred).length, inferred: extracted.rules.filter((r) => r.inferred).length },
      langs: inventory.langs, packages: inventory.packages.length, degraded, configErrors: o.configErrors || [], timings,
    },
    config, gate, findings, proofs, placement, ci, change, tests,
    ai: { provider: provider.name, model: provider.model || '', note: provider.note || '', stats: judged.stats, cache: cache.stats },
  };
  ledger.summary = summarize(ledger);
  // The lock: every model verdict this run relied on, to commit. Asked once, reviewed in a diff, a fact from then on
  // on every machine, whatever happens to the CI cache.
  if (o.writeLock && lockFile) writeAtomic(lockFile, JSON.stringify({ version: 1, note: 'Model verdicts the quality gate relies on, keyed by a hash of the rule and the test excerpts. Regenerate: aqg run --write-lock', verdicts: Object.fromEntries(Object.entries(judged.used || {}).sort(([a], [b]) => (a < b ? -1 : 1))) }, null, 2) + '\n');
  cache.save();
  return ledger;
}

/** The ledger without the object graph: what findings.json holds, and what tools downstream may rely on. */
function serialise(ledger) {
  return {
    version: ledger.version, run: ledger.run, gate: ledger.gate, summary: ledger.summary,
    findings: ledger.findings.map(({ anchors: _a, ...f }) => f),
    rules: ledger.proofs.map((p) => ({
      id: p.rule.id, kind: p.rule.kind, title: p.rule.title, path: p.rule.path, line: p.rule.line, critical: p.rule.critical, tags: p.rule.tags.map((t) => t.area), inferred: p.rule.inferred,
      status: p.status, evidence: p.basis, holes: p.holes.map((h) => h.kind), expectedLevel: p.placement?.expected || p.modelLevel || p.rule.lowest,
      tests: p.links.map((l) => ({ path: l.case.file.path, line: l.case.line, name: l.case.name, level: l.case.file.level, by: l.by, skipped: l.case.skipped })),
      implementation: p.impl,
    })),
    levels: Object.fromEntries(Object.entries(ledger.placement.levels).map(([l, s]) => [l, { files: s.files, cases: s.cases, runOnPullRequests: s.pr }])),
    ci: ledger.ci.checks.map(({ id, state, where, command, detail }) => ({ id, state, where, command, detail })),
    change: ledger.change && { affectedTests: ledger.change.affectedTests, touchedRules: ledger.change.touchedRules },
    ai: ledger.ai,
  };
}

function writeOutputs(ledger, outDir, { reportUrl = '', writeBaseline = null } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  writeAtomic(path.join(outDir, 'report.md'), renderReport(ledger));
  writeAtomic(path.join(outDir, 'comment.md'), renderComment(ledger, { url: reportUrl }));
  writeAtomic(path.join(outDir, 'fix-brief.md'), renderBrief(ledger));
  writeAtomic(path.join(outDir, 'findings.json'), JSON.stringify(serialise(ledger), null, 2) + '\n');
  writeAtomic(path.join(outDir, 'results.sarif'), JSON.stringify(toSarif(ledger), null, 2) + '\n');
  // The baseline is what pull requests are compared against: every finding of this run, by fingerprint.
  if (writeBaseline) writeAtomic(writeBaseline, JSON.stringify({ sha: ledger.run.sha, fingerprints: ledger.findings.map((f) => f.fingerprint).sort() }) + '\n');
}

module.exports = { runPipeline, writeOutputs, serialise };
