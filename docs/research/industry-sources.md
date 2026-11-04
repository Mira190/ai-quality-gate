# Industry practices: precise, low-noise, shift-left automated analysis and AI review

Researched 2026-11-04. The source tag on each figure says how far it was checked:
- **[FT]**: I read the full text myself (PDF text extraction or the HTML full text).
- **[ABS]**: taken from the abstract.
- **[BLOG]**: taken from a primary engineering or vendor blog or docs page.
- **[SEC]**: taken from a secondary summary or search snippet that I could not confirm.
- **[UNVERIFIED]**: from memory and not checked.

Vendor numbers are self-reported.

---

## 1. Google

### Tricorder (Sadowski et al., ICSE 2015) [FT]
URL: https://research.google/pubs/tricorder-building-a-program-analysis-ecosystem/ (PDF: https://static.googleusercontent.com/media/research.google.com/en//pubs/archive/43322.pdf)
- **"Effective false positive"**: "any report from the tool where a user chooses not to take action to resolve the report." A report that is technically wrong but whose fix improves the code does *not* count as a false positive.
- **Not-useful rate**: NOT_USEFUL / (NOT_USEFUL + PLEASE_FIX + APPLY_FIX), shown on a per-analyzer dashboard.
  - At **≥10%**, the analyzer goes on **probation**.
  - At **>25%**, Google "may decide to turn the analyzer off immediately."
- **Bar for admitting an analyzer**: developers should "feel that we are pointing out an actual issue at least 90% of the time." Before launch this is measured by manually checking a statistically sound sample of results on existing code. The paper says the 10% threshold matches Coverity's.
- **Results**: the not-useful rate across all analyzers was "typically at around 5%", and "under 4%" with analyzers on probation excluded.
- **Diff-only display**: results are shown "on changed lines by default", with an opt-in to see unchanged lines.
- **Admission criteria**: the finding must be easy to understand and have an obvious fix (cyclomatic complexity and location-based fault prediction explicitly fail this test), it must matter, and it must occur at a "small but noticeable frequency."
- **Message wording**: for one analyzer, 75% of the bugs filed against it came from people misreading the message. Rewording the message or linking to docs fixed them.
- **Fixes**: suggested fixes can be previewed and applied ("Apply fix") inside the review tool.
- **What it implies for us:**
  - Adopt the per-check not-useful-rate formula, with probation at ≥10% and a kill switch at >25%.
  - Report only on changed lines or touched rules by default.
  - Drop vague checks with no clear fix.
  - Treat a confusing message as a bug.

### Resolving code review comments with ML (Google Research blog, 2023) [BLOG]
URL: https://research.google/blog/resolving-code-review-comments-with-ml/
- **Precision target**: 50%, meaning "50% of suggested edits on our evaluation dataset are correct". At that precision the model addresses 52% of comments offline, and about 50% of relevant comments online clear the confidence threshold.
- **Usage**: authors preview about 40% of suggestions (up from about 20% in beta) and apply 40–50% of the ones they preview.
- **Serving-time filtering**: heuristics filter known failure patterns, deliberately trading quantity for quality.
- **What it implies for us**: confidence gating plus serving-time heuristic filters tuned against a labelled evaluation set. A suggestion people choose to preview can tolerate about 50% precision. A gating finding cannot.

### AutoCommenter, "AI-Assisted Assessment of Coding Practices in Modern Code Review" (arXiv 2405.13565, AIware 2024) [FT, HTML]
URL: https://arxiv.org/abs/2405.13565
- **Every comment cites a best-practice URL.** Usefulness by developer feedback plateaued at about 54%, against a target of 80%.
  - Suppressing 17 non-actionable URLs raised it to 66% (developer feedback) and to 74% (raters).
  - Suppressing 5 more and rewording summaries reached 80%.
- **Thresholds**:
  - A single global threshold of 0.98 was too strict: about 80% of predictions below it were still correct.
  - They switched to **per-URL thresholds** computed on a validation set.
