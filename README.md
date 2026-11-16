# ai-quality-gate

一个对**整个仓库**做 full review 的 GitHub Action，为 shift left 服务：每个 PR 上跑一遍（也可定时或手动），在合并前回答三个问题：

1. **证明**：每条需求、每个设计决策，有没有测试能证明它？
2. **层级（placement）**：每件事是不是在合适的层级测的（unit / component / integration / e2e）？
3. **CI**：测试、lint、type check 等检查，是不是真的在 PR 上强制执行？

**确定的问题交给代码，不确定的才交给模型。** 规则抽取、测试索引、层级判定、CI 解析、placement、优先级、是否阻断，全部是确定性规则。模型（GitHub Copilot CLI）只回答一件事：代码没能链接上的规则，这几个候选测试到底有没有断言它——而且它的回答要过代码核对才算数。按规则 ID 给测试打标的仓库，模型调用次数是 0。

- 报告示例：[examples/report.md](examples/report.md)（PR 评论：[examples/comment.md](examples/comment.md)，修复清单：[examples/fix-brief.md](examples/fix-brief.md)）
- 设计与取舍：[docs/architecture.md](docs/architecture.md)
- 本工具自己的需求：[docs/requirements.md](docs/requirements.md)（CI 里用它审查本仓库）

## 用法

```yaml
# .github/workflows/quality-gate.yml（完整示例：examples/quality-gate.yml）
on:
  pull_request:
  push: { branches: [main] }
  schedule: [{ cron: '17 4 * * 1' }]
  workflow_dispatch:
permissions: { contents: read, pull-requests: write }
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: Mira190/ai-quality-gate@v1
        with:
          copilot-token: ${{ secrets.COPILOT_PAT }}   # 可选
          new-only: 'true'                            # 棘轮：全部报告，只有 baseline 里没有的才阻断
          enforce: 'false'                            # 先只报告，几周后改成 'true'
```

`COPILOT_PAT` 是带 **Copilot Requests** 权限的 fine-grained personal access token（classic PAT 不行）。不配这个 secret 也能跑：只出代码判定的 finding，需要语义判断的规则标为 unverified。

| input | 默认 | 说明 |
| --- | --- | --- |
| `copilot-token` | 空 | 上述 PAT；空则不用模型 |
| `model` | 空 | 传给 Copilot CLI 的 `--model`；空用 CLI 默认 |
| `provider` | `auto` | `auto` / `copilot` / `command` / `handoff` / `none` |
| `new-only` | `false` | 棘轮：默认分支的运行写 baseline，只有 baseline 里没有的 finding 才阻断；审查范围不变 |
| `enforce` | `true` | gate fail 时让步骤失败；`false` 只报告 |
| `fail-on` | 配置值（P1） | 阻断的最低优先级 |
| `comment` | `true` | 在 PR 上发一条（并持续更新）评论 |
| `sarif` | `false` | 上传到 code scanning |
| `config` | `.quality-gate.yml` | 配置文件路径，全部键见 [examples/.quality-gate.yml](examples/.quality-gate.yml) |

outputs：`verdict`、`blocking`、`p0`、`p1`、`report`。产物（artifact）里有 `report.md`、`comment.md`、`fix-brief.md`、`findings.json`、`results.sarif`。

## 报告里有什么

- **结论**：pass / fail，几条 finding 阻断本次改动。
- **Fix first**：P0 和 P1，每条带证据位置（`path:line`）、证据级别和修法（含应测的边界值，如 `$499, $500 and $501`）。
- **1. Proof**：每份文档里多少规则被证明、有洞、没有测试、未核实；全部规则的明细表。
- **2. Placement**：各层的文件数、用例数、PR 上跑了多少；placement finding。这一节始终出现。
- **3. CI**：每项检查的状态（enforced / 失败被忽略 / 不在 PR 上跑 / 配置了没跑 / 缺失）和所在的 workflow 行。
- **Run**：读了什么、没读什么、模型调用了几次（几次来自缓存或锁文件、发了多少 token）、哪个阶段降级了。
- **fix-brief.md**：阻断项逐条变成任务，直接交给 coding agent 或人：证据、要做什么、测试放哪、测试骨架（名字带规则 ID，用例是规则写明的边界值）、怎样算完成。

