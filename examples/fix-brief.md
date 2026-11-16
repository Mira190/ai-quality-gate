# Fix brief

10 blocking findings in acme/shop @ 4f2a9c1, most severe first. Each task names the evidence, the change to make, and how the gate will know it is done.

## 1. P0 REQ-4 Refund window (critical: money · "refund") is proven only by skipped tests
- **Evidence:** `tests/unit/refund.test.ts:3` is skipped, so nothing checks the rule.
- **Do:** Fix and re-enable the test, or delete it and write one that runs.
- **Where:** add to `tests/unit/refund.test.ts` (unit level)
- **Rule:** "Refund window. A refund can be requested within 30 days of delivery." (`docs/requirements.md:6`)
- **Done when:** `proof.skipped` for `REQ-4` is gone from the next report.

## 2. P0 REQ-10 Price rounding (critical: money · "price") has no test
- **Evidence:** "Price rounding. A price is rounded half up to whole cents before it is shown." (`docs/requirements.md:11`): the nearest test (`tests/unit/price.test.ts:4` "price › rounds the price half up to whole cents") does not assert it, by the model's reading, done twice: rounding half up to whole cents; the test only checks the currency sign.
- **Do:** Write a unit test that fails when the rule is broken; name `REQ-10` in the test (its title or a `// covers: REQ-10` comment) so the link is a fact from then on.
- **Where:** add to `tests/unit/price.test.ts` (unit level)
- **Rule:** "Price rounding. A price is rounded half up to whole cents before it is shown." (`docs/requirements.md:11`)

```ts
it('REQ-10 Price rounding', () => {
  // arrange the situation the rule describes, act, then:
  expect(/* outcome */).toBe(/* what the rule promises */);  // fails when the rule is broken
});
```
- **Done when:** `proof.unproven` for `REQ-10` is gone from the next report.

## 3. P1 REQ-6 Password length (critical: auth · "password"): no linked test uses the stated limit at least 12 characters
- **Evidence:** Linked test: `tests/unit/password.test.ts:4` "password › rejects a password shorter than the minimum leng…". The model adds: the 12-character boundary: the test only tries 8 characters, never 11 and 12.
- **Do:** Add cases at 11, 12 and 13.
- **Where:** add to `tests/unit/password.test.ts` (unit level)
- **Rule:** "Password length. Passwords must be at least 12 characters long." (`docs/requirements.md:8`)

```ts
it.each([
  [11, /* expected */],  // below the limit (at least 12 characters)
  [12, /* expected */],  // the limit (at least 12 characters)
  [13, /* expected */],  // above the limit (at least 12 characters)
])('REQ-6 Password length: %s', (value, expected) => {
  expect(/* call the code with value */).toBe(expected);
});
```
- **Done when:** `proof.limit` for `REQ-6` is gone from the next report.

## 4. P1 e2e tests do not gate pull requests
- **Evidence:** 2 e2e test files (2 cases) are run only outside pull requests. 1 rule is proven only there, 1 critical: REQ-2.
- **Do:** Run a smoke subset on pull requests, or accept the gap and say so in .quality-gate.yml.
- **Done when:** `ci.level-not-run` for `e2e` is gone from the next report.

## 5. P1 REQ-3 Payment retry (critical: money, external · "payment") is proven only against fakes
- **Evidence:** REQ-3 is about a real boundary (gateway), and every test that proves it fakes that boundary (`jest.mock(` in tests/unit/payment.test.ts).
- **Do:** Add one integration test that crosses the real boundary; the unit tests can keep the edge cases.
- **Where:** a new file next to `tests/integration/webhook.int.test.ts` (`tests/integration/`) (integration level)
- **Rule:** "Payment retry. When the payment gateway times out, the payment is retried at most 3 times." (`docs/requirements.md:5`)

```ts
it.each([
  [2, /* expected */],  // below the limit (at most 3 times)
  [3, /* expected */],  // the limit (at most 3 times)
  [4, /* expected */],  // above the limit (at most 3 times)
])('REQ-3 Payment retry: %s', (value, expected) => {
  expect(/* call the code with value */).toBe(expected);
});
```
- **Done when:** `placement.boundary-mocked` for `REQ-3` is gone from the next report.

## 6. P1 REQ-2 Free shipping (critical: money · "fee") is tested above the level it needs
- **Evidence:** REQ-2 is logic with limits (over $50, $5), and is proven only at e2e level (5 cases in tests/e2e/shipping.spec.ts).
- **Do:** Add unit tests for the rule and its boundary values against `src/shipping.ts`; keep one e2e case for the wiring.
- **Where:** a new file next to `tests/unit/cart.test.ts` (`tests/unit/`) (unit level)
- **Rule:** "Free shipping. Orders over $50 ship free; the shipping fee is $5 otherwise." (`docs/requirements.md:4`)

```ts
it.each([
  [49, /* expected */],  // below the limit (over $50)
  [50, /* expected */],  // the limit (over $50)
  [51, /* expected */],  // above the limit (over $50)
  [4, /* expected */],  // below the limit ($5)
  [5, /* expected */],  // the limit ($5)
  [6, /* expected */],  // above the limit ($5)
])('REQ-2 Free shipping: %s', (value, expected) => {
  expect(/* call the code with value */).toBe(expected);
});
```
- **Done when:** `placement.too-high` for `REQ-2` is gone from the next report.

## 7. P1 REQ-7 Order export has no test
- **Evidence:** "Order export. An order history can be exported as CSV." (`docs/requirements.md:9`): no test comes near it, by the model's reading, done twice: no test exports an order history as CSV.
- **Do:** Write a unit test that fails when the rule is broken; name `REQ-7` in the test (its title or a `// covers: REQ-7` comment) so the link is a fact from then on.
- **Where:** a new file next to `tests/unit/cart.test.ts` (`tests/unit/`) (unit level)
- **Rule:** "Order export. An order history can be exported as CSV." (`docs/requirements.md:9`)

```ts
it('REQ-7 Order export', () => {
  // arrange the situation the rule describes, act, then:
  expect(/* outcome */).toBe(/* what the rule promises */);  // fails when the rule is broken
});
```
- **Done when:** `proof.unproven` for `REQ-7` is gone from the next report.

## 8. P1 Lint: failures are ignored
- **Evidence:** Lint runs on pull requests (`npm run lint`, `.github/workflows/ci.yml:13`), and its failure is ignored (continue-on-error or `|| true`).
- **Do:** Remove `continue-on-error` / `|| true`, or fix what fails and then remove it.
- **Done when:** `ci.lint` for `lint` is gone from the next report.

## 9. P1 Type check: set up, not enforced
- **Evidence:** Type check is set up (tsconfig.json) and no CI step runs it: nothing stops a change that breaks it.
- **Do:** Add a pull-request step that runs it.
- **Done when:** `ci.typecheck` for `typecheck` is gone from the next report.

## 10. P1 tests/e2e/totals.e2e.test.ts is a unit test in the e2e suite
- **Evidence:** tests/e2e/totals.e2e.test.ts is filed as e2e and crosses no boundary: it calls `src/totals.ts` directly (1 case). No pull-request step runs this suite, so today this check gates no change; as unit tests they would.
- **Do:** Move these cases to the unit suite: same proof, feedback in seconds, and they run on every pull request.
- **Done when:** `placement.no-boundary` for `tests/e2e/totals.e2e.test.ts` is gone from the next report.
