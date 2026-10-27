---
name: tech-paradigm
description: >-
  Use when the user is about to BUILD something and needs the superior
  paradigm / state-of-the-art approach for a specific technology — finding
  supporting papers, reference implementations, and practitioner articles,
  ranked and graded for trustworthiness. Triggers: 技术调研 / 这个技术现在最佳
  范式是什么 / SOTA / 怎么做 X 最好 / 有没有更好的路线 / 该抄谁的作业 / nl2ui /
  design-to-code / RAG 方案对比 / 想看看别人怎么实现的 / 一句话出页有什么可以参考.
  Use ONLY when the goal is understanding paradigms across sources (papers +
  repos + articles); do NOT use for picking a single library (that is
  github-discovery), for daily AI news digests, or for reading the user's own
  repo. The repo's github-discovery skill handles the "which repo to use"
  deep-dive; this skill explains WHY a paradigm wins and what the field looks
  like.
---

# tech-paradigm —— 技术范式调研

产出:一份带可信度分级([A]/[B]/[C])的技术简报 —— 范式演进时间线、当前公认范式及证据、
可用实现选型、按阅读顺序的论文清单、常见陷阱。

**脚本目录(绝对路径)**
`~/.config/opencode/skills/tech-paradigm/scripts`
下文命令均在此目录下执行。

**目录**:0 前提 · 1 七步流程 · 2 命令 · 3 调参 · 4 定级规则 · 5 限额与降级 · 6 反模式 · 7 衔接

## 0. 前提

- Node 20+(本机 v22)。**无第三方依赖**(lib 仅复用 http/cache 的零依赖实现)。
- `GITHUB_TOKEN` 已在用户级环境变量(实测为 fine-grained PAT:search 30/min、core 60/hr、GraphQL 0,脚本按此节流)。
- 代理:默认直连。实测只有 `huggingface.co` 在本机 DNS 被污染、直连必超时 —— 脚本对该主机
  **自动降级走 CONNECT 隧道**(http.mjs 内置,需 `HTTPS_PROXY` 环境变量可用,无需 undici)。
  其余源(hn.algolia / export.arxiv / api.github / api.openalex)直连已验证可达,优先直连
  (共享出口 IP,走代理反而加剧按 IP 限流)。
- 先自检:

```powershell
node research.mjs rate
```

GitHub `search.limit` ≥ 10 且各源 `ok` 即正常。任一源失败 → 见第 5 节降级,**不要编造**。

## 1. 七步流程

**Step 0 需求结构化 + 话题分型(决定整个检索的权重)**

先判定话题类型,再设计查询:
- **学术型**(有明确算法/架构名,如 "KV cache eviction"):论文为主轴,arXiv/HF 权重高
- **工程型**(产品/工程实践名,如 "一句话出页"、"design-to-code"):论文少且偏,**GitHub 实现 +
  HN 实战讨论为主**,论文作补充 —— 不要在论文维度硬凑

然后抽 3–6 个查询变体(分号分隔):核心术语、同义词/别名、任务名、代表系统名、benchmark 名。
> 例:「我想给 AI 助手加记忆」→ `agent memory; long-term memory LLM; memory retrieval agent; MemGPT`

**Step 1 自检限额**

```powershell
node research.mjs rate
```

**Step 2 召回**

```powershell
node research.mjs gather "<q1; q2; q3; q4>" --out evidence-<slug>.json
```

脚本内部:4 个源并行按查询变体召回(GitHub 仓库 / HN 文章 / arXiv recent+relevance 双切片 /
HF papers)→ 客观硬闸门(仓库:archived/fork/星数/时效/黑名单;文章:HN points 下限;论文:时间窗)
→ 跨源按标题/URL 合并 → OpenAlex 引用数富化(best-effort,**只对已召回论文**,带标题相似度门槛,
429 静默跳过并声明)→ 压缩成 ≤60 条证据包(JSON 文件 + md 摘要)。

**读证据包文件**,不要只看 stdout 摘要。

**Step 3 语义复核(必做,精度的最后一道闸)**

关键词闸门只管"词汇命中"。对前 5–8 个候选逐个验证:

```powershell
node research.mjs readme <owner/repo> | Select-Object -First 120
```

剔除:集成/包装类("X for Y")、awesome-list、教程示例、同名不同物、僵尸项目。
论文类:核对 abstract 是否真的解决你的问题(arXiv 页面可用 webfetch 读)。

**Step 4 可信度定级**(规则见第 4 节,每条结论必须标注)

