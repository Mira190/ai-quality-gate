# ai-quality-gate v1 pipeline 设计

目标只有一个：对任意目标 repo，产出与 [`mock-report-summary (2).md`](../mock-report-summary%20(2).md)（下称 mock）**同一结构**的报告。
验收标准就写在 mock 头部：`tests/report-golden.test.js` 构建 fixture repo `quote-service`，`scripts/repo-report.js` 对它的输出**逐字等于** mock。

研究基础：一个内部前身项目（报告模板、仓库审计设计、双向追溯研究、大厂评审实践几份调研文档）。下文简称"前身项目"。

---

## 0. 第一性原理：从输出倒推

报告是一张**有固定格子的表**。每个格子只能来自三种生产者之一，按可信度排序：

| 证据级 | 生产者 | 实测精度（前身项目自己的 eval） |
| --- | --- | --- |
| **E** 执行 | 跑测试 / 覆盖率 / mutation | 覆盖率缺口行级 ~100%（A3） |
| **S** 静态 | 确定性代码：解析 YAML、import 图、正则、词表 | tsDetect 类规则 96% P / 97% R |
| **M** 模型 | LLM 判断，带引用 | "missing test" 仅 0–24%（A3/E3: 18/76），两次运行 Jaccard 0.17（A1）；需求 smell 检测 Smella 59% P |

由此推出 5 条不可违反的架构约束：

1. **LLM 只填窄格子，不写报告。** 所有计数、分数、优先级、排序、Issue 编号、表格都由代码从一个 JSON ledger 渲染。LLM 输出只能是 schema 约束的单条判断（"这条需求是否 Testable，引用哪句"）。否则 "counts agree across sections" 无法保证，golden test 也不可能逐字相等。
2. **S 能做的绝不交给 M。** CI gate（第 5 节）、Not skipped、Runs on PR、Placement、Covers stated limits、critical 标签——全部确定性。
3. **每个 M 结论必须带 `path:line` 引用，代码校验引用存在于该 sha，不存在就丢弃**（前身项目已有同类校验可借鉴）。
4. **"不存在"类结论（No test / Suspected not built）必须由代码复核**：No test = 代码用规则的 ID、符号、关键词在全部测试里检索为空，并把检索词写进行内（mock I-10: "No test names `applyDiscount` or "concession""）。Suspected not built 永不陈述为事实，只给"今天应该失败的测试"（mock Top action 1）。
5. **优先级重排是规则，不是 LLM。** P0–P3 由 (critical?, level/fail 类型) 查表决定，见 §7。

---

## 1. mock 每个格子 → 生产者

| mock 中的值 | 生产者 | 依赖阶段 |
| --- | --- | --- |
| 标题 `owner/repo @ sha` | S | 1 获取 |
| Run line：读了哪些文档 + 条数、测试数/文件数、CI 文件数、Rules found（含"with an ID in the source"）、Tests read not run、Branch protection、**Not read**（超 60 KB 预算 / Jira / Confluence）、**Skipped**（superseded） | S | 2 文档召回、5 测试索引、6 CI 解析 |
| 记分板 5 行（分数 = ready ÷ 全部 ×100，颜色 🟢≥90 🟡70–89 🔴<70） | S（从 ledger 计算） | 全部 |
| "Critical rules with tests that meet the standard and run in PR CI: 1 of 15" | S | 4 标签 + 8 证据检查 |
| §1 需求健康：Fails on（Clear/One behaviour/Testable/Specific/Complete/Consistent/Feasible）、Status（Ready/Test now fix later/Blocked/Partly blocked）、引文、Rewrite（缺值用 `<N>` `<T>` 占位） | S 预筛 + M 判定 + S 校验 | 3 抽取、7a |
| §2 设计健康：Serves、Fails on（Traceable/Trade-off/Simple/Failure behaviour/Verifiable） | M + S | 3、7a |
| "Not critical (n)" 一行 | S（词表） | 4 |
| §3/§4 覆盖：Level（None/Blocked/Weak/Checked nightly/达标）、Fails on（No test、Not skipped、Calls the code、Asserts the rule、Covers stated limits、Runs on PR、Placement、Crosses the real boundary、Suspected not built） | 除 Asserts the rule / Suspected not built 外全部 S | 5、6、8 |
| §4 尾行：Counted as rules of their own / Restate a requirement / Not critical | M（adds behaviour vs restates，带引用） | 3 |
| §5 CI gate 7 项：Secret scan、Coverage、Dependency scan、Format、Lint、Type check、Unit and component tests | S | 6 |
| Issue number I-n、Priority P0–P3 | S | 9 重排 |
| Top actions ≤5，"What is at risk"、"Critical rules protected" | S 聚类排序 + M 文字（模板化） | 10 |
| 页脚 model + AI 用量 | S（累加 usage） | 全部 |

