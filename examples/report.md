# Quality gate: acme/shop @ 4f2a9c1

**❌ Fail**: 9 findings block the gate (2 P0, 7 P1). Full review of the repository.

| Question | Answer | P0 | P1 |
| --- | --- | --- | --- |
| 1. Is every requirement and design decision proven by a test? | **5 of 11** rules proven · 2 with a hole · 3 with no test · 0 unverified · 1 not testable as written. Critical rules: **4 of 9** proven. | 2 | 3 |
| 2. Is each thing tested at the right level? | 5 placement findings. Cases: unit 7 · component 0 · integration 2 · e2e 2. | 0 | 2 |
| 3. Does CI enforce the checks on pull requests? | **2 of 8** checks enforced: Tests ✅ · Lint ❌ · Type check ❌ · Format ❌ · Coverage ❌ · Dependency scan ✅ · Secret scan ❌ · Static security analysis ❌. | 0 | 3 |

## Fix first: P0 and P1

| # | Priority | Blocks | Finding | Evidence | Fix |
| --- | --- | --- | --- | --- | --- |
| 1 | P0 | **yes** | **REQ-4 Refund window (critical: money · "refund") is proven only by skipped tests** | `tests/unit/refund.test.ts:3` is skipped, so nothing checks the rule. _(code)_ | Fix and re-enable the test, or delete it and write one that runs. |
| 2 | P0 | **yes** | **REQ-10 Price rounding (critical: money · "price") has no test** | "Price rounding. A price is rounded half up to whole cents before it is shown." (`docs/requirements.md:11`): the nearest test (`tests/unit/price.test.ts:4` "price › rounds the price half up to whole cents") does not assert it, by the model's reading, done twice: rounding half up to whole cents; the test only checks the currency sign. _(model, verified)_ | Write a unit test that fails when the rule is broken; name `REQ-10` in the test (its title or a `// covers: REQ-10` comment) so the link is a fact from then on. |
| 3 | P1 | **yes** | **REQ-6 Password length (critical: auth · "password"): no linked test uses the stated limit at least 12 characters** | Linked test: `tests/unit/password.test.ts:4` "password › rejects a password shorter than the minimum leng…". The model adds: the 12-character boundary: the test only tries 8 characters, never 11 and 12. _(model, verified)_ | Add cases at 11, 12 and 13. |
| 4 | P1 | **yes** | **e2e tests do not gate pull requests** | 2 e2e test files (2 cases) are run only outside pull requests. 1 rule is proven only there, 1 critical: REQ-2. _(code)_ | Run a smoke subset on pull requests, or accept the gap and say so in .quality-gate.yml. |
| 5 | P1 | **yes** | **REQ-3 Payment retry (critical: money, external · "payment") is proven only against fakes** | REQ-3 is about a real boundary (gateway), and every test that proves it fakes that boundary (`jest.mock(` in tests/unit/payment.test.ts). _(code)_ | Add one integration test that crosses the real boundary; the unit tests can keep the edge cases. |
| 6 | P1 | **yes** | **REQ-2 Free shipping (critical: money · "fee") is tested above the level it needs** | REQ-2 is logic with limits (over $50, $5), and is proven only at e2e level (5 cases in tests/e2e/shipping.spec.ts). _(code)_ | Add unit tests for the rule and its boundary values against `src/shipping.ts`; keep one e2e case for the wiring. |
| 7 | P1 | **yes** | **REQ-7 Order export has no test** | "Order export. An order history can be exported as CSV." (`docs/requirements.md:9`): no test names `REQ-7` or shares its words (searched: csv, export, history, order). _(code)_ | Write a unit test that fails when the rule is broken; name `REQ-7` in the test (its title or a `// covers: REQ-7` comment) so the link is a fact from then on. |
| 8 | P1 | **yes** | **Lint: failures are ignored** | Lint runs on pull requests (`npm run lint`, `.github/workflows/ci.yml:13`), and its failure is ignored (continue-on-error or `\|\| true`). _(code)_ | Remove `continue-on-error` / `\|\| true`, or fix what fails and then remove it. |
| 9 | P1 | **yes** | **Type check: set up, not enforced** | Type check is set up (tsconfig.json) and no CI step runs it: nothing stops a change that breaks it. _(code)_ | Add a pull-request step that runs it. |
| 10 | P1 | no (advice) | **REQ-8 Payment speed (critical: money · "payment") cannot be tested as written** | "Payment speed. Payment processing should be fast." (`docs/requirements.md:10`): "fast" has no number; state a time limit such as p95 under <N> ms _(advice)_ | Rewrite it with a subject, a trigger and a checkable outcome (a number, a state, an error). |

