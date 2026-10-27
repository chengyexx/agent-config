# agent-config

Personal AI-agent configuration, kept in one place:

- global working rules (`AGENTS.md`)
- OpenCode agents, skills, tools, and plugins
- research notes behind the output contract

Claude-specific configuration is intentionally **not** included.

## Structure

```text
agent-config/
├─ AGENTS.md                  # global rules → ~/.config/opencode/AGENTS.md
├─ opencode/
│  ├─ opencode.jsonc          # main config
│  ├─ opencode-pets.json      # pets plugin config
│  ├─ package.json            # plugin dependency
│  ├─ agent/                  # omen-alpha, verifier
│  ├─ skills/                 # artifact-reconciliation, github-discovery, tech-paradigm, web-retrieval
│  ├─ plugins/                # bun-shim, open-code-review
│  └─ tools/                  # batch_fetch, cn_search, ddg_search
└─ docs/
   └─ ai-output-research.md   # why the output contract looks like this
```

## Install (Windows / PowerShell)

Copy this repo over the OpenCode config directory, keeping a backup first:

```powershell
$dst = "$env:USERPROFILE\.config\opencode"
Copy-Item -Recurse -Force .\* $dst
```

Or link individual pieces. `AGENTS.md` must live at
`~/.config/opencode/AGENTS.md`; everything under `opencode/` maps to
`~/.config/opencode/`.

`opencode.jsonc` uses `uvx` from `PATH`. If yours lives elsewhere, change the
`cn` MCP command back to an absolute path.

## Web retrieval stack

`opencode/tools/` plus the `web-retrieval` skill form one retrieval path:

| Piece | Role |
| --- | --- |
| `ddg_search` | DuckDuckGo HTML endpoint — an independent second index next to the built-in `websearch` |
| `batch_fetch` | Concurrent multi-URL fetch, HTML→text, explicit `[BLOCKED]` / `[NO TEXT]` markers instead of silent empty output |
| `cn_search` | On-demand gateway to `cn-scraper-mcp` (Bilibili, Douban, Zhihu, Weibo, Xiaohongshu); the server spawns only when called and exits after 10 min idle |

Requirements: `curl.exe` on `PATH` (ships with Windows 10+) and `uvx` for `cn_search`.
The `cn` MCP server is declared but `enabled: false`, so opencode registers none of
its ~40 tools; only `cn_search` exists in context, and it starts the server itself.

Login-walled platforms (Zhihu, Weibo, Xiaohongshu) need a one-time cookie:
ask the agent to call `cn_search` with `tool='guided_login'`.

The `web-retrieval` skill holds the channel-selection strategy and the measured
site behaviour (which hosts need `Referer: <same url>`, which return 200 with no
content, which are unreachable) — load it before debugging a failed fetch.

## What the rules optimize for

`AGENTS.md` §4 defines the output contract:

- **P0 / P1 / P2** ranking: contracts and behavior first, formatting last.
- Hard budget: 5 files, 8 symbols, 400 characters for change summaries.
- Explanation order: **why → what → impact → action**.
- Acceptance: 100% P0 recall, ≤20% noise, no self-judging.

The underlying research is summarized in `docs/ai-output-research.md`.

## Security

- No API keys, tokens, or credentials are stored here.
- `~/.claude/settings.json` (which contains a plaintext token) is excluded.
- `.cache/`, `evidence-*.json`, session history, and `node_modules/` are
  excluded by `.gitignore`.

If you fork this, replace the provider/model names in `opencode.jsonc` with
your own.

## Attribution

The skills under `opencode/skills/` are personal working copies. Third-party
material, if any, remains subject to its original license and attribution.
