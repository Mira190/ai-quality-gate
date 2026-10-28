# Report summary template

The shape of `report.md`, the repository health report that `scripts/repo-report.js` writes. Every number, priority,
order, link and bold mark below is set by code from the ledger (`ledger.json`); the model writes only the text of the
"What fails / Why, and the fix" cells and the "Do this / What is at risk" cells, and code checks every file, line,
number and issue it cites (a cell that fails the check is replaced by a plain code-written one and listed in
`ledger.dropped`). `tests/report-golden.test.js` proves the template: the fixture repository renders byte-equal to
`mock-report-summary (2).md`.

Slots are written `{like_this}`. A line starting with `?` is printed only when its condition holds.

---

## Layout

```markdown
# AI repository review: {owner/name} @ `{sha7}`

| Area | Score (0–100) | What the score means |
| --- | :-: | --- |
| [1. Requirement health](#s1) | {score s1} | {x} of {n} requirements are clear enough to test |
| [2. Design health](#s2) | {score s2} | {x} of {n} design decisions are clear enough to test |
| [3. Requirement coverage](#s3) | {score s3} | {x} of {n} requirements meet the test standard with tests running in PR CI |
| [4. Design coverage](#s4) | {score s4} | {x} of {n} design decisions that add behaviour meet the test standard with tests running in PR CI |
| [5. CI gate](#s5) | {score s5} | {x} of the 7 CI checks are set up |

Critical rules with tests that meet the standard and run in PR CI: **{met} of {critical}{ (IDs) when 1 to 3 met}**.

{run line}

---

## Top actions

| # | Do this | What is at risk | Critical rules protected |
| :-: | --- | --- | --- |
| {n} | **{headline}** {body} | {risk per rule} | {credits} |

---

<a id="s1"></a>

## 1. Requirement health

| Issue number | Priority | Req | Fails on | Status | What fails, and the fix |
| :-: | :-: | --- | --- | --- | --- |
| I-{n} | {P0/P1} | {label} | **{measure}**{ (part)} | {status} | {cell} |

**Not critical ({k}):** {IDs}.

---
(sections 2 to 5, below)
---

**AI used:** model `{model}` · **{AIU, 2 decimals} AIU** in total.
```

`{score}` is `🟢 n` for n ≥ 90, `🟡 n` for 70 to 89, `🔴 n` below 70, with n = round(100 · x / n). When n is 0 the cell is
`n/a` and the meaning names why: `No requirement found`, `No design decision found`, `No tests found`,
`No design decision that adds behaviour found`, `No CI configuration found`, or `Not judged` / `Not traced: no model
reply` (rules the model gave no answer for are left out of the score and named in the run line).

## Run line

One paragraph wrapped at 115 characters, parts joined by ` · `:

1. `Run {date} · Read: {sources}, {cases} tests in {files} files, {k} CI workflows`. A source is
   `` `path` (12 requirements) ``; with more than 5 documents, one entry per folder
   (`` `docs/` (6 requirements in 3 files) ``), and per top-two-level folder when that still gives more than 8.
   Documents with requirements come first, then design documents, each by path.
2. `**Rules found:** {n} ({k} with an ID in the source)` (rules without an ID get `REQ-n` / `DEC-n` in document order).
3. `?` `**Not judged:** / **Not traced:** {n} rules (no model reply; left out of scores …)`
4. `**Tests: read, not run**` (the target repository is never built or run).
5. `**Branch protection: {not readable | requires {checks} | no required checks}**` (needs a token with Administration
   read).
6. `**Not read:** {documents over the size or count budget}, Jira, Confluence, PR history. Rules that appear only in
   those sources are not counted.`
7. `?` `**Skipped:** {superseded or archived documents}. Rules in them are not counted.`

More than 5 Not read / Skipped entries are grouped by folder and reason (`` `docs/` (9 files, over the … budget) ``).

## Labels

- First time a rule appears in the whole report: `{ID} {title} (critical: {area} · "{word}")`, or
  `(critical: {area}, as {REQ})` for a decision that restates a critical requirement. Non-critical: `{ID} {title}`.
- Later in the same section: `{ID}` only. First time in a later section: `{ID} {title}`, without the tag.

## Critical rules

A rule is critical when its `title. text` contains a word from one of four fixed lists; the earliest strong word wins.

| Area (rank) | Strong words |
| --- | --- |
| money (1) | price, pricing, premium, fee, charge, discount, refund, payment, excess, tax, currency, invoice |
| access control (2) | authenticate, authentication, authorization, role, permission, admin, session, login |
| customer data (3) | personal data, customer record, retention, deletion, consent |
| outside calls (4) | gateway, CRM, webhook, HTTP client, queue, external service |

A design decision that restates a requirement inherits its tag. Sections 1 to 4 show critical rules only; the rest are
listed under **Not critical** (cut at 30 IDs, with the full list in `report-details.md`).

## Sections 1 and 2: document health

Measures, in column order. **Bold** = blocking (no correct test can be written until the text is fixed).

- Requirement: **Clear**, One behaviour, **Testable**, Specific, **Complete**, **Consistent**, Feasible
- Design decision: Traceable, **Trade-off**, Simple, **Failure behaviour**, **Verifiable**

`Traceable` is decided by code (the decision names a requirement, a Serves line, or a reason). A conflict is one fact
seen from both sides: `Consistent` on the requirement, `Trade-off` on the decision, and both cells cite the other row.
A measure that fails only for part of the rule shows the part: `**Complete** (the stacking case only)`.

