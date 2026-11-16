<!-- ai-quality-gate -->

### Quality gate @ 4f2a9c1

**❌ Fail**: 10 findings block the gate (2 P0, 8 P1). Full review of the repository.

| Question | Answer | P0 | P1 |
| --- | --- | --- | --- |
| 1. Is every requirement and design decision proven by a test? | **5 of 11** rules proven · 2 with a hole · 3 with no test · 0 unverified · 1 not testable as written. Critical rules: **4 of 9** proven. | 2 | 3 |
| 2. Is each thing tested at the right level? | 5 placement findings. Cases: unit 7 · component 0 · integration 2 · e2e 2. | 0 | 3 |
| 3. Does CI enforce the checks on pull requests? | **2 of 5** checks enforced: Tests ✅ · Lint ❌ · Type check ❌ · Format ❌ · Dependency scan ✅. | 0 | 3 |

#### Blocks the gate

- **P0 REQ-4 Refund window (critical: money · "refund") is proven only by skipped tests** (`docs/requirements.md:6`)
  `tests/unit/refund.test.ts:3` is skipped, so nothing checks the rule. _(code)_
  **Fix:** Fix and re-enable the test, or delete it and write one that runs.
- **P0 REQ-10 Price rounding (critical: money · "price") has no test** (`docs/requirements.md:11`)
  "Price rounding. A price is rounded half up to whole cents before it is shown." (`docs/requirements.md:11`): the nearest test (`tests/unit/price.test.ts:4` "price › rounds the price half up to whole cents") does not assert it, by the model's reading, done twice: rounding half up to whole cents; the test only checks the currency sign. _(model, verified)_
  **Fix:** Write a unit test that fails when the rule is broken; name `REQ-10` in the test (its title or a `// covers: REQ-10` comment) so the link is a fact from then on.
- **P1 REQ-6 Password length (critical: auth · "password"): no linked test uses the stated limit at least 12 characters** (`docs/requirements.md:8`)
  Linked test: `tests/unit/password.test.ts:4` "password › rejects a password shorter than the minimum leng…". The model adds: the 12-character boundary: the test only tries 8 characters, never 11 and 12. _(model, verified)_
  **Fix:** Add cases at 11, 12 and 13.
- **P1 e2e tests do not gate pull requests** (`tests/e2e/shipping.spec.ts:4`)
  2 e2e test files (2 cases) are run only outside pull requests. 1 rule is proven only there, 1 critical: REQ-2. _(code)_
  **Fix:** Run a smoke subset on pull requests, or accept the gap and say so in .quality-gate.yml.
- **P1 REQ-3 Payment retry (critical: money, external · "payment") is proven only against fakes** (`tests/unit/payment.test.ts:8`)
  REQ-3 is about a real boundary (gateway), and every test that proves it fakes that boundary (`jest.mock(` in tests/unit/payment.test.ts). _(code)_
  **Fix:** Add one integration test that crosses the real boundary; the unit tests can keep the edge cases.
- **P1 REQ-2 Free shipping (critical: money · "fee") is tested above the level it needs** (`tests/e2e/shipping.spec.ts:4`)
  REQ-2 is logic with limits (over $50, $5), and is proven only at e2e level (5 cases in tests/e2e/shipping.spec.ts). _(code)_
  **Fix:** Add unit tests for the rule and its boundary values against `src/shipping.ts`; keep one e2e case for the wiring.
- **P1 REQ-7 Order export has no test** (`docs/requirements.md:9`)
  "Order export. An order history can be exported as CSV." (`docs/requirements.md:9`): no test comes near it, by the model's reading, done twice: no test exports an order history as CSV. _(model, verified)_
  **Fix:** Write a unit test that fails when the rule is broken; name `REQ-7` in the test (its title or a `// covers: REQ-7` comment) so the link is a fact from then on.
- **P1 Lint: failures are ignored** (`.github/workflows/ci.yml:13`)
  Lint runs on pull requests (`npm run lint`, `.github/workflows/ci.yml:13`), and its failure is ignored (continue-on-error or `|| true`). _(code)_
  **Fix:** Remove `continue-on-error` / `|| true`, or fix what fails and then remove it.
- **P1 Type check: set up, not enforced**
  Type check is set up (tsconfig.json) and no CI step runs it: nothing stops a change that breaks it. _(code)_
  **Fix:** Add a pull-request step that runs it.
- **P1 tests/e2e/totals.e2e.test.ts is a unit test in the e2e suite** (`tests/e2e/totals.e2e.test.ts:3`)
  tests/e2e/totals.e2e.test.ts is filed as e2e and crosses no boundary: it calls `src/totals.ts` directly (1 case). No pull-request step runs this suite, so today this check gates no change; as unit tests they would. _(code)_
  **Fix:** Move these cases to the unit suite: same proof, feedback in seconds, and they run on every pull request.

#### P0 and P1 that do not block

- **P1 REQ-8 Payment speed (critical: money · "payment") cannot be tested as written** (`docs/requirements.md:10`)
  "Payment speed. Payment processing should be fast." (`docs/requirements.md:10`): "fast" has no number; state a time limit such as p95 under <N> ms _(advice)_
  **Fix:** Rewrite it with a subject, a trigger and a checkable outcome (a number, a state, an error).

#### Placement

- **P2 tests/unit/geo.test.ts is not a unit test**: tests/unit/geo.test.ts is filed as unit and needs a network, a database or a child process (`localhost:3000`). **Fix:** Move it to the integration suite, or replace `localhost:3000` with a fake so it stays a unit test.
- **P2 tests/e2e/shipping.spec.ts runs a parameter table at e2e level**: tests/e2e/shipping.spec.ts runs 5 parameter rows at e2e level: each one pays for the whole system to vary one input. **Fix:** Keep one case here to prove the wiring; move the other 4 to a table in a unit test of the logic they vary.

<sub>Model: handoff, 3 calls, 0 cached. Full report: job summary and the report artifact.</sub>
