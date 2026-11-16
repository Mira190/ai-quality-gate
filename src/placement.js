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
//   no-boundary       a case in an integration or end-to-end file that crosses nothing: no call out of the process,
//                     nothing awaited, nothing of the suite's setup used. A unit test waiting in the slow queue.
//   table-at-top      a parameter table in an integration or end-to-end test, written as a table or as several
//                     cases that differ only in their data: combinations belong below, one case stays.
//   duplicate-below   an integration or end-to-end case that says what a unit test already says (advice).
// The first two need no document and no model: they are read off the tests alone, case by case.
//   pyramid           more slow tests than fast ones.
//   level-not-run     tests of a level exist and no pull-request step runs them.
const { rank, LEVELS } = require('./index/tests');
const { runsOnPR } = require('./ci/checks');
const { groupBy, plural, clip } = require('./util');

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

  // What already says the same thing at unit level: the names of the unit cases, by their words.
  const unitByWord = new Map();
  for (const tf of tests.files) if (tf.level === 'unit' && !tf.script) for (const c of tf.cases) for (const w of c.nt) if (!w.startsWith('=')) { if (!unitByWord.has(w)) unitByWord.set(w, []); unitByWord.get(w).push(c); }
  const twinOf = (c) => {
    const words = c.nt.filter((w) => !w.startsWith('='));
    if (words.length < 4) return null;
    const hits = new Map();
    for (const w of words) for (const u of unitByWord.get(w) || []) hits.set(u, (hits.get(u) || 0) + 1);
    let best = null;
    for (const [u, n] of hits) {
      const size = new Set([...words, ...u.nt.filter((w) => !w.startsWith('='))]).size;
      // a unit test that fakes its collaborators is not repeated by the test that crosses the real boundary: that
      // one is the other half of the proof
      if (n >= 4 && n / size >= 0.6 && !u.file.mock && (!best || n / size > best.share)) best = { case: u, share: n / size };
    }
    return best;
  };

  const plan = { heavy: 0, movable: 0, pure: 0, variations: 0, twins: 0, waitMs: 0 };
  for (const tf of tests.files) {
    if (tf.lang === 'gherkin') continue;
    const heavy = rank(tf.level) >= rank('integration') && !tf.script;
    if (heavy) plan.heavy += tf.cases.reduce((n, c) => n + Math.max(1, c.params || 0), 0);   // a row of a table is a case that runs
    const gates = () => { const st = runsOnPR(tf, ci); return st === 'pr' || st === 'unknown'; };
    const seconds = (ms) => (ms >= 1000 ? ` They wait at least ${Math.round(ms / 1000)} s between them.` : '');
    if (tf.declared && rank(tf.observed) > rank(tf.declared)) {
      issues.push({ kind: 'mislabelled', basis: 'S', files: [tf], text: `${tf.path} is filed as ${tf.declared} and needs ${tf.observed === 'e2e' ? 'a browser or a running system' : tf.observed === 'integration' ? 'a network, a database or a child process' : 'a rendered component'} (\`${tf.why}\`).`, fix: `Move it to the ${tf.observed} suite, or replace \`${tf.why}\` with a fake so it stays a ${tf.declared} test.` });
      continue;   // the file as a whole is the finding; its cases are not judged one by one on top of it
    } else if (tf.declared && rank(tf.declared) >= rank('integration') && tf.observed === 'unit' && tf.imports.length && !tf.mock && !tf.fs) {
      plan.movable += tf.cases.length; plan.pure += tf.cases.length;
      issues.push({ kind: 'no-boundary', basis: 'S', files: [tf], cases: tf.cases, gates: gates(), text: `${tf.path} is filed as ${tf.declared} and crosses no boundary: it calls \`${tf.imports[0]}\` directly (${plural(tf.cases.length, 'case')}).`, fix: 'Move these cases to the unit suite: same proof, feedback in seconds, and they run on every pull request.' });
      continue;
    }
    if (!heavy) continue;
    // 1. cases that cross nothing: no call out of the process, nothing awaited, nothing of the suite's setup used
    const pure = tf.cases.filter((c) => c.pure && c.asserts > 0 && !c.skipped);
    if (pure.length) {
      plan.movable += pure.length; plan.pure += pure.length;
      issues.push({
        kind: 'no-boundary', basis: 'S', files: [tf], cases: pure, gates: gates(),
        text: `${plural(pure.length, 'case')} of ${tf.cases.length} in ${tf.path} (${tf.level}) cross${pure.length === 1 ? 'es' : ''} no boundary: no call out of the process, nothing awaited, nothing of the suite's setup used (${pure.slice(0, 3).map((c) => `line ${c.line} "${clip(c.name.split(' › ').pop(), 40)}"`).join(', ')}${pure.length > 3 ? ', …' : ''}).`,
        fix: `Move ${pure.length === 1 ? 'it' : 'them'} to a unit test file${tf.imports.length ? ` next to \`${tf.imports[0]}\`` : ''}: the same assertions, without the ${tf.level} suite's start-up.`,
      });
    }
    // 2. the same case several times with different data: a parameter table, written out or not
    const rest = tf.cases.filter((c) => !c.pure && !c.skipped);
    const rows = rest.reduce((n, c) => n + (c.params >= 4 ? c.params : 0), 0);
    const shapes = [...groupBy(rest.filter((c) => c.shape && !c.params), (c) => c.shape).values()].filter((g) => g.length >= 3);
    const copies = shapes.reduce((n, g) => n + g.length, 0);
    if (rows || copies) {
      const extra = Math.max(0, rows - rest.filter((c) => c.params >= 4).length) + copies - shapes.length;
      const waitMs = [...rest.filter((c) => c.params >= 4), ...shapes.flat()].reduce((n, c) => n + c.waitMs * Math.max(1, c.params), 0);
      plan.movable += extra; plan.variations += extra; plan.waitMs += waitMs;
      const what = [rows && `${plural(rows, 'parameter row')}`, copies && `${plural(copies, 'case')} that differ only in their data (${shapes.slice(0, 2).map((g) => `lines ${g.slice(0, 4).map((c) => c.line).join(', ')}${g.length > 4 ? ', …' : ''}`).join('; ')})`].filter(Boolean).join(' and ');
      issues.push({ kind: 'table-at-top', basis: 'S', files: [tf], cases: [...rest.filter((c) => c.params >= 4), ...shapes.flat()], text: `${tf.path} runs ${what} at ${tf.level} level: each one pays for the whole ${tf.level === 'e2e' ? 'system' : 'boundary'} to vary one input.${seconds(waitMs)}`, fix: `Keep one case here to prove the wiring; move the other ${extra} to a table in a unit test of the logic they vary.` });
    }
    // 3. what a unit test already says
    const twins = rest.map((c) => ({ c, twin: twinOf(c) })).filter((x) => x.twin);
    if (twins.length) {
      plan.twins += twins.length;
      issues.push({ kind: 'duplicate-below', basis: 'A', files: [tf], cases: twins.map((x) => x.c), text: `${plural(twins.length, 'case')} in ${tf.path} ${twins.length === 1 ? 'says' : 'say'} what a unit test already says (line ${twins[0].c.line} "${clip(twins[0].c.name.split(' › ').pop(), 40)}" and \`${twins[0].twin.case.file.path}:${twins[0].twin.case.line}\`${twins.length > 1 ? `, and ${twins.length - 1} more` : ''}).`, fix: `If the ${tf.level} case adds nothing but the route to the same check, keep one as a smoke test and drop the rest.` });
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
    const anyEnforced = ci.testSteps.some((t) => t.state === 'enforced' || t.state === 'path_filtered' || t.state === 'unverified');
    for (const l of LEVELS) {
      const s = levels[l];
      if (!s.files || s.notRun.length < s.files) continue;
      const states = groupBy(s.notRun, (x) => x.state);
      const why = states.has('soft') ? 'only by a step whose failure is ignored' : states.has('not_pr') ? 'only outside pull requests' : 'by no CI step';
      issues.push({ kind: 'level-not-run', level: l, basis: 'S', silent: !anyEnforced || (!testsEnforced && l !== 'e2e'), files: tests.files.filter((f) => f.level === l).slice(0, 5), text: `${plural(s.files, `${l} test file`)} (${plural(s.cases, 'case')}) ${s.files === 1 ? 'is' : 'are'} run ${why}.`, fix: l === 'e2e' ? 'Run a smoke subset on pull requests, or accept the gap and say so in .quality-gate.yml.' : `Add a pull-request step that runs the ${l} tests.` });
    }
  }
  return { issues, levels, plan };
}

module.exports = { assessPlacement };
