# 相关研究与下一步方向（2026-10-29）

本文回答三个问题：检索要不要上 grep / RAG / 向量；有哪些前沿思路值得做；arXiv 上与本项目各阶段相关的工作。每条论文都核对过 arXiv 编号与标题；数字取自论文摘要，未逐篇读全文的已注明。

## 1. 结论先行

| 问题 | 结论 | 依据（本仓库实测） |
|---|---|---|
| 要用 grep 加速检索吗 | 不需要 | 19k 文件的 agenta：列文件 112 ms，文档召回 1.1 s；growi：BM25 建索引 484 ms、每次查询 42 ms（已预计算 tf，更快）；测试索引热缓存 603 ms。首次 37.5 s 是 Windows 冷读盘与杀毒扫描，不是算法问题。瓶颈是模型调用（秒级），不是本地检索 |
| 要用 RAG / 向量检索吗 | 现在不需要 | 候选召回已满：fixture 上实现文件 22/22 进 top 5，金标测试 18/18 进候选。精度损失发生在"从候选里选"（模型判断），向量检索只改善"进候选"，治不了这里 |
| 什么时候再考虑 | 真实仓库上候选召回被证明偏低时 | 届时用 BM25 + 向量的 RRF 融合（倒数排名融合），而不是替换 BM25；先建 §4.1 的追溯基准再说 |

