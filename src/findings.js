'use strict';
// Everything the earlier stages found, as one list of findings with a priority, an evidence level and a stable
// fingerprint. Priority is a lookup table, not a judgment: the same finding has the same priority in every run.
//
//   P0  a critical rule nobody tests; tests that do not gate pull requests
//   P1  any other rule nobody tests; a hole in the proof of a critical rule; a critical rule tested at the wrong
//       level; lint or type check not enforced
//   P2  holes and placement of non-critical rules; format, coverage, dependency and secret checks
//   P3  information
// Advice is never P0: what only a heuristic or an unverified model opinion supports cannot be the top of the list.
//
// Evidence: S code-decided · V model-proposed, code-verified · A advice (a heuristic or an unverified model opinion).
const { sha, clip, plural } = require('./util');

const critTag = (r) => (r.critical ? ` (critical: ${r.tags.map((t) => t.area).join(', ')} · "${r.tags[0].word}")` : '');
const ruleLabel = (r) => `${r.id} ${r.title}`;
const P = (critical, a, b) => (critical ? a : b);

function make(f) {
  const subject = f.subject;
  return {
    section: f.section, check: f.check, priority: f.basis === 'A' && f.priority === 'P0' ? 'P1' : f.priority, basis: f.basis, subject, title: f.title, detail: f.detail, fix: f.fix || '',
    critical: Boolean(f.critical), loc: f.loc || null, anchors: f.anchors || [], global: Boolean(f.global),
    fingerprint: sha(`${f.check}|${subject}`, 12),
  };
}
const ruleAnchor = (r) => ({ path: r.path, from: r.line, to: r.line });
const caseAnchor = (c) => ({ path: c.file.path, from: c.line, to: c.end });

function proofFindings(proofs, config, collapsed = new Set()) {
  const out = [];
  for (const p of proofs) {
    const r = p.rule;
    if (p.status === 'inactive' || p.status === 'not_a_rule' || p.status === 'proven') {
      if (p.status === 'proven' && p.untestable) { /* proven in practice: the wording advice below still applies */ } else continue;
    }
    const base = { section: 'proof', subject: r.id, critical: r.critical, loc: { path: r.path, line: r.line } };
    const tagHint = `name \`${r.id}\` in the test (its title or a \`// covers: ${r.id}\` comment) so the link is a fact from then on`;
    const level = p.modelLevel || r.lowest;
    if (p.untestable || p.status === 'untestable') {
      out.push(make({ ...base, check: 'rule.untestable', priority: P(r.critical, 'P1', 'P2'), basis: 'A', title: `${ruleLabel(r)}${critTag(r)} cannot be tested as written`, detail: `"${clip(r.text, 160)}" (\`${r.path}:${r.line}\`)${p.missing ? `: ${p.missing}` : ''}`, fix: 'Rewrite it with a subject, a trigger and a checkable outcome (a number, a state, an error).', anchors: [ruleAnchor(r)] }));
      if (p.status === 'proven' || p.status === 'untestable') continue;
    }
    if (p.status === 'unproven' && !p.links.length) {
      const near = p.candidates[0];
      const how = p.basis === 'V' ? `${near ? `the nearest test (\`${near.case.file.path}:${near.case.line}\` "${clip(near.case.name, 50)}") does not assert it` : 'no test comes near it'}, by the model's reading${p.readTwice ? ', done twice' : ''}${p.missing ? `: ${p.missing}` : ''}` : `no test names \`${r.id}\` or shares its words (searched: ${p.terms.slice(0, 5).join(', ')})`;
      out.push(make({
        ...base, check: 'proof.unproven', priority: P(r.critical, 'P0', 'P1'), basis: p.basis,
        title: `${ruleLabel(r)}${critTag(r)} has no test`,
        detail: `"${clip(r.text, 160)}" (\`${r.path}:${r.line}\`): ${how}.`,
        fix: `Write ${level === 'e2e' ? 'an' : 'a'} ${level} test that fails when the rule is broken${r.limits.length ? `, at ${boundaryValues(r.limits)}` : ''}; ${tagHint}.`,
        anchors: [ruleAnchor(r)],
      }));
    } else if (p.status === 'unproven') {
      out.push(make({
        ...base, check: 'proof.skipped', priority: P(r.critical, 'P0', 'P1'), basis: 'S',
        title: `${ruleLabel(r)}${critTag(r)} is proven only by skipped tests`,
        detail: `${p.links.slice(0, 3).map((l) => `\`${l.case.file.path}:${l.case.line}\``).join(', ')} ${p.links.length === 1 ? 'is' : 'are'} skipped, so nothing checks the rule.`,
        fix: 'Fix and re-enable the test, or delete it and write one that runs.',
        anchors: [ruleAnchor(r), ...p.links.map((l) => caseAnchor(l.case))],
      }));
    } else if (p.status === 'unverified') {
      const c = p.candidates[0];
      out.push(make({
        ...base, check: 'proof.unverified', priority: P(r.critical, 'P1', 'P2'), basis: 'A',
        title: `${ruleLabel(r)}${critTag(r)}: a test may prove it, nobody has checked`,
        detail: `"${clip(r.text, 120)}" (\`${r.path}:${r.line}\`). Nearest test: ${c ? `\`${c.case.file.path}:${c.case.line}\` "${clip(c.case.name, 60)}" (shares: ${c.shared.slice(0, 4).join(', ')})` : 'none'}.${p.note ? ` ${p.note}.` : ''}`,
        fix: `If that test proves the rule, ${tagHint}. If not, write the test.`,
        anchors: [ruleAnchor(r)],
      }));
    } else if (p.status === 'weak') {
      for (const h of p.holes) {
        // one root cause, one finding: when a whole level never gates pull requests, that finding lists the rules
        if (h.kind === 'not-in-pr' && p.links.filter((l) => !l.case.skipped).every((l) => collapsed.has(l.case.file.level))) continue;
        const first = p.links.find((l) => !l.case.skipped).case;
        const fixes = {
          'no-assert': 'Add an assertion on the outcome the rule promises.',
          limit: `Add cases at ${boundaryValues(h.limits || [])}.`,
          'not-in-pr': 'Run these tests in a pull-request step that can fail the build.',
          partial: `Assert the missing part${level ? ` in ${level === 'e2e' ? 'an' : 'a'} ${level} test` : ''}.`,
        };
        out.push(make({
          ...base, check: `proof.${h.kind}`, priority: P(r.critical, 'P1', 'P2'), basis: h.basis === 'S' && p.basis === 'V' ? 'V' : h.basis,
          title: `${ruleLabel(r)}${critTag(r)}: ${h.kind === 'partial' ? 'the tests check only part of it' : h.text}`,
          detail: `Linked test: \`${first.file.path}:${first.line}\` "${clip(first.name, 60)}"${p.links.length > 1 ? ` and ${p.links.length - 1} more` : ''}. ${h.kind === 'partial' ? `Not asserted: ${h.text}.` : h.note ? `The model adds: ${h.note}.` : ''}`.trim(),
          fix: fixes[h.kind],
          anchors: [ruleAnchor(r), ...p.links.map((l) => caseAnchor(l.case)), ...p.impl.map((f) => ({ path: f }))],
        }));
      }
    }
  }
  void config;
  return out;
}

