'use strict';
// Stage 4c, trace: one proof record per rule, from the explicit links, the model's verified verdicts and checks that
// code runs on every linked test: is it skipped, does it assert anything, does it exercise the limits the rule states,
// does a pull request run it.
//
// status      meaning                                                       evidence
// proven      a live, asserting test is linked, and nothing below failed    S (ID link) or V (model link, verified)
// weak        linked, but the proof has a hole (see `holes`)                S for code-found holes, V for model-found
// unproven    no test, or only skipped tests                                S, V, or A (see basisOfAbsence)
// unverified  candidate tests exist and nobody has judged them              A
// untestable  the model judged the wording too vague to check             A (the finding is about the wording)
// not_a_rule  an inferred sentence the model judged not to be behaviour     dropped from every count
// inactive    superseded, rejected or still a draft                         dropped from every count
const path = require('node:path');
const { readText, uniq } = require('../util');
const { exercisesLimit } = require('../extract/risk');
const { runsOnPR } = require('../ci/checks');

function assessRules({ root, rules, links, verdicts, ci }) {
  const texts = new Map();
  const bodyOf = (c) => {
    if (!texts.has(c.file.path)) texts.set(c.file.path, (readText(path.join(root, c.file.path), 1 << 20) || '').split(/\r?\n/));
    return texts.get(c.file.path).slice(c.line - 1, c.end).join('\n');
  };
  // Does this repository tag tests with rule IDs? Then a rule with an ID and no tagged test is a fact worth blocking on.
  const convention = rules.filter((r) => r.active && !r.inferred && links.get(r.id).explicit.length).length >= 2;
  const prState = new Map();
  const stateOf = (tf) => { if (!prState.has(tf.path)) prState.set(tf.path, runsOnPR(tf, ci)); return prState.get(tf.path); };

  const proofs = [];
  for (const rule of rules) {
    const link = links.get(rule.id);
    const p = { rule, status: null, basis: 'S', links: [], holes: [], candidates: link.candidates, terms: link.terms, missing: '', modelLevel: null, impl: [], untestable: false };
    proofs.push(p);
    if (!rule.active) { p.status = 'inactive'; continue; }
    const v = verdicts.get(rule.id);
    if (v) { p.modelLevel = v.level; p.missing = v.missing; p.readTwice = v.readTwice; }
    if (v && !v.testable) {
      if (rule.inferred) { p.status = 'not_a_rule'; p.basis = 'A'; continue; }
      // A rule that cannot be tested cannot be asked for a test: the finding is about its wording.
      if (!link.explicit.length) { p.status = 'untestable'; p.basis = 'A'; continue; }
      p.untestable = true;
    }
    if (link.explicit.length) p.links = link.explicit.map((c) => ({ case: c, by: 'id' }));
    else if (v?.links.length) { p.links = v.links; p.basis = 'V'; }

    if (!p.links.length) {
      if (v?.status === 'unverified') { p.status = 'unverified'; p.basis = 'A'; p.note = v.note; }
      else if (v) { p.status = 'unproven'; p.basis = 'V'; }
      else if (link.candidates.length) { p.status = 'unverified'; p.basis = 'A'; }
      else { p.status = 'unproven'; p.basis = rule.inferred ? 'A' : 'S'; p.searched = true; }
      p.convention = convention;
      continue;
    }

    const live = p.links.filter((l) => !l.case.skipped);
    p.levels = uniq(p.links.map((l) => l.case.file.level));
    p.impl = uniq(p.links.flatMap((l) => l.case.file.imports)).sort();
    if (!live.length) { p.status = 'unproven'; p.holes.push({ kind: 'skipped', basis: 'S', text: `every linked test is skipped (${p.links.length})` }); continue; }
    if (!live.some((l) => l.case.asserts > 0)) p.holes.push({ kind: 'no-assert', basis: 'S', text: 'no linked test contains an assertion' });
    const bodies = live.map((l) => bodyOf(l.case));
    const unexercised = rule.limits.filter((lim) => !bodies.some((b) => exercisesLimit(b, lim)));
    if (unexercised.length) p.holes.push({ kind: 'limit', basis: 'S', text: `no linked test uses the stated limit ${unexercised.map((l) => l.raw).join(', ')}`, limits: unexercised });
    const states = live.map((l) => stateOf(l.case.file));
    // with no test step at all, one CI finding says so; repeating it on every rule would bury it
    if (ci.testSteps.length && !states.some((s) => s === 'pr' || s === 'unknown')) {
      const why = states.includes('soft') ? 'only by a step whose failure is ignored' : states.includes('not_pr') ? 'only outside pull requests' : 'by no CI step';
      p.holes.push({ kind: 'not-in-pr', basis: 'S', text: `its tests do not gate pull requests (run ${why})`, state: states.includes('soft') ? 'soft' : states.includes('not_pr') ? 'not_pr' : 'never' });
    }
    if (v && v.status === 'weak' && !link.explicit.length) {
      // code and the model often find the same hole (a limit nobody exercises): one finding, with both voices
      const same = p.holes.find((h) => h.kind === 'limit');
      if (same) same.note = v.missing;
      else p.holes.push({ kind: 'partial', basis: 'V', text: v.missing || 'the tests check only part of the rule' });
    }
    p.status = p.holes.length ? 'weak' : 'proven';
  }
  return { proofs, convention };
}

module.exports = { assessRules };
