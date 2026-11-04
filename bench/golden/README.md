# Golden set: does the report find what is there, and only that?

The question this set answers is the one the project has to answer before anyone relies on a report: **when the report
says a rule is untested, a test is weak, a document is unclear or a CI check is missing, is that true, and does it
miss real gaps?** Each track gives recall (real gaps found) and precision (reported issues that are real) per check, so a
check that cannot be trusted shows up on its own line instead of hiding inside an average.

| Track | What it is | Ground truth | Covers | Needs the model |
| --- | --- | --- | --- | --- |
| **seeded** | `seeded/`: a clean repository (`refund-service`) plus one case per seeded defect, and negative cases that must stay clean | By construction: each case changes one thing and lists the issue it must produce | Sections 1–5: document measures, test evidence (no test, skipped, simulator, weak assertion, limits, mocked boundary, nightly only, placement, suspected not built), CI gate, critical tags | Sections 1–4 yes (`--mode live`); section 5, Specific, Traceable and critical tags no |
| **real-ci** | `real-ci/labels.json`: 17 open-source repositories (JS/TS, Python, Go) at pinned commits | Each CI check labelled by hand from the workflow files, with the `path:line` evidence, independently of the tool's code | Section 5 on real-world CI | No |
| fixture (existing) | `tests/fixture/quote-service`: the mock report's repository | The mock report | Whole report, cassette replay | Replay only |
| discovery (existing) | `bench/discovery`: 16 repositories, 2,197 labelled documents | Hand / independent reviewer labels | Stage 2, finding requirement and design documents | Optional |

## First results (2026-11-04, code only, see RESULTS.md)

- **Real gaps are found:** on 17 real repositories, every check the hand labels call missing was reported (recall
  100%, 49 of 49). Missing secret scans (16 of 17 repositories) and dependency scans are reported with 93–94% precision.
- **Too many false "missing" claims:** only 49 of 99 "missing" issues are real (precision 49%). The worst is the
  **P0 "No PR job runs the unit or component tests", which is wrong on 14 of 16 repositories that do run them**,
  this repository included (`node --test`). Its cause is that the parser only knows vitest, jest, playwright, pytest
  and `go test` called directly; mocha, `node --test`, `make` targets, tox/nox, reusable workflows and pre-commit are
  not followed. Format, lint and type check have 20–35% precision for the same reason.
- **The seeded hard group agrees:** 0 of 5 hard defects found and 21 false alarms, 5 of them P0, while the cases written
  against the tool's vocabulary score 100%. The checks are correct on what they recognise; the recognised set is too
  narrow for real repositories.
- Sections 1–4 (the model's part, which is most of the report's value) are not scored yet: this environment has no
  API key. 24 expected issues are waiting; `--mode record` scores them.



```bash
node scripts/eval-golden.js                                   # both tracks, code only (no key needed)
node scripts/eval-golden.js --track seeded --mode record      # sections 1-4 with the model; saves cassettes
node scripts/eval-golden.js --track seeded --mode replay      # re-score from the cassettes, free
node scripts/eval-golden.js --out bench/golden/RESULTS.md     # write the scorecard
```

`--mode record` needs `ANTHROPIC_API_KEY` (in the environment or `.env`). It costs a few cents per case with
`claude-haiku-5-5` and 3 votes; `--max-usd` caps each case. Commit `seeded/cassettes/` so later runs replay for free.
Run it 3 times (`--mode live`) to see how stable the model-judged checks are.

`npm test` runs the seeded cases offline and fails if a code-decided check misses a seeded defect or raises a false
alarm (except the "hard" group, which records known gaps).

## How to read the seeded track

- **expect**: issues a correct reviewer reports for that change. Missing one is a miss.
- **allow**: issues that are also defensible for that change (a vague requirement also has no limits to cover). They
  count neither way.
- Anything else reported is a **false alarm**. The clean base and the `neg-*` cases expect nothing, so every issue
  on them is a false alarm.
- Two groups. The first was written knowing which tools and phrases the code recognises, so its score is an **upper
  bound**: it proves the checks work on their own vocabulary and guards against regressions. The **hard** group was
  written from how real repositories set up CI (pre-commit, a Makefile, a reusable workflow, `xo`, `c8`,
  `node --test`, `|| true`, `if: false`), without tailoring. That group and the real-ci track are the honest estimate.

## Adding cases

A seeded case is `{ id, what, needs, expect, allow?, apply(files) }` in `seeded/cases.js`; `apply` edits the base files
with `edit(files, path, from, to)`, which throws if `from` is not found, so a case cannot silently stop applying. Seed
one defect per case. Write new section-5 cases from a real repository you have seen, not from `src/ci.js`.

A real-ci entry is `{ repo, sha, labels: { secret, coverage, dependency, format, lint, typecheck, tests }, evidence }`;
a label is `true` (set up and able to fail a PR), `false` (missing, or cannot fail), or `"na"`. Only workflows triggered
by `pull_request`, `pull_request_target` or `merge_group` count.

## Limits

- Seeded repositories are small and clean. They measure whether each check can see its defect, not how a report
  reads on a 400-file repository; the real-ci and discovery tracks and the fixture cover scale.
- The real-ci labels are one careful reading per repository. Rows marked medium or low confidence in `labels.json`
  are the ones to recheck first when a disagreement looks surprising.
- Sections 1–4 on real repositories have no golden labels yet. The next track to build: repositories whose tests carry
  requirement IDs (the IDs are the gold links; mask them and score the trace), and escaped defects (a bug-fix commit
  that adds the first test for a documented rule: the report at the parent commit should have flagged that rule).
