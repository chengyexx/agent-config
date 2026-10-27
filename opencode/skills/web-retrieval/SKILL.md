---
name: web-retrieval
description: >-
  Use for any web research / information-gathering task, and especially when a
  fetch FAILS or returns nothing. Covers channel selection across websearch,
  webfetch, ddg_search, batch_fetch and cn_search, and the diagnosis order for
  403 / 412 / SPA empty shell / rate-limited responses.
  中文触发：搜索 / 检索 / 搜集资料 / 抓取 / 爬一下 / 抓不到 / 打不开 /
  返回空 / 403 / 412 / 反爬 / 需要登录 / 牛客 / 知乎 / 小红书 / 微博 / 面经搜集。
  Do NOT use for reading the user's own repo, or for one already-known URL that
  webfetch reads fine on the first try.
---

# Web Retrieval

Goal: pick the cheapest channel that actually works, and fail loudly instead of silently.

## 1. Strategy: breadth then depth

```
websearch            → 3-8 snippets, fast, semantic. Start here.
ddg_search           → independent index; fills gaps Exa misses (Chinese long tail,
                       zhihu columns, CSDN, university job boards).
batch_fetch          → read full text of 5-20 URLs in ONE call. Never loop webfetch.
cn_search            → login-walled / JS-rendered Chinese platforms.
chrome-cdp-ex        → only when you need live page state, clicks, or screenshots.
```

Rules of thumb:
- One `websearch` rarely answers a research question. Run 2-3 with different phrasing
  (`site:` operators, company names, year, 岗位/批次) **in parallel**.
- After a search, do not summarize snippets. Feed the promising URLs to `batch_fetch`.
- Prefer structured sources over generic search: company interview hubs, maintained
  GitHub aggregators, curated timetable sites. They beat paginated search results.

## 2. Tool cheatsheet

| Tool | Key params | Notes |
|---|---|---|
| `websearch` | `query`, `numResults` | Exa/Parallel hosted, keyless. Cannot page. |
| `webfetch` | `url`, `format` | One URL, no browser UA, no cookie. |
| `ddg_search` | `query`, `maxResults`, `region` (default `cn-zh`) | Returns title/real URL/snippet. |
| `batch_fetch` | `urls[]`, `maxCharsPerPage`, `maxTotalChars`, `concurrency`, `timeoutSeconds`, `includeHtml`, `referer` | `referer` defaults to `same` — required by some SSR sites. |
| `cn_search` | `tool`, `keyword`, `argsJson`, `limit` | `tool='__list'` to self-inspect. Cold start ~5s, warm ~0.5s. Auto-exits after 10 min idle. |

`cn_search` useful tool names: `bilibili_search`, `bilibili_popular`, `bilibili_video`,
`bilibili_comments`, `douban_search`, `douban_subject`, `douban_reviews`,
`zhihu_search`, `zhihu_hot_list`, `zhihu_answer`, `weibo_search`, `weibo_hot_list`,
`xiaohongshu_search`, `guided_login`, `check_cookies`.

## 3. Diagnosis order when a fetch fails

Stop and identify the layer. Do not retry blindly.

1. **Network** — `curl.exe -s -o NUL -w "%{http_code} %{size_download}" <url>`
   `000` = cannot connect at all; anything else means you reached something.
2. **Proxy** — outbound traffic goes through an HTTP proxy declared in
   `HTTP_PROXY`/`HTTPS_PROXY`. Node's `fetch` **ignores** env proxy → connect
   timeout. `curl.exe` respects it. Any network code you write must shell out to
   curl, not use fetch.
3. **Response shape** — size alone lies. 14 KB may be an anti-bot challenge page;
   36 KB may be a SPA shell with zero text. Check for a known marker string
   (e.g. `result__a`, article title) before trusting a 200.
4. **Rendering** — compare against a human-opened browser. Vary ONE header at a time
   (`Referer`, `User-Agent`, `Accept`, `Cookie`). Many sites SSH-render only for
   plausible browser traffic.
5. **Rate limiting** — compare 1 request vs N concurrent. Content vanishing under
   concurrency is throttling, not a bug. Serialize and retry with ~1s spacing.
6. **Encoding** — GBK sites mojibake in UTF-8 pipelines. Judge by bytes on disk,
   not by console output (PowerShell console is often GBK and lies).
7. **Verification** — proving logic offline does not prove it is wired up. Execute
   through the real entry point.

## 4. Observed site behaviour (all measured, not assumed)

| Target | Verdict |
|---|---|
| `nowcoder.com/experience/{id}` | Full SSR, 210 KB — **only with `Referer` = the same URL** |
| `nowcoder.com/discuss/experience?tagId=N` | 302 → 1.9 KB shell. Use `/experience/{id}` instead |
| `nowcoder.com/enterprise/{id}/interview` | Works; company-level interview hub |
| nowcoder, parallel requests | Throttles to ~5 KB. Fetch serially or accept one retry |
| `html.duckduckgo.com/html/?q=` | Works with `--compressed` + browser UA/Accept/Referer; without them → 202 anomaly |
| zhihu (any page, incl. zhuanlan) | 403 even with Chrome UA. Use `cn_search` + login |
| zhihu hot list | Requires login (README claims guest-readable — it does not) |
| xiaohongshu | SPA shell; needs local Chrome + residential IP. Datacenter/proxy IPs blocked |
| `api.bilibili.com` direct | 412 (WBI signature). Use `cn_search` `bilibili_*` |
| Bing with `setlang=zh-CN` | Degraded, returns dictionary entries. Do not use for research |
| `r.jina.ai` reader | Times out from this network. Unusable |
| Public SearXNG JSON API | JSON disabled on most instances |
| GitHub raw / normal blogs / 高校就业网 / linux.do | Work fine |

## 5. Anti-patterns

- Using `fetch`/axios for outbound requests → no proxy → timeouts.
- Treating HTTP 200 as success. Always assert on content, not status.
- Looping `webfetch` over a result list → use `batch_fetch`.
- Hammering an anti-bot site concurrently, then concluding "it is blocked".
- Reaching for a headless browser before trying header variations.
- Returning an empty string instead of an explicit `[BLOCKED] / [NO TEXT]` marker.
- Quoting numbers from a single search snippet as fact; verify against the source page.

## 6. Verifying your own retrieval code

Two gates, both required:

1. **Offline logic** — stub `@opencode-ai/plugin`, then
   `node --experimental-strip-types your-test.mjs` and assert on parsed output.
2. **Real entry point** — `opencode run --model <provider/model> --format json "..."`
   and look for `"type":"tool_use"` with `"status":"completed"`. This is the only
   proof the tool is registered and callable; offline tests cannot show that.

If you changed a tool, re-run both. A warm-cache pass after a cold-cache failure is
not proof — reproduce the original failure path.
