'use strict';
// Questions a coding agent (or a person) asks the ledger while writing code, before any CI run: which rules does this
// file carry, which tests guard them, what are the limits, what is open. Shared by the MCP server and the hook.
const fs = require('node:fs');

function loadLedger(file) {
  const L = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { rules: L.rules || [], issues: L.issues || [], meta: L.meta || {} };
}

const short = (r) => ({
  id: r.id, title: r.title, kind: r.kind, text: r.text, source: `${r.path}:${r.line}`,
  critical: r.critical ? r.critical.area : null,
  implementation: r.impl ? `${r.impl.path}:${r.impl.line} ${r.impl.symbol}` : null,
  limits: (r.limits || []).map((l) => `${l.value}${l.unit ? ` ${l.unit}` : ''}`),
  tests: (r.links || []).map((l) => l.path),
  test_level: r.evidence?.level || null,
  belongs_at: r.placement?.level || null,
});
const open = (L, r) => L.issues.filter((i) => i.rule && i.rule.id === r.id).map((i) => `${i.priority} ${i.measure || i.check}${i.part ? ` (${i.part})` : ''}`);
const norm = (p, cwd) => String(p || '').replace(/\\/g, '/').replace(new RegExp(`^${(cwd || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?`), '').replace(/^\.\//, '');

/** Rules a file implements, documents or tests. */
function rulesForFile(L, file, cwd) {
  const f = norm(file, cwd);
  return L.rules.filter((r) => r.impl?.path === f || r.path === f || (r.links || []).some((l) => l.path === f)).map((r) => ({
    ...short(r), role: r.impl?.path === f ? 'implements' : r.path === f ? 'states' : 'tests', open_issues: open(L, r),
  }));
}

function rule(L, id) {
  const r = L.rules.find((x) => x.id.toLowerCase() === String(id).toLowerCase());
  return r ? { ...short(r), status: r.status, open_issues: open(L, r) } : null;
}

/** The rules a set of changed files touches, and the tests to run for them. */
function impact(L, files, cwd) {
  const fs_ = new Set(files.map((f) => norm(f, cwd)));
  const rs = L.rules.filter((r) => fs_.has(r.impl?.path) || fs_.has(r.path) || (r.links || []).some((l) => fs_.has(l.path)));
  return { rules: rs.map((r) => ({ id: r.id, title: r.title, critical: !!r.critical, test_level: r.evidence?.level || null })), tests_to_run: [...new Set(rs.flatMap((r) => (r.links || []).map((l) => l.path)))].sort() };
}

/** One paragraph for an agent that just edited a file: what it must keep true, and how to check it. */
function contextFor(L, file, cwd) {
  const rs = rulesForFile(L, file, cwd).filter((r) => r.role !== 'states');
  if (!rs.length) return null;
  return [`ai-quality-gate: ${norm(file, cwd)} carries ${rs.length} rule(s). Keep them true and their tests passing in this change:`,
    ...rs.map((r) => `- ${r.id} ${r.title}${r.critical ? ` [critical: ${r.critical}]` : ''} (${r.source})${r.limits.length ? `; limits ${r.limits.join(', ')}` : ''}; ${r.tests.length ? `tests: ${r.tests.join(', ')} (level: ${r.test_level})` : 'NO TEST: add one that names the rule ID'}${r.open_issues.length ? `; open: ${r.open_issues.join('; ')}` : ''}`),
  ].join('\n');
}

module.exports = { loadLedger, rulesForFile, rule, impact, contextFor };
