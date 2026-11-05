# ai-quality-gate

PR 时运行的仓库质量门禁：从需求和设计文档抽出规则，追溯到实现代码和测试，检查测试证据（是否断言了规则、是否覆盖边界值、测试层级是否合适、是否在 PR 上运行）以及 CI 卫生情况。**代码能定的不交给模型；能阻断合并的结论必须有确定性证据。**

- 报告：固定结构（[mock](./mock-report-summary%20(2).md)），每个数字都能从 ledger 复算
- Gate：只有执行（E）、代码（S）、模型提出且代码校验（V）的证据能阻断；纯模型判断（M）只作建议；只拦相对 baseline 新增、触及改动文件、未被 suppress 的 finding
- 稳定性：逐条目的内容寻址判定缓存，输入不变则判定不变
- Placement：只在代码里找到 seam 时才建议下沉到单元测试
- 可选执行证据：规则定向 mutant（极端 mutant / 限值 ±1 / 边界翻转）跑关联测试；有 diff 时只做被改动的规则
- diff 级影响分析：改了规则实现却没有达标测试守护、代码与文档数值不一致（双向），并给出要先跑的测试
- 追溯链变成显式标记：已校验的链接生成 `// covers REQ-07` 补丁，没有测试的规则生成待实现测试和边界值表
- 前移到写代码的时候：MCP server 和 Claude Code hook，让 coding agent 编辑文件时就知道要守住哪些规则（`agent/`）
- 成本：判定缓存、自适应投票、prompt caching、按阶段设票数、baseline 运行可走 Batch API（半价）

## 用法（GitHub Action）

```yaml
# .github/workflows/quality-gate.yml（完整示例见 examples/quality-gate.yml）
on: { pull_request: {}, push: { branches: [main] } }
permissions: { contents: read, pull-requests: write }
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: Mira190/ai-quality-gate@v0
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          enforce: 'false'   # 灰度：先只报告，再改成 'true'
```

配置写在 `.quality-gate.yml`（示例见 [examples/.quality-gate.yml](examples/.quality-gate.yml)），包括 fail_on、可阻断的证据级别、critical 词表、执行命令、带期限的 suppression。

对任意仓库生成报告（不做 gate）：`.github/workflows/repo-health.yml`（workflow_dispatch），或本地运行：

```bash
node scripts/repo-report.js --repo https://github.com/owner/name --out out
```

输出：`report.md`、`report-details.md`、`ledger.json`、`gate.json`、`results.sarif`、`comment.md`、`baseline.json`、`affected.json`、`construct.patch`、`construct.json`。

## 运维：让 gate 跟着数据变严或变松

```bash
# 每个检查项的处理率（需要完整 git 历史和 action 保存的历史目录）→ 建议的 gate.probation
node scripts/usefulness.js --history .quality-gate-state/history --repo .
```

```bash
# 用金标 ledger 校准投票阈值（Learn then Test）→ 建议的 gate.min_agreement
node scripts/calibrate.js gold/ledger.json run1/ledger.json run2/ledger.json --target 0.9 --delta 0.1
```

## 文档

- [docs/research-v2.md](docs/research-v2.md)：v0.2 调研与设计（精度、稳定性、Placement 的运行时极限，unknown unknowns）
- [docs/pipeline-design.md](docs/pipeline-design.md)：流水线各阶段与 v1 实测
- [docs/research.md](docs/research.md)：v1 相关研究

## 测试

```bash
npm test
```

golden test：fixture 仓库的报告与 mock 逐字相等（模型回复从 cassette 回放）。
