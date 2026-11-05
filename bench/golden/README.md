# Golden set: does the report find what is there, and only that?

The question this set answers is the one the project has to answer before anyone relies on a report: **when the report
says a rule is untested, a test is weak, a document is unclear or a CI check is missing, is that true, and does it
miss real gaps?** Each track gives recall (real gaps found) and precision (reported issues that are real) per check, so a
check that cannot be trusted shows up on its own line instead of hiding inside an average.

| Track | What it is | Ground truth | Covers | Needs the model |
| --- | --- | --- | --- | --- |
| **seeded** | `seeded/`: a clean repository (`refund-service`) plus one case per seeded defect, and negative cases that must stay clean | By construction: each case changes one thing and lists the issue it must produce | Sections 1–5: document measures, test evidence (no test, skipped, simulator, weak assertion, limits, mocked boundary, nightly only, placement, suspected not built), CI gate, critical tags | Sections 1–4 yes (`--mode live`); section 5, Specific, Traceable and critical tags no |
| **real-ci** | `real-ci/labels.json`: 31 open-source repositories (JS/TS, Python, Go) at pinned commits: a `tuned` split (17, used while fixing the code) and a `held-out` split (14, labelled separately and run once with the code frozen) | Each CI check labelled by hand from the workflow files, with the `path:line` evidence, independently of the tool's code | Section 5 on real-world CI | No |
| fixture (existing) | `tests/fixture/quote-service`: the mock report's repository | The mock report | Whole report, cassette replay | Replay only |
| discovery (existing) | `bench/discovery`: 16 repositories, 2,197 labelled documents | Hand / independent reviewer labels | Stage 2, finding requirement and design documents | Optional |

## Results so far (section 5, code only; full tables in RESULTS.md)

| Version | Tuned split, 17 repositories: agreement / precision / recall | Held-out split, 14 repositories: agreement / precision / recall | Seeded hard cases |
| --- | --- | --- | --- |
| v1 (before) | 57% / 49% / 100% | 61% / 52% / 100%, with 2 repositories crashing | 0 of 5 found, 21 false alarms (5 P0) |
| v2, frozen before the held-out run | 93% / 86% / 100% | **84% / 75% / 94%** | 5 of 5, 0 false alarms |
| v2, after fixing the held-out failures | 93% / 86% / 100% | 95% / 89% / 100% | 5 of 5, 0 false alarms |

- **The honest estimate is the frozen held-out row (84% / 75% / 94%).** The last row was fixed by looking at those
  failures, so it is optimistic. To get the next honest number, label a new held-out batch before changing the code again.
- v1's worst issue was the P0 "No PR job runs the unit or component tests", which was wrong on 14 of 16 repositories,
  this one included. v2 follows package.json scripts, Makefile targets, repository shell scripts, tox (ini and
  pyproject, envlist), nox, pre-commit hooks (including local `entry:` hooks), local reusable workflows and composite
  actions, workspace fan-out (`pnpm -r`, turbo, lerna) and `working-directory`. It knows mocha, `node --test`, ava, borp,
  unittest and `$(GO) test`. It treats `|| true`, `if: false` and a `pull_request` limited to other branches as unable to gate.
- v2 also fixed a crash in v1's glob matcher: jest's default `?(*.)+(spec|test)` pattern threw an error.
- Remaining errors are known gaps: reusable workflows from another repository (fastify, bubbletea), task runners it
  does not read (mise in date-fns, Vite+ `vp` in hono, `go run scripts/build.go` in urfave/cli), and type checks done
  only inside sub-package test fixtures (axios).