---

## 2. GitHub Actions 外形

```yaml
# .github/workflows/repo-health.yml
on:
  workflow_dispatch:
    inputs:
      repo_url:        { required: true }               # https://github.com/acme/quote-service
      ref:             { required: false }              # 默认分支 HEAD
      requirement_urls:{ required: false }              # 多行，每行一个 URL
      design_urls:     { required: false }
      test_doc_urls:   { required: false }
      include_paths:   { required: false }              # glob，强制纳入
      exclude_paths:   { required: false }
      model:           { required: false, default: '…' }
      read_budget_kb:  { required: false, default: '60' }
  workflow_call: { inputs: …同上…, outputs: { report_path, ledger_path, verdict } }  # golden pipeline 调用
permissions: { contents: read }
```

Jobs：

1. **resolve**：校验输入（URL 白名单：github.com blob/raw、https 文本/Markdown/PDF/HTML），解析 owner/repo/sha，选 token（公开 repo 用 `GITHUB_TOKEN`；私有 repo 用 GitHub App installation token 秘钥，只给 `contents:read`、可选 `administration:read` 读分支保护）。
2. **analyze**（主 job）：clone 到 `target/`（`--filter=blob:limit=…`，不执行目标仓任何代码、不 `npm install`），跑 §3 全流程，产出 `ledger.json` + `report.md`，写入 `$GITHUB_STEP_SUMMARY`，上传 artifact。
3. **execute**（v1 不做，mock 也写 "Tests: read, not run"）：将来在**无 secret** 的隔离 job 里跑目标测试 / mutation，升级 E 级证据。

安全：目标仓内容是不可信输入，可对 LLM 做 prompt injection。缓解：LLM 无工具权限、只返回 schema JSON、所有引用被代码复核、目标仓代码从不执行；带 LLM key 的 job 不 checkout 目标仓的 workflow 或脚本来运行。

技术栈：Node 20（借鉴前身项目的 JS 实现）、`yaml`、`web-tree-sitter`（多语言符号/import）、BM25、`ajv`（schema）、`turndown`/`@mozilla/readability`（HTML→MD）、`pdf-parse`。模型供应商做成适配层（mock 页脚是 `gpt-5.4` + AIU，像 GitHub Models/Copilot 计费——见 §13 待定）。

---

## 3. 流水线阶段

```
1 获取 → 2 文档召回 → 3 规则抽取 → 4 critical 标签
                         ↓
5 代码/测试索引 → 6 CI 解析 → 7 文档质量判定(§1/§2) → 8 追溯+证据检查(§3/§4)
                         ↓
       9 验证 + 重排 P0–P3 → 10 Top actions → 11 不变量校验 → 12 渲染
```

### 阶段 1：获取
- `git clone` 指定 sha；`git ls-files` 得清单；跳过 vendored（`.gitattributes linguist-vendored`、`node_modules`、`dist`、`vendor`、`third_party`、sample/fixture 树）。
- 外部 URL 文档：GitHub blob → raw；HTML → readability + markdown；PDF → 文本（保留页码作为 line 引用 `file.pdf:p3`）。外部文档同样分配 `path`（`url#Lnn`）供引用。
- Confluence/Jira：v1 只在 run line 里写 "Not read"，与 mock 一致；v2 走官方 API + token。

### 阶段 2：文档召回（需求/设计不在固定目录）

原则（前身项目的模板）：**按内容判定，路径名只加权。** 两阶段：高召回粗筛 → 精排分类。

