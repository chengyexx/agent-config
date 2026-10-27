---
name: github-discovery
description: >-
  Use when the user needs to FIND or COMPARE open-source projects / libraries /
  tools to reuse, instead of implementing from scratch — "search GitHub for a
  library that does X", "find an open-source alternative to Y", "which repo
  should we use", "is there a project for Z", "选型", "找现成开源方案".
  Use it whenever a plain GitHub search box would give noisy or low-quality
  results and the answer must be ranked, filtered, and justified.
  中文触发：找开源项目 / GitHub 搜索 / 搜仓库 / 开源替代 / 选型 / 调研开源方案 /
  有没有现成的库 / 比较几个开源项目 / 开源项目质量参差。
  Do NOT use for reading code inside the user's own repo, or for pure
  Q&A about a single already-known project.
---

# GitHub Discovery —— 有精度 / 有质量 / 有广度的开源项目发现

解决「直接搜 GitHub 精度、质量、广度都一般」的问题。产出**候选表 + 打分 + 匹配理由 + 排除原因 + 风险**。

**脚本目录（绝对路径）**
`~/.config/opencode/skills/github-discovery/scripts`
下文命令均在此目录下执行。

**目录**：0 前提 · 1 六步流程 · 2 命令 · 3 调参 · 4 判读 · 5 限额与降级 · 6 反模式

## 0. 前提

- 依赖 Node 20+（本机 v22）。**无第三方依赖**。
- Token 与代理已在本机配好（用户级 `GITHUB_TOKEN`、`HTTPS_PROXY`）。先自检：

```powershell
node discover.mjs rate
```

`authenticated: true` + `search.limit: 30` 即正常。若为 false → 见第 6 节降级说明，**不要**编造结果。

## 1. 六步流程

**Step 1 需求结构化**（别直接拿用户原话去搜）

抽出：① 功能关键词（1–3 个核心名词/动词）② 语言/生态（可选）③ 硬门槛（stars、活跃度、许可证）。

> 「我想要个能本地跑的向量数据库」→ 关键词 `vector database`，门槛 `--min-stars 1000`，看是否要 `--lang go`。
> 「有没有替代 Auth0 的开源方案」→ 关键词 `authentication self-hosted`，`--exclude saas,cloud`。

**Step 2 召回 + 硬过滤 + 打分**

```powershell
node discover.mjs "<关键词>" --lang <语言> --min-stars <N> --limit 10
```

脚本内部：GitHub 双查询召回（`in:name,description` 保精度 + `in:description,readme` 保广度）+ npm registry 召回 → GraphQL 批量补 stars/commits/releases/issues/topics → npm/PyPI 下载量（**仅当包仓库链接与仓库一致，不猜**）→ 硬过滤（archived/fork/star/时效）→ 关键词相关性闸门 → 加权打分。

**Step 3 语义复核（必做，这是精度的最后一道闸）**

关键词闸门只管"词汇命中"，**不能判断"是不是真的解决需求"**。对前 5–8 个候选逐个读 README 摘要：

```powershell
node discover.mjs readme <owner/repo> | Select-Object -First 80
```

判断并剔除：
- **集成/包装类**：description 是 "X integration for Y" / "plugin" / "binding" → 多半不是本体
- **Awesome-list / 教程 / 示例**类
- **同名不同物**：名字像但要解决的问题不同
- **僵尸项目**：最后提交 >12 个月（脚本已用 `--months` 拦，但人工再确认）

**Step 4 代码级验证（有具体 API/标识符时用）**

`/search/code` 能确认"仓库代码里真的实现了这个特性"，是比 README 更硬的证据。**仅对 top N 用，且必须给具体词**（限额 10/min）：

```powershell
node discover.mjs "<关键词>" --verify --code-terms "hnsw" --verify-top 5
```

命中数会显示为 `code:verified(N)`。`--code-terms` 用**代码里会出现的字面量**（函数名、关键字、API 路径），不要用自然语言描述。

**Step 5 交叉核对**

对最终推荐 top-3，至少做一项独立佐证：读 README 的 Quickstart / 看 releases 节奏 / 用 `websearch` 查口碑与已知坑。**单靠星级会选到"名气大但不合用"的库。**

**Step 6 输出**

