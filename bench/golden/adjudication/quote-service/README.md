# Adjudicated: the quote-service fixture, mock vs the tool with a stand-in model

The mock report is the fixture's hand-written answer. Here the whole pipeline ran on the fixture with a stand-in model
(a separate agent answering the model calls from the prompts alone, 1 vote; `standin-cassette.json`). Every finding in
sections 1–4 that only one side reported (28) went to an independent reviewer (another agent, a different model) who
read the fixture's documents, code, tests and CI, judged each claim against the tool's own definitions, and did not know
which side reported it (`disputes.json` → `verdicts.json`; `disputes-key.json` says which side each came from).
Findings both sides reported count as true.

| Shown rows (P0/P1), sections 1–4 | Findings | True | False | Unclear | Precision | Share of all true findings |
| --- | :-: | :-: | :-: | :-: | :-: | :-: |
| Mock (hand-written spec) | 27 | 25 | 1 | 1 | 96% | 25 of 33 |
| Tool + stand-in model, 1 vote | 36 | 30 | 4 | 2 | 88% | 30 of 33 |

The mock misses true findings, including a real code defect: DEC-05 says gateway calls have a timeout, and
`src/payment/gateway-adapter.ts:10` calls `fetch` with none. It also misses DEC-11 having no test at all, and DEC-06,
DEC-03 and DEC-09 not saying what happens when their store or outside call fails. The stand-in's false findings:
two Complete fails the design already answers, the 100 in `round.ts` (a cents factor) taken as a limit, and a missed
link to `integration/eligibility.test.ts` (one vote; the production setting takes a majority of 3).

Caveats: one fixture, one stand-in run, one reviewer. The stand-in is an agent on a Claude model answering the
production prompts, not the production API call; treat these as a direction, not a rate.