**2a 候选生成（S，便宜，目标召回 ≥95%）**——对每个文本文件（.md .mdx .rst .adoc .txt .feature .org，OpenAPI/Proto 作为补充源，README 按 section 切）计算特征：
| 特征 | 来源 |
| --- | --- |
| 规范性句子密度：shall/must/should not/required to/必须/应当/不得（RFC 2119 大写加权） | 前身项目已有 |
| 显式 ID：`REQ-12`、`DEC-04`、`AC-3`、`FR-1.2`、`US-7` | 前身项目已有 |
| EARS 句型：When/While/If…then…the system shall | 新增 |
| Gherkin：Feature/Scenario/Given-When-Then | 前身项目已有 |
| ADR 结构：Status/Context/Decision/Consequences（Nygard、MADR）、`docs/adr/NNNN-*.md` | 新增 |
| 设计信号：timeout、retry、cache、idempotent、queue、"we chose/decided"、架构图块 | 新增 |
| 路径/文件名提示：specs/ requirements/ design/ adr/ rfcs/ prd srs `.kiro/specs` openspec | 前身项目已有 |
| 反向信号：templates/ prompts/ CHANGELOG、教程类 | `NON_SPEC_DIR` |

加权打分后取 top-K（K=40），**再加一路"ID 反查"召回**：代码和测试里出现的规则 ID（如测试名 `REQ-07`）若不在任何候选文档中，搜全仓找定义它的文件；找不到就在 run line 记一条 Not read 线索。这一路专治"文档放在奇怪位置"。

**2b 精排分类（M，便宜模型）**：对每个候选只发标题大纲 + 前 2 KB，返回 `{kind: requirements|design|both|test_plan|none, status: accepted|proposed|superseded|unknown, evidence_line}`。superseded 判定优先用 S（ADR `Status: Superseded by`、front-matter `status:`、"Deprecated" 横幅），M 只补漏。

**2c 预算**：单文档超 `read_budget_kb`（默认 60 KB）→ "Not read (84 KB, over the 60 KB read budget)"，并注明后果 "Rules that appear only in those sources are not counted"（mock 原句）。superseded → "Skipped"。用户显式给的 URL/`include_paths` 永远纳入。

**2d 用户输入优先级**：显式 URL > include_paths > 仓内召回。显式文档与仓内文档冲突时不由模型选边，作为 Consistent 失败报告（前身项目 chunking:134-138）。

Embedding 不进 v1：前身项目 结论是等真实样本证明词法检索输掉再加；加的话用 RRF 融合，不把 BM25 分与向量分相加。

**召回评测**：建 10–20 个真实开源 repo 的人工标注（文档实际位置），指标 recall@K、strict precision（前身项目 测过当前启发式 strict precision 只有 22%，所以 2b 的 LLM 精排是必要的）。

### 阶段 3：规则抽取

- **切块保上下文**（避开 前身项目 已知坑 F30–F32）：按标题树切块，每块携带 heading chain、表头与单位、Gherkin Background/Examples；不设最短长度丢弃（"AC-1: Reject zero." 也是规则）；阈值表整表保留。
- **有 ID 的条目直接成规则**；无 ID 的段落交 LLM 原子化，按出现顺序分配 `REQ-n`/`DEC-n`，记录 `has_source_id: false`（run line 的 "25 with an ID in the source"）。
- **原子规则记录**：`{id, kind: requirement|decision, text, path, line, subject, trigger, expected, limits:[{value, unit, line}], named_artifacts:[如 src/pricing/rates.json], fingerprint}`。
- **分类按内容不按位置**：一个文件可同时给出需求和设计决策。
- **设计决策额外字段**（M，带引用）：`serves: REQ-xx | reason`、`adds_behaviour: bool`（timeout、failure path、role check = true；只是复述需求 = false）。驱动 §4 尾行 "Counted as rules of their own / Restate a requirement" 和 §4 分母。

### 阶段 4：critical 标签（S）

直接用 前身项目 模板的五区词表，强词单独命中、弱词须同句有同区强词：

| 区 | 强词 | 弱词 |
| --- | --- | --- |
| money | price, pricing, premium, fee, charge, discount, refund, payment, excess, tax, currency, invoice | rate, cost, total, amount |
| access control | authenticate, authorization, role, permission, admin, session, login | token, user |
| customer data | personal data, customer record, retention, deletion, consent | store, keep, profile |
| outside calls | gateway, CRM, webhook, HTTP client, queue, external service | call, send, sync |
| secrets（仅 §5） | key, password, secret, credential | token |

- 输出命中词，渲染为 `(critical: money · "payment")`。
- 复述需求的决策继承需求标签（mock DEC-11 "critical: money, as REQ-08"）。
- LLM 只能**加**标签且须引用理由，标为 AI-tagged；永不删除。
- 词表可按 repo 配置扩展（中文词表一并提供）。

