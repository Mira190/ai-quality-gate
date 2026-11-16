# Quality gate: Mira190/pi-durable-bot @ 941a70f

**❌ Fail**: 8 findings block the gate (1 P0, 7 P1). Full review of the repository.

| Question | Answer | P0 | P1 |
| --- | --- | --- | --- |
| 1. Is every requirement and design decision proven by a test? | **0 of 15** rules proven · 13 with a hole · 1 with no test · 1 unverified. Critical rules: **0 of 15** proven. Beside these, 8 sentences without an ID that may be rules, not judged. | 1 | 6 |
| 2. Is each thing tested at the right level? | 0 placement findings. Cases: unit 196 · component 0 · integration 89 · e2e 0. | 0 | 0 |
| 3. Does CI enforce the checks on pull requests? | **3 of 5** checks enforced: Tests ✅ · Lint ❌ · Type check ✅ · Formal models ❌ · Dependency scan ✅. | 0 | 2 |

## Fix first: P0 and P1

| # | Priority | Blocks | Finding | Evidence | Fix |
| --- | --- | --- | --- | --- | --- |
| 1 | P0 | **yes** | **Inbox.DecidedAreLogged DecidedAreLogged: Only logged events are decided (critical: invariant · "model-checked") has no test** | "Only logged events are decided." (`spec/Inbox.tla:192`): the nearest test (`test/waker.test.ts:482` "reasons › the judge's no is logged and wakes nobo…") does not assert it, by the model's reading, done twice: that an event marked decided has a row in the log. _(model, verified)_ | Write a unit test that fails when the rule is broken; name `Inbox.DecidedAreLogged` in the test (its title or a `// covers: Inbox.DecidedAreLogged` comment) so the link is a fact from then on. |
| 2 | P1 | **yes** | **D-28A9AF It lists the models (for --model) and judges (for --judge) that have a login, a… (critical: auth · "login"): the tests check only part of it** | Linked test: `test/terminal.test.ts:190` "pots in a terminal › login adds a local server, tries it, a…". Not asserted: judges in the list, and no secret printed when a key is stored. _(model, verified)_ | Assert the missing part in a integration test. |
| 3 | P1 | **yes** | **D-EEF0B9 After the restart the bot must send once, be woken once, and make the memory pa… (critical: auth · "password"): the tests check only part of it** | Linked test: `test/pages.test.ts:333` "pages › finishes a password page's submission that a crash…". Not asserted: the send-once, woken-once, memory-pass and stopped-child parts; only the password page is in the shown tests. _(model, verified)_ | Assert the missing part in a integration test. |
| 4 | P1 | **yes** | **Debounce.GroupsInOrder GroupsInOrder: Groups of a place follow each other (critical: invariant · "model-checked"): the tests check only part of it** | Linked test: `test/properties.test.ts:98` "debounce grouping › wakes each place once per group, at min…". Not asserted: an explicit check that a group starts no earlier than the one before it was decided. _(model, verified)_ | Assert the missing part in a unit test. |
| 5 | P1 | **yes** | **Debounce.WakeTiming WakeTiming: A group is decided Quiet after its last event, or Max after its first, whiche… (critical: invariant · "model-checked"): the tests check only part of it** | Linked test: `test/waker.test.ts:292` "at once › a mention wakes at once, with the events that wai…". Not asserted: a group never decided earlier than 3 seconds after its last event, as an assertion of its own. _(model, verified)_ | Assert the missing part in a unit test. |
| 6 | P1 | **yes** | **Outbox.DoneMeansSent DoneMeansSent: A finished send went out and is recorded (critical: invariant · "model-checked"): the tests check only part of it** | Linked test: `test/gateway.behavior.test.ts:276` "crashes and restarts › finishes the agent's work after a st…". Not asserted: that a send marked done has its record; the test checks the messages went out. _(model, verified)_ | Assert the missing part in a integration test. |
| 7 | P1 | **yes** | **Lint: not run in CI** | No CI step runs lint. _(code)_ | Add a pull-request step that runs lint and fails the build. |
| 8 | P1 | **yes** | **Formal models: set up, not enforced** | Formal models are set up (3 TLA+ models, checked by `npm run tla`) and no CI step runs them: nothing stops a change that breaks them. 13 properties of the design are proven only by it (13 critical): Debounce.AllDecided, Debounce.EveryEventOnce, Debounce.GroupsInOrder, Debounce.WaitLimits, Debounce.WakeTiming, Inbox.DecidedAreLogged, Inbox.LoggedOnce, Inbox.NothingLost, Inbox.StoredBeforeAck, Inbox.WokenOnce +3. _(code)_ | Run the model checker in a pull-request job (it needs Java and tla2tools.jar; cache the jar), at least when the models or the code they describe change. |
| 9 | P1 | no (advice) | **Outbox.EverySendGoesOut EverySendGoesOut: Every send goes out in the end, however often the process dies (critical: invariant · "model-checked"): a test may prove it, nobody has checked** | "Every send goes out in the end, however often the process dies." (`spec/Outbox.tla:105`). Nearest test: `test/properties.test.ts:322` "inbox › logs each event once, in the order it first came, h…" (shares: howev, often, =send). `scripts/install-test.ts:1` is too long to show the model in full (0 assertion lines left out), so its "no proof" is not relied on. _(advice)_ | If that test proves the rule, name `Outbox.EverySendGoesOut` in the test (its title or a `// covers: Outbox.EverySendGoesOut` comment) so the link is a fact from then on. If not, write the test. |

