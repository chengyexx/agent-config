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
│  ├─ skills/                 # artifact-reconciliation, github-discovery, tech-paradigm
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