### 阶段 5：代码与测试索引（S）

- **测试发现**：按框架配置（vitest/jest `include`/`exclude`/`projects`、pytest `testpaths`、go `_test.go`、JUnit/Maven surefire）+ 命名约定。
- **测试用例**：tree-sitter 抽 describe/it/test 名、行号、skip/todo/only 标记（含 `.only`）、断言行。
- **测试层级**：unit/component/integration/e2e，按路径 + import（pg/mongoose/testcontainers → integration；playwright/cypress → e2e；supertest/app in memory → component）。**注意 mock I-18**：放在 `unit/` 但 import `pg` 的测试判为 integration——层级以 import 为准，路径为辅。
- **mock/fake 识别**：`vi.mock`/`jest.mock`/`unittest.mock.patch`、import `*Simulator`/`*Mock`（→ Calls the code 失败）；`msw`/`nock`/`wiremock`/本地 HTTP fake server（→ Crosses the real boundary 通过）。
- **import 图**：测试 → 被测模块（tree-sitter + 路径解析，含 tsconfig paths）。
- **覆盖率配置**：`coverage.exclude`、`thresholds`（`vitest.config.ts:22` excludes `src/pricing/**`）。

### 阶段 6：CI 解析（S，第 5 节 100% 确定性）

- 解析 `.github/workflows/*.yml`：每个 job 的触发器（`pull_request`/`push`/`schedule`/`workflow_dispatch`）、steps、`continue-on-error`、`if:`。
- **命令 → 测试集映射**：`run: npm run test:unit` → `package.json` scripts → `vitest --project unit` → config include/exclude → 具体测试文件集。这是 "Runs on PR" 和 "runs only in `nightly.yml:12`" 的来源，最难也最关键。复合 action / reusable workflow 展开一层；解析不了的命令标为 unknown 并在 run line 说明。
- **7 项检查判定**（工具识别表可扩展）：

| 检查 | 识别 | 失败形态 |
| --- | --- | --- |
| Secret scan | gitleaks、trufflehog、detect-secrets、ggshield | 无步骤 → P0 |
| Coverage | `--coverage`、codecov/coveralls action；读 config exclude/threshold | 逻辑目录被排除、仅全局阈值 → P2（每条独立 issue，如 I-29/I-30） |
| Dependency scan | npm/pnpm audit、osv-scanner、snyk、dependency-review-action、pip-audit、trivy | 缺失或 `continue-on-error: true` → P2 |
| Format | prettier --check、black --check、gofmt、ruff format --check | 缺失 → P3 |
| Lint | eslint、ruff、golangci-lint | P3 |
| Type check | tsc --noEmit、mypy、pyright | P3 |
| Unit and component tests | PR 触发的测试 job | 缺失 → 由 §3/§4 的 Runs on PR 体现 |

- 分支保护：有权限则 `GET /repos/{o}/{r}/branches/{b}/protection` 判 required checks，否则 "Branch protection: not readable"。

### 阶段 7：文档质量判定（§1 / §2）

**7a 先 S 后 M**：
- S 预筛（INCOSE GtWR v4 / ISO 29148 可机检部分）：模糊词表（reasonable、where possible、appropriate、fast、user-friendly、合理、尽量…）→ Specific/Testable 候选；数值缺单位；一句多个 shall / "and" 连接多行为 → One behaviour；EARS 句型不符 → Complete 候选。
- M 判定：每条规则一次调用，rubric 即模板 measure 表，输出 `{measure, pass, quote, line, why, rewrite, blocks_part}`。批量（一次 10–20 条）+ 每批带全部规则摘要，以便判 Consistent。
- **Consistent 走结构化比对**：从每条规则抽 `(subject, attribute, value)`，代码按 subject/attribute 分组找值冲突（REQ-08 20% vs DEC-11 25%），再交 M 确认。不靠 LLM 全文通读去"发现"冲突。
- **Rewrite 防编造**：代码检查 rewrite 中出现的每个数字都在源文档里出现过，否则必须替换为 `<N>`/`<T>` 占位并附 "The documents give no values, so the owner fills the placeholders"。
- **Status**：任一 blocking measure 失败 → Blocked；仅某部分失败 → Partly blocked（注明 "the stacking case only"）；非 blocking 失败 → Test now, fix later；全过 → Ready。
- **Ready 计分**：§1 分数 = Ready 需求 ÷ 全部需求。