/** The values a boundary test needs: the limit, one below, one above. */
function boundaryValues(limits) {
  return limits.slice(0, 2).map((l) => {
    const n = Number(l.value);
    if (!Number.isFinite(n)) return l.raw;
    const step = l.value.includes('.') ? Number((10 ** -l.value.split('.')[1].length).toFixed(6)) : 1;
    const pre = /^[$€£¥]$/.test(l.unit) ? l.unit : '';
    const u = pre ? '' : l.unit === '%' ? '%' : l.unit && l.unit.length < 4 ? ` ${l.unit}` : '';
    return `${pre}${+(n - step).toFixed(6)}${u}, ${pre}${n}${u} and ${pre}${+(n + step).toFixed(6)}${u}`;
  }).join('; ');
}

const PLACEMENT_TITLES = {
  'too-high': (i) => `${ruleLabel(i.rule)}${critTag(i.rule)} is tested above the level it needs`,
  'boundary-mocked': (i) => `${ruleLabel(i.rule)}${critTag(i.rule)} is proven only against fakes`,
  mislabelled: (i) => `${i.files[0].path} is not a ${i.files[0].declared} test`,
  'no-boundary': (i) => `${i.files[0].path} is a unit test in the ${i.files[0].declared} suite`,
  'table-at-top': (i) => `${i.files[0].path} runs a parameter table at ${i.files[0].level} level`,
  pyramid: () => 'The test suite is top-heavy',
  'level-not-run': (i) => `${i.level} tests do not gate pull requests`,
};

