'use strict';
// The gate: which findings may fail a pull request, and which only inform. The report says everything it found; the
// gate blocks only on what it can prove and what the change introduced. Four filters, all code:
//
// 1. Evidence basis (two-key rule). Every finding carries the strongest evidence behind it:
//      E  executed: a mutant run against the linked tests (execute.js)
//      S  static: code alone decided it (CI parsing, vague-term list, missing step, a search that found no test at all)
//      V  verified: the model proposed it and code checked a deterministic witness (two numbers that conflict, a test
//         link that passes the import-reachability check, a placement seam found in the code)
//      M  model: a cited judgment of meaning (does this assertion check the rule, is this decision built)
//    By default E, S and V may block; M never blocks on its own. A model that is right 80% of the time is a fine
//    reviewer and a bad gatekeeper: one false red build costs more trust than ten missed comments.
// 2. New only (Clean as You Code). A finding whose fingerprint is in the baseline (the default branch's last run) is
//    existing debt: reported, never blocking. The pull request answers only for what it adds.
// 3. Scope. With the changed-file list, a finding blocks only if one of its files (rule document, implementation,
//    linked tests, workflow) is in the change.
// 4. Suppressions with an owner, a reason and an expiry (≤ 1 year). Expired suppressions come back on their own.
//
// Fingerprints do not use rule IDs (REQ-7 becomes REQ-8 when a rule is inserted above it) or line numbers: they hash
// the normalised rule text, the check, and the part of the evidence that names the problem.
const crypto = require('node:crypto');