**7b 一个根因一条修复**：DEC-11 与 REQ-08 同一冲突 → I-7 写 "Fixed by the same edit as REQ-08 (I-3)"，代码按冲突对去重并互相引用。

### 阶段 8：追溯与证据检查（§3 / §4）

**8a 规则 → 代码**：BM25（规则文本 + limits 值 + named_artifacts）→ tree-sitter 符号候选 top-5 → M 选定实现位置并引用行。值变化搜新旧两个值（前身项目 `valueDeltas`）。

**8b 规则 → 测试**，链接来源分三级并记录：
1. **tag**：测试名/注释含规则 ID（前身项目 现在会剥掉 `@REQ-xx`，需新建匹配器）；
2. **name**：测试 import 了 8a 的实现模块，或 describe 名含规则术语；
3. **AI link**：都没有时 M 提议，标 *AI link*，必须复核。

**8c 证据检查**——"第一个失败的检查决定 Level"：

| 检查 | 通过条件 | 生产者 |
| --- | --- | --- |
| No test | 存在任何链接测试；否则 Level = **None**，行内写检索词（先于 Agreed result：mock 中 REQ-08、DEC-13 在 §1/§2 是 Blocked，但 §3/§4 Level 为 None） | S |
| Agreed result | 规则在 §1/§2 非 Blocked；否则 Level = **Blocked** | S（读 7 的结果） |
| Not skipped | 匹配用例无 skip/todo/only | S |
| Calls the code | import 实现模块，且未被 mock/simulator 替换 | S |
| Asserts the rule | 有断言比较规则结果与期望值（非仅 toHaveBeenCalled/not.toThrow/snapshot） | S 候选 + M 判定，引用断言行 |
| Covers stated limits | 规则陈述或其引用的表/配置里的每个边界值（如 rates.json 的 3/7/12；$500/$5,000），测试中有"等于"和"越过"两例（ISO 29119-4 边界值） | S：M 只负责列出数值，代码在测试输入里找 |
| Crosses the real boundary | outside-call 决策：测试经真实 adapter 打到 fake server，而非 mock client | S |
| Placement | 纯计算/日期/计数规则只在 e2e/integration 层被测 → 应下沉为 unit，原测试保留一例；integration 依赖却放在 unit 目录（I-18） | S（层级 + 规则性质，规则性质由 7 阶段 M 标注 `logic_kind: calculation|date|count|io|ui`） |
| Runs on PR | 断言规则的测试被某个 PR 触发的 job 执行；否则 **Checked nightly** | S（阶段 6 映射） |
| Suspected not built | 实现代码不做文档说的事（无 timeout、未查 role） | M，引用代码行；只用于 critical 决策；必须附"今天应失败的测试" |

Level 取值与 mock 一致：None / Blocked / Weak / Checked nightly / 达标（PR 上满足以上全部）。§3 分数 = 达标需求 ÷ 全部需求；§4 分数 = 达标决策 ÷ adds_behaviour 决策。
一条规则多个失败 → 多个 issue 行（mock REQ-01 有 I-11 Covers stated limits + I-12 Placement）。

### 阶段 9：验证 + 重排（Find → Verify → Rank）

**9a 验证**（借 Anthropic Find→Verify→Rank、Google Tricorder <10% 有效误报）：
1. 引用校验：quote 必须在 sha 的 `path:line` 找到（模糊匹配窗口 ±3 行），否则丢弃并计入 dropped。
2. 否定结论复核：No test 重新全仓检索 ID+符号+术语；仍为空才保留。
3. **P0 级 M 结论做 fresh-context refute**：另起一次调用，只给证据，让模型尝试反驳；反驳成功即降级或丢弃。
4. 关键 M 判断 self-consistency：critical 规则的 measure 判断跑 3 次取多数，压 Jaccard 0.17 的抖动。
5. 被读者标记 wrong 的 finding 按 fingerprint 下次隐藏。

**9b 优先级表（确定性）**——从 mock 反推，与之完全吻合：

