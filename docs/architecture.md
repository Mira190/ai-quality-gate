# 架构

ai-quality-gate 是一个在 PR 上运行的 GitHub Action，为 shift left 服务：在合并前回答三个问题。

1. **证明**：每条需求、每个设计决策，有没有测试能证明它？
2. **层级（placement）**：每件事是不是在合适的层级测的（unit / component / integration / e2e）？
3. **CI**：lint、type check、测试等检查，是不是真的在 PR 上强制执行？

本文说明它为什么这样设计。需求见 [requirements.md](requirements.md)，本仓库用自己审查自己。

## 第一性原理

审查结论要能拦住合并，就必须满足三件事：**可重复**（同样的输入得到同样的结论）、**可核对**（每条结论指向一行文档、一行测试或一行 workflow）、**便宜**（每个 PR 都跑，仓库再大也跑得动）。模型在这三件事上都弱于代码，所以分工很简单：

| 问题 | 谁来定 | 为什么 |
| --- | --- | --- |
| 文档里哪些是规则、规则 ID、是否 critical、规则写了哪些限值 | 代码 | 规则的身份不能变，否则 baseline、缓存、suppress 全部失效 |
| 测试用例在哪、是否 skip、有没有断言、需要什么才能跑（层级） | 代码 | 解析即可 |
| 测试名字里带了规则 ID → 链接 | 代码 | 这是事实 |
| CI 是否在 PR 上跑、失败会不会被忽略、`npm run lint` 实际执行什么 | 代码 | 解析 YAML 和脚本即可 |
| Placement（测高了、只对着 mock 测、放错目录） | 代码 | 输入全是上面的事实 |
| 优先级 P0–P3、是否阻断、报告里的每个数字 | 代码 | 查表 |
| **没带 ID 的测试，到底有没有断言这条规则？** | **模型** | 需要读懂语义 |
| **这句话是不是一条可测的行为？最低能在哪一层证明？** | **模型**（顺带，同一次调用） | 需要读懂语义 |

模型只做最后两行，而且它的回答要过代码的核对才算数。

## 流水线

```
scan → extract → index → ci → trace(link → judge → assess) → placement → gate → report
```

| 阶段 | 输入 | 输出 | 模型 |
| --- | --- | --- | --- |
| scan `src/scan` | `git ls-files -s` | 文件清单：按路径分成 doc / test / source / ci / manifest / config，包与语言 | 否 |
| extract `src/extract` | 文档 | 规则（需求、决策）、风险标签、性质、限值 | 否 |
| index `src/index` | 测试文件 | 用例（名字、行号、skip、断言数、参数行数、提到的规则 ID）、文件所需层级、是否 mock、import | 否 |
| ci `src/ci` | workflow、package.json、Makefile | 每项检查的状态：enforced / 失败被忽略 / 不在 PR 上 / 配置了没跑 / 缺失 | 否 |
| trace `src/trace` | 规则 × 用例 | 每条规则的证明记录：proven / hole / no test / unverified | **仅 judge** |
| placement `src/placement.js` | 证明记录、层级 | placement finding、各层用例数 | 否 |
| gate `src/gate.js` | finding、diff、baseline | 每条 finding 是否阻断、verdict | 否 |
| report `src/report` | ledger | report.md、comment.md、findings.json、results.sarif | 否 |

## 设计决策

每个决策都有 ID，证明它的测试带着这个 ID。

