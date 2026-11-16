# ai-quality-gate requirements

What the gate must do. Every requirement has an ID, and the test that proves it names that ID: the gate reviews this
repository with the same rules it applies to any other.

## Reading rules out of documents

- **GATE-1 Rules with an ID.** An item that starts a heading, a list item or a table row with an ID (`REQ-12`, `DEC-4`, `AC-3`) is a rule; `REQ_007` and `req-7` name the same rule.
- **GATE-2 Decision records.** An architecture decision record yields one decision; a decision that is superseded, rejected or still proposed is not counted.
- **GATE-3 Rules without an ID.** In a requirement or design document that numbers nothing, a normative sentence (must, shall, should, never, always) is an inferred rule whose ID is a hash of its text; a sentence is read whole across wrapped lines, and instructions to developers are not rules.
- **GATE-4 Critical rules.** A rule about money, access control, customer data, calls to outside systems or data safety is critical, and the report names the word that made it so; a word that means risk only in some contexts does not make a rule critical on its own.

## Proof

- **GATE-5 Links by ID.** A test that names a rule's ID in its title, a comment or a tag is linked to the rule by code alone.
- **GATE-6 Skipped tests prove nothing.** A rule whose linked tests are all skipped is reported as having no proof.
- **GATE-7 Limits.** When a rule states a limit and no linked test uses that value, the report names the limit as a hole in the proof.
- **GATE-8 Citations are checked.** A model verdict that a test proves a rule is believed only when it cites a candidate test it was shown, at a line it was shown, and that line is an assertion; anything else is advice.
- **GATE-9 Model budget.** The model is called for rules code could not link, most severe first, never more often than the configured number of calls; a rule whose text and candidate tests are unchanged is answered from the verdict cache or the lock file, and what the budget did not reach is judged by the next run.
- **GATE-30 A wider second look.** The second reading is also shown the next nearest tests, ordered with the help of words that keep company in this repository, and an assertion it cites there that checks out links the test to the rule; what counts as a candidate without a model never depends on the rest of the suite.
- **GATE-32 Different words, same thing.** A rule and a test meet when they use different forms of a word (walkers, walked), a short form and its long form (acks, acknowledging), or two sides of one idea (never twice, once); and a test that speaks of more of the rule's things in its name is shown before one that shares a single rare word.
- **GATE-21 Read twice.** A model verdict that no candidate test proves a rule stands on the model's word alone, so it blocks only after a second, differently framed reading of the same tests agrees; a disagreement is advice.
- **GATE-24 Nothing is concluded from part of a test.** The model is shown each candidate test whole, or its opening, its assertions and the lines that share the rule's words; assertions made through a helper, in the same file or in a helper file the test imports, are shown too, with the setup block above the test; and when not every assertion fits, a verdict that the test proves nothing is advice.
- **GATE-25 Candidates through imports.** A test that imports a source file named by one of the rule's words is a candidate for the rule even when the test shares none of its wording.
- **GATE-26 Executed evidence.** When a test command is given, the gate moves a rule's limit in the code by one step and runs the linked tests on disk: a rule whose tests still pass is reported as unguarded with executed evidence, every file is restored, and nothing is concluded when the tests fail before any change.
- **GATE-22 Model failures stop early.** Two failed calls in a row, or one refused for bad credentials, end the model calls of the run; a reply in the wrong shape gets one repair attempt.

## Placement

- **GATE-10 Tested too high.** A rule that is pure logic and is proven only by integration or end-to-end tests is reported, with the level it needs.
- **GATE-11 Proven against fakes.** A rule about a real boundary that is proven only by tests which fake their collaborators is reported.
- **GATE-12 Misfiled tests.** A test file filed as unit that needs a network, a browser or a child process is reported, and so is a file filed as integration or end to end that crosses no boundary.

## CI

- **GATE-31 Formal models.** Each invariant or property that a TLA+ configuration names is a design decision, said in the words of the comment above its definition; it asks for two proofs: the model checker run by CI where it can stop a change (when it is only run by hand that is one finding that lists the properties, not one finding each), and a test of the code, found like the test of any rule or by the property's name in the test.
- **GATE-13 Enforced means it can fail a pull request.** A check counts as enforced only when a step runs it in a workflow triggered by pull requests and the step's failure is not ignored.
- **GATE-14 Scripts are followed.** A step that calls a package script, a make target or a shell script of the repository is judged by the commands that script runs.
- **GATE-29 Checks that are programs.** A program a CI step runs to check the product, named as a check or a test, is a test even without a test framework; each of its assertions that says in words what it checks is a test case named by those words.
- **GATE-15 Priorities of CI gaps.** Tests that do not gate pull requests are P0; a linter or type checker that is set up and not enforced is P1; an optional check the repository never set up is shown in the CI table and is not a finding.
- **GATE-28 No guesses in the list.** A sentence without an ID that nobody has judged to be a rule is counted in the report and produces no finding.

## Gate

- **GATE-16 What blocks.** The review covers the whole repository, and a finding blocks when its priority reaches the gate and its evidence is code-decided or code-verified; advice never blocks, and with the ratchet on a finding already in the baseline does not block.
- **GATE-27 Probation.** A check whose findings were dismissed, not fixed, more often than the configured share stops blocking and is reported as on probation; the counts come from default-branch runs, and too few of them decide nothing.
- **GATE-17 Suppressions.** A suppression needs a reason, and one whose end date has passed is no longer applied.
- **GATE-18 Repeatable.** Two runs on the same repository state write the same report, byte for byte, whether the cache on disk is cold or warm.
- **GATE-19 The gate does not break the build by breaking.** When a stage or the model fails, the report says what was skipped, and the exit code of the command line is zero unless enforcement was asked for and the gate failed.
- **GATE-23 Measured.** The quality of what the gate reports is measured by planting one defect at a time in a fixture repository on disk: every planted defect must be found, nothing else may be reported, and a second run must agree.
- **GATE-20 Untested change.** When a review is given a change, a changed source file that no test reaches, in a change that adds no test for it, is reported; the change narrows nothing else.
