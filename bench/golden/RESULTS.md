# Golden set scorecard

Run 2026-11-04 · mode offline

## Seeded track (48 cases, mode offline)

**Seeded defects found: 23 of 28 (recall 82%)** · **Issues reported that were seeded: 23 of 44 (precision 52%)** · Cases that should be clean but got a false alarm: 5 of 13 · Not evaluable without the model: 24 expected issues

| Group | Cases | Recall | Precision | False alarms | Clean cases with a false alarm |
| --- | :-: | :-: | :-: | :-: | :-: |
| written knowing the tool | 39 | 100% (23/23) | 100% | 0 | 0 of 8 |
| hard: written from real-world setups | 9 | 0% (0/5) | 0% | 21 | 5 of 5 |

False P0 issues (the report's most urgent rows, wrong): S5 Secret scan secret-missing (hard-neg-precommit); S5 Unit and component tests tests-missing (hard-neg-makefile); S5 Secret scan secret-missing (hard-neg-reusable); S5 Unit and component tests tests-missing (hard-neg-reusable); S5 Unit and component tests tests-missing (hard-neg-node-test).

| Check | Seeded | Found | Recall | False alarms | Precision | False alarms in |
| --- | :-: | :-: | :-: | :-: | :-: | --- |
| S1 Specific | 2 | 2 | 100% | 0 | 100% | – |
| S2 Traceable | 1 | 1 | 100% | 0 | 100% | – |
| S5 Coverage coverage-exclusion | 1 | 1 | 100% | 0 | 100% | – |
| S5 Coverage coverage-global | 1 | 1 | 100% | 0 | 100% | – |
| S5 Coverage coverage-missing | 3 | 2 | 67% | 4 | 33% | hard-neg-makefile, hard-neg-reusable, hard-neg-xo-c8, hard-neg-node-test |
| S5 Dependency scan dependency-missing | 2 | 2 | 100% | 2 | 50% | hard-neg-makefile, hard-neg-reusable |
| S5 Dependency scan dependency-soft | 2 | 1 | 50% | 0 | 100% | – |
| S5 Format format-missing | 3 | 3 | 100% | 3 | 50% | hard-neg-precommit, hard-neg-makefile, hard-neg-reusable |
| S5 Lint lint-missing | 4 | 3 | 75% | 4 | 43% | hard-neg-precommit, hard-neg-makefile, hard-neg-reusable, hard-neg-xo-c8 |
| S5 Secret scan secret-missing | 5 | 4 | 80% | 2 | 67% | hard-neg-precommit, hard-neg-reusable |
| S5 Type check typecheck-missing | 2 | 2 | 100% | 3 | 40% | hard-neg-makefile, hard-neg-reusable, hard-neg-xo-c8 |
| S5 Unit and component tests tests-missing | 2 | 1 | 50% | 3 | 25% | hard-neg-makefile, hard-neg-reusable, hard-neg-node-test |

Critical tags on the clean base: 7 of 7 right.

| Case | What was seeded | Expected | Found | Missed | False alarms |
| --- | --- | :-: | :-: | --- | --- |
| clean | the base repository, nothing seeded | 0 | 0 | – | – |
| ci-secret-missing | no secret scan step | 1 | 1 | – | – |
| ci-secret-nightly-only | the secret scan runs only in the nightly workflow, not on PRs | 1 | 1 | – | – |
| ci-secret-soft | the secret scan step has continue-on-error, so it cannot fail a PR | 1 | 1 | – | – |
| ci-dependency-missing | no dependency scan | 1 | 1 | – | – |
| ci-dependency-soft | npm audit with continue-on-error | 1 | 1 | – | – |
| ci-coverage-missing | tests run on PR without coverage | 1 | 1 | – | – |
| ci-coverage-excludes-logic | coverage excludes a logic folder (src/payments) | 1 | 1 | – | – |
| ci-coverage-global-only | one global coverage threshold, no per-file or per-folder threshold | 1 | 1 | – | – |
| ci-format-missing | no format check | 1 | 1 | – | – |
| ci-format-writes | prettier runs with --write (fixes files, never fails), not --check | 1 | 1 | – | – |
| ci-lint-missing | no lint step | 1 | 1 | – | – |
| ci-lint-soft | lint step with continue-on-error | 1 | 1 | – | – |
| ci-typecheck-missing | no type check | 1 | 1 | – | – |
| ci-pr-trigger-missing | the checks workflow runs on push to main only, not on pull requests | 7 (+7 n/e) | 7 | – | – |
| neg-ci-trufflehog | trufflehog instead of gitleaks | 0 | 0 | – | – |
| neg-ci-osv | osv-scanner instead of npm audit | 0 | 0 | – | – |
| neg-ci-dependency-review | GitHub dependency-review-action instead of npm audit | 0 | 0 | – | – |
| neg-ci-biome | biome ci (format and lint in one) instead of prettier and eslint | 0 | 0 | – | – |
| neg-ci-script-chain | one `npm run check` script that chains format, lint and type check | 0 | 0 | – | – |
| neg-ci-separate-jobs | the same checks split into separate jobs and a second PR workflow | 0 | 0 | – | – |
| hard-neg-precommit | format, lint and the secret scan run as pre-commit hooks via pre-commit/action | 0 | 0 | – | S5 Secret scan secret-missing; S5 Format format-missing; S5 Lint lint-missing |
| hard-neg-makefile | the PR workflow runs `make ci`; the Makefile runs audit, format check, lint, type check and tests | 0 | 0 | – | S5 Unit and component tests tests-missing; S5 Coverage coverage-missing; S5 Dependency scan dependency-missing; S5 Format format-missing; S5 Lint lint-missing; S5 Type check typecheck-missing |
| hard-neg-reusable | pr.yml calls a reusable workflow (workflow_call) that holds all the steps | 0 | 0 | – | S5 Secret scan secret-missing; S5 Unit and component tests tests-missing; S5 Coverage coverage-missing; S5 Dependency scan dependency-missing; S5 Format format-missing; S5 Lint lint-missing; S5 Type check typecheck-missing |
| hard-neg-xo-c8 | lint with xo, coverage with c8 around vitest (no --coverage flag), type check with tsc -b | 0 | 0 | – | S5 Coverage coverage-missing; S5 Lint lint-missing; S5 Type check typecheck-missing |
| hard-neg-node-test | tests run with the built-in node --test runner, with its coverage flag | 0 | 0 | – | S5 Unit and component tests tests-missing; S5 Coverage coverage-missing |
| hard-audit-or-true | `npm audit || true`: the scan runs but can never fail the PR | 1 | 0 | S5 Dependency scan dependency-soft | – |
| hard-lint-or-true | `npm run lint || echo ...`: lint runs but can never fail the PR | 1 | 0 | S5 Lint lint-missing | – |
| hard-tests-if-false | the test step is switched off with `if: false` | 2 | 0 | S5 Unit and component tests tests-missing; S5 Coverage coverage-missing | – |
| hard-secret-other-branch | the secret scan job runs only for pull requests into a `release` branch, never for PRs into main | 1 | 0 | S5 Secret scan secret-missing | – |
| test-no-test | the refund fee (REQ-02) has no test | 0 (+1 n/e) | 0 | – | – |
| test-skipped | the refund window cases (REQ-01) are all skipped | 0 (+1 n/e) | 0 | – | – |
| test-limits-missed | the refund window test (REQ-01) uses days 10 and 45, never the edge at 30 | 0 (+1 n/e) | 0 | – | – |
| test-weak-assert | the idempotency test (DEC-02) only checks the gateway was called, not that a second refund pays nothing | 0 (+1 n/e) | 0 | – | – |
| test-simulator | the refund fee test (REQ-02) calls a simulator copy of the formula, not src/refund.js | 0 (+1 n/e) | 0 | – | – |
| test-mocked-boundary | the gateway test (DEC-01) mocks fetch-level code instead of running the adapter against a fake server | 0 (+1 n/e) | 0 | – | – |
| test-nightly-only | the refund window and fee tests (REQ-01, REQ-02) moved to a suite that only the nightly workflow runs | 0 (+2 n/e) | 0 | – | – |
| test-e2e-only | the refund fee (REQ-02) is tested only through the browser, in an e2e test run on PR | 0 (+1 n/e) | 0 | – | – |
| code-no-timeout | the gateway adapter (DEC-01) has no timeout, and its test has no timeout case | 0 (+1 n/e) | 0 | – | – |
| code-no-role-check | the admin fee route (REQ-04) checks only that someone is logged in; its test covers only the admin | 0 (+1 n/e) | 0 | – | – |
| doc-vague-critical | the refund window (REQ-01) says "within a reasonable time" instead of 30 days | 1 (+1 n/e) | 1 | – | – |
| doc-vague-noncritical | the page size (REQ-03) says "a reasonable number" instead of 50 | 1 (+1 n/e) | 1 | – | – |
| doc-conflict | a design decision allows refunds up to 45 days, against the 30 days of REQ-01 | 0 (+1 n/e) | 0 | – | – |
| doc-ambiguous | the refund fee (REQ-02) says "pro rata minus a $15 fee" without saying pro rata by what | 0 (+1 n/e) | 0 | – | – |
| doc-two-behaviours | REQ-04 also requires an email to finance on every fee change | 0 (+1 n/e) | 0 | – | – |
| doc-no-failure-behaviour | the gateway decision (DEC-01) no longer says what happens on a timeout or an error | 0 (+1 n/e) | 0 | – | – |
| doc-untraceable | DEC-02 has neither a Serves line nor a reason | 1 | 1 | – | – |
| neg-doc-rewording | REQ-01 reworded in EARS form with the same meaning | 0 | 0 | – | – |

Model: 0 calls, US$0.000.

## Real-repository CI track (17 repositories, labelled by hand at pinned commits)

**Agreement with the hand labels: 66 of 116 checks (57%)** · "Missing" issues that are real: 49 of 99 (precision 49%) · Real gaps reported: 49 of 49 (recall 100%)

| Check | Real gaps | Reported, real | False alarms | Missed | Precision | Recall | Wrong on |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | --- |
| secret | 16 | 16 | 1 | 0 | 94% | 100% | gin-gonic/gin (false alarm) |
| coverage | 10 | 10 | 7 | 0 | 59% | 100% | expressjs/express (false alarm), pinojs/pino (false alarm), fastify/fastify (false alarm), honojs/hono (false alarm), encode/httpx (false alarm), fastapi/typer (false alarm), gin-gonic/gin (false alarm) |
| dependency | 13 | 13 | 1 | 0 | 93% | 100% | fastify/fastify (false alarm) |
| format | 6 | 6 | 11 | 0 | 35% | 100% | colinhacks/zod (false alarm), pinojs/pino (false alarm), fastify/fastify (false alarm), honojs/hono (false alarm), vitest-dev/vitest (false alarm), psf/requests (false alarm), pallets/flask (false alarm), encode/httpx (false alarm), fastapi/typer (false alarm), spf13/cobra (false alarm), gin-gonic/gin (false alarm) |
| lint | 2 | 2 | 8 | 0 | 20% | 100% | sindresorhus/got (false alarm), colinhacks/zod (false alarm), date-fns/date-fns (false alarm), honojs/hono (false alarm), psf/requests (false alarm), pallets/flask (false alarm), encode/httpx (false alarm), fastapi/typer (false alarm) |
| typecheck | 2 | 2 | 8 | 0 | 20% | 100% | axios/axios (false alarm), colinhacks/zod (false alarm), date-fns/date-fns (false alarm), pinojs/pino (false alarm), fastify/fastify (false alarm), pallets/flask (false alarm), encode/httpx (false alarm), fastapi/typer (false alarm) (n/a for 3, flagged anyway on 3) |
| tests | 0 | 0 | 14 | 0 | 0% | – | expressjs/express (false alarm), sindresorhus/got (false alarm), colinhacks/zod (false alarm), date-fns/date-fns (false alarm), pinojs/pino (false alarm), fastify/fastify (false alarm), honojs/hono (false alarm), psf/requests (false alarm), pallets/flask (false alarm), encode/httpx (false alarm), fastapi/typer (false alarm), spf13/cobra (false alarm), gin-gonic/gin (false alarm), mira190/ai-quality-gate (false alarm) |

| Repository | Commit | secret | coverage | dependency | format | lint | typecheck | tests |
| --- | --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| axios/axios | `fb88a1b` | ✔ gap | ✔ gap | ✔ | ✔ gap | ✔ | ✘ FA | ✔ |
| expressjs/express | `43fca52` | ✔ gap | ✘ FA | ✔ gap | ✔ gap | ✔ | ✔ gap | ✘ FA |
| sindresorhus/got | `6b5aafc` | ✔ gap | ✔ gap | ✔ gap | ✔ gap | ✘ FA | ✔ | ✘ FA |
| colinhacks/zod | `93b7a62` | ✔ gap | ✔ gap | ✔ gap | ✘ FA | ✘ FA | ✘ FA | ✘ FA |
| date-fns/date-fns | `a9739fb` | ✔ gap | ✔ gap | ✔ gap | ✔ gap | ✘ FA | ✘ FA | ✘ FA |
| pinojs/pino | `b29dbe9` | ✔ gap | ✘ FA | ✔ | ✘ FA | ✔ | ✘ FA | ✘ FA |
| fastify/fastify | `1b954e5` | ✔ gap | ✘ FA | ✘ FA | ✘ FA | ✔ | ✘ FA | ✘ FA |
| honojs/hono | `8b7f9e9` | ✔ gap | ✘ FA | ✔ gap | ✘ FA | ✘ FA | ✔ | ✘ FA |
| vitest-dev/vitest | `1b2380c` | ✔ gap | ✔ gap | ✔ gap | ✘ FA | ✔ | ✔ | ✔ |
| psf/requests | `3c7baaa` | ✔ gap | ✔ gap | ✔ gap | ✘ FA | ✘ FA | ✔ | ✘ FA |
| pallets/flask | `49943b5` | ✔ gap | ✔ gap | ✔ gap | ✘ FA | ✘ FA | ✘ FA | ✘ FA |
| encode/httpx | `b5addb6` | ✔ gap | ✘ FA | ✔ gap | ✘ FA | ✘ FA | ✘ FA | ✘ FA |
| fastapi/typer | `f2183bf` | ✔ gap | ✘ FA | ✔ gap | ✘ FA | ✘ FA | ✘ FA | ✘ FA |
| spf13/cobra | `adbc881` | ✔ gap | ✔ gap | ✔ gap | ✘ FA | ✔ | n/a ⚠ | ✘ FA |
| gin-gonic/gin | `0f09c3a` | ✘ FA | ✘ FA | ✔ | ✘ FA | ✔ | n/a ⚠ | ✘ FA |
| gitleaks/gitleaks | `5f6ec56` | ✔ gap | ✔ gap | ✔ gap | ✔ gap | ✔ gap | n/a ⚠ | ✔ |
| mira190/ai-quality-gate | `c6aaf38` | ✔ gap | ✔ gap | ✔ gap | ✔ gap | ✔ gap | ✔ gap | ✘ FA |

✔ gap = both say missing · ✔ = both say set up · ✘ FA = the report says missing, the label says set up · ✘ miss = the label says missing, the report says set up
