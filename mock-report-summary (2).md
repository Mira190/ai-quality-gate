# AI repository review: acme/quote-service @ `a1b2c3d` (MOCK)

> Mock for layout review: names and numbers are invented, counts agree across sections, and the shape follows the
> [summary template](./report-summary-template.md). `scripts/repo-report.js` produces this shape; the test
> `tests/report-golden.test.js` builds the fixture repository `quote-service` and checks that its report equals this file.

| Area | Score (0–100) | What the score means |
| --- | :-: | --- |
| [1. Requirement health](#s1) | 🔴 42 | 5 of 12 requirements are clear enough to test |
| [2. Design health](#s2) | 🔴 38 | 5 of 13 design decisions are clear enough to test |
| [3. Requirement coverage](#s3) | 🔴 0 | 0 of 12 requirements meet the test standard with tests running in PR CI |
| [4. Design coverage](#s4) | 🔴 17 | 1 of 6 design decisions that add behaviour meet the test standard with tests running in PR CI |
| [5. CI gate](#s5) | 🔴 43 | 3 of the 7 CI checks are set up |

Critical rules with tests that meet the standard and run in PR CI: **1 of 15 (DEC-04)**.

Run 2026-10-22 · Read: `docs/requirements.md` (12 requirements), `docs/design.md` (13 decisions), 376 tests in 74
files, 2 CI workflows · **Rules found:** 25 (25 with an ID in the source) · **Tests: read, not run** · **Branch
protection: not readable** · **Not read:** `docs/legacy-rules.md` (84 KB, over the 60 KB read budget), Jira,
Confluence, PR history. Rules that appear only in those sources are not counted. · **Skipped:**
`docs/adr/0003-session-store.md` (superseded). Rules in them are not counted.

---

## Top actions

| # | Do this | What is at risk | Critical rules protected |
| :-: | --- | --- | --- |
| 1 | **Check whether the 2 suspected defects are real, then fix them.** `/admin/rates` checks the login but not the admin role (DEC-08). The CRM call has no timeout (DEC-07). Write a component test that a customer cannot change rates, and a CRM component test, with a fake CRM server, that has a timeout case and an error case. Both should fail today. If one fails, fix `src/routes/admin.ts` or `src/notify/crm.ts` until it passes. If it passes, drop the finding. | DEC-08: any logged-in customer may be able to change rates (`src/routes/admin.ts:12`). DEC-07: a CRM that never answers may hang or fail a purchase (`src/notify/crm.ts:22`) | DEC-08, DEC-07 |
| 2 | **Fix the unclear text in sections 1 and 2:** 8 issues, 6 on 5 requirements and 2 on 2 design decisions. Each row gives the rewrite. Where the documents give no value, the rewrite has a placeholder (`<N>`, `<T>`) for the document owner to fill. | REQ-05, REQ-08, REQ-10, REQ-11, REQ-12, DEC-11, DEC-13: money and access rules have no clear expected result, so a test written now may lock in the wrong value | None. It unblocks action 5, and REQ-11 in action 4 |
| 3 | **Close the critical CI gap: add a secret scan to `pr.yml`.** Today no secret scan runs. Branch protection is not readable, so check by hand that the new step is required. | A committed secret goes unnoticed: `pr.yml` and `nightly.yml` have no secret-scan step | None. It closes a CI gap, not a rule |
| 4 | **Write the 7 critical tests (the CRM update test comes after action 1):** unit test for the premium band edges · excess limit cases at $500 and $5,000 · unit test for the 30-day quote window · component test for the CRM update, in the CRM component test from action 1 · unit test for the concession discount · component test for the payment timeout (if it shows no timeout, add one in `src/payment/gateway-adapter.ts`) · test that the same payment request charges once. | REQ-01: a wrong premium at a band edge. REQ-02: a wrong excess limit. REQ-04: a quote kept past 30 days. REQ-06: a missing CRM update. REQ-11: a missing concession discount. DEC-05: a payment that hangs. DEC-06: a payment charged twice | REQ-01, REQ-02, REQ-04, REQ-06, DEC-06; REQ-11 once action 2 is done; DEC-05 once action 5 is done |
| 5 | **After action 2, write the 5 tests it unblocks:** unit test for the retry count · unit test for the discount cap · unit test for session expiry · unit test for the refund amount · component test for a refund the gateway rejects. | REQ-05: a payment retried too often or not at all. REQ-08: a discount above the cap. REQ-10: sessions that never expire. REQ-12: a wrong refund amount. DEC-13: a refund that fails silently | REQ-05, REQ-08, REQ-10, REQ-12, DEC-13 |

---

<a id="s1"></a>

## 1. Requirement health

| Issue number | Priority | Req | Fails on | Status | What fails, and the fix |
| :-: | :-: | --- | --- | --- | --- |
| I-1 | P1 | REQ-05 Payment retried on failure (critical: money · "payment") | **Testable** | **Blocked** | "Payment should be retried where possible" (`requirements.md:13`): no count and no timing. Rewrite: "If the payment gateway returns `<which errors>`, the system shall retry up to `<N>` times, `<T>` s apart." The documents give no values, so the owner fills the placeholders |
| I-2 | P1 | REQ-08 Discount cap (critical: money · "discount") | **Testable** | **Blocked** | "Discounts never exceed 20%" (`requirements.md:19`) does not say what happens above the cap. Rewrite: "When the total discount is above 20%, the system shall cap it at 20%." |
| I-3 | P1 | REQ-08 | **Consistent** | **Blocked** | `design.md:88` (DEC-11) allows 25%, so there are two expected results. Keep 20% or 25%, then edit the other document; this fixes DEC-11 too (I-7) |
| I-4 | P1 | REQ-10 Session expiry (critical: access control · "session") | **Testable** | **Blocked** | "Sessions must expire in a reasonable time" (`requirements.md:23`): no limit. Rewrite: "When a session has been idle for `<T>` min, the system shall expire it." The documents give no limit, so the owner fills `<T>` |
| I-5 | P1 | REQ-11 Concession card discount (critical: money · "discount") | **Complete** (the stacking case only) | Partly blocked | "Concession card holders get 10% off" (`requirements.md:25`): does not say how it combines with other discounts. Rewrite: "When a concession card holder gets a quote, the system shall apply 10% off `<before or after>` the other discounts, within the discount cap." |
| I-6 | P1 | REQ-12 Cancellation refund (critical: money · "refund") | **Clear** | **Blocked** | "Refund is pro rata minus a $50 fee" (`requirements.md:27`): pro rata by day or by month gives two refunds. Rewrite: "When a policy is cancelled, the system shall refund the premium pro rata by `<day or month>`, minus a $50 fee." |

**Not critical (3):** REQ-03, REQ-07, REQ-09.

---

<a id="s2"></a>

## 2. Design health

| Issue number | Priority | Decision | Serves | Fails on | Status | What fails, and the fix |
| :-: | :-: | --- | --- | --- | --- | --- |
| I-7 | P1 | DEC-11 Discounts stack up to 25% (critical: money, as REQ-08) | REQ-08 | **Trade-off** | **Blocked** | `design.md:88` conflicts with the 20% cap in REQ-08 and does not say which wins. Fixed by the same edit as REQ-08 (I-3) |
| I-8 | P1 | DEC-13 Refund posted to the gateway (critical: money · "refund") | REQ-12 | **Failure behaviour** | **Blocked** | `design.md:101` says nothing about a refund the gateway rejects or does not answer. Rewrite: "If the gateway does not confirm a refund, the policy stays cancelled and the refund is retried up to `<N>` times, then `<next step>`." The documents give no values, so the owner fills the placeholders |

**Not critical (2):** DEC-10, DEC-12.

---

<a id="s3"></a>

## 3. Requirement coverage

| Issue number | Priority | Rule | Level | Fails on | Why, and the fix |
| :-: | :-: | --- | --- | --- | --- |
| I-9 | P0 | REQ-08 Discount cap | **None** | No test | No test asserts a total discount above 20%. After action 2, add a unit test for the discount cap |
| I-10 | P0 | REQ-11 Concession card discount | **None** | No test | No test names `applyDiscount` or "concession". Add a unit test for the concession discount |
| I-11 | P1 | REQ-01 Premium by vehicle age (critical: money · "premium") | Weak | Covers stated limits | `e2e/quote.spec.ts` (9 cases) has no case on a band edge of the rate table the requirement names (`src/pricing/rates.json`: 3, 7, and 12 years). Add a unit test for the premium with the ages on and either side of each band edge |
| I-12 | P1 | REQ-01 | Weak | Placement | 9 cases in `e2e/quote.spec.ts` check the premium calculation through the browser, and E2E runs only in `nightly.yml:30`. The unit test from I-11 covers the calculation. Keep `e2e/quote.spec.ts` as one case that checks a premium shows on the page |
| I-13 | P1 | REQ-02 Excess $500 to $5,000 (critical: money · "excess") | Weak | Covers stated limits | `unit/excess.test.ts` uses $1,000 and $10,000 (`:9`, `:15`), none at $500 or $5,000, so `>= 500` could become `> 500` unnoticed. Add cases: $500 and $5,000 accepted; $499.99 and $5,000.01 rejected |
| I-14 | P1 | REQ-04 Quote retention, 30 days (critical: customer data · "retention") | Checked nightly | Placement | `integration/quote-repo.test.ts` checks the 30-day cut-off, a date rule, through a database, and `e2e/retrieve.spec.ts` checks it through the browser. They run only in `nightly.yml` (`:12`, `:30`). Test the cut-off with a unit test that calls the date check directly. Keep one case in each nightly test for the saved quote |
| I-15 | P1 | REQ-05 Payment retried on failure | Blocked | Runs on PR | `integration/payment.test.ts` runs only in `nightly.yml:12`. Add a component test for the payment timeout and a unit test for the retry count |
| I-16 | P1 | REQ-06 Document, CRM update, event log (critical: outside calls · "CRM") | Weak | Asserts the rule | Tests: `component/notification.test.ts`, `integration/purchase.test.ts`, `e2e/buy.spec.ts`. Only the document is asserted (`component/notification.test.ts:27`); nothing checks the CRM update or the event log. Add a case to the CRM component test, which uses a fake CRM server so the real adapter runs: a purchase sends one CRM update and writes one event-log entry |
| I-17 | P1 | REQ-10 Session expiry | Blocked | Not skipped | The expiry cases in `unit/session.test.ts` are `it.skip` at `:18` and `:24`. Replace them with a unit test for session expiry |
| I-18 | P1 | REQ-12 Cancellation refund | Blocked | Placement | `unit/refund.test.ts` checks the refund amount, a plain calculation, but it starts a database (it imports `pg` at `:2`), so it is an integration test. `vitest.config.ts:14` excludes it from the PR run, so it runs only in `nightly.yml:12`. Test the amount with a unit test that calls the refund function directly. Move this file to `integration/refund.test.ts`, because it needs a database, and keep one case that checks the saved refund row |

---

<a id="s4"></a>

## 4. Design coverage

| Issue number | Priority | Rule | Level | Fails on | Why, and the fix |
| :-: | :-: | --- | --- | --- | --- |
| I-19 | P0 | DEC-06 Payment is idempotent (critical: money · "payment") | None | No test | No test sends the same idempotency key twice to `PaymentService.charge` (`src/payment/service.ts:18`). Add one: the same request twice → one charge |
| I-20 | P0 | DEC-07 CRM timeout; errors surfaced (critical: outside calls · "CRM") | Weak | **Suspected not built** | `src/notify/crm.ts:22` sets no timeout. The timeout case and the error case in the CRM component test should fail today; then fix the code: add a timeout to the CRM call, and log and return its errors (`:22`, `:40`). If the cases pass, drop the finding |
| I-21 | P0 | DEC-08 Admin routes check the role (critical: access control · "admin") | None | **Suspected not built** | `src/routes/admin.ts:12` checks the login only, not the admin role. A component test that a customer cannot change rates should fail today; then fix the code: check that the user is an admin on `/admin/rates`. If the test passes, drop the finding |
| I-22 | P0 | DEC-08 | None | No test | No test covers the admin role. Add a component test, with the app in memory: a customer token on `POST /admin/rates` → 403; an admin token → 200 |
| I-23 | P0 | DEC-13 Refund posted to the gateway | None | No test | No test covers `RefundService.post` (`src/refund/service.ts:30`). After action 2, add a component test for a refund the gateway rejects |
| I-24 | P1 | DEC-05 Gateway timeout and retry limit (critical: outside calls · "gateway") | Weak | Calls the code | `integration/payment-sim.test.ts` imports `PaymentSimulator` (`:3`), not the adapter. A component test with a fake gateway server runs the real adapter; if it shows no timeout, add one in `src/payment/gateway-adapter.ts` |
| I-25 | P1 | DEC-05 | Weak | Placement | `integration/payment-sim.test.ts` checks the retry limit, a plain count, through the payment simulator, and runs only in `nightly.yml:12`. After action 5, test the limit with the unit test for the retry count (I-15). The component test for the payment timeout covers the timeout. Keep one case in the nightly test that checks a failed charge reaches the simulator |
| I-26 | P1 | DEC-07 | Weak | Asserts the rule | `component/notification.test.ts:27` checks the document only: no timeout case and no error case. Add both to the CRM component test |
| I-27 | P1 | DEC-07 | Weak | Crosses the real boundary | The CRM client is a mock (`component/notification.test.ts:8`), so no test reaches the real adapter over HTTP. The CRM component test runs the adapter against a fake CRM server |

**Counted as rules of their own (6):** DEC-04, DEC-05, DEC-06, DEC-07, DEC-08, DEC-13. **Restate a requirement (7):** DEC-01, DEC-02, DEC-03, DEC-09, DEC-10, DEC-11, DEC-12. **Not critical (2):** DEC-10, DEC-12.

---

<a id="s5"></a>

## 5. CI gate

| Issue number | Priority | Check | Status | What is wrong, and the fix |
| :-: | :-: | --- | :-: | --- |
| I-28 | P0 | Secret scan | ❌ | No secret-scan step in `pr.yml` or `nightly.yml`. Add one (for example gitleaks) to `pr.yml` |
| I-29 | P2 | Coverage | ❌ | `vitest.config.ts:22` excludes `src/pricing/**` from coverage, so the pricing logic is never measured. Remove the exclusion |
| I-30 | P2 | Coverage | ❌ | `vitest.config.ts:19` sets one global threshold (`lines: 70`). Add a threshold for changed files or per folder |
| I-31 | P2 | Dependency scan | ❌ | The step exists (`pr.yml:31`) but has `continue-on-error: true`, so it cannot fail the PR. Remove that line |
| I-32 | P3 | Format | ❌ | No format step in `pr.yml` or `nightly.yml`. Add a format check to `pr.yml` |
| – | – | Lint | ✅ | `pr.yml:14` |
| – | – | Type check | ✅ | `pr.yml:16` |
| – | – | Unit and component tests | ✅ | `pr.yml:18` |

---

**AI used:** model `gpt-5.4` · **42.36 AIU** in total.