| 优先级 | 例子 |
| --- | --- |
| P0 | critical 规则没有测试，或只有被 skip 的测试；测试不在 PR 上跑；仓库没有 CI |
| P1 | 其它规则没有测试；critical 规则的限值没被测到；critical 规则只在 e2e 被证明，或只对着 mock 被证明；lint / type check 没强制 |
| P2 | 测试放错目录、高层测试里跑参数表、format / coverage / 依赖扫描缺失 |

证据级别：**code**（代码判定）、**model, verified**（模型提出、代码核对了引用）、**advice**（建议）。只有前两种能阻断。

**什么会阻断**：仓库里任何一条 P0 / P1，证据是 code 或 model-verified，且没有被 suppress。打开 `new-only` 后，只有默认分支 baseline 里没有的才阻断——存量问题照常报告，不会让每个 PR 都变红。

## 成本与稳定性

- 代码能判定的不问模型。fixture 仓库（13 条规则）整个流程是 2 次调用、约 1k token；本仓库（32 条规则，全部按 ID 打标）是 0 次。
- 每条模型结论按内容缓存，规则和候选测试不变就不再问；`aqg run --write-lock` 还可以把结论提交进仓库（`.quality-gate.lock.json`），换机器、清缓存、没有模型时结论照旧。
- 模型说"已证明"必须引用一行断言并通过代码核对；说"没有证明"且词法检索不同意时要换问法再读一遍，两次一致才可阻断。
- 模型调用有预算、截止时间和熔断；预算没覆盖到的规则下次运行接着判。
- 27 个埋缺陷场景组成的评分卡（precision / recall / 两次运行一致）在 CI 里必须全满，见 [docs/architecture.md](docs/architecture.md#评分卡gate-23)。

## 让链接变成事实

在测试标题或注释里写上规则 ID，链接就由代码判定，不再需要模型：

```ts
it('REQ-8 caps the discount at 20%', () => { /* … */ });

// covers: REQ-12
it('refunds pro rata', () => { /* … */ });
```

规则来自仓库里的文档：带 ID 的条目（`REQ-12`、`DEC-4`、`AC-3` 等，前缀可配）、ADR（`docs/adr/0007-*.md`，一份一个决策）、需求和设计文档里的规范性句子（must / shall / should / 必须 / 不得）。

## 没有 Copilot CLI 的时候

`handoff` provider 把模型该回答的提示写到 `out/ai-requests.json`；由人或 coding agent 把回答按 id 写进 `out/ai-answers.json`，再跑一次即可。回答的形状就是提示里要求的 JSON。测试里的录制回答（`tests/fixtures/shop.answers.json`）走的是同一条路，所以整条流水线在没有任何模型的环境里也是可测、可重复的。

```bash
node bin/aqg.js run --repo /path/to/repo --provider handoff --out out
```

```bash
node bin/aqg.js run --repo /path/to/repo --provider handoff --out out --answers out/ai-answers.json
```

## 本地使用（合并之前，甚至提交之前）

```bash
# 全仓审查；不用模型，一两秒
node bin/aqg.js run --repo . --provider none
```

```bash
# pre-push：全仓照常审查，另外指出本次改动里没有测试触达的源码；--new-only 让只有改动触及的才阻断
node bin/aqg.js run --repo . --base origin/main --new-only --provider none --enforce
```

```bash
# 动手改一个文件之前：它实现或测试了哪些规则，证明到什么程度（给人看，或用 --json 给 coding agent）
node bin/aqg.js rules --repo . --file src/pricing/discount.ts
```

pre-push hook 示例：[examples/pre-push](examples/pre-push)。

## 开发

```bash
npm ci
```

```bash
npm run lint
```

```bash
npm run typecheck
```

```bash
npm test
```

测试分三层：`tests/unit`（纯函数）、`tests/integration`（整条流水线跑在磁盘上的 fixture 仓库上；Copilot provider 对着一个假的 `copilot` 可执行文件；评分卡）、`tests/e2e`（从外部调用命令行）。改了提示词或 fixture 之后用 `node tests/fixtures/record.js` 重录替身模型的回答。每个测试标题里的 `GATE-n` / `DEC-n` 对应 docs 里的需求和设计决策。

`docs/research*.md` 是早期版本的调研笔记，保留作背景。