## 1. Proof: is every rule proven by a test?

| Document | Rules | Critical | Proven | Hole in the proof | No test | Unverified | Reword |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `docs/adr/0003-idempotent-webhooks.md` | 1 | 1 | 1 | 0 | 0 | 0 | 0 |
| `docs/design.md` | 1 | 0 | 1 | 0 | 0 | 0 | 0 |
| `docs/requirements.md` | 9 | 8 | 3 | 2 | 3 | 0 | 1 |

<details><summary>All 11 rules, critical first</summary>

| Rule | Critical | Status | Evidence |
| --- | --- | --- | --- |
| **REQ-10** Price rounding (`docs/requirements.md:11`) | money | ❌ no test | the model read the nearest tests: none asserts it |
| **REQ-4** Refund window (`docs/requirements.md:6`) | money | ❌ no test | `tests/unit/refund.test.ts:3` (unit, names the ID, skipped): every linked test is skipped (1) |
| **REQ-2** Free shipping (`docs/requirements.md:4`) | money | 🟡 hole | `tests/e2e/shipping.spec.ts:4` (e2e, names the ID): its tests do not gate pull requests (run only outside pull requests) |
| **REQ-6** Password length (`docs/requirements.md:8`) | auth | 🟡 hole | `tests/unit/password.test.ts:5` (unit, model-linked): no linked test uses the stated limit at least 12 characters |
| **REQ-8** Payment speed (`docs/requirements.md:10`) | money | ✏️ reword | too vague to test: "fast" has no number; state a time limit such as p95 under <N> ms |
| **ADR-3** Idempotent webhooks (`docs/adr/0003-idempotent-webhooks.md:1`) | external | ✅ proven | `tests/integration/webhook.int.test.ts:5` (integration, names the ID) |
| **REQ-1** Discount cap (`docs/requirements.md:3`) | money | ✅ proven | `tests/unit/discount.test.ts:4` (unit, names the ID) |
| **REQ-3** Payment retry (`docs/requirements.md:5`) | money, external | ✅ proven | `tests/unit/payment.test.ts:8` (unit, names the ID) |
| **REQ-5** Session expiry (`docs/requirements.md:7`) | auth | ✅ proven | `tests/unit/session.test.ts:6` (unit, model-linked) |
| **REQ-7** Order export (`docs/requirements.md:9`) |  | ❌ no test | no test names it or shares its words |
| **D-F72D1A** The cart must reject a quantity above 99 for one item (`docs/design.md:3`) |  | ✅ proven | `tests/unit/cart.test.ts:5` (unit, model-linked) |

</details>

Not counted: 1 rule superseded, rejected or still a draft; 1 sentence the model judged not to be testable behaviour.

## 2. Placement: is each thing tested at the right level?

| Level | What a test at this level needs | Files | Cases | Files a pull request runs |
| --- | --- | --- | --- | --- |
| unit | one process, nothing real around it | 7 | 7 | 7 of 7 |
| component | one rendered component or module slice | 0 | 0 | 0 of 0 |
| integration | a real database, HTTP, queue or process | 2 | 2 | 2 of 2 |
| e2e | the whole system, driven from outside | 2 | 2 | 0 of 2 |