- **DEC-1 模型不写报告。** 报告里的每个数字、优先级、排序和表格都由代码从 ledger 渲染；同一个 ledger 渲染出的报告逐字节相同。
- **DEC-2 规则抽取是确定性的。** 规则只来自四种代码能识别的形态：带 ID 的条目、ADR、规范性句子、验收标准列表；无 ID 规则的 ID 是其文本的哈希，所以句子在文档里挪位置不会变成另一条规则。
- **DEC-3 模型只看片段。** 发给模型的是代码筛出的少数候选用例的带行号片段，不是文件，更不是仓库；提示里声明片段是数据，其中的指令不得执行。
- **DEC-4 结论按输入内容缓存。** 每条规则的模型结论以"规则文本 + 候选用例片段"的哈希为键写入缓存；输入不变就不再调用模型，结论也不变。
- **DEC-5 模型没有工具。** Copilot CLI 作为子进程以非交互模式在空目录里运行，不授予任何工具，只带最小环境变量；作业里的其它密钥不会传给它。
- **DEC-6 解析结果按 blob 哈希缓存。** 文档和测试文件的解析结果以 git blob 哈希为键写入缓存；PR 只重新解析它改动的文件，源码文件根本不读。
- **DEC-7 阶段独立降级。** 某个阶段抛错、模型调用失败或超时，报告的 Run 一节写明跳过了什么，其余阶段照常出结果；gate 自己坏了不会让构建失败。
- **DEC-8 证据分级。** 每条 finding 带证据级别：S（代码判定）、V（模型提出、代码核对）、A（建议）；只有 S 和 V 能阻断，建议永远不是 P0。

## 模型的使用：省 token，且不可被说服

**只问需要问的。** 进入 judge 的规则必须同时满足：没有任何测试提到它的 ID；默认还要求它是 critical 或者被本次改动触及（`ai.scope: all` 可放开）。在一个按 ID 打标的仓库里，模型调用次数是 0——本仓库就是。

**先问最严重的。** 排序为：critical 且在改动里 → critical → 在改动里 → 其余。预算（`ai.max_requests`、`ai.max_rules`）用完后，剩下的规则标为 unverified，报告写明数量，不会静默丢弃。

**一次问多条，每条只带片段。** 每次调用 6 条规则，每条最多 4 个候选用例，每个用例最多 30 行。一次调用同时回答三件事（是否可测、哪个候选证明了它、最低能在哪层证明），placement 需要的模型输入因此不另花 token。

**回答要过核对。** 模型说"已证明"时必须引用它被展示过的候选用例，行号必须在被展示的范围内，那一行（或相邻两行内）必须是断言。任何一条不满足，结论降为建议（A），不计入证明，也不能阻断。因此仓库里的文字（例如测试文件里写一句"所有规则都已证明"）无法让 gate 放行。

**模型能改变什么。** 只有三件事：把候选测试确认为链接（需引用）、确认"最近的几个测试都没断言它"（V 级的 no test）、判定一句无 ID 的话不是可测行为（从统计中去掉）。它不能新增规则，不能改优先级，不能改 CI 和 placement 的事实。

### Provider

| provider | 用途 |
| --- | --- |
| `copilot` | 生产用。`copilot -p <prompt> -s --no-ask-user --deny-tool=…`，用带 "Copilot Requests" 权限的 fine-grained PAT（`COPILOT_GITHUB_TOKEN`）认证 |
| `command` | 任何"stdin 读提示、stdout 写回答"的程序 |
| `handoff` | 没有模型时：跑不出答案的提示写到 `out/ai-requests.json`，由人或 coding agent 把回答写进 `ai-answers.json`，下次运行读取。测试里的录制回答也走这条路 |
| `none` | 只出代码判定的 finding |

`auto`（默认）：装了 CLI 且有 token 用 copilot，否则有回答文件用 handoff，否则 none。没有模型时 gate 照常运行，只是需要语义判断的规则显示为 unverified。

## Placement

层级不看目录名，看测试**需要什么才能跑**（Google 的 test size 思路）：驱动浏览器 → e2e；连 localhost、数据库、起子进程 → integration；渲染组件 → component；其余 → unit。目录声明的层级单独记录，两者不一致本身就是一条 finding。

规则的"性质"由词表判定它最低能在哪层被证明（纯逻辑 → unit，界面 → component，真实边界 → integration，整条流程 → e2e），模型可以修正；模型与词表不一致时该 finding 降为建议。