function placementFindings(issues, proofs = []) {
  return issues.filter((i) => !i.silent).map((i) => {
    let critical = Boolean(i.rule?.critical);
    let priority = i.kind === 'level-not-run' ? { unit: 'P0', component: 'P0', integration: 'P1', e2e: 'P2' }[i.level] : i.rule ? P(critical, 'P1', 'P2') : 'P2';
    if (i.kind === 'level-not-run') {
      // the rules whose only proof lives at this level: their proof never gates a pull request
      const hit = proofs.filter((p) => p.holes?.some((h) => h.kind === 'not-in-pr') && p.links.filter((l) => !l.case.skipped).every((l) => l.case.file.level === i.level));
      const crit = hit.filter((p) => p.rule.critical);
      if (hit.length) i = { ...i, text: `${i.text} ${plural(hit.length, 'rule')} ${hit.length === 1 ? 'is' : 'are'} proven only there${crit.length ? `, ${crit.length} critical` : ''}: ${hit.slice(0, 8).map((p) => p.rule.id).join(', ')}${hit.length > 8 ? ` +${hit.length - 8}` : ''}.` };
      if (crit.length && priority === 'P2') { priority = 'P1'; critical = true; }
    }
    return make({
      section: i.kind === 'level-not-run' ? 'ci' : 'placement', check: i.kind === 'level-not-run' ? 'ci.level-not-run' : `placement.${i.kind}`, priority, basis: i.basis, critical,
      subject: i.rule ? i.rule.id : i.kind === 'pyramid' ? 'suite' : i.kind === 'level-not-run' ? i.level : i.files[0].path,
      title: PLACEMENT_TITLES[i.kind](i), detail: i.text, fix: i.fix,
      loc: i.files[0] ? { path: i.files[0].path, line: i.files[0].cases?.[0]?.line || 1 } : null,
      anchors: [...(i.rule ? [ruleAnchor(i.rule)] : []), ...i.files.map((f) => ({ path: f.path }))],
      global: i.kind === 'pyramid' || i.kind === 'level-not-run',
    });
  });
}

const CI_TEXT = {
  missing: (c) => `No CI step runs ${c.title.toLowerCase()}.`,
  configured: (c) => `${c.title} is set up (${c.configured}) and no CI step runs it: nothing stops a change that breaks it.`,
  not_on_pr: (c) => `${c.title} runs (\`${c.command}\`, \`${c.where[0]?.file}\`), but not on pull requests: a failure is found after the merge.`,
  non_blocking: (c) => `${c.title} runs on pull requests (\`${c.command}\`, \`${c.where[0]?.file}:${c.where[0]?.line}\`), and its failure is ignored (continue-on-error or \`|| true\`).`,
};
const CI_FIX = {
  missing: (c) => `Add a pull-request step that runs ${c.title.toLowerCase()} and fails the build.`,
  configured: (c) => `Add a pull-request step that runs it${c.configured?.startsWith('package.json script') ? ` (${c.configured.replace('package.json script ', 'npm run ').replace(/"/g, '')})` : ''}.`,
  not_on_pr: () => 'Add `pull_request` to the workflow\'s triggers.',
  non_blocking: () => 'Remove `continue-on-error` / `|| true`, or fix what fails and then remove it.',
};

function ciFindings(ci, inventory, config) {
  const out = [];
  const anchors = [...(inventory.byKind.ci || []).map((f) => ({ path: f.path })), ...(inventory.byKind.manifest || []).filter((m) => !m.path.includes('/')).map((f) => ({ path: f.path }))];
  const hasCode = Object.keys(inventory.langs).length > 0;
  if (!ci.hasCI && hasCode) {
    out.push(make({ section: 'ci', check: 'ci.none', priority: 'P0', basis: 'S', subject: 'ci', title: 'The repository has no CI', detail: 'No workflow or pipeline file was found: nothing checks a change before it merges.', fix: 'Add a workflow that runs the tests, the linter and the type checker on every pull request.', anchors, global: true }));
    return out;
  }
  for (const c of ci.checks) {
    if (!['missing', 'configured', 'not_on_pr', 'non_blocking'].includes(c.state)) {
      if (c.id === 'coverage' && c.noThreshold && c.state !== 'na') out.push(make({ section: 'ci', check: 'ci.coverage.no-threshold', priority: 'P3', basis: 'S', subject: 'coverage', title: 'Coverage is measured, and no minimum is enforced', detail: `\`${c.command}\` reports coverage; nothing fails when it drops.`, fix: 'Set a threshold at today\'s number, so coverage can only go up.', anchors, global: true }));
      continue;
    }
    if (c.need === 'na') continue;
    const required = config.ci.required.includes(c.id) && c.need === 'required';
    let priority = c.id === 'tests' ? 'P0' : required ? 'P1' : c.id === 'sast' ? 'P3' : 'P2';
    if (c.id === 'tests' && c.state === 'missing' && !(inventory.byKind.test || []).length) priority = 'P0';
    out.push(make({
      section: 'ci', check: `ci.${c.id}`, priority, basis: 'S', subject: c.id,
      title: { missing: `${c.title}: not run in CI`, configured: `${c.title}: set up, not enforced`, not_on_pr: `${c.title}: not run on pull requests`, non_blocking: `${c.title}: failures are ignored` }[c.state],
      detail: c.detail && c.state === 'missing' ? `${CI_TEXT.missing(c)} (${c.detail})` : CI_TEXT[c.state](c), fix: CI_FIX[c.state](c),
      loc: c.where[0] ? { path: c.where[0].file, line: c.where[0].line } : null, anchors, global: true,
    }));
  }
  return out;
}

module.exports = { proofFindings, placementFindings, ciFindings, make, boundaryValues, critTag, ruleLabel };