| # | Priority | Blocks | Finding | Evidence | Fix |
| --- | --- | --- | --- | --- | --- |
| 5 | P1 | **yes** | **REQ-3 Payment retry (critical: money, external · "payment") is proven only against fakes** | REQ-3 is about a real boundary (gateway), and every test that proves it fakes that boundary (`jest.mock(` in tests/unit/payment.test.ts). _(code)_ | Add one integration test that crosses the real boundary; the unit tests can keep the edge cases. |
| 6 | P1 | **yes** | **REQ-2 Free shipping (critical: money · "fee") is tested above the level it needs** | REQ-2 is logic with limits (over $50, $5), and is proven only at e2e level (5 cases in tests/e2e/shipping.spec.ts). _(code)_ | Add unit tests for the rule and its boundary values against `src/shipping.ts`; keep one e2e case for the wiring. |
| 12 | P2 | no (below the gate) | **tests/unit/geo.test.ts is not a unit test** | tests/unit/geo.test.ts is filed as unit and needs a network, a database or a child process (`localhost:3000`). _(code)_ | Move it to the integration suite, or replace `localhost:3000` with a fake so it stays a unit test. |
| 13 | P2 | no (below the gate) | **tests/e2e/totals.e2e.test.ts is a unit test in the e2e suite** | tests/e2e/totals.e2e.test.ts is filed as e2e and crosses no boundary: it calls `src/totals.ts` directly (1 case). _(code)_ | Move these cases to the unit suite: same proof, feedback in seconds, and they run on every pull request. |
| 14 | P2 | no (below the gate) | **tests/e2e/shipping.spec.ts runs a parameter table at e2e level** | tests/e2e/shipping.spec.ts runs 5 parameter rows at e2e level. _(code)_ | Move the table to a unit test of the logic it varies; keep one row here to prove the wiring. |

## 3. CI: are the checks enforced on pull requests?

| Check | State | Where | Note |
| --- | --- | --- | --- |
| Tests | ✅ enforced | `.github/workflows/ci.yml:16` (check) | `npm test` |
| Lint | ❌ failures ignored | `.github/workflows/ci.yml:13` (check) | `npm run lint` |
| Type check | ❌ set up, not run | set up: tsconfig.json |  |
| Format | ❌ set up, not run | set up: .prettierrc |  |
| Coverage | ❌ missing |  |  |
| Dependency scan | ✅ enforced | set up: .github/dependabot.yml | by .github/dependabot.yml |
| Secret scan | ❌ missing |  | GitHub secret scanning is a repository setting this run cannot see |
| Static security analysis | ❌ missing |  |  |

- Branch protection (which checks are required to merge) is a repository setting this run does not read.

## Lower priority: P2 and P3

<details><summary>1 finding</summary>

| # | Priority | Finding | Evidence | Fix |
| --- | --- | --- | --- | --- |
| 11 | P2 | **Format: set up, not enforced** | Format is set up (.prettierrc) and no CI step runs it: nothing stops a change that breaks it. _(code)_ | Add a pull-request step that runs it. |

</details>

## Run

- Files: 35 listed, 0 vendored or generated and skipped; read: 4 rule documents, 11 test files (11 cases), 2 CI files. Source files are not read, except the ones a change touches.
- Rules: 13 (11 with an ID in the source, 2 inferred from normative sentences) from `docs/requirements.md` (9), `docs/adr/0003-idempotent-webhooks.md` (1), `docs/adr/0004-soap-gateway.md` (1), `docs/design.md` (2).
- Model: handoff (stand-in (recorded answers)). 6 rules needed a judgment: 0 from the verdict cache, 6 asked, 1 read a second time, in 2 calls (5k characters, about 1k tokens sent).
- Shown to the model: 5 candidate tests, 19 of their 19 lines (the opening, every assertion, the lines that share the rule's words). Every assertion of every candidate was shown.
- Read by code, in full: 4 rule documents, 11 test files, 2 CI files. The model reads no file.
- Tests are read, not run. Evidence levels: _code_ is decided by parsing; _model, verified_ is a model answer whose citation code checked; _advice_ never blocks.
- Time: scan 4 ms · extract 23 ms · index 11 ms · ci 19 ms · model 0 ms · link 1 ms · judge 6 ms · assess 1 ms · execute 0 ms · placement 1 ms.