- Sections 1–4 (the model's part) are still not scored: this environment has no API key. 24 expected issues are
  waiting for `--mode record`.

## Test evidence that code decides (sections 3–4, 2026-11-05)

From first principles a row's value is the chance it is true times what it protects. The P0 rows "critical rule has no
test" are the most valuable and were decided entirely by the model: with no model there were no section 3–4 rows, and
with one, "No test" meant "the model did not link a test", which code never checked (design constraint 4 says it must).
Code now decides what it can prove:

- **Implementation**: a rule that names its code (`` `src/gateway.js` ``, `` `RefundService.refund` ``) gets that code, found by
  code (a method in its class's file, TypeScript signatures included), over the model's pick. On the quote-service
  fixture: right for all 3 rules that name their code.
- **Limits**: the edges the rule text states ("within 30 days", "$15 or less", "from $500 to $5,000", "after 5 seconds")
  are added to the model's limits, so "Covers stated limits" works without it. Plain amounts ("a $50 fee"), IDs and
  status codes are not edges.
- **Links without the model**: only what proves intent counts, which means tests that carry the rule's ID. A test that
  imports or names the code exercises it but may not assert the rule (the fixture's `payment.test.ts` charges a card and
  never sends the same key twice), so that rule stays "not traced" instead of looking covered.
- **"No test" without the model** only when no test names the rule's ID or symbol and none imports its file.
  With the model, links stay the model's call (the mock's accepted behaviour), plus ID tags.

What this buys, measured: offline, 5 more seeded test-evidence defects are scored (all found, no false alarms on the
clean cases). What it does not: on the fixture, code can trace only 1 of 25 rules on its own; on the 31 real repositories,
offline extraction finds rules in only one (react-router's ADRs, 9 decisions), and code traces none of them, correctly.
Real requirement documents rarely carry IDs or name their code, so **most of the report's value still sits on the model
and is still unmeasured here**.

A real-repository check caught a bug before it shipped: react-router's `useBlocker` decision was first reported "No
test" by code, but `__tests__/dom/use-blocker-test.tsx` exists. A `\b` written in a template string meant a backspace,
not a word boundary, so the safety search matched nothing. Fixed, and covered by a unit test.

## Sections 1–4 with a stand-in model (2026-11-05)

No API key here, so other agents stood in for the model: `scripts/llm-standin.js` writes every model call the
cassettes lack as a request; an agent (Claude Haiku, told to read only the request files) answers in the call's JSON
schema; the answers go into `seeded/cassettes-standin/`. Three agents answered one vote each, so the pipeline's
majority-of-3 rule worked as with the API. Full table: `RESULTS-standin.md`; re-score with
`node scripts/eval-golden.js --track seeded --mode fill --votes 3 --cassettes bench/golden/seeded/cassettes-standin`.

| | Seeded defects found | Issues that were seeded | Clean cases with a false alarm | False P0 |
| --- | :-: | :-: | :-: | :-: |
| Sections 1–5, stand-in model, 3 votes | 51 of 54 (94%) | 51 of 60 (85%) | 0 of 19 | 0 |
| Sections 1–2 only | 9 of 9 | 9 of 9 | 0 | 0 |

Of the 9 extra issues, 4 are defensible (no running test asserts a rule whose cases are all skipped; a 45-day
decision whose only test asserts day 31 is rejected; an HTTPS decision nothing tests). The rest, and 2 of the 3 misses,
are one weakness: a general browser test the model links to a rule turns a P0 "No test" into P1 rows (limits,
placement, assertion), so the gap is still reported, one priority too low; and a test of a copy of the code is dropped
by the import check instead of reported as "Calls the code". The third miss: "Suspected not built" is checked for design
decisions only, so an admin route that checks the login but not the role is caught only through its tests.

The runs also found 6 bugs in the tool, all fixed with a unit test: a status code taken as a limit (HTTP 403, twice);
values either side of an edge (4999/5001 ms) not counted as covering it; "retried by the nightly job" read as counting
to a limit; the cases that assert a rule cut from the model's view (search terms are phrases, tests say `toBe(403)`);
and a general browser test hiding that all of a rule's own cases are skipped. The first round also found a real gap in
our "clean" base (DEC-02 said nothing about its store failing), which the base now states.

On the quote-service fixture (`adjudication/quote-service/`), an independent reviewer judged the 28 findings only one
side reported: the tool with a stand-in model got 30 of 36 shown findings right (88%) and found 30 of the 33 true
ones; the hand-written mock got 25 of 27 right and found 25, missing a real defect (a gateway call with no timeout).

Caveats: the stand-in is an agent on a Claude model answering the production prompts, not the production API; the
seeded repository is small and was written knowing the checks. Confirm with `--mode record` when a key is available.

## Run it

```bash
node scripts/eval-golden.js                                   # both tracks, code only (no key needed)
node scripts/eval-golden.js --track real-ci --split held-out  # one split of the real repositories
node scripts/eval-golden.js --track seeded --mode record      # sections 1-4 with the model; saves cassettes
node scripts/eval-golden.js --track seeded --mode replay      # re-score from the cassettes, free
node scripts/eval-golden.js --out bench/golden/RESULTS.md     # write the scorecard
```

`--mode record` needs `ANTHROPIC_API_KEY` (in the environment or `.env`). It costs a few cents per case with
`claude-haiku-5-5` and 3 votes; `--max-usd` caps each case. Commit `seeded/cassettes/` so later runs replay for free.
Run it 3 times (`--mode live`) to see how stable the model-judged checks are.

`npm test` runs the seeded cases offline and fails if a code-decided check misses a seeded defect or raises a false
alarm.

## How to read the seeded track

- **expect**: issues a correct reviewer reports for that change. Missing one is a miss.
- **allow**: issues that are also defensible for that change (a vague requirement also has no limits to cover). They
  count neither way.
- Anything else reported is a **false alarm**. The clean base and the `neg-*` cases expect nothing, so every issue
  on them is a false alarm.
- Three groups. The first was written knowing which tools and phrases the code recognises, so its score is an **upper
  bound**: it proves the checks work on their own vocabulary. The **hard** group was written from how real repositories
  set up CI (pre-commit, a Makefile, a reusable workflow, `xo`, `c8`, `node --test`, `|| true`, `if: false`) before the
  parser handled them. The **regression** group repeats, in miniature, each pattern a real repository broke. `npm test`
  asserts all three, so a fixed gap stays fixed. The real-ci held-out split is the honest estimate.

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
- Keep the held-out split honest: when you fix code using its failures, label a fresh batch (other repositories, by
  someone who has not read `src/ci.js`) as the next held-out split, and report its first frozen run.
- The real-ci labels are one careful reading per repository. Rows marked medium or low confidence in `labels.json`
  are the ones to recheck first when a disagreement looks surprising.
- Sections 1–4 on real repositories have no golden labels yet. The next track to build: repositories whose tests carry
  requirement IDs (the IDs are the gold links; mask them and score the trace), and escaped defects (a bug-fix commit
  that adds the first test for a documented rule: the report at the parent commit should have flagged that rule).
