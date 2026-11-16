'use strict';
// Stage 5, placement: is each thing tested at the level where the test is cheapest and still honest?
// Deterministic. The inputs are facts gathered earlier: the level each test file needs (what it imports and drives),
// the level its folder claims, whether it fakes its collaborators, how many parameter rows it runs, which rules it
// proves, and whether a pull request runs it.
//
// The rules, each one a named check in the report:
//   too-high          a rule that is pure logic is proven only by integration or end-to-end tests: every boundary
//                     value costs a browser or a database. Push the cases down, keep one at the top.
//   boundary-mocked   a rule about a real boundary (database, HTTP, queue) is proven only by tests that fake the
//                     boundary: the fake is what is tested. Add one test that crosses it.
//   mislabelled       a file under unit/ that needs the network, a browser or a child process: it slows and flakes
//                     the suite the team believes is fast.
//   no-boundary       a file under integration/ or e2e/ that crosses nothing: unit tests waiting in the slow queue.
//   table-at-top      many parameter rows in an integration or end-to-end test: combinations belong below.
//   pyramid           more slow tests than fast ones.
//   level-not-run     tests of a level exist and no pull-request step runs them.
const { rank, LEVELS } = require('./index/tests');
const { runsOnPR } = require('./ci/checks');
const { groupBy, plural } = require('./util');

function assessPlacement({ proofs, tests, ci }) {
  const issues = [];

  for (const p of proofs) {
    if (!p.links.length || p.status === 'inactive' || p.status === 'not_a_rule') continue;
    const live = p.links.filter((l) => !l.case.skipped);
    if (!live.length) continue;
    const rule = p.rule;
    // The lowest level that can prove the rule: the word lists say, the model may refine. When they disagree the
    // finding is advice; when they agree, or only code spoke, it stands as code-decided.
    const expected = p.modelLevel || rule.lowest;
    const agreed = !p.modelLevel || p.modelLevel === rule.lowest;
    const lv = live.map((l) => rank(l.case.file.level));
    const lowest = Math.min(...lv), highest = Math.max(...lv);
    p.placement = { expected, lowest: LEVELS[lowest], highest: LEVELS[highest], ok: true };
    if (rank(expected) <= rank('component') && lowest > rank(expected) && lowest >= rank('integration')) {
      p.placement.ok = false;
      const rows = live.reduce((n, l) => n + Math.max(1, l.case.params), 0);
      issues.push({
        kind: 'too-high', rule, basis: agreed ? 'S' : 'A', files: live.map((l) => l.case.file),
        text: `${rule.id} is ${rule.nature === 'ui' ? 'one component\'s behaviour' : 'logic'}${rule.limits.length ? ` with limits (${rule.limits.map((l) => l.raw).join(', ')})` : ''}, and is proven only at ${LEVELS[lowest]} level (${plural(rows, 'case')} in ${live[0].case.file.path}).`,
        fix: `Add ${expected} tests for the rule${rule.limits.length ? ' and its boundary values' : ''}${p.impl.length && p.impl.length <= 2 ? ` against \`${p.impl[0]}\`` : ''}; keep one ${LEVELS[lowest]} case for the wiring.`,
      });
    } else if (rank(expected) >= rank('integration') && highest < rank('integration') && live.every((l) => l.case.file.mock)) {
      p.placement.ok = false;
      issues.push({
        kind: 'boundary-mocked', rule, basis: agreed ? 'S' : 'A', files: live.map((l) => l.case.file),
        text: `${rule.id} is about a real boundary (${rule.tags.find((t) => t.area === 'external' || t.area === 'data')?.word || rule.nature}), and every test that proves it fakes that boundary (\`${live[0].case.file.mock}\` in ${live[0].case.file.path}).`,
        fix: `Add one ${expected} test that crosses the real boundary; the ${LEVELS[highest]} tests can keep the edge cases.`,
      });
    }
  }

  for (const tf of tests.files) {
    if (tf.lang === 'gherkin') continue;
    if (tf.declared && rank(tf.observed) > rank(tf.declared)) {
      issues.push({ kind: 'mislabelled', basis: 'S', files: [tf], text: `${tf.path} is filed as ${tf.declared} and needs ${tf.observed === 'e2e' ? 'a browser or a running system' : tf.observed === 'integration' ? 'a network, a database or a child process' : 'a rendered component'} (\`${tf.why}\`).`, fix: `Move it to the ${tf.observed} suite, or replace \`${tf.why}\` with a fake so it stays a ${tf.declared} test.` });
    } else if (tf.declared && rank(tf.declared) >= rank('integration') && tf.observed === 'unit' && tf.imports.length && !tf.mock && !tf.fs) {
      issues.push({ kind: 'no-boundary', basis: 'S', files: [tf], text: `${tf.path} is filed as ${tf.declared} and crosses no boundary: it calls \`${tf.imports[0]}\` directly (${plural(tf.cases.length, 'case')}).`, fix: 'Move these cases to the unit suite: same proof, feedback in seconds, and they run on every pull request.' });
    }
    if (rank(tf.level) >= rank('integration')) {
      const rows = tf.cases.reduce((n, c) => n + (c.params >= 4 ? c.params : 0), 0);
      if (rows) issues.push({ kind: 'table-at-top', basis: 'S', files: [tf], text: `${tf.path} runs ${plural(rows, 'parameter row')} at ${tf.level} level.`, fix: 'Move the table to a unit test of the logic it varies; keep one row here to prove the wiring.' });
    }
  }

  // shape and CI, per level
  const levels = {};
  for (const l of LEVELS) levels[l] = { files: 0, cases: 0, pr: 0, notRun: [] };
  for (const tf of tests.files) {
    const s = levels[tf.level];
    s.files++; s.cases += tf.cases.length;
    const st = runsOnPR(tf, ci);
    if (st === 'pr' || st === 'unknown') s.pr++; else s.notRun.push({ path: tf.path, state: st });
  }
  const fast = levels.unit.cases + levels.component.cases, slow = levels.integration.cases + levels.e2e.cases;
  if (fast + slow >= 10 && slow > fast) issues.push({ kind: 'pyramid', basis: 'S', files: [], text: `${slow} integration and end-to-end cases against ${fast} unit and component cases: the suite is top-heavy.`, fix: 'For each slow test, ask what it would lose as a unit test; move what loses nothing.' });
  if (ci.testSteps.length) {
    // When the test check itself is not enforced, that is one finding (ci.tests). The levels it takes down with it are
    // recorded, so the rules proven there are not reported one by one, and not reported a second time here.
    const testsEnforced = ci.testSteps.some((t) => !t.e2e && (t.state === 'enforced' || t.state === 'path_filtered' || t.state === 'unverified'));
    for (const l of LEVELS) {
      const s = levels[l];
      if (!s.files || s.notRun.length < s.files) continue;
      const states = groupBy(s.notRun, (x) => x.state);
      const why = states.has('soft') ? 'only by a step whose failure is ignored' : states.has('not_pr') ? 'only outside pull requests' : 'by no CI step';
      issues.push({ kind: 'level-not-run', level: l, basis: 'S', silent: !testsEnforced && l !== 'e2e', files: tests.files.filter((f) => f.level === l).slice(0, 5), text: `${plural(s.files, `${l} test file`)} (${plural(s.cases, 'case')}) ${s.files === 1 ? 'is' : 'are'} run ${why}.`, fix: l === 'e2e' ? 'Run a smoke subset on pull requests, or accept the gap and say so in .quality-gate.yml.' : `Add a pull-request step that runs the ${l} tests.` });
    }
  }
  return { issues, levels };
}

module.exports = { assessPlacement };
