# ai-quality-gate requirements

What the gate must do. Every requirement has an ID, and the test that proves it names that ID: the gate reviews this
repository with the same rules it applies to any other.

## Reading rules out of documents

- **GATE-1 Rules with an ID.** An item that starts a heading, a list item or a table row with an ID (`REQ-12`, `DEC-4`, `AC-3`) is a rule; `REQ_007` and `req-7` name the same rule.
- **GATE-2 Decision records.** An architecture decision record yields one decision; a decision that is superseded, rejected or still proposed is not counted.
- **GATE-3 Rules without an ID.** In a requirement or design document that numbers nothing, a normative sentence (must, shall, should) is an inferred rule whose ID is a hash of its text; instructions to developers are not rules.
- **GATE-4 Critical rules.** A rule about money, access control, customer data, calls to outside systems or data safety is critical, and the report names the word that made it so.

## Proof

- **GATE-5 Links by ID.** A test that names a rule's ID in its title, a comment or a tag is linked to the rule by code alone.
- **GATE-6 Skipped tests prove nothing.** A rule whose linked tests are all skipped is reported as having no proof.
- **GATE-7 Limits.** When a rule states a limit and no linked test uses that value, the report names the limit as a hole in the proof.
- **GATE-8 Citations are checked.** A model verdict that a test proves a rule is believed only when it cites a candidate test it was shown, at a line it was shown, and that line is an assertion; anything else is advice.
- **GATE-9 Model budget.** The model is called for rules code could not link, most severe first, never more often than the configured number of calls; a rule whose text and candidate tests are unchanged is answered from the verdict cache or the lock file, and what the budget did not reach is judged by the next run.
- **GATE-21 Read twice.** A model verdict that no candidate test proves a rule stands on the model's word alone, so it blocks only after a second, differently framed reading of the same tests agrees; a disagreement is advice.
- **GATE-22 Model failures stop early.** Two failed calls in a row, or one refused for bad credentials, end the model calls of the run; a reply in the wrong shape gets one repair attempt.

## Placement

- **GATE-10 Tested too high.** A rule that is pure logic and is proven only by integration or end-to-end tests is reported, with the level it needs.
- **GATE-11 Proven against fakes.** A rule about a real boundary that is proven only by tests which fake their collaborators is reported.
- **GATE-12 Misfiled tests.** A test file filed as unit that needs a network, a browser or a child process is reported, and so is a file filed as integration or end to end that crosses no boundary.

## CI

- **GATE-13 Enforced means it can fail a pull request.** A check counts as enforced only when a step runs it in a workflow triggered by pull requests and the step's failure is not ignored.
- **GATE-14 Scripts are followed.** A step that calls a package script or a make target is judged by the commands that script runs.
- **GATE-15 Priorities of CI gaps.** Tests that do not gate pull requests are P0; a linter or type checker that is set up and not enforced is P1.

## Gate

- **GATE-16 What blocks.** The review covers the whole repository, and a finding blocks when its priority reaches the gate and its evidence is code-decided or code-verified; advice never blocks, and with the ratchet on a finding already in the baseline does not block.
- **GATE-17 Suppressions.** A suppression needs a reason, and one whose end date has passed is no longer applied.
- **GATE-18 Repeatable.** Two runs on the same repository state write the same report, byte for byte, whether the cache on disk is cold or warm.
- **GATE-19 The gate does not break the build by breaking.** When a stage or the model fails, the report says what was skipped, and the exit code of the command line is zero unless enforcement was asked for and the gate failed.
- **GATE-23 Measured.** The quality of what the gate reports is measured by planting one defect at a time in a fixture repository on disk: every planted defect must be found, nothing else may be reported, and a second run must agree.
- **GATE-20 Untested change.** When a review is given a change, a changed source file that no test reaches, in a change that adds no test for it, is reported; the change narrows nothing else.
