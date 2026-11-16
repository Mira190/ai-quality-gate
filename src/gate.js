'use strict';
// The verdict, over the whole repository. A finding blocks when all of these hold:
//   1. its priority is at or above gate.fail_on (default P1);
//   2. its evidence may block (default: S code-decided, V model-proposed and code-verified; never advice);
//   3. it is not suppressed in .quality-gate.yml (a suppression needs a reason, and may carry an end date);
//   4. its check is not on probation: a check whose findings people mostly dismiss, instead of fixing, has shown it
//      is not precise enough here, and stops blocking until that changes;
//   5. with gate.new_only (a ratchet for a repository that starts with debt): it is not in the baseline written by
//      the default branch. Everything is still reported; only what is new blocks.
// A review can also be given a change (--base, --staged: a local hook). That never narrows what is reviewed or
// reported; with gate.new_only and no baseline, it stands in for the baseline: what the change touches blocks.
const { matcher, by } = require('./util');

const PRI = ['P0', 'P1', 'P2', 'P3'];

function touches(finding, changes) {
  for (const a of finding.anchors) {
    const ch = changes.get(a.path);
    if (!ch) continue;
    if (a.from === undefined || ch.status === 'A' || ch.status === 'R') return true;
    if (ch.added.some(([s, e]) => s <= a.to && e >= a.from)) return true;
  }
  return false;
}

function suppressionOf(f, suppress) {
  for (const s of suppress) {
    if (s.id && [f.fingerprint, f.subject].some((x) => String(x).toUpperCase() === String(s.id).toUpperCase()) && (!s.check || f.check.startsWith(s.check))) return s;
    if (!s.id && s.check && !s.path && f.check.startsWith(s.check)) return s;
    if (s.path && (!s.check || f.check.startsWith(s.check)) && f.anchors.some((a) => matcher([s.path])(a.path))) return s;
  }
  return null;
}

/**
 * How the findings of each check ended, counted across default-branch runs: fixed (the finding went away) or
 * dismissed (someone suppressed it). This is the tool measuring its own precision in the only place that counts.
 */
function nextHistory(prev, findings) {
  const checks = JSON.parse(JSON.stringify(prev?.checks || {}));
  const bump = (check, field) => { (checks[check] ||= { fixed: 0, dismissed: 0 })[field]++; };
  const now = new Map(findings.map((f) => [f.fingerprint, f]));
  for (const [fp, [check, wasSuppressed]] of Object.entries(prev?.seen || {})) if (!now.has(fp) && !wasSuppressed) bump(check, 'fixed');
  for (const f of findings) if (f.suppressed && !(prev?.seen?.[f.fingerprint]?.[1])) bump(f.check, 'dismissed');
  const seen = Object.fromEntries([...now].sort(([a], [b]) => (a < b ? -1 : 1)).map(([fp, f]) => [fp, [f.check, f.suppressed ? 1 : 0]]));
  return { checks, seen };
}

function probationOf(check, history, policy) {
  const h = history?.[check];
  if (!h) return null;
  const n = h.fixed + h.dismissed;
  return n >= policy.min_resolved && h.dismissed / n > policy.max_dismissed ? `on probation: ${h.dismissed} of the last ${n} findings of this check were dismissed, not fixed` : null;
}

/** Sets on each finding: suppressed, isNew, touchesChange, blocking, why (when it does not block). */
function decide({ findings, config, changes, baseline }) {
  const failAt = config.gate.fail_on === 'never' ? -1 : PRI.indexOf(config.gate.fail_on);
  const known = baseline ? new Set(baseline.fingerprints) : null;
  const ratchet = config.gate.new_only;
  for (const f of findings) {
    const sup = suppressionOf(f, config.suppress);
    f.suppressed = sup ? sup.reason : null;
    f.isNew = known ? !known.has(f.fingerprint) : null;
    f.touchesChange = changes ? touches(f, changes) : null;
    let why = null;
    if (PRI.indexOf(f.priority) > failAt) why = 'below the gate';
    else if (!config.gate.basis.includes(f.basis)) why = 'advice';
    else if (f.suppressed) why = 'suppressed';
    else if (probationOf(f.check, baseline?.checks, config.gate.probation)) why = probationOf(f.check, baseline.checks, config.gate.probation);
    else if (ratchet && known && !f.isNew) why = 'in the baseline';
    else if (ratchet && !known && changes && !f.touchesChange) why = 'not touched by the change';
    f.blocking = why === null;
    f.why = why;
  }
  findings.sort(by((f) => PRI.indexOf(f.priority), (f) => (f.blocking ? 0 : 1), (f) => (f.critical ? 0 : 1), (f) => ['proof', 'change', 'ci', 'placement'].indexOf(f.section), (f) => f.check, (f) => String(f.subject)));
  findings.forEach((f, i) => { f.n = i + 1; });
  const blocking = findings.filter((f) => f.blocking);
  const counts = {};
  for (const p of PRI) counts[p] = findings.filter((f) => f.priority === p && !f.suppressed).length;
  const probation = [...new Set(findings.map((f) => f.check))].filter((c) => probationOf(c, baseline?.checks, config.gate.probation)).sort();
  return { verdict: blocking.length ? 'fail' : 'pass', blocking: blocking.length, counts, mode: changes ? 'change' : 'full', baseline: Boolean(known), ratchet, probation };
}

module.exports = { decide, touches, nextHistory, probationOf, PRI };
