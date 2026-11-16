<!-- ai-quality-gate -->

### Quality gate @ 4f2a9c1

**❌ Fail**: 2 findings block this change (1 P0, 1 P1). Change review: 2 changed files against `7481654738`.

| Question | Answer | P0 | P1 |
| --- | --- | --- | --- |
| 1. Is every requirement and design decision proven by a test? | **5 of 11** rules proven · 2 with a hole · 3 with no test · 0 unverified · 1 not testable as written. Critical rules: **4 of 9** proven. | 2 | 5 |
| 2. Is each thing tested at the right level? | 5 placement findings. Cases: unit 6 · component 0 · integration 2 · e2e 2. | 0 | 2 |
| 3. Does CI enforce the checks on pull requests? | **2 of 8** checks enforced: Tests ✅ · Lint ❌ · Type check ❌ · Format ❌ · Coverage ❌ · Dependency scan ✅ · Secret scan ❌ · Static security analysis ❌. | 0 | 2 |

#### Blocks this change

- **P0 REQ-9 Gift card limit (critical: money · "payment") has no test** (`docs/requirements.md:11`)
  "Gift card limit. A gift card payment never exceeds $500 per order." (`docs/requirements.md:11`): the model read the 0 nearest tests and none asserts it: no test rejects a gift card payment above $500. _(model, verified)_
  **Fix:** Write a unit test that fails when the rule is broken, at $499, $500 and $501; name `REQ-9` in the test (its title or a `// covers: REQ-9` comment) so the link is a fact from then on.
- **P1 src/payment/giftcard.ts changed and no test reaches it** (`src/payment/giftcard.ts:1`)
  9 lines added in a new file; no test file imports it, and this change adds no test for it (the path says money). _(code)_
  **Fix:** Add a unit test next to it (`src/payment/giftcard.test.ts`) for the behaviour this change adds.

#### Placement

- **P1 REQ-3 Payment retry (critical: money, external · "payment") is proven only against fakes**: REQ-3 is about a real boundary (retry), and every test that proves it fakes that boundary (`jest.mock(` in tests/unit/payment.test.ts). **Fix:** Add one integration test that crosses the real boundary; the unit tests can keep the edge cases.
- **P1 REQ-2 Free shipping (critical: money · "fee") is tested above the level it needs**: REQ-2 is logic with limits (over $50, $5), and is proven only at e2e level (5 cases in tests/e2e/shipping.spec.ts). **Fix:** Add unit tests for the rule and its boundary values against `src/shipping.ts`; keep one e2e case for the wiring.
- **P2 tests/unit/geo.test.ts is not a unit test**: tests/unit/geo.test.ts is filed as unit and needs a network, a database or a child process (`localhost:3000`). **Fix:** Move it to the integration suite, or replace `localhost:3000` with a fake so it stays a unit test.
- **P2 tests/e2e/totals.e2e.test.ts is a unit test in the e2e suite**: tests/e2e/totals.e2e.test.ts is filed as e2e and crosses no boundary: it calls `src/totals.ts` directly (1 case). **Fix:** Move these cases to the unit suite: same proof, feedback in seconds, and they run on every pull request.
- **P2 tests/e2e/shipping.spec.ts runs a parameter table at e2e level**: tests/e2e/shipping.spec.ts runs 5 parameter rows at e2e level. **Fix:** Move the table to a unit test of the logic it varies; keep one row here to prove the wiring.

<sub>Model: handoff, 1 call, 0 cached. Full report: job summary and the report artifact.</sub>