## 1. Proof: is every rule proven by a test?

| Document | Rules | Critical | Proven | Hole in the proof | No test | Unverified | Reword |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `docs/development.md` | 5 | 2 | 0 | 1 | 1 | 3 | 0 |
| `docs/for-agents.md` | 5 | 1 | 0 | 1 | 0 | 4 | 0 |
| `spec/Debounce.tla` | 5 | 5 | 0 | 5 | 0 | 0 | 0 |
| `spec/Inbox.tla` | 5 | 5 | 0 | 4 | 1 | 0 | 0 |
| `spec/Outbox.tla` | 3 | 3 | 0 | 2 | 0 | 1 | 0 |

<details><summary>All 23 rules, critical first</summary>

| Rule | Critical | Status | Evidence |
| --- | --- | --- | --- |
| **Inbox.DecidedAreLogged** DecidedAreLogged: Only logged events are decided (`spec/Inbox.tla:192`) | invariant | ❌ no test | the model read the nearest tests: none asserts it · its model is checked only by hand |
| **D-28A9AF** It lists the models (for --model) and judges (for --judge)… (`docs/for-agents.md:47`) | auth | 🟡 hole | `test/terminal.test.ts:216` (integration, model-linked): judges in the list, and no secret printed when a key is stored |
| **D-EEF0B9** After the restart the bot must send once, be woken once, an… (`docs/development.md:57`) | auth | 🟡 hole | `test/pages.test.ts:349` (integration, model-linked): the send-once, woken-once, memory-pass and stopped-child parts; only the password page is in the shown tests |
| **Debounce.AllDecided** AllDecided: In the end nothing waits (`spec/Debounce.tla:112`) | invariant | 🟡 hole | its model is checked only by hand; `test/gateway.behavior.test.ts:301` (unit, model-linked) |
| **Debounce.EveryEventOnce** EveryEventOnce: Every event is in exactly one group (`spec/Debounce.tla:109`) | invariant | 🟡 hole | its model is checked only by hand; `test/properties.test.ts:125` (unit, model-linked) |
| **Debounce.GroupsInOrder** GroupsInOrder: Groups of a place follow each other (`spec/Debounce.tla:103`) | invariant | 🟡 hole | its model is checked only by hand; `test/properties.test.ts:125` (unit, model-linked): an explicit check that a group starts no earlier than the one before it was decided |
| **Debounce.WaitLimits** WaitLimits: While a group waits, the first event is at most… (`spec/Debounce.tla:94`) | invariant | 🟡 hole | its model is checked only by hand; `test/properties.test.ts:125` (unit, model-linked) |
| **Debounce.WakeTiming** WakeTiming: A group is decided Quiet after its last event,… (`spec/Debounce.tla:98`) | invariant | 🟡 hole | its model is checked only by hand; `test/waker.test.ts:301` (unit, model-linked): a group never decided earlier than 3 seconds after its last event, as an assertion of its own |
| **Inbox.LoggedOnce** LoggedOnce: An event the platform delivers twice is logged… (`spec/Inbox.tla:189`) | invariant | 🟡 hole | its model is checked only by hand; `test/properties.test.ts:341` (unit, model-linked), `test/gateway.behavior.test.ts:326` (unit, model-linked) |
| **Inbox.NothingLost** NothingLost: Nothing acknowledged is lost (`spec/Inbox.tla:200`) | invariant | 🟡 hole | its model is checked only by hand; `test/gateway.behavior.test.ts:302` (unit, model-linked) |
| **Inbox.StoredBeforeAck** StoredBeforeAck: Store before acknowledging (`spec/Inbox.tla:186`) | invariant | 🟡 hole | its model is checked only by hand; `test/slack.test.ts:129` (unit, model-linked) |
| **Inbox.WokenOnce** WokenOnce: No event reaches the agent in two wakes, also wh… (`spec/Inbox.tla:197`) | external | 🟡 hole | its model is checked only by hand; `test/gateway.behavior.test.ts:264` (unit, model-linked) |
| **Outbox.DoneMeansSent** DoneMeansSent: A finished send went out and is recorded (`spec/Outbox.tla:102`) | invariant | 🟡 hole | its model is checked only by hand; `test/gateway.behavior.test.ts:288` (unit, model-linked): that a send marked done has its record; the test checks the messages went out |
| **Outbox.NoDuplicateSend** NoDuplicateSend: Never the same message twice (`spec/Outbox.tla:99`) | invariant | 🟡 hole | its model is checked only by hand; `test/gateway.test.ts:49` (integration, model-linked) |
| **D-6A858B** The gateway must stop cleanly: its output must end with shu… (`docs/development.md:13`) | external | ❔ unverified | candidate `scripts/install-test.ts:1`, not judged |
| **Outbox.EverySendGoesOut** EverySendGoesOut: Every send goes out in the end, however o… (`spec/Outbox.tla:105`) | invariant | ❔ unverified | candidate `test/properties.test.ts:322`, not judged |
| **D-5B6F9B** Each server tool is a pi-durable tool with callers: ["tools… (`docs/development.md:124`) |  | ❌ no test | no test names it or shares its words |
| **D-42A130** Check, then hand over: pots chat --bot <id> -m "hi" --timeo… (`docs/for-agents.md:59`) |  | ❔ unverified | candidate `scripts/install-test.ts:1`, not judged |
| **D-4754E1** That covers channel messages that never mention it, DMs, ed… (`docs/for-agents.md:11`) |  | ❔ unverified | candidate `test/discord.test.ts:369`, not judged |
| **D-6E4596** Every other message comes to it too, and it decides whether… (`docs/for-agents.md:12`) |  | ❔ unverified | candidate `test/waker.test.ts:413`, not judged |
| **D-811891** A new section goes at the end, before the memory's, and a s… (`docs/development.md:122`) |  | ❔ unverified | candidate `test/gateway.test.ts:194`, not judged |
| **D-AC1AC5** Every outgoing message has a send ID, so the bot never send… (`docs/for-agents.md:15`) |  | ❔ unverified | candidate `test/telegram.test.ts:392`, not judged |
| **D-FD6D8E** Spans hold IDs, addresses, counts, times and error messages… (`docs/development.md:80`) |  | ❔ unverified | candidate `test/discord.test.ts:599`, not judged |

</details>

8 sentences without an ID were not judged (no model, or outside this run's budget): they are in the table above and produce no finding. Give a sentence an ID to make it a rule for certain.

Not counted: 2 sentences the model judged not to be testable behaviour.

## 2. Placement: is each thing tested at the right level?

| Level | What a test at this level needs | Files | Cases | Files a pull request runs |
| --- | --- | --- | --- | --- |
| unit | one process, nothing real around it | 15 | 196 | 15 of 15 |
| component | one rendered component or module slice | 0 | 0 | 0 of 0 |
| integration | a real database, HTTP, queue or process | 8 | 89 | 8 of 8 |
| e2e | the whole system, driven from outside | 0 | 0 | 0 of 0 |

No placement findings: 13 rules with tests are tested at the level they need, and every test file needs what its folder says.

## 3. CI: are the checks enforced on pull requests?

| Check | State | Where | Note |
| --- | --- | --- | --- |
| Tests | ✅ enforced | `.github/workflows/ci.yml:36` (test), `.github/workflows/ci.yml:66` (install), `.github/workflows/ci.yml:70` (install) | `npm test` |
| Lint | ❌ missing |  |  |
| Type check | ✅ enforced | `.github/workflows/ci.yml:34` (test) | `tsc` |
| Formal models | ❌ set up, not run | set up: 3 TLA+ models, checked by `npm run tla` |  |
| Format | ➖ not set up |  |  |
| Coverage | ➖ not set up |  |  |
| Dependency scan | ✅ enforced | set up: .github/dependabot.yml | by .github/dependabot.yml |
| Secret scan | ➖ not set up |  | GitHub secret scanning is a repository setting this run cannot see |
| Static security analysis | ➖ not set up |  |  |

- Branch protection (which checks are required to merge) is a repository setting this run does not read.

## Run

- Files: 137 listed, 1 vendored or generated and skipped; read: 2 rule documents, 23 test files (285 cases), 2 CI files. Source files are not read, except the ones a change touches.
- Rules: 25 (13 with an ID in the source, 12 inferred from normative sentences) from `docs/development.md` (6), `docs/for-agents.md` (6).
- Model: handoff (stand-in (a coding agent answering the gate's prompts)). 18 rules needed a judgment: 18 from the verdict cache, 0 asked, in 0 calls (0k characters, about 0k tokens sent).
- Shown to the model: 46 candidate tests, 789 of their 1480 lines (the opening, every assertion, the lines that share the rule's words), with the assertions of same-file helpers for 17. 5 tests too long to show every assertion: a "no proof" about them is not relied on.
- Read by code, in full: 2 rule documents, 23 test files, 2 CI files. The model reads no file.
- Tests are read, not run. Evidence levels: _code_ is decided by parsing; _model, verified_ is a model answer whose citation code checked; _advice_ never blocks.
- Time: scan 5 ms · extract 30 ms · formal 4 ms · ci-scripts 31 ms · index 7 ms · formal-links 17 ms · ci 8 ms · model 0 ms · link 59 ms · judge 126 ms · assess 2 ms · execute 0 ms · placement 1 ms.