const BASIS_RANK = { E: 0, S: 1, V: 2, M: 3 };
const PRI = (p) => Number(String(p).slice(1));
const norm = (s) => String(s || '').toLowerCase().replace(/\b(req|dec|fr|nfr|us|ac)[-_]?\d+\b/g, '').replace(/[^a-z0-9%$.]+/g, ' ').trim();
const h = (...xs) => crypto.createHash('sha256').update(xs.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\u0000')).digest('hex').slice(0, 20);

// S checks: decided by code from facts code gathered. Checks that rest on the model's choice of implementation or of
// test links are V (the model proposed, code verified reachability and line existence).
const CODE_TEST_CHECKS = new Set(['Not skipped', 'Runs on PR']);
const VERIFIED_TEST_CHECKS = new Set(['Calls the code', 'Covers stated limits', 'Crosses the real boundary', 'Placement']);

function basisOf(i) {
  if (i.section === 5) return 'S';
  if (i.section <= 2) {
    const f = (i.rule.fails || []).find((x) => x.measure === i.measure && (x.part || '') === (i.part || ''));
    if (f?.code) return 'S';
    if ((i.measure === 'Consistent' || i.measure === 'Trade-off') && i.rule.numericConflicts?.includes(i.conflictWith)) return 'V';
    return 'M';
  }
  const fact = (i.rule.evidence?.fails || []).find((f) => f.check === i.check);
  if (fact?.basis) return fact.basis;
  if (i.check === 'No test') return i.rule.strongCandidates === 0 ? 'S' : 'M';
  if (CODE_TEST_CHECKS.has(i.check)) return i.rule.links.every((l) => l.source === 'tag' || l.source === 'test doc') ? 'S' : 'V';
  if (VERIFIED_TEST_CHECKS.has(i.check)) return 'V';
  return 'M'; // Asserts the rule (model), Suspected not built
}

function fingerprint(i) {
  if (i.section === 5) return h('ci', i.checkKey || i.check, i.kind || '', norm(i.text).replace(/[\w./-]+:\d+/g, ''));
  const partner = i.conflictWith && i.partnerText ? norm(i.partnerText) : '';
  return h(String(i.section), i.measure || i.check, norm(`${i.rule.title} ${i.rule.text}`), norm(i.part), partner);
}

/** Files a finding is about: a change to any of them puts the finding in the pull request's scope. */
function filesOf(i) {
  if (i.section === 5) return ['.github/workflows/', 'package.json', ...(String(i.text || '').match(/[\w./-]+\.(ya?ml|json|toml|cfg|ini|[cm]?[jt]s)\b/g) || [])];
  const r = i.rule;
  return [r.path, r.impl?.path, ...(r.links || []).map((l) => l.path), ...((i.facts?.runs || r.evidence?.tests || []).flatMap((t) => [...(t.pr || []), ...(t.other || [])].map((x) => x.workflow)))].filter(Boolean);
}
const touches = (files, changed) => files.some((f) => changed.some((c) => c === f || (f.endsWith('/') && c.startsWith(f))));

// ---- suppressions ----------------------------------------------------------------------------------------------
const YEAR_MS = 366 * 24 * 3600 * 1000;
function checkSuppressions(list = [], today) {
  const valid = [], problems = [];
  for (const [k, s] of list.entries()) {
    const id = s.fingerprint || (s.rule && s.check ? `${s.rule}/${s.check}` : null);
    if (!id) { problems.push(`suppress[${k}]: needs a fingerprint, or a rule and a check`); continue; }
    if (!s.reason || String(s.reason).trim().length < 10) { problems.push(`suppress[${k}] (${id}): needs a reason of at least 10 characters`); continue; }
    const until = s.until ? new Date(String(s.until)) : null;
    if (!until || Number.isNaN(until.getTime())) { problems.push(`suppress[${k}] (${id}): needs an expiry date (until: YYYY-MM-DD)`); continue; }
    if (until - new Date(today) > YEAR_MS) { problems.push(`suppress[${k}] (${id}): expiry more than a year away`); continue; }
    valid.push({ ...s, id, expired: until < new Date(today) });
  }
  return { valid, problems };
}
const matches = (s, i) => (s.fingerprint ? s.fingerprint === i.fingerprint : i.rule && s.rule === i.rule.id && s.check === (i.measure || i.check));

/**
 * Decide the gate. → { verdict: 'pass'|'fail', findings: [...], counts, problems }
 *   policy: { failOn: 'P0'|'P1'|'P2'|'P3'|'never', basis: ['E','S','V'], newOnly: true }
 *   baseline: { fingerprints: [...] } | null; changed: [paths] | null; suppress: config list; today: 'YYYY-MM-DD'
 */
function decide(ledger, { policy = {}, baseline = null, changed = null, suppress = [], today } = {}) {
  const failOn = policy.failOn || 'P1', allowed = new Set(policy.basis || ['E', 'S', 'V']), newOnly = policy.newOnly !== false;
  // calibrated vote thresholds (scripts/calibrate.js) for model-backed findings, and checks on probation (their
  // usefulness fell below the bar in scripts/usefulness.js): both inform, neither blocks
  const minAgree = policy.minAgreement || {}, probation = new Set(policy.probation || []);
  const agreeNeed = (f) => minAgree[f.measure || f.check] ?? minAgree.default ?? 0;
  const base = baseline ? new Set(baseline.fingerprints || []) : null;
  const { valid, problems } = checkSuppressions(suppress, today || ledger.meta.date);
  const byId = new Map(ledger.rules.map((r) => [r.id, r]));
  const findings = ledger.issues.map((i) => {
    if (i.conflictWith) i.partnerText = (byId.get(i.conflictWith) || {}).text;
    const f = { ...i, basis: basisOf(i) };
    f.fingerprint = fingerprint(i);
    f.files = filesOf(i);
    f.isNew = base ? !base.has(f.fingerprint) : true;
    f.inScope = changed ? touches(f.files, changed) : true;
    const s = valid.find((x) => matches(x, f));
    f.suppressed = s && !s.expired ? { reason: s.reason, until: s.until, by: s.by || '' } : null;
    if (s?.expired) f.suppressionExpired = s.until;
    const severe = failOn !== 'never' && PRI(f.priority) <= PRI(failOn);
    const onProbation = probation.has(f.measure || f.check);
    const split = (f.basis === 'V' || f.basis === 'M') && typeof f.agreement === 'number' && f.agreement < agreeNeed(f);
    f.blocking = severe && allowed.has(f.basis) && (!newOnly || f.isNew) && f.inScope && !f.suppressed && !onProbation && !split;
    f.why = !severe ? 'below the fail-on priority' : !allowed.has(f.basis) ? `evidence ${f.basis} cannot block` : onProbation ? 'check on probation' : split ? `votes ${Math.round(f.agreement * 100)}% agree, ${Math.round(agreeNeed(f) * 100)}% needed` : newOnly && !f.isNew ? 'in the baseline' : !f.inScope ? 'outside the change' : f.suppressed ? 'suppressed' : 'blocks';
    return f;
  });
  findings.sort((a, b) => b.blocking - a.blocking || PRI(a.priority) - PRI(b.priority) || BASIS_RANK[a.basis] - BASIS_RANK[b.basis]);
  const counts = {
    total: findings.length,
    blocking: findings.filter((f) => f.blocking).length,
    newAdvisory: findings.filter((f) => !f.blocking && f.isNew && !f.suppressed && f.inScope).length,
    existing: findings.filter((f) => !f.isNew).length,
    suppressed: findings.filter((f) => f.suppressed).length,
    byBasis: Object.fromEntries(Object.keys(BASIS_RANK).map((b) => [b, findings.filter((f) => f.basis === b).length])),
  };
  return { verdict: counts.blocking ? 'fail' : 'pass', findings, counts, problems, policy: { failOn, basis: [...allowed], newOnly, minAgreement: minAgree, probation: [...probation] } };
}

const toBaseline = (gate, meta) => ({ version: 1, repo: meta.repo, sha: meta.sha, date: meta.date, fingerprints: [...new Set(gate.findings.map((f) => f.fingerprint))].sort() });

// ---- outputs ---------------------------------------------------------------------------------------------------
const label = (f) => (f.rule ? `${f.rule.id} ${f.rule.title}` : f.check);
const what = (f) => (f.measure || f.check) + (f.part ? ` (${f.part})` : '');
const BASIS_TEXT = { E: 'executed', S: 'code', V: 'model + code check', M: 'model' };

function locationOf(f) {
  if (f.section === 5) {
    const m = String(f.text || '').match(/([\w./-]+\.ya?ml):(\d+)/);
    return m ? { path: m[1], line: Number(m[2]) } : { path: '.github/workflows', line: 1 };
  }
  const fact = (f.rule.evidence?.fails || []).find((x) => x.check === f.check)?.facts || {};
  if (fact.path && fact.line) return { path: fact.path, line: fact.line };
  if (f.check === 'Placement' && fact.seam) return { path: fact.seam.path, line: fact.seam.line };
  if (fact.mutation && f.rule.impl) return { path: f.rule.impl.path, line: fact.mutation[0]?.line || f.rule.impl.line };
  return { path: f.rule.path, line: f.rule.line || 1 };
}

/** SARIF 2.1.0 for GitHub code scanning; partialFingerprints keep an alert the same alert across commits. */
function toSarif(gate, ledger, { cells = {}, version = '0.2.0' } = {}) {
  const checks = [...new Set(gate.findings.map((f) => what(f).replace(/ \(.*$/, '')))];
  const ruleId = (f) => `aqg/${what(f).replace(/ \(.*$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const level = (p) => ({ P0: 'error', P1: 'error', P2: 'warning', P3: 'note' })[p] || 'note';
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'ai-quality-gate', version, informationUri: 'https://github.com/Mira190/ai-quality-gate', rules: checks.map((c) => ({ id: `aqg/${c.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, name: c.replace(/[^A-Za-z0-9]+/g, ''), shortDescription: { text: c } })) } },
      results: gate.findings.filter((f) => !f.suppressed).map((f) => {
        const loc = locationOf(f);
        return {
          ruleId: ruleId(f),
          level: level(f.priority),
          message: { text: `${f.priority} ${label(f)}: ${cells[f.n] || f.text || f.why || what(f)} [evidence: ${BASIS_TEXT[f.basis]}]` },
          locations: [{ physicalLocation: { artifactLocation: { uri: loc.path }, region: { startLine: Math.max(1, loc.line) } } }],
          partialFingerprints: { 'aqgFingerprint/v1': f.fingerprint },
          properties: { priority: f.priority, basis: f.basis, blocking: f.blocking, isNew: f.isNew },
        };
      }),
    }],
  };
}

