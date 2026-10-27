import { tool } from "@opencode-ai/plugin"
import { execFile } from "node:child_process"

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

const MARKER = "\n__HTTP_STATUS__:"

function curl(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "curl.exe",
      args,
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: "utf8", windowsHide: true },
      (err, stdout) => {
        if (err && !stdout) reject(err)
        else resolve(stdout ?? "")
      },
    )
  })
}

function splitStatus(out: string): { status: number; body: string } {
  const i = out.lastIndexOf(MARKER)
  if (i < 0) return { status: 0, body: out }
  const status = parseInt(out.slice(i + MARKER.length).trim().split("\n")[0], 10) || 0
  return { status, body: out.slice(0, i) }
}

function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  }
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, g: string) => {
    if (named[g] !== undefined) return named[g]
    if (/^#x/i.test(g)) return String.fromCodePoint(parseInt(g.slice(2), 16))
    if (g.startsWith("#")) return String.fromCodePoint(parseInt(g.slice(1), 10))
    return m
  })
}

function plain(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
}

function realUrl(href: string): string {
  const m = href.match(/[?&]uddg=([^&]+)/)
  if (m) {
    try {
      return decodeURIComponent(m[1])
    } catch {
      return href
    }
  }
  if (href.startsWith("//")) return "https:" + href
  return href
}

export default tool({
  description:
    "Search the web through the DuckDuckGo HTML endpoint (independent second index). Use it to widen coverage when the built-in websearch returns too few or low-relevance results, and for Chinese sites such as nowcoder, zhihu columns and csdn. Returns title, real URL and snippet. No API key.",
  args: {
    query: tool.schema.string().describe("Search query. Chinese keywords work."),
    maxResults: tool.schema.number().optional().describe("Max results to return (default 10)."),
    region: tool.schema
      .string()
      .optional()
      .describe("DuckDuckGo region code, default cn-zh (other useful: wt-wt, us-en)."),
  },
  async execute(args) {
    const max = Math.max(1, Math.min(args.maxResults ?? 10, 30))
    const region = args.region ?? "cn-zh"
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}&kl=${encodeURIComponent(region)}`

    const base = [
      "-s",
      "--compressed",
      "-L",
      "-w",
      `${MARKER}%{http_code}`,
      "-H",
      `User-Agent: ${UA}`,
      "-H",
      "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "-H",
      "Accept-Language: zh-CN,zh;q=0.9,en;q=0.8",
      "-H",
      "Referer: https://duckduckgo.com/",
      "--max-time",
      "30",
      url,
    ]

    let out = await curl(base, 40000)
    let { status, body } = splitStatus(out)

    if (status !== 200 || /anomaly|challenge-form/i.test(body.slice(0, 4000))) {
      out = await curl([...base, "-H", "Cache-Control: no-cache"], 40000)
      const retry = splitStatus(out)
      status = retry.status
      body = retry.body
    }

    if (status === 202 || /anomaly|challenge-form/i.test(body.slice(0, 4000))) {
      return `[ddg_search] blocked by DuckDuckGo anomaly detection (HTTP ${status}). Retry later or fall back to websearch.`
    }
    if (status !== 200) {
      return `[ddg_search] HTTP ${status} for ${url}`
    }

    const blocks = body.split(/<div class="result results_links/).slice(1)
    const rows: string[] = []

    for (const b of blocks) {
      if (rows.length >= max) break
      const t = b.match(/<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/)
      if (!t) continue
      const href = realUrl(t[1])
      const title = plain(t[2])
      if (!title || !href) continue
      const s = b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/)
      const snippet = s ? plain(s[1]) : ""
      rows.push(`${rows.length + 1}. ${title}\n   ${href}\n   ${snippet}`)
    }

    if (rows.length === 0) {
      return `[ddg_search] no parseable results (HTTP ${status}, ${body.length} bytes). Page layout may have changed.`
    }
    return `[ddg_search] query="${args.query}" region=${region} results=${rows.length}\n\n${rows.join("\n\n")}`
  },
})