| P | 条件 | mock 中的例子 |
| --- | --- | --- |
| **P0** | critical 规则 ∧ (Level None ∨ Suspected not built)；或 Secret scan 缺失 | I-9 I-10 I-19–I-23、I-28 |
| **P1** | critical 规则 ∧ (Weak ∨ Blocked ∨ Checked nightly ∨ Placement)；或 critical 规则上的 blocking/partly blocking 文档问题（§1/§2） | I-1–I-8、I-11–I-18、I-24–I-27 |
| **P2** | 度量缺口（coverage 排除、仅全局阈值）、dependency scan 缺失/不阻断；非 critical 规则的上述问题 | I-29–I-31 |
| **P3** | format/lint/type check 缺失；不阻断任何测试的措辞问题 | I-32 |

**9c 过滤与排序**：
- §1–§4 只渲染 P0/P1；非 critical 规则合并成一行 "Not critical (n): …"。§5 是固定清单，渲染所有失败检查（含 P2/P3）+ 已通过项（✅ 行）。
- 表内排序：P0 在前，P 内按规则 ID 自然序，再按检查顺序（§8c 表的顺序）。
- Issue 编号 I-n 在渲染顺序上全局连续（§1 → §5）。

### 阶段 10：Top actions（S 聚类排序 + 模板化文字）

- **聚类**：按"同一个修复动作"把 issue 合并（同一个测试文件、同一处文档编辑、同一 CI 步骤）。例：I-20/I-26/I-27 都由"CRM component test with fake CRM server"解决。
- **排序规则**（与 mock 一致）：(1) 确认 suspected defects；(2) 解锁其他工作的文档修复；(3) critical CI 缺口；(4) 写 critical 测试，按受保护 critical 规则数降序；(5) 被 (2) 解锁的测试。一个动作永不排在它依赖的动作前；最多 5 行。
- **Credit**：每条规则只记给写它测试的那个动作；有依赖时写 "REQ-11 once action 2 is done"。
- **文字**：由各 issue 的 `fix` 字段（M 生成、已校验）按模板拼接；"What is at risk" 用 `规则ID: 一句后果 (path:line)`。这样 golden test 可复现。

### 阶段 11：不变量校验（发布前必须全过，否则 job 失败）
- 记分板 X/N 与各节表格、尾行计数一致；Critical rules 分母 = critical 需求数 + critical 且 adds_behaviour 决策数（mock: 9 + 6 = 15）。
- Rules found = 需求数 + 决策数（12 + 13 = 25）。
- Top actions 引用的 issue/规则都存在；"8 issues, 6 on 5 requirements and 2 on 2 design decisions" 这类句内计数由代码生成。
- 每个 P0/P1 行都有可校验引用。

### 阶段 12：渲染与输出
- `ledger.json`（完整，含被过滤的 P2/P3 和 dropped）→ `report.md`（mock 结构）。
- 输出：`$GITHUB_STEP_SUMMARY`、artifact（report.md、ledger.json、可选 SARIF 供 code scanning）、`workflow_call` outputs 给 golden pipeline 下游。
- 页脚：`**AI used:** model <m> · <usage>`，usage 由适配层累加。

---

## 4. 测试与评测

| 层 | 内容 | 通过标准 |
| --- | --- | --- |
| 单元 | 每个 S 模块（CI 解析、命令映射、层级、边界值、词表、打分、优先级表） | 常规 |
| **golden** | `fixtures/quote-service`：手工构造一个包含 mock 里全部 32 个问题的仓；LLM 响应用 cassette 录制回放 | `report.md` 逐字等于 mock |
| 渲染 golden | 手写 ledger.json → 渲染 | 逐字等于 mock（先于 pipeline 完成，锁定渲染器） |
| live eval | 同一 fixture 用真实模型跑 | 每类 finding 的 precision/recall（fixture 植入的问题就是标签） |
| 稳定性 | 同 sha 跑 3 次 | 每类 finding Jaccard；低于阈值的类别降级为不显示 |
| 真实 repo | 5–10 个开源仓 + 人工标注样本 | 每类 finding 有效误报 <10% 才默认显示（Tricorder 标准） |

---

## 5. 里程碑

| M | 交付 | 完成判据 |
| --- | --- | --- |
| M0 | 仓骨架、`workflow_dispatch` + `workflow_call`、ledger schema、渲染器 | 渲染 golden 通过 |
| M1 | 获取 + CI 解析 + 测试索引 + critical 标签（全 S） | §5 对 fixture 与 mock 一致；run line 测试/CI 计数一致 |
| M2 | 文档召回 + 规则抽取 + §1/§2 判定 | §1/§2 与 mock 一致（cassette）；召回 eval 基线 |
| M3 | 追溯 + §3/§4 证据检查 | §3/§4 与 mock 一致 |
| M4 | 验证 + 重排 + Top actions + 不变量 | 端到端 golden 通过 |
| M5 | live eval + 真实 repo 试跑 | 每类 finding 精度报表；不达标类别默认隐藏 |