- **Changed lines only**: 80% of raw comments fell on lines the author had not modified, and were filtered out.
- **Resolution**: about 40% of comments are resolved, while only about 10% of comments receive any explicit feedback.
  - Automated estimate: in 6,000 snapshot pairs, 50% of commented lines no longer carried the comment at submission.
  - Manual check: in 40 such pairs, 80% were resolved by the author's own change.
- **Rule coverage**: 66% of the top 50 rules cannot be detected by traditional static analysis.
- **A/B test**: no significant change in review duration.
- **What it implies for us:**
  - Cite a rule or doc anchor in every finding.
  - Set thresholds per rule, not globally.
  - Suppress whole rule categories that developers reject.
  - Filter out findings on lines the change did not touch.
  - Measure resolution implicitly ("did the flagged region change?") because explicit feedback is sparse.

### Mutation testing in code review [FT]
- **"State of Mutation Testing at Google" (Petrović & Ivanković, ICSE-SEIP 2018)**
  URL: https://research.google.com/pubs/archive/46584.pdf
  - Diff-based and probabilistic: only changed and covered lines are mutated.
  - 6,000 engineers used it.
  - Evaluated on more than 70,000 diffs, 1.1M mutants tested and 150,000 findings surfaced.
  - Usefulness rose from **20% to 80%** through the feedback loop. In the steady state, 75% of findings that received feedback were rated useful.
  - Usefulness varies by mutation operator, from 87.3% (LCR) down to 61.7% (AOR).
- **"Practical Mutation Testing at Scale" (Petrović, Ivanković, Fraser, Just; arXiv 2102.11378, TSE)**
  URL: https://arxiv.org/abs/2102.11378
  - Initially **85% of reported mutants were unproductive**. Feedback from more than 20,000 developers over six years produced suppression heuristics that raised the productive ratio from **15% to 89%**.
  - **Arid nodes**: logging statements, deadlines and timeouts, and config flags gave most of the gain (about 15% → 80%).
  - **Unsound heuristics** (fuzzy name and AST-shape matching) gave "much more important improvements" than sound, type-based ones.
  - Live mutants per changelist: median 2, p99 43.
  - Mutants are capped per line and per review.
  - Productivity: "change-detector" tests written just to kill unproductive mutants are explicitly undesirable.
- **What it implies for us:**
  - For "boundary values covered" and "test asserts the rule", keep an *arid* list: logging, timeouts, config, capacity constants.
  - Cap findings per file and per PR.
  - Prefer unsound heuristics that cut noise over sound but noisy checks.
  - Never ask people to write change-detector tests.

### Test sizes and test mix: Software Engineering at Google, ch. 11 [FT, web]
URL: https://abseil.io/resources/swe-book/html/ch11.html
- **Size is defined by resources, not intent**:
  - *Small*: a single process, with no sleep, no I/O and no blocking calls.
  - *Medium*: a single machine; `localhost` is allowed.
  - *Large*: multiple machines.
- **Scope** ("the specific code paths we are verifying") is a separate axis.
- **Target mix**: about 80% unit, 15% integration and 5% e2e, by count. The chapter names two antipatterns:
  - *Ice cream cone*: many e2e tests, few unit tests.
  - *Hourglass*: many e2e and many unit tests, few integration tests. The chapter says it arises when tight coupling makes dependencies hard to instantiate in isolation.
- **Flakiness**: Google's rate "hovers around 0.15%." Near 1%, tests "lose value."
- **What it implies for us:**
  - Classify test level by *observable resources* (network, DB, browser, multiple processes) rather than by folder name.
  - When we see an hourglass, the advice should be "add an integration seam", not "move it to unit".
  - Only recommend moving a test down when the logic can be instantiated without its I/O dependencies.