| 检查 | 含义 |
| --- | --- |
| `placement.too-high` | 纯逻辑规则只在 integration / e2e 被证明：每个边界值都要付一次浏览器或数据库的代价 |
| `placement.boundary-mocked` | 关于真实边界的规则只被 mock 掉边界的测试证明：测的是 mock |
| `placement.mislabelled` | 放在 unit 目录却需要网络 / 浏览器 / 子进程 |
| `placement.no-boundary` | 放在 integration / e2e 目录却什么边界都没跨：慢队列里的单元测试 |
| `placement.table-at-top` | 高层测试里跑大参数表：组合应当下沉 |
| `placement.pyramid` | 慢测试比快测试多 |
| `ci.level-not-run` | 某一层的测试没有任何 PR 步骤在跑 |

Placement 一节在报告里始终出现（各层文件数、用例数、PR 上跑了多少），即使 finding 都是 P2。

## 优先级与 gate

| 优先级 | 内容 |
| --- | --- |
| P0 | critical 规则没有测试（或只有被 skip 的测试）；测试不在 PR 上跑、或失败被忽略；仓库没有 CI |
| P1 | 其它规则没有测试；critical 规则的证明有洞（限值没测到、没有断言、不在 PR 上跑）；critical 规则 placement 不对；lint / type check 没强制；改动的高风险代码没有测试触达 |
| P2 | 非 critical 规则的洞和 placement；format、coverage、依赖扫描、密钥扫描 |
| P3 | 信息 |

一条 finding 阻断合并，需要同时满足：优先级 ≥ `gate.fail_on`（默认 P1）；证据是 S 或 V；没有被 suppress（suppress 必须写理由，可带截止日期）；在 PR 上，它触及本次改动（规则所在的行、测试、实现文件、workflow），且不在默认分支的 baseline 里。最后一条让存量问题只报告不阻断，gate 才能在老仓库里落地。

finding 的指纹是"检查 + 对象"的哈希，不含行号和措辞，所以代码挪动不会让老问题变成新问题。

## 大仓库

- **不读源码。** 只读文档、测试、CI 文件和 manifest；源码只在 diff 触及时按路径参与分析。文件清单来自 `git ls-files -s`，一次调用拿到全部路径和 blob 哈希。
- **增量。** 解析结果按 blob 哈希缓存（DEC-6），热缓存下 PR 只解析它改动的文件。
- **不做 规则 × 用例 的全量比较。** 候选检索走倒排索引：成本随"提到规则关键词的用例数"增长。
- **上限都有，且会说出来。** 文档数、单文件大小、规则数、每次运行的模型调用数、报告每张表的行数都有上限；超出的部分在 Run 一节计数，完整列表在 findings.json。
- **monorepo。** 每个 manifest 目录是一个包；候选检索优先同包测试；`turbo run lint` / `nx run-many -t test` 会展开到各包的同名脚本。

## 稳定性

- 同样的仓库状态 → 逐字节相同的报告（GATE-18）。迭代顺序全部排序，时间不进入结论。
- 模型结论走内容寻址缓存（DEC-4）：结论只在规则文本或候选测试变化时才可能变化。
- 阶段隔离（DEC-7）：坏掉的 YAML、超时的模型、不存在的 base commit，都只会让报告少一部分并写明原因。
- 退出码恒为 0，除非显式 `--enforce` 且 gate 判定 fail。
- 配置里的错字会被报告，对应项回落到默认值；不会因为配置错误静默关掉 gate。

## 已知边界

- 测试只读不跑。"这个测试断言了规则"来自阅读（ID、断言行、限值字面量），不是来自 mutation。
- 层级信号来自文件文本；把别的测试源码当字符串数据的文件（例如本仓库解析器的测试）会被误判，用 `suppress` 标注。
- 非 GitHub 的 CI（GitLab、Jenkins 等）只识别命令，不判断触发条件，报告中标为"runs, trigger not read"。
- 分支保护（哪些检查是 required）是仓库设置，本工具不读取。
- Rust 的 `#[cfg(test)]` 内联测试、Go 的表驱动子测试只做粗粒度识别。