Status, from the failing measures: `**Blocked**` (a blocking measure fails for the whole rule) · `Partly blocked`
(only for a part) · `Test now, fix later` (only non-blocking measures fail) · `Ready`.

Section 2 adds a `Serves` column: the requirement the decision serves or restates, else `–`.

The fix cell quotes the text with its `file:line`, says what is missing, and gives a rewrite in EARS form
("When …, the system shall …"). A value no document gives becomes a placeholder (`<N>`, `<T>`) for the owner.

## Sections 3 and 4: test coverage

Section 3 covers requirements; section 4 covers design decisions that add behaviour (a decision that only restates a
requirement is covered by that requirement). Columns: Issue number, Priority, Rule, Level, Fails on, Why, and the fix.

Checks, in order. The level is set by the first failing check.

| Check | Fails when |
| --- | --- |
| Suspected not built | (decisions) the model cites a line of the implementing file that does not do what the decision says |
| No test | no test is linked: by the rule ID in the test, by the rule's terms, or by the model's pick from candidates |
| Not skipped | the cases that test the rule are `skip` / `todo` |
| Calls the code | a non-E2E test does not import the implementation, directly or through one import |
| Asserts the rule | no assert line checks the rule's expected result (the model cites the line; code checks it is an assert) |
| Covers stated limits | the tests use none of the edge values the rule (or a file it names) states |
| Crosses the real boundary | (decisions about an outside call or stored data) the boundary is mocked, not a fake server or real store |
| Placement | a calculation, date or count rule has no unit-level test (replaces the Runs on PR row) |
| Runs on PR | no linked test runs in a pull-request workflow (excluded by config, or nightly only) |

Level: `None` (no test) · `Blocked` (status Blocked) · `Weak` (a check up to Crosses the real boundary fails) ·
`Checked nightly` (tests exist but none runs on PR) · `Meets the standard`. Section 3 bolds `**None**`; section 4 bolds
`**Suspected not built**`.

## Priority and the rerank

| Priority | Rows |
| --- | --- |
| P0 | critical rule: No test, or Suspected not built · CI: no secret scan, no PR test job |
| P1 | critical rule: a blocking measure (whole or part), or a test check that fails (Weak, Blocked, nightly, Placement, Runs on PR) |
| P2 | the same for a non-critical rule · CI: a coverage exclusion or a global-only threshold, a dependency scan missing or with `continue-on-error` |
| P3 | a non-blocking measure · CI: format, lint or type check missing |

Sections 1 to 4 show P0 and P1 only; section 5 shows every row. Rows sort by priority, then rule (requirements
before decisions, by number), then measure or check order. Issue numbers `I-n` run 1, 2, 3 … over the shown rows in
report order. Every hidden row is in `report-details.md`, so each score can be checked by hand.

## Section 5: CI gate

Seven checks, read from `.github/workflows/*.yml` (PR workflows first) and the test runner config. Failing rows first
(by priority), then passing rows with the step that does it (`` `pr.yml:14` ``).

| Check | Passes when | Fails as |
| --- | --- | --- |
| Secret scan | a PR step runs gitleaks, trufflehog, detect-secrets … and cannot be skipped | P0 |
| Coverage | a PR test step measures coverage with no source excluded and a per-folder or changed-file threshold | P2 per finding |
| Dependency scan | a PR step runs npm audit, osv-scanner, Snyk, Dependabot … without `continue-on-error` | P2 |
| Format | a PR step checks formatting | P3 |
| Lint | a PR step runs a linter | P3 |
| Type check | a PR step runs the type checker | P3 |
| Unit and component tests | a PR step runs the unit and component tests | P0 |

## Top actions

At most 5, in this order; an empty action is dropped and the rest renumbered:

1. **Confirm the suspected defects**: write the tests that should fail today (every test of a suspected rule).
2. **Fix the unclear text in sections 1 and 2**: the rewrites in the cells. Protects `None. It unblocks action N, and
   {ID} in action M`.
3. **Close the critical CI gaps** (P0 and P1 rows of section 5). Protects `None. It closes a CI gap, not a rule`.
4. **Write the critical tests** that need no document fix.
5. **After action 2, write the tests it unblocks.**

The model proposes the smallest set of tests that fixes every shown section 3 and 4 row (one test may fix several);
code checks each cited issue and rule, adds a test for any row left over, and groups the tests into actions. A critical
rule is credited once, to the first action that writes a test asserting it, as `{ID} once action N is done` when it
still waits on the document fix (Partly blocked) or on a later test. Action 1 lists its rules by area rank, the others
by ID.

## Scores

| Area | x | n |
| --- | --- | --- |
| 1 | requirements with status Ready | requirements judged |
| 2 | design decisions with status Ready | design decisions judged |
| 3 | requirements at level Meets the standard | requirements traced |
| 4 | decisions that add behaviour at level Meets the standard | those decisions traced |
| 5 | CI checks that pass | 7 |

Ready means every measure passes, not only the blocking ones: a rule with a vague word but a testable result still
costs a point, because the score is "clear enough to test", and the reader can check it against `report-details.md`.
Meets the standard needs every check to pass and a linked test to run on PR. All five are plain ratios with no weights,
so a reader can recompute each score from the rows.

## AI usage

AIU = model cost at API list price × 100 (1 AIU = US$0.01; `AIU_PER_USD` changes it), summed over every call of the run,
from the token counts the API returns.