外部证据与此一致：[Is Grep All You Need?（arXiv 2605.15184）](https://arxiv.org/abs/2605.15184)发现 grep 式检索一般不输向量检索，但结果对 harness 和结果交付方式很敏感；[LiSSA（ICSE 2025）](https://fuchss.org/conferences/icse25/)用 RAG 做追溯，收益来自"给模型合适的候选"，而本项目候选已经齐了。本项目的检索对象是单个仓库、每次运行重建，不存在需要向量库维护的大规模、跨运行语料。

## 2. 按流水线阶段对照

| 阶段 | 相关工作 | 对本项目的启示 |
|---|---|---|
| 2 文档召回 | [零样本需求分类（arXiv 2302.04723）](https://arxiv.org/abs/2302.04723)：嵌入式 ZSL，FR/NFR F1 0.66；[ChatGPT 区分 FR/NFR（arXiv 2311.11547）](https://arxiv.org/abs/2311.11547)：few-shot 只在 zero-shot 很差时有用 | 这些工作分类的是"需求句子"，不是"仓库里的文件是不是需求/设计文档"；后者几乎没有公开基准，我们的 16 仓库 2197 条标注本身就是贡献。few-shot 收益有限，与我们不加示例、改类别边界的做法一致 |
| 2 文档召回（ADR） | [ADR 违规检测（arXiv 2602.07609）](https://arxiv.org/abs/2602.07609)：109 个 GitHub 仓库 980 份 ADR；[ADR 生成的上下文策略（arXiv 2604.03826）](https://arxiv.org/abs/2604.03826)引用的大规模研究指出很多仓库的 ADR 半途而废、过期 | 支持我们的 SUPERSEDED 检测和"状态行"特征；过期 ADR 是真实常见噪声，不只是测试集的特例 |
| 3/7 规则质量 | [Requirements Smells / Smella（arXiv 1611.08847）](https://arxiv.org/abs/1611.08847)：词法规则检测，精度 59%、召回 82%；[NALABS（arXiv 2202.05641）](https://arxiv.org/abs/2202.05641)；[LLM 按 ISO 29148 评需求（arXiv 2408.10886）](https://arxiv.org/abs/2408.10886) | 纯词法 smell 精度只有约六成，不能直接当 P0/P1；适合做代码层预筛，由模型按证据确认（与 §7.1 降噪规则一致） |
| 3→8 质量影响追溯 | [How Requirements Quality Makes (or Breaks) TLR（arXiv 2606.11834，RE 2026）](https://arxiv.org/abs/2606.11834)：28 类缺陷 × 5 种追溯方法，有的缺陷降低追溯效果，有的（含实现细节）反而提高 | 规则文本质量可以预测追溯判断的可信度：见 §3 思路 E |
| 8a 规则→代码 | [T-BERT（arXiv 2102.04411，ICSE 2021）](https://arxiv.org/abs/2102.04411)；[Prompts Matter（arXiv 2308.00229）](https://arxiv.org/abs/2308.00229)；[TraceLLM（arXiv 2602.01253）](https://arxiv.org/abs/2602.01253)：8 个模型、4 个数据集，标签感知+多样性选示例最好，但 few-shot 平均增益小、方差大；[LiSSA 复现包（Zenodo 10.5281/zenodo.14714706）](https://doi.org/10.5281/zenodo.14714706) | 微调路线（T-BERT）需要标注和训练，不适合"任意仓库即插即用"；提示工程路线的结论是方差大，正好对应我们的多数投票。LiSSA 复现包里有现成的需求→代码金标，可做外部基准 |
| 8b 规则→测试 | [REST-at（Chalmers）](https://research.chalmers.se/publication/554150)：需求↔系统测试的 LLM 追溯，对提示很敏感；[AI 从需求生成测试综述（arXiv 2606.06563）](https://arxiv.org/abs/2606.06563)：生成式系统普遍不产出追溯链 | 我们"先追溯、再判断测试是否断言规则"的结构是综述指出的空白处 |
| 8b 测试→被测代码 | [TCtracer（ICSE 2020）](https://discovery.ucl.ac.uk/id/eprint/10091100/)：方法级 MAP 78%；[Methods2Test（arXiv 2203.12776）](https://arxiv.org/abs/2203.12776)：78 万 Java 测试↔焦点方法对；[pyMethods2Test（arXiv 2502.05143）](https://arxiv.org/abs/2502.05143)：200 万+ Python 对；TestLinker（TSE，[作者主页](https://yanmeng.github.io/papers/TSE241.pdf)） | 焦点方法启发式（测试调用集合 ∩ 被测类方法唯一时取之；名字相似；断言前最后一次调用）是确定性的，可替代一部分模型投票。两个数据集是现成金标：见 §4.1 |
| 8 证据：断言是否对 | [nl2postcond（arXiv 2310.01831，FSE 2024）](https://arxiv.org/abs/2310.01831)：自然语言→后置条件，抓到 Defects4J 64 个历史 bug；[Doc2OracLL（arXiv 2412.09360）](https://arxiv.org/abs/2412.09360)：只给文档注释生成的 oracle 不比给全上下文差，且比从实现生成的更能抓真实缺陷 | 规则文本本身就足够生成"应该断言什么"；从实现反推会把 bug 当成预期。见 §3 思路 C |
| 8 Placement | [Göttingen 单元/集成测试差异研究](https://www.swe.informatik.uni-goettingen.de/node/2889)：27 个项目 4.9 万测试，按 IEEE/ISTQB 定义分类，多数项目集成测试多于单元测试；[PROFES 2024 包含关系法](https://conf.researchr.org/details/profes-2024/profes-2024-short-papers-and-posters/4/Exploring-an-Inclusion-Relation-on-Test-Cases-for-Identification-Unit-and-Integration)；[UW 测试类型分析（AST 2025）](https://homes.cs.washington.edu/~rjust/publ/test_type_analysis_ast_2025.pdf) | 层级定义本身有歧义，业界普遍"右偏"。我们的 belongsAt 只用确定性信号（纯计算、无 I/O）判"应在单元层"，与 ISTQB 定义一致；"集成测试多于单元测试"说明 Placement 发现在真实仓库会很多，要排序而不是全报 |
| 8 测试坏味道 | [LLM 检测测试坏味道（arXiv 2407.19261）](https://arxiv.org/abs/2407.19261)；[arXiv 2506.07594](https://arxiv.org/abs/2506.07594)：Assertion Roulette 检测准确率约 89–98% | 多数坏味道可用 AST 规则直接定（tsDetect 一类），不必用模型；可作为 §4 测试质量的 S 级证据 |
| 8 测试充分性 | [Meta ACH 变异引导测试生成（arXiv 2501.12862）](https://arxiv.org/abs/2501.12862)：只针对关心的问题生成少量变异体；LLM 等价变异体判断加简单预处理后精度 0.95 / 召回 0.96 | "规则相关的少量变异"是比覆盖率更硬的证据，但要执行目标仓库代码，见 §3 思路 D |
| 9 验证与排序 | [Self-Consistency（arXiv 2203.11171）](https://arxiv.org/abs/2203.11171)；[Chain-of-Verification（arXiv 2309.11495）](https://arxiv.org/abs/2309.11495)；[When LLMs Agree, Are They Right?（arXiv 2607.08065）](https://www.alphaxiv.org/abs/2607.08065)：自一致性单独作置信度不可靠，越自信的前沿模型越差；[LLM 评审过度自信（arXiv 2508.06225）](https://arxiv.org/abs/2508.06225)；[共形弃权（arXiv 2405.01563）](https://arxiv.org/abs/2405.01563) | 多数票能降方差，但"全票"不等于"正确"：需要用金标校准每个阶段的投票阈值，并允许弃权（标为"未确认"而不是升 P0） |
| 9 工业降噪 | [BitsAI-CR（arXiv 2501.15134）](https://arxiv.org/abs/2501.15134)：字节跳动，规则检查 + 过滤两段式，评论精度 75%；[腾讯 LLM + 静态分析消除误报（arXiv 2601.18844）](https://arxiv.org/abs/2601.18844)：消除 94–98% 误报；[Agentless（arXiv 2407.01489）](https://arxiv.org/abs/2407.01489)：固定流程（文件→函数→行）分层定位，不用自主 agent | 与我们"代码先定、模型只判剩下的、再由代码校验"的结构一致；固定流水线在成本和可复现上优于 agent，适合 Actions |

## 3. 前沿思路（按性价比排序）

每条给出：做什么、对应哪个阶段、怎么验证、成本。都先在 tuned 集上开发，held-out 和 test 集只用来报告。

**A. 校准投票阈值，允许弃权（阶段 7–9）。** 依据 2607.08065：一致不等于正确。做法：对每个模型判断（文档分类、追溯链、Suspected not built 等），在已有金标上统计 3/3 与 2/3 票的精度；若 2/3 票精度明显低，则该阶段改为 2/3 票只进"未确认"列表，不进 P0/P1。fixture 上已有迹象：正确的测试链全部是全票。成本：只是重放已有 cassette，不花钱。

**B. P0 断言做独立复核（阶段 9）。** 依据 CoVe：先生成"验证问题"，再在看不到原结论的上下文里独立回答。只对 Suspected not built 这类 P0 做，例如"`fetchQuote` 是否设置了超时？给出行号"，回答必须带可校验的行号（代码检查行在文件里）。目标是 fixture 上残留的两个假 P0。成本：每次运行只多几次调用，约 $0.01。

**C. 规则→期望断言，代码比对（阶段 8 Limits/Asserts）。** 依据 nl2postcond、Doc2OracLL：只从规则文本生成"应断言的边界值与结果"（例如 `refund(31 days) → rejected`），不看实现；再由代码在测试文本里查这些字面量是否出现。把"测试是否覆盖边界"从模型判断变成字符串匹配。验证：fixture 的 Limits 行精度/召回对比现状。成本：每条规则一次小调用。

**D. 规则相关变异（阶段 8，选做）。** 依据 Meta ACH：把规则里的阈值（30→31、`<`→`<=`）在实现行上变异，看测试是否失败。这是最硬的"测试真的断言了规则"证据，但必须执行目标仓库代码，违反"目标仓库不可信、不执行"的安全约束。只能作为目标仓库自己 CI 里的可选 job（在它自己的 runner 上跑），本流水线不做。

**E. 规则质量预测追溯可信度（阶段 3→8）。** 依据 Hey & Frattini 2606.11834。做法：给每条规则算几个确定性特征（是否有标识符/文件名、是否有数字界限、句子是否以名词短语开头、长度），在 fixture 和 §4.1 基准上看哪些特征与追溯错误相关；相关的特征用来下调该规则发现的优先级，而不是丢弃。成本：零模型调用。

**F. 焦点方法启发式替代部分投票（阶段 8b）。** 依据 Methods2Test / TCtracer。做法：在测试文本里取"断言前最后调用的函数"和"调用集合 ∩ 实现文件导出符号"，作为确定性链；只有启发式无结论时才问模型。验证：§4.1 基准上的链精度与调用数。成本：零。

**G. 共形方法定文档召回的分档线（阶段 2）。** 现在 score ≥3 直收、1.5–3 交模型、<1.5 丢弃是手调的。用 tuned 集 1 千余条标注做共形风险控制，按"漏召率 ≤ 5%"反推下档线，按"误收率 ≤ 5%"反推上档线。前提是可交换性：仓库间分布差异大，所以按仓库分组做留一校准，并在 test 集上报告实际覆盖率。成本：零模型调用。

不推荐：微调模型（T-BERT 路线）：需要训练与部署，且对"任意仓库"泛化未证；few-shot 示例（TraceLLM 发现增益小、方差大，还带来对 tuned 集过拟合的风险）；向量库（见 §1）。

## 4. 可直接用的外部数据集

### 4.1 追溯基准
- **pyMethods2Test / Methods2Test**：测试↔焦点方法的大规模金标，测试 F（焦点方法启发式）与 reaches()/touchesImpl 的精度，不需要自己标注。注意它们是方法级、单元测试为主，覆盖不到 e2e 链。
- **LiSSA 复现包**：需求→代码金标，测阶段 8a（实现定位）。数据集里的需求是用例文本，比真实仓库的 README/设计文档更规整，结果会偏乐观。
- **自建**：选测试里带需求 ID 的真实仓库，遮掉 ID 后看能否恢复链（ID 本身就是金标）。

### 4.2 Placement 人工核查
从 bench 仓库各抽 20 个 Placement 发现人工判对错，按"纯计算 / 金额日期 / 计数 / 无 I/O 函数体"四种判据分别报精度，判据精度低的降为 P2。

## 5. 未核实与局限
- 表中数字来自摘要或检索摘要，未逐篇核对全文；2607.08065 与 2601.18844 的部分数字来自第三方摘要。
- 文件级"需求/设计文档识别"未找到直接对应的公开基准，这一结论基于检索未命中，不代表不存在。