前身项目可借鉴的部分：文档发现与条目解析、BM25 索引、测试分层与跳过/断言识别、引用校验、测试映射、import 解析、多格式覆盖率解析（v2 E 级证据用）。需新建：CI 解析与命令→测试集映射、tag 匹配器、mock/fake 识别、Placement、Crosses the real boundary、优先级表、Top actions 聚类、不变量校验、外部 URL 获取。

---

## 6. mock 本身需要先定的问题（已定，见 §7）

1. **被过滤的行让分数不可核对。** §1 分数 42 = 5/12，即 7 条不 Ready，但表里只有 5 条需求（REQ-05/08/10/11/12）；另外 2 条是非 critical 的 P2/P3，没有显示。§2 同理：38 = 5/13，8 条不 Ready，表里只显示 2 条。建议在 "Not critical" 行补上计数，例如 "Not critical (3): REQ-03, REQ-07, REQ-09 · 2 have P2/P3 issues, listed in ledger.json"。否则读者无法核对分数。
2. mock 头部链接的 `./report-summary-template.md` 在本仓不存在。前身项目 的模板是 8 项 CI + Fix first/next/Later 分层，而本 mock 是 7 项 CI + P0–P3 + Placement 检查。需要把模板同步成本 mock 的规则，或者删掉这个链接。
3. LLM 供应商与计费单位：页脚写的是 `gpt-5.4` 和 AIU，看起来是 GitHub Models/Copilot 计费。需要确定供应商，以及 AIU 怎么换算（token 还是 premium request）。
4. 私有目标仓的访问方式：GitHub App 还是 PAT，以及是否申请 `administration:read` 来读分支保护。

---

## 7. v1 实现状态与决定（2026-10-28）

模板：[`report-summary-template.md`](../report-summary-template.md)（从 mock 倒推，golden test 证明它能逐字复现 mock）。
workflow：[`.github/workflows/repo-health.yml`](../.github/workflows/repo-health.yml)（`workflow_dispatch` + `workflow_call`，actionlint 通过）。

**§6 的决定**

1. 分数可核对：被过滤的 P2/P3 行全部写进 `report-details.md`（与 report.md 同一 artifact），mock 本身不改。
2. 模板已按本 mock 重写（7 项 CI、P0–P3、Placement）。
3. 模型 `claude-haiku-5-5`（Anthropic SDK，structured outputs `output_config.format`，effort low）。AIU = 按 API 标价折算的美元 × 100（`AIU_PER_USD` 可改）。每次运行有 `max_usd` 上限（默认 $2）。
4. 私有仓用 PAT（secret `TARGET_REPO_PAT`，fine-grained：Contents read，读分支保护需要 Administration read）。token 只通过 git `http.extraheader` 传入，不进 URL，也不进日志。

**分数定义（为什么这样最合理）**

- S1/S2 = Ready ÷ 已判定规则数。Ready 要求所有 measure 都通过，不只是 blocking 的那几项。mock 的 38 = 5/13 只有在这个定义下才算得出来：8 条不 Ready，但只有 2 条 blocking 行显示。分数的含义是 "clear enough to test"，措辞问题也应该扣分。
- S3/S4 = 达标 ÷ 已追溯规则数。达标指所有检查都通过，并且有测试在 PR 上运行。
- S5 = 通过的检查 ÷ 7。
- 五个分数都是不加权的比值，读者可以从行里复算。加权会让分数无法核对，而且权重本身没有依据。
- 模型没回复的规则（未判定 / 未追溯）不进分母，也不生成 "No test" 行，在 run line 里写明数量。否则，离线或预算用尽时会出现 "100 分" 或满屏假 P0。

**真实仓的鲁棒性**（在 Fission-AI/OpenSpec 上验证）

