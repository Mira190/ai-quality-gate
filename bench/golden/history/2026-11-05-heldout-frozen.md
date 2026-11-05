<!-- First run of the held-out split, with src/ci.js frozen before any held-out failure was looked at. -->
# Golden set scorecard

Run 2026-11-05 · mode offline

## Real-repository CI track (12 repositories, labelled by hand at pinned commits)

**Agreement with the hand labels: 69 of 82 checks (84%)** · "Missing" issues that are real: 33 of 44 (precision 75%) · Real gaps reported: 33 of 35 (recall 94%)

| Check | Real gaps | Reported, real | False alarms | Missed | Precision | Recall | Wrong on |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | --- |
| secret | 12 | 12 | 0 | 0 | 100% | 100% | – |
| coverage | 2 | 2 | 3 | 0 | 40% | 100% | psf/black (false alarm), pytest-dev/pluggy (false alarm), urfave/cli (false alarm) |
| dependency | 11 | 11 | 1 | 0 | 92% | 100% | charmbracelet/bubbletea (false alarm) |
| format | 5 | 4 | 2 | 1 | 67% | 80% | pydantic/pydantic (false alarm), pytest-dev/pluggy (missed), charmbracelet/bubbletea (false alarm) |
| lint | 3 | 2 | 3 | 1 | 40% | 67% | typeorm/typeorm (false alarm), pydantic/pydantic (false alarm), pytest-dev/pluggy (missed), charmbracelet/bubbletea (false alarm) |
| typecheck | 2 | 2 | 0 | 0 | 100% | 100% | – (n/a for 2) |
| tests | 0 | 0 | 2 | 0 | 0% | – | sindresorhus/execa (false alarm), urfave/cli (false alarm) |

| Repository | Commit | secret | coverage | dependency | format | lint | typecheck | tests |
| --- | --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| tj/commander.js | `ba6d13d` | ✔ gap | ✔ gap | ✔ gap | ✔ | ✔ | ✔ | ✔ |
| chalk/chalk | `7211001` | ✔ gap | ✔ | ✔ gap | ✔ gap | ✔ | ✔ | ✔ |
| sindresorhus/execa | `247faa0` | ✔ gap | ✔ | ✔ gap | ✔ gap | ✔ | ✔ | ✘ FA |
| lukeed/kleur | `fa34544` | ✔ gap | ✔ | ✔ gap | ✔ gap | ✔ gap | ✔ gap | ✔ |
| nodejs/undici | `779ee3e` | – | – | – | – | – | – | – | error: Invalid regular expression: /^(?:.*/)?(?:*\.)?(?:spec|test)+\.[jt]s(?:x)?$/: Nothing to repeat
| typeorm/typeorm | `5bdc678` | ✔ gap | ✔ | ✔ gap | ✔ | ✘ FA | ✔ | ✔ |
| remix-run/react-router | `db80dda` | – | – | – | – | – | – | – | error: Invalid regular expression: /^(?:.*/)?(?:*\.)?(?:spec|test)+\.[jt]s(?:x)?$/: Nothing to repeat
| mswjs/msw | `28c74aa` | ✔ gap | ✔ gap | ✔ gap | ✔ gap | ✔ | ✔ | ✔ |
| pydantic/pydantic | `a175209` | ✔ gap | ✔ | ✔ gap | ✘ FA | ✘ FA | ✔ | ✔ |
| Textualize/rich | `9d8f9a3` | ✔ gap | ✔ | ✔ gap | ✔ | ✔ gap | ✔ | ✔ |
| psf/black | `b4f1fca` | ✔ gap | ✘ FA | ✔ gap | ✔ | ✔ | ✔ | ✔ |
| pytest-dev/pluggy | `30b8ae2` | ✔ gap | ✘ FA | ✔ gap | ✘ miss | ✘ miss | ✔ gap | ✔ |
| urfave/cli | `7dad5b6` | ✔ gap | ✘ FA | ✔ gap | ✔ | ✔ | n/a | ✘ FA |
| charmbracelet/bubbletea | `67b4c7a` | ✔ gap | ✔ | ✘ FA | ✘ FA | ✘ FA | n/a | ✔ |

✔ gap = both say missing · ✔ = both say set up · ✘ FA = the report says missing, the label says set up · ✘ miss = the label says missing, the report says set up