```
## 候选（按评分）
| 仓库 | 评分 | 星 | 最近提交 | License | 下载/月 | 信号 | 为什么匹配 | 风险 |

## 推荐 top-N（逐个一句话说明取舍）
## 已排除（原因）
## 未验 / 残余风险
```

**评分口径必须写清**（脚本 detail 已给分项：pop/act/comm/mat/adopt/docs），不要把综合分当唯一依据。

## 2. 命令

```powershell
node discover.mjs "<need>"                    # 主入口
node discover.mjs "<need>" --json             # 结构化输出，便于后续处理
node discover.mjs readme <owner/repo>         # 取 README（做语义复核）
node discover.mjs rate                        # 查限额/是否带 token
node discover.mjs cache clear                 # 清缓存（结果异常时）
```

选项：`--lang` `--min-stars`(100) `--months`(12) `--min-match`(0.5) `--exclude` `--limit`(10) `--candidates`(50) `--no-npm` `--no-deep` `--verify` `--code-terms` `--verify-top`(5) `--json`。

## 3. 调参（结果不对时按此顺序调）

| 症状 | 调整 |
|---|---|
| 结果太少 | 降 `--min-stars`；`--months 24`；换更通用的关键词 |
| 结果太杂 | 升 `--min-match 0.75`；加 `--exclude integration,plugin,example`；加 `--lang` |
| 全是同一类 | 关键词收窄到**用户真正要的能力**（如 `self-hosted`、`offline`、`rest api`） |
| 需要限定许可证 | 加 `--exclude` 只能排词；许可证需在结果中人工确认 |
| 要具体特性证据 | `--verify --code-terms "<字面量>"` |

## 4. 判读打分局部分

- `pop`(25) log 星级 · `act`(25) 最近提交新鲜度 · `comm`(15) issue 关闭率 · `mat`(15) 提交量+发版数 · `adopt`(10) 包下载量 · `docs`(10) README 长度。
- `downloads` 只在**包→仓库链接能对上**时才给，`downloadsSource` 会标 `npm:x` / `pypi:x`。为空 = 无可靠对应，**不要**解读为"没人用"。
- 相关性闸门按**词边界**匹配，避免 `orm` 命中 `platform`；但仍是词汇级，语义判断在 Step 3。
- `warnings`：`no-license` / `low-activity` / `issue-backlog` / `immature` / `readme-unavailable`（README 取不到，docs 分按中性值）/ `verify-failed(<status>)`（代码验证调用失败，**不等于 0 命中**）。
- 无 token（降级）时 `comm`/`mat` 恒为 0，**不可据此比较**。

## 5. 限额与降级

- 限额：search **30/min**、code search **10/min**、core **5000/hr**、GraphQL **5000 pt/hr**。脚本已内置节流（search 2.2s、code 6.2s 间隔）与磁盘缓存（search 6h、README 7d）。**不要并发跑多个 discover 实例。**
- 降级：未检出 token 时自动关闭 GraphQL 富化与代码搜索，仅用 REST + npm/PyPI，输出会标 `token=NO (degraded)`。**降级结果可以给，但必须告知用户"未经富化/代码验证"，不可声称与完整模式等价。**
- 降级时的**有意丢弃**：由 npm registry 召回、但拿不到 GitHub 星级/最近提交的项目，会以 `stars-unknown` / `pushed-unknown` 被过滤掉（过滤原因里会看到）。这是为了避免"未经验证的项目"混入结果；若需保留，请改用带 token 的完整模式，而不是放宽过滤。
- 已弃用通道（不要试图改回去）：grep.app（429 硬限流）、Sourcegraph（需账号）、libraries.io（需 key）、OSSInsight（服务抖动）。代码验证用 GitHub `/search/code` 替代。

## 6. 反模式

- ❌ 拿用户原话整句去搜（空格=AND，会过窄）。
- ❌ 只看星级排序就下结论（老而大的库常压过最合适的）。
- ❌ 跳过 Step 3 语义复核，把 `integration/wrapper` 当成候选本体。
- ❌ 用自然语言做 `--code-terms`。
- ❌ 把降级模式结果当完整结果汇报。
- ❌ 让用户把 token 贴在对话里；如需重设，让其在**自己终端**执行 `[Environment]::SetEnvironmentVariable('GITHUB_TOKEN','<token>','User')`。
- ❌ 把 README 原文大段贴给用户；只提取与需求相关的结论。