- 代码直接解析无 ID 的规格格式：OpenSpec/Kiro `### Requirement:`、ADR 的 Decision 段、Gherkin Scenario。按文档顺序分配 `REQ-n`/`DEC-n`。只有完全没有结构的文档才交给模型原子化。
- 跳过 `archive/`、`deprecated/` 目录（Skipped: archived）。`changes/`、`proposals/`、`drafts/`、`work/` 是在途提案，排名降低。`fixtures/`、`.agents/`、`SKILL.md`、`AGENTS.md` 不算规格文档。
- 文档预算：最多 60 份 / 800 KB，按分数取前面的，其余写进 Not read。超过 5 条的 Read / Not read / Skipped 列表按目录聚合，仍超过 8 组时上提一级。
- OpenSpec 离线结果：读 60 份文档，得 299 条规则，4028 个测试（229 个文件），4 个 workflow。CI gate 57 分，P0 是缺 secret scan。

**运行模式**：`live` / `record`（录制 cassette）/ `replay`（golden test 用）/ `offline`（不调模型，只出代码能确定的部分，依赖模型的分区显示 n/a）。 `fill`：cassette 里有的调用照常回放，没有的把 prompt 写到 `<cassette>.pending.json`，由人工（或另一个模型）逐轮回答再并入 cassette。没有可用 key 时，可以用这种方式把真实仓库的全流程跑通。2026-10-28 用这个方式在 OpenSpec（3 份文档，18 条规则，7 次调用）上跑通：0 条回答被引用校验丢弃。过程中发现并修复了三个问题：多行 ESM import 解析不到；启动 CLI 进程的测试被判成 unit，导致 "Calls the code" 误报，S3 因此从 61 被压到 33；OpenSpec 的 Scenario 没有进入 judge 的 prompt。

**验证**：`npm test` 共 13 项，包括 golden（fixture → 与 mock 逐字相等）和 12 个确定性模块单测（glob、规则解析、critical 标签、status、优先级重排、文档召回与预算、CI 7 项、run line 聚合、计价）。

**计划中但 v1 未做**

- tree-sitter：import 和符号目前用正则解析，只覆盖 JS/TS，Python/Go 只到测试发现和 CI 层。
- critical 判断的 3 次 self-consistency 和 P0 的 fresh-context refute（等 live eval 数据出来再决定是否值得这份成本）。
- PDF 外部文档、Embedding、执行级（E）证据。
- live eval：精度报表要等有效 key（见下一条）。

**真实运行**：已用 `claude-haiku-5-5` 对 fixture 跑通 live eval（见下）。下一步是对真实仓试跑。

**live eval（claude-haiku-5-5，2026-10-28）**：用 fixture 对照 golden 标准答案，`node scripts/eval-fixture.js <gold ledger> <run ledger>...`。每次运行约 2 AIU（$0.02），耗时约 2 分钟。

| 轮次 | 改动 | recall | precision | 假 P0 | 第 3 节 P / R |
| --- | --- | :-: | :-: | :-: | :-: |
| 1 | 基线 | 0.66 | 0.50 | 10 | 0.60 / 0.60 |
| 2 | built schema 改为先 why 后 verdict；trace prompt 把"关联"与"评质量"分开 | 0.59 | 0.53 | 7 | 0.55 / 0.60 |
| 3 | 候选测试加入 import 了候选实现文件的测试，以及按用例名做 BM25 检索 | 0.69 | 0.63 | 2 | 0.89 / 0.80 |
| 4–5 | built 检查附上实现符号的调用点 | 0.66–0.72 | 0.57–0.58 | 2 | 1.00 / 0.80 |

- 两次同配置运行之间的 Jaccard 为 0.73（前身项目 基线 0.17）。第 5 节 7 项检查每轮都完全一致。
- 剩下的 2 个"假 P0"：DEC-05 haiku 是对的（`gateway-adapter.ts:10` 的 fetch 确实没设超时），是标准答案写得含糊；DEC-11 haiku 判为新增行为，标准答案判为复述需求，属于判断尺度不同。
- 剩余差距：第 1 节（文档判断比标准答案严或宽，recall 约 0.5）和第 4 节（关联偏宽，把 "No test" 降级为 "Asserts the rule"；以及新增行为还是复述需求的判断）。
- 试过一次"模型没给关联时，由代码按实现符号补关联"，后来撤掉了：它会把 DEC-06 这种"有测试调用了 `charge`，但测的不是幂等"的正确 No test 改错。
- 注意：fixture 和标准答案都是本项目自己写的，指标只能说明方向。真实精度要靠真实仓库的人工标注样本。
