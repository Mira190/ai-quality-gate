# 别人怎么做代码/仓库审查，我们借了什么

调研时间：2026-11。多数细节来自二手报道，标了"二手"的未能在官方页面核实。目的只有一个：找出**便宜且真正提高精度**的做法，其余不要。

## 各家做法

| 谁 | 做法 | 花在哪 | 来源 |
| --- | --- | --- | --- |
| Anthropic · Claude Code Review | 多个 agent 并行各查一类问题 → 验证层给每条 finding 打 0–100 置信分 → 只发 ≥80 的。报道称单次 15–25 美元、被标为错误的不到 1%（二手，厂商数据） | 多 agent + 再跑一遍验证 | [1][2] |
| OpenAI · Codex review | 默认只标 P0 / P1；仓库在 `AGENTS.md` 的 review 规则里写自己的不变量（二手） | 一次 agent 审查 | [3][4] |
| OpenAI · Aardvark（现 Codex Security） | 先对全仓建威胁模型 → 扫提交 → 在沙箱里**验证可利用**后才报 → 附补丁 | agent + 执行 | [5] |
| Google · Tricorder | 分析器的结果在 code review 里出现，每条有"not useful"按钮；被点太多的分析器下线整改。原则：误报率必须低到开发者信任 | 无模型 | [6][7] |
| Google · mutation testing | 在 code review 时展示 mutant；跳过"arid"代码（日志等不值得测的行）；限制每行、每次 review 的 mutant 数；按历史反馈筛选 | 跑测试 | [8][9] |
| Google · AutoCommenter | 用真实 review 数据训练的模型提示最佳实践违规，在 IDE 和 review 里给出 | 专用模型 | [10] |
| Uber · uReview | 生成评论 → 第二个 prompt 打置信分（阈值按类别细调）→ 语义去重 → 按历史价值压掉低价值类别。报告 75% 评论被标为有用 | 生成 + 评分两次调用 | [11] |
| Cursor · Bugbot | 早期：8 路并行、diff 顺序随机、多数票过滤；后来改为 agent 式 | 8 倍调用 | [12] |

## 共同规律

1. **精度靠第二道关，不靠第一道写得好。** Anthropic 的验证层、Uber 的 grader、Cursor 的多数票，都是"先多报，再过滤"。区别只在过滤花多少钱。
2. **能执行就执行。** Aardvark 的沙箱验证、Google 的 mutation，都是用"跑一下"代替"判断一下"。执行结果没有人能争辩。
3. **只说重要的。** Codex 默认只标 P0 / P1。
4. **让使用者的反应决定什么继续报。** Tricorder 的 not-useful、Uber 的按类别压制。
5. **一个问题只说一次。** Uber 的语义去重。

## 我们借了什么，没借什么

| 做法 | 我们的版本 | 成本 |
| --- | --- | --- |
| 第二道关（1） | 模型说"已证明"→ **代码**核对引用的那行是不是断言（不花 token）。模型说"没有证明"且词法检索不同意 → 换问法、候选倒序再读一遍，两次一致才算。借的是 Cursor 的"顺序随机 + 一致才算"，但只用在无法用代码核对的那一类结论上 | 多数情况 0 次，少数 1 次额外调用 |
| 执行（2） | **GATE-26**：规则写了限值且有链接测试时，把代码里的限值挪一步，只跑链接的测试。测试没失败 = 一条带执行证据的 P0。借 Google 的三条纪律：每条规则一个 mutant、跳过 arid 行（日志、字符串、注释、import）、结果缓存 | CPU，0 token；默认关，需给测试命令 |
| 只说重要的（3） | 只有 P0 / P1 阻断，P2 / P3 折叠；建议永远不是 P0 | 0 |
| 使用者反应（4） | **GATE-27**：每个检查项统计"被修掉"与"被 suppress"的次数（默认分支运行之间）。被 suppress 的比例超过阈值，该检查项进入试用期，只报告不阻断 | 0 |
| 一个问题只说一次（5） | 同一根因合并（测试检查没强制、某一层没人跑）；同一文档里同类缺口的规则在表里合成一行 | 0 |
| 仓库自己的规则 | 需求和设计文档本身就是规则来源，`.quality-gate.yml` 调词表和阈值 | 0 |

**没借的，和原因：**

- **多 agent 并行 / 8 路投票。** 花钱最多的部分。它们解决的是"在 diff 里找未知 bug"这个开放问题；我们的问题是封闭的（这条规则有没有被这个测试断言），能用代码核对，不需要靠人多。
- **置信分阈值。** 模型自报的置信分是又一个不稳定的模型输出。我们用可核对的事实代替：引用存在且是断言、两次读法一致、测试真的失败了。
- **训练专用模型（AutoCommenter）。** 需要海量内部 review 数据。
- **读 `AGENTS.md` / `CLAUDE.md` 当规则。** 里面多是流程指令，当成行为规则会带来误报。

## 和它们比

不是同一件事，不能直接比高下：上面的产品大多在 diff 里找 bug，我们查的是"规则有没有被测试证明、测在哪一层、CI 有没有强制"。能比的是成本结构：

- 它们每次审查是多次到几十次模型调用（Anthropic 的报道价 15–25 美元一次，二手）。
- 我们在 fixture 仓库上是 2 次调用、约 1k token；按规则 ID 打标的仓库是 0 次；执行证据不花 token。
- 它们的精度由厂商报告；我们的由仓库里的评分卡度量（27 个埋缺陷场景，precision / recall 都要求 1.00），任何人可以重跑。

评分卡只覆盖确定性部分和 fixture 仓库，不代表在任意真实仓库上的精度。那个数字要靠 GATE-27 的统计在真实使用中积累。

## 来源

1. [Claude Code Now Uses AI Agents to Review Pull Requests](https://interviewkickstart.com/blogs/articles/claude-code-now-uses-ai-agents-to-review-pull-requests-what-engineers-need-to-know)（二手）
2. [How Code Review Confidence Scoring Works in Claude Code](https://instagit.com/anthropics/claude-code/code-review-confidence-scoring-claude-code)（二手，讲开源 `/code-review` 插件）
3. [Custom code review rules for Codex](https://developers.openai.com/blog/custom-code-review-rules-for-codex)（OpenAI，仅见标题）
4. [Codex Code Review Rules: AGENTS.md Setup Guide](https://agentpedia.codes/blog/codex-code-review-agents-md-rules)（二手）
5. [Introducing Aardvark](https://openai.com/index/introducing-aardvark)（OpenAI）
6. [Tricorder: Building a program analysis ecosystem](https://alastairreid.github.io/RelatedWork/papers/sadowski:icse:2015)（论文摘要页）
7. [Software Engineering at Google, ch. 20: Static Analysis](https://abseil.io/resources/swe-book/html/ch20.html)
8. [State of Mutation Testing at Google](https://research.google/pubs/state-of-mutation-testing-at-google/)
9. [Practical Mutation Testing at Scale: A view from Google](https://research.google/pubs/practical-mutation-testing-at-scale-a-view-from-google/)
10. [AI-Assisted Assessment of Coding Practices in Modern Code Review](https://arxiv.org/html/2405.13565v1)
11. [uReview](https://www.uber.com/blog/ureview/)（Uber）
12. [Building Bugbot](https://cursor.com/blog/building-bugbot)（Cursor）