**Step 5 补充 websearch(可选但推荐)**:对最终范式候选,用 websearch 查口碑与已知坑;
实践类文章(benchmark 榜外的工程经验)主要靠这一步,但**引用其 URL 必须真实可访问**。

**Step 6 输出**(模板见下)。若用户要选具体库,结尾补一句:
「实现层深挖请跑 github-discovery」。

## 2. 命令

```powershell
node research.mjs gather "<q1; q2; ...>" --out <file> [--days 365] [--months 12]
node research.mjs gather "<q>" --depth quick          # 快速定向:跳过雪球/富化,单层召回
node research.mjs gather "<q>" --json                 # stdout 输出完整 JSON
node research.mjs readme <owner/repo>                 # 读 README 前 120 行
node research.mjs rate                                # 各源限额自检
node research.mjs cache stats|clear
```

## 3. 调参(按症状顺序)

| 症状 | 调整 |
|---|---|
| 论文太少 | 查询换成学术语汇(如 `layout generation`,别用口语);升 `--per` |
| 仓库太杂 | 换更精确的查询词(如 `text-to-ui`、`nl2ui`);升 `--min-stars`;收窄 `--months` |
| 全是词命中但不对题 | 正常 —— 这是闸门的天性,靠 Step 3 语义复核剔除 |
| 想要更久远的奠基论文 | 升 `--days 1095` |

## 4. 可信度定级(核心规则)

脚本给的是**信号**(sources 数、stars、pushed_at、points、upvotes、cited_by_count),
**定级由 agent 做**,口径如下:

- **[A] 可作为决策依据**:≥2 个独立信号互证 —— 典型组合:论文存在(有 arXiv id)
  **且** 有活跃实现(pushed ≤12 月、星达标)**且** 社区有热度(HN/UF 非零)
- **[B] 单源强信号**:只有论文(preprint 未同行评审要标注)或只有实现
- **[C] 观察期**:半年内新工作、无实现、无社区热度

硬约束:**「当前公认范式」一节只允许用 [A] 级证据支撑**。[B]/[C] 可列,但必须标注。

**引用数的使用纪律**:`cited_by_count` 仅当 OpenAlex 富化**成功**时才存在(实测本机常 429)。
没有它,"奠基 vs 前沿"用 `年份 + 实现谱系 + 社区热度` 判断,并且**必须在输出里声明这一局限**。
不允许因为"没有引用数"就拒绝下结论 —— 用互证信号说话。

## 5. 限额与降级

| 源 | 限额 | 本机实测 |
|---|---|---|
| GitHub search | 30/min(fine-grained PAT) | 脚本节流 2.3s/次 |
| HN Algolia | 宽松 | ok |
| arXiv | 3s 礼貌间隔 | ok |
| HF papers | 宽松 | DNS 被污染 → 自动隧道,ok |
| OpenAlex | 按共享 IP 限 | **常 429** → 只做富化,失败仅声明降级 |

- 降级结果可以给,但**必须**列出哪些维度缺失(如「引用数缺失,本机 OpenAlex 429」),不可声称完整。
- Semantic Scholar 未认证 = 全 429(全人类共享池),已从数据源移除,不要加回。
- Papers With Code 的 `/api/v1/*` 已死(返回 HTML);需要 SOTA 信息时用 webfetch 读页面并人工核对。

## 6. 反模式

- ❌ 编造论文标题、arXiv 号或 DOI —— 所有链接逐字取自证据包或 webfetch 实读结果
- ❌ 只看星数/引用数排序就下结论 —— 老而大的项目常压过最合适的路线
- ❌ 跳过 Step 3 语义复核,把集成/包装/awesome-list 当成范式本体
- ❌ 拿用户原话整句当查询词(先结构化成变体)
- ❌ 把降级结果当完整结果汇报
- ❌ 把「工程型话题」硬往论文上凑 —— 论文少是这类话题的常态,不是工具坏了

## 7. 输出模板

```
# <技术名> · 范式调研(<日期>)

① 范式演进时间线:奠基(年份) → 关键分支 → 当前活跃方向
② 当前公认优越范式:结论 + 为什么(逐条 [A]/[B] 标注)
③ 可用实现 top-3(表:仓库 | 星 | 最近提交 | license | 为什么匹配 | 风险)
④ 按阅读顺序的论文清单(先读哪篇,一句话理由)
⑤ 常见陷阱(来自证据包/社区讨论,不来自记忆)
⑥ 降级声明 + 残余风险(哪些维度没跑成)

实现层选型深挖 -> github-discovery
```