- 2010 Testing Blog "Test Sizes" (https://testing.googleblog.com/2010/12/test-sizes.html): I could not extract the table text. [UNVERIFIED details]

### 2024–2026 Google papers on AI code review or test quality
- **Found**: only AutoCommenter (above) and the ML code-review-comments blog (above).
- **Not found**: a 2025–26 Google paper on LLM code review with a "useful" rate. I am not claiming one exists.

---

## 2. Meta

### Infer / Zoncolan: "Scaling Static Analyses at Facebook" (Distefano, Fähndrich, Logozzo, O'Hearn, CACM 2019) [FT, UCL preprint]
URL: https://discovery.ucl.ac.uk/10084236/1/O%27Hearn%20AAM%20scaling-static-analysis-at-facebook.pdf
- **Batch vs diff time**: in nightly batch mode they assigned 20–30 issues, and the fix rate was "near zero" even though the false-positive rate was thought to be under 20%.
- **Diff time**: "the fix rate rocketed to over 70%. The same program analysis, with same false positive rate." The authors' explanations are context switching and relevance (the bot comments on the diff that introduced the issue).
- **Timeliness**: if a bot runs "for an hour or more" it is too late. Infer returns results in about 15 minutes on average.
- **Metrics**: they track "actioned reports" and "missed bugs" (bugs observed later that no tool reported) rather than an abstract false-positive rate.
  - Zoncolan's action rate is above 80%, with about 11 missed bugs.
  - The concurrency analysis had a fix rate of about 50%.
  - Diff time prevented 211 severe security issues, against 122 found on master.
- **What it implies for us:**
  - Deliver at PR time, on the diff, in under about 15 minutes.
  - Track an *actioned rate*.
  - Never present a backlog dump as the main output.

### TestGen-LLM: "Automated Unit Test Improvement using LLMs at Meta" (arXiv 2402.09171, FSE 2024) [ABS + FT]
URL: https://arxiv.org/abs/2402.09171
- **"Assured LLMSE" filters, applied in sequence**: builds → passes → passes reliably (**all 5 of 5 runs**) → increases coverage. Survivors are "guaranteed to improve the existing test class."
- **Abstract numbers**: 75% of test cases built, 57% passed reliably and 25% increased coverage. 11.5% of classes improved, and 73% of recommendations were accepted.
- **Deployment (full text)**:
  - 196 of 1,979 classes improved.
  - About 4% of individual generation attempts succeeded.
  - Facebook diffs: 144 accepted, 64 rejected or abandoned, 61 got no review, 11 withdrawn, out of 280.
- **What it implies for us**: an LLM proposal only reaches the user after deterministic, executable checks prove it. Use N-run agreement as the stability filter: 5 of 5 runs must agree, or the verdict is dropped.

### ACH: "Mutation-Guided LLM-based Test Generation at Meta" (arXiv 2501.12862, FSE 2025) [ABS]
URL: https://arxiv.org/abs/2501.12862
- **Scale**: 10,795 Kotlin classes, 9,095 mutants and 571 tests.
- **Acceptance**: engineers accepted 73% of tests and judged 36% privacy-relevant.
- **Equivalent-mutant LLM detector**: precision 0.79 and recall 0.47 alone, rising to **0.95 and 0.96 with simple pre-processing** (deterministic stripping before the LLM).
- **What it implies for us**: deterministic pre-processing before an LLM judgment made a large difference here. Generate concrete faults (mutants) for each rule and ask "does a test kill this?" rather than "does this test look like it covers the rule?"

### Just-in-Time Catching Tests (arXiv 2601.22832, FSE Companion 2026; Meta blog 2026-10-29) [ABS + BLOG]
URLs: https://arxiv.org/abs/2601.22832 and https://engineering.fb.com/2026/10/29/security/catching-bugs-before-they-land-jittestings-human-on-the-loop-approach-at-full-scale/
- **Assessors**: rule-based plus LLM assessors "reduce human review load by 70%."
- **Paper deployment**: 41 candidate catches were reported, and 8 were true positives (about 20%).
- **Blog (company-reported)**: engineers report a 60% true-positive rate. 74 SEV privacy bugs were caught in H1 2026, and privacy SEVs fell 20%.
- **Design**: a deterministic rule assessor ("RubFake") is paired with an ensemble LLM judge. The blog notes the LLM judgments are "non-deterministic and hard to verify." Only top-ranked candidates are escalated.
- **What it implies for us**: a layered judge (deterministic rules first, then an LLM ensemble) with selective escalation.

### Sapienz (SSBSE 2018 keynote paper) [SEC]
URL: https://link.springer.com/doi/10.1007/978-3-319-99241-9_1
- Fix rate of **about 75% as a lower bound**. Each report carries a "debug payload" (stack trace and crash-witness video).
- Harman (VentureBeat): it is "very easy for an automated technique to generate all sorts of irrelevant noise."
- **What it implies for us**: attach the evidence (the trace, the test, the doc line) to every finding.

---

## 3. Other companies

### Uber uReview (blog, 2025) [BLOG]
URL: https://www.uber.com/us/en/blog/ureview/
- **Pipeline**: prefilter (configuration, generated and experimental files) → 3 generators → a **grader prompt** that assigns a confidence → thresholds per assistant × language × category → semantic deduplication → a category classifier that suppresses low-value categories.
- **Results**:
  - 75% of comments are rated useful.
  - 65% of posted comments are addressed, against **51% for human comments**.
  - Median latency is 4 minutes.
  - More than 90% of about 65k diffs a week are analysed. The post gives this figure as per week in one place and per month in another.
- **Addressed check**: they re-run uReview 5 times on the final commit to decide whether a comment was addressed.
- **Lessons**:
  - "Precision over volume."
  - Developers dislike readability, style, logging and minor-performance comments.
  - "Guardrails matter as much as prompts."
  - Linters are best for syntactic rules.
- **Best model configuration**: Claude-4-Sonnet as generator with o4-mini-high as grader.
- **What it implies for us:**
  - Use a separate grader pass.
  - Calibrate thresholds per rule category.
  - Drop style and readability categories entirely.
  - Measure addressed-rate by whether the flagged code changed.

### Uber Piranha (ICSE-SEIP 2020) [SEC]
URLs: https://2020.icse-conferences.org/details/icse-2020-Software-Engineering-in-Practice/16/Piranha-Reducing-Feature-Flag-Debt-at-Uber and https://eng.uber.com/piranha/
- 65% of generated cleanup diffs landed unchanged, and more than 85% compiled and passed tests.
- It covered 1,381 flags (17% of all flags).
- **What it implies for us**: deterministic, AST-based changes routed to the right owner land without edits.

### ByteDance BitsAI-CR (arXiv 2501.15134, FSE 2025 industry) [ABS + FT HTML]
URL: https://arxiv.org/abs/2501.15134
- **Two stages**: RuleChecker, then a ReviewFilter verifier.
- **Filter output format (Conclusion-First, chosen for precision)**:

| Pattern | Precision | Recall | Filter rate | Speed |
|---|---|---|---|---|
| Conclusion-First | 77.1% | 69.0% | 55% filtered | 1.7 s |
| Reasoning-First | 65.8% | 81.8% | not noted | 31 s |
| Direct Conclusion | 63.3% | not noted | not noted | not noted |

- **Results**:
  - Peak precision is 75% (abstract). Online, RuleChecker rose from 27.9% to 62.6%.
  - The Go "Outdated Rate" is 26.7%, against a human baseline of 35–46%.
  - More than 12k weekly active users. 74.5% of surveyed users found the reviews valuable.
- **Outdated Rate**: the share of seen comments whose flagged lines are modified in later commits. It is an implicit acceptance proxy.
- **Rule governance**: rules are evaluated over 14 days against about 65% precision and about 25% Outdated Rate. **Rules that are precise but never acted on are also removed.**
- **Other mechanics**: embedding-based deduplication keeps one comment per cluster. Daily manual annotation covers up to 10% of online output.
- **What it implies for us:**
  - Keep a per-rule precision and acceptance scorecard.
  - Retire a rule when it is right but not useful.
  - Use a cheap binary verifier.
  - The table above favoured conclusion-first output in that setup.

### Tencent: "Reducing False Positives in Static Bug Detection with LLMs: An Empirical Study in Industry" (arXiv 2601.18844) [ABS + FT HTML]
URL: https://arxiv.org/abs/2601.18844
- **Dataset**: 433 alarms (328 false positives, 105 true positives) from Tencent's BkCheck; about 76% of alarms were false positives. The bug types are null-pointer, out-of-bounds and divide-by-zero, mostly in C/C++.
- **Results**:
  - The hybrid **LLM4PFA** (static path constraints plus agentic reasoning) eliminates **94–98% of false positives** at **recall 0.75–0.88**.
  - Basic prompting reaches only 0.40–0.55 accuracy.
  - Few-shot was the best plain prompt. Chain-of-thought was the weakest, sometimes worse than the basic prompt.
- **Cost**: $0.001–0.12 and 2–110 seconds per alarm, against 10–20 minutes of manual review.
- **Stability**: they used **majority vote over 3 runs**.
- **Failures**: concentrated in long functions.
- **What it implies for us:**
  - Have the LLM verify a *deterministically produced candidate* with structured evidence (paths, constraints). Do not let it generate candidates.
  - Use majority vote for stability.
  - Recall is still below 90%, so an LLM filter must not silently drop high-severity findings.

### Microsoft AI code review (Engineering@Microsoft blog, 2025-07-14) [BLOG]
URL: https://devblogs.microsoft.com/engineering-at-microsoft/enhancing-code-quality-at-scale-with-ai-powered-code-reviews/
- **Scale**: more than 90% of PRs, more than 600k PRs a month and 5,000 repositories.
- **Effect**: median PR completion time improved 10–20%.
- **Design**:
  - Comments are inline and categorised.
  - The author stays in control; nothing is auto-committed.
  - "Ask the AI" provides information on demand rather than as extra comments.
  - Teams can set guidelines per repository.
- **Not published**: precision numbers.

### Atlassian RovoDev Code Reviewer (arXiv 2601.01129, ICSE-SEIP 2026) [ABS + FT HTML]
URL: https://arxiv.org/abs/2601.01129
- **Pipeline**: generation (Claude 3.5 Sonnet) → a gpt-4o-mini factual-correctness judge → a **ModernBERT actionability classifier** trained on about 50k comments labelled by whether they led to a code change.
- **Code resolution rate**: 38.7%, against **44.45% for human comments**.
- **Workflow effects**: PR cycle time down 30.8% and human comments down 35.6%. The deployment covered about 1,900–2,000 repositories and 54k comments.
- **Ablation**:
  - The cheap actionability classifier improved alignment by about 15–20 points.
  - **The LLM factual judge had minimal impact.**
  - Review guidelines were the most important prompt input.
- **Feedback**: engineers rarely clicked thumbs up or down.
- **What it implies for us:**
  - A small classifier trained on "did this lead to change" labels can beat an LLM judge. It is deterministic at inference time, which helps stability.
  - Rule and guideline text must be in the prompt.

### Datadog SAST false-positive filtering (blogs 2025 and 2026-07) [BLOG]
URLs: https://www.datadoghq.com/blog/using-llms-to-filter-out-false-positives/ and https://www.datadoghq.com/blog/sast-triage-agentic-evaluation-bits-memories/
- **No numbers published.**
- **Lessons**:
  - Prompts tuned to catch true positives misclassify more false positives, and the reverse.
  - The LLM filter is only as good as the underlying analyzer.
- **"Memories"**: scoped per rule and treated as *evidence, not a suppression list*.
- **Explanations**: they must cite the validator or caller behind each verdict.
- **Agent access**: read-only.

---

## 4. Vendors

### SonarQube: Clean as You Code, new code period and quality gate [BLOG, docs]
- **New code definitions**: previous version (the default), a number of days (default 30, maximum 90), a reference branch, or a specific analysis.
  URL: https://docs.sonarsource.com/sonarqube-server/latest/user-guide/about-new-code/
- **Sonar way quality gate (new code only)**: no new issues; all new hotspots reviewed; coverage on new code ≥80%; duplication on new code ≤3%.
  URL: https://docs.sonarsource.com/sonarqube-server/latest/quality-standards-administration/managing-quality-gates/introduction-to-quality-gates/
- **Fudge factor**, quoted: "conditions on coverage are ignored until the number of new lines to cover is at least 20". Duplication works the same way, with a threshold of 20 new lines. It is on by default.
- **What it implies for us:**
  - Gate only on new or changed rules and code.
  - Skip ratio conditions on tiny changes.
  - Keep legacy debt in the report, not in the gate.

### Codecov patch coverage [docs]
URL: https://docs.codecov.com/docs/commit-status
- **Patch coverage**: coverage of the added or changed lines only.
- **Status settings**: `target: auto` compares against the base commit. `threshold` allows a tolerance. `informational: true` reports without blocking. `only_pulls`. `if_ci_failed: error` is the default.
- **What it implies for us**: offer an informational mode before a blocking mode, and compare against the base rather than an absolute target.

### Mutation testing in CI
- **StrykerJS incremental** [docs], https://stryker-mutator.io/docs/stryker-js/incremental/
  - The doc's example reused 3,731 of 3,965 mutant results, so only 6% re-ran.
  - Results are invalidated when files change or when the killing test changes.
  - It does not detect dependency, environment or snapshot changes.
  - It is recommended for CI. The incremental file must be cached between runs (my inference).
- **PIT (Java)**: has incremental analysis via history files. [UNVERIFIED, not re-checked]

### Semgrep Assistant [BLOG]
- **Methodology post**, https://semgrep.dev/blog/2025/building-an-appsec-ai-that-security-researchers-agree-with-96-of-the-time/
  - Evaluated on more than 2,000 findings labelled by researchers.
  - Agreement on **true positives is 96%** (the headline), but **agreement on false positives is only 41%** (it started at 25%).
  - It is conservative: it is more likely to suggest fixing a false positive than to dismiss a true positive.
  - Prompt inputs: rule metadata, prior triage, examples, memories, the dataflow trace and the rule's confidence value.
- **Triage post**, https://semgrep.dev/blog/2025/semgrep-is-confidently-handling-60-of-all-triage-for-users-without-reducing-coverage
  - It auto-handles about 60% of triage, and audits agree more than 96% of the time.
  - It is **asymmetric**: the AI may only *act* on false-positive verdicts above a confidence level. True-positive reasoning is advisory.
- **Memories**: in one example, 18 false positives were filtered without the memory and 588 with it [SEC, from a search snippet of https://semgrep.dev/blog/2025/announcing-ai-noise-filtering-and-triage-memories]. Memories are approved by admins and scoped.
- **What it implies for us:**
  - Report precision split by class.
  - Make LLM authority asymmetric: it may *downgrade* a finding only with evidence, and must never silently remove high-severity findings.
  - Memories should be approved by a person, scoped and versioned.

### Snyk DeepCode AI Fix [BLOG, vendor]
URL: https://snyk.io/blog/ai-code-security-snyk-autofix-deepcode-ai
- **Hybrid design**: the LLM proposes a fix, then the symbolic engine re-scans it to filter hallucinated or incorrect fixes.
- **Accuracy**: "over 80%" of fixes are accurate.
- **Not published**: the share of candidate fixes the symbolic engine rejects.

### GitHub
- **Copilot Autofix** [SEC; the GitHub changelog was surfaced by search, but I did not fully read the post] https://github.blog/news-insights/product-news/secure-code-more-than-three-times-faster-with-copilot-autofix/
  - CodeQL detects; the LLM fixes.
  - Median time to commit a fix was 28 minutes, against 1.5 hours manually, in the May–July 2024 beta.
  - XSS fixes were about 7× faster and SQL injection about 12× faster (per the changelog).
- **Copilot code review docs**, https://docs.github.com/en/copilot/concepts/agents/code-review
  - It is "not guaranteed to spot all problems."
  - By default its reviews do not count toward required approvals.
  - Custom instructions live in `.github/copilot-instructions.md` and path-scoped `*.instructions.md`.
  - **No accuracy statistics are published.**
- **SARIF fingerprints**, https://docs.github.com/en/code-security/code-scanning/integrating-with-code-scanning/sarif-support-for-code-scanning
  - Code scanning uses only `partialFingerprints.primaryLocationLineHash` to match results across runs.
  - Matching needs a stable `ruleId` and consistent file paths; otherwise a new alert opens and the old one closes.
  - If uploads through the API omit fingerprints, users "may see duplicate alerts." `upload-sarif` computes them.
  - `runAutomationDetails.id` = `category/run-id`.
  - **What it implies for us**: emit SARIF with stable rule IDs and content-hash fingerprints. Then the same finding is the same alert across runs, which also hides LLM wording churn.

### AI review vendors' precision claims (all vendor or third-party, low trust) [SEC]
- **CodeRabbit**: precision 49.2%, recall 53.5%, F1 51.2% on the Martian Code Review Bench (early 2026), per CodeRabbit's blog.
  URL: https://www.coderabbit.ai/blog/coderabbit-tops-martian-code-review-benchmark
- **Qodo**: 60.1% F1 on its own benchmark (100 PRs with 580 injected issues).
- **Graphite**: claims a false-positive rate under 3% for Reviewer (Product Hunt). Its Claude case study reports 96% positive feedback and 67% of suggestions implemented.
  - Its internal metric definitions (via Braintrust) are useful: *acceptance rate* = comments whose suggested change is committed, which is their key metric. *Downvote rate* is tracked separately.
  - URL: https://graphite.com/blog/how-graphite-uses-claude
- **Takeaway**: state-of-the-art *generative* review sits around 50–60% precision on benchmarks. Credible high precision comes from verified or filtered narrow checks.

---

## 5. Baselines, suppression and ratchets

- **ESLint bulk suppressions** [docs], https://eslint.org/docs/latest/use/suppressions
  - Commands: `--suppress-all`, `--suppress-rule` and `--prune-suppressions`.
  - The suppressions file is `eslint-suppressions.json`, matched by file path. It applies only to rules set to `"error"`.
  - Suppressions that no longer match cause a **non-zero exit** until pruned, so the baseline is forced to shrink.
  - The version that introduced it was not stated on the page (I believe it is v9.24, 2025) [UNVERIFIED].
- **Detekt baseline** [docs], https://detekt.dev/docs/introduction/baseline/
  - The file is `baseline.xml`, with `CurrentIssues` (accepted debt) and `ManuallySuppressedIssues` (known false positives, kept out of source code).
  - Entry IDs are `RuleID:FileName:Signature`. The signature is symbol-based, not line-based.
  - The docs warn that baselines break across major versions and with auto-formatting.
- **Betterer** [docs], https://phenomnomnominal.github.io/betterer/docs/introduction
  - The `.betterer.results` snapshot is committed. Improvements are written back as the new baseline; regressions fail.
- **SpotBugs**: supports excluding a previous result set as a baseline (`-excludeBugs`, or `excludeBugsFile` in the Maven and Gradle plugins). [UNVERIFIED, not re-checked]
- **What it implies for us:**
  - Commit a baseline file keyed by stable fingerprints: rule ID plus file plus symbol or content hash, not line numbers.
  - Gate only on new fingerprints.
  - Keep "known false positive" separate from "accepted debt."
  - Fail on stale entries so the baseline only shrinks (a ratchet).

---

## 6. Test placement realism

- **Google sizes vs scope** (above): level is an observable resource property, and the hourglass antipattern comes from tight coupling, *not* from developer laziness.
- **Fowler, "Practical Test Pyramid" (Ham Vocke)** [web], https://martinfowler.com/articles/practical-test-pyramid.html
  - "Push your tests as far down the test pyramid as you can", **and** "If a higher-level test gives you more confidence... you should have it."
  - Trigger for adding a lower test: "If a higher-level test spots an error and there's no lower-level test failing, you need to write a lower-level test."
  - Delete duplicated high-level tests.
  - Sociable and solitary unit tests are both fine.
- **Fowler, TestPyramid bliki** [web], https://martinfowler.com/bliki/TestPyramid.html
  - If high-level tests are "fast, reliable, and cheap to modify", lower-level tests may not be needed.
  - Disagreement between authors is largely about the definition of "unit."
- **Kent C. Dodds, Testing Trophy** [web], https://kentcdodds.com/blog/the-testing-trophy-and-testing-classifications
  - Layers: static, unit, **integration (the largest layer)**, e2e.
  - The framing is return on investment: confidence for the time spent.
  - Explicitly **no ratio data**. Only considered for monoliths.
- **Trautsch & Grabowski, ICST 2017**: in 10 Python OSS projects, developers believed they wrote more unit tests than they actually did, by IEEE/ISTQB definitions. The result depends on the definition used. [SEC]
  URL: https://www.swe.informatik.uni-goettingen.de/node/2651
- **Stein, Herbold, Trautsch & Grabowski, JSS 2020**: classified 38,782 Java tests and used mutation analysis. They found **no evidence that unit and integration tests differ in which defect types they detect**, and propose usage-based definitions. [ABS via search, SEC]
  DOI: 10.1016/j.jss.2019.110421
- **Feathers seams** (*Working Effectively with Legacy Code*): a seam is a place to alter behaviour without editing in that place. Moving a test down requires a seam to exist. [UNVERIFIED wording; book not fetched]
- **Data on how often moving tests down is feasible**: **I found no quantitative industry data.** This is a gap.
- **What it implies for us:**
  - Recommend "push down" only when there is (a) pure or deterministic logic reachable without I/O and (b) an existing seam (injectable dependency or exported function). Otherwise accept the higher-level test and check only that it asserts the rule and runs on PR.
  - The Stein 2020 finding supports *not* penalising integration-level evidence.

---

## 7. Cross-cutting recommendations for the AI quality gate

1. **Track not-useful and actioned rates per rule.**
   - Use Tricorder's formula, with probation at ≥10% and disable at >25%.
   - Measure acceptance implicitly: did the flagged region change (Uber, BitsAI Outdated Rate, AutoCommenter).
   - Retire rules that are precise but ignored (BitsAI).
2. **Report on the diff by default and run at PR time in under about 15 minutes** (Infer: about 0% fix rate in batch against more than 70% at diff time; Tricorder; AutoCommenter, where 80% of raw comments were on unchanged lines).
3. **Let the LLM verify; don't let it generate.**
   - Deterministic candidates first, then a narrow binary verifier with structured evidence (Tencent: 94–98% of false positives removed, recall 0.75–0.88).
   - Have it output the conclusion first (BitsAI: 77% precision, 1.7 s).
   - Do deterministic pre-processing (ACH: 0.79/0.47 → 0.95/0.96).
4. **Stability**:
   - Require N-of-N or majority agreement (TestGen-LLM 5/5; Tencent majority of 3).
   - Fingerprint findings by stable rule ID and content hash (SARIF `primaryLocationLineHash`), so wording churn does not create new alerts.
   - Use a small trained classifier where possible (Atlassian ModernBERT beat the LLM judge).
5. **Make LLM authority asymmetric**: it may downgrade a finding with cited evidence but may not delete high-severity ones (Semgrep: 96% agreement on true positives but 41% on false positives; Tencent recall below 90%).
6. **Suppression**:
   - Keep an arid list (logging, timeouts, config) and per-rule thresholds (Google mutation testing: 15% → 89% productive; AutoCommenter: 54% → 80%).
   - Use a committed baseline that only shrinks (ESLint, Detekt, Betterer).
7. **Gate design**:
   - Gate on new code only, using a reference branch (Sonar).
   - Skip ratio checks under 20 changed lines (Sonar fudge factor).
   - Offer informational mode first (Codecov).
8. **Test placement**: classify test level by resources (Google sizes). Recommend moving a test down only when a seam exists. Otherwise accept the integration or e2e evidence; Stein 2020 found no evidence that unit and integration tests differ in which defects they detect.
9. **Every finding carries evidence and a citation**: the doc line, code span and test name (AutoCommenter URLs, Sapienz debug payload, Datadog cited validators).