const MARKER = '<!-- ai-quality-gate -->';
/** The pull-request comment: short, only what this change must answer for, and why everything else does not block. */
function toComment(gate, ledger, { reportUrl = '', cells = {} } = {}) {
  const c = gate.counts, rows = gate.findings.filter((f) => f.blocking);
  const adv = gate.findings.filter((f) => !f.blocking && f.isNew && f.inScope && !f.suppressed && PRI(f.priority) <= 1).slice(0, 8);
  const row = (f) => `| ${f.priority} | ${label(f)} | ${what(f)} | ${BASIS_TEXT[f.basis]} | ${String(cells[f.n] || f.text || '').replace(/\|/g, '\\|').slice(0, 220)} | \`${f.fingerprint.slice(0, 10)}\` |`;
  return [
    MARKER,
    `### ${gate.verdict === 'fail' ? '❌' : '✅'} AI quality gate: ${gate.verdict === 'fail' ? `${c.blocking} blocking` : 'pass'}`,
    '',
    `Blocks on ${gate.policy.failOn} and above, evidence ${gate.policy.basis.join('/')}, ${gate.policy.newOnly ? 'new findings in this change only' : 'all findings'}. ` +
      `${c.newAdvisory} new advisory · ${c.existing} existing (baseline) · ${c.suppressed} suppressed · model calls ${ledger.meta.usage.calls}, ${ledger.meta.aiu.toFixed(2)} AIU.`,
    '',
    ...(rows.length ? ['| P | Rule or check | Fails on | Evidence | What fails, and the fix | Fingerprint |', '| :-: | --- | --- | --- | --- | --- |', ...rows.map(row), ''] : []),
    ...(adv.length ? ['<details><summary>New, not blocking (model judgment or outside the change)</summary>', '', '| P | Rule or check | Fails on | Evidence | Note | Fingerprint |', '| :-: | --- | --- | --- | --- | --- |', ...adv.map(row), '', '</details>', ''] : []),
    ...(gate.problems.length ? [`> Suppression problems: ${gate.problems.join('; ')}`, ''] : []),
    `To accept a finding, add it to \`.quality-gate.yml\` under \`suppress:\` with \`fingerprint\`, \`reason\` and \`until\`.${reportUrl ? ` [Full report](${reportUrl})` : ''}`,
  ].join('\n');
}

module.exports = { decide, basisOf, fingerprint, filesOf, checkSuppressions, toBaseline, toSarif, toComment, MARKER, norm };
