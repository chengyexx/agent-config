import { tool } from "@opencode-ai/plugin"
import { execFile } from "node:child_process"

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

const MARKER = "\n__HTTP_STATUS__:"

function curl(
  url: string,
  timeoutSec: number,
  referer: string | null,
): Promise<{ status: number; body: string; error?: string }> {
  const args = [
    "-s",
    "--compressed",
    "-L",
    "-w",
    `${MARKER}%{http_code}`,
    "-H",
    `User-Agent: ${UA}`,
    "-H",
    "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
    "-H",
    "Accept-Language: zh-CN,zh;q=0.9,en;q=0.8",
    ...(referer ? ["-H", `Referer: ${referer}`] : []),
    "--max-time",
    String(timeoutSec),
    url,
  ]
  return new Promise((resolve) => {
    execFile(
      "curl.exe",
      args,
      { timeout: (timeoutSec + 10) * 1000, maxBuffer: 32 * 1024 * 1024, encoding: "utf8", windowsHide: true },
      (err, stdout) => {
        const out = stdout ?? ""
        const i = out.lastIndexOf(MARKER)
        const status = i < 0 ? 0 : parseInt(out.slice(i + MARKER.length).trim().split("\n")[0], 10) || 0
        const body = i < 0 ? out : out.slice(0, i)
        if (err && !body) {
          resolve({ status, body: "", error: err.killed ? `timeout after ${timeoutSec}s` : err.message })
          return
        }
        resolve({ status, body })
      },
    )
  })
}

function decodeOnce(s: string): string {
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

function decodeEntities(s: string): string {
  const once = decodeOnce(s)
  return once === s ? once : decodeOnce(once)
}

function htmlToText(html: string): string {
  let s = html
  s = s.replace(/<!--[\s\S]*?-->/g, " ")
  s = s.replace(/<(script|style|svg|noscript|iframe|template|head)[\s\S]*?<\/\1>/gi, " ")
  s = s.replace(/<br\s*\/?>/gi, "\n")
  s = s.replace(/<\/(p|div|li|tr|td|h[1-6]|section|article|header|footer|blockquote|pre|table)>/gi, "\n")
  s = s.replace(/<[^>]+>/g, " ")
  s = decodeEntities(s)
  s = s.replace(/[ \t\u00a0]+/g, " ")
  s = s.replace(/\s*\n\s*/g, "\n")
  s = s.replace(/\n{3,}/g, "\n\n")
  return s.trim()
}

function looksLikeHtml(body: string): boolean {
  const head = body.trimStart().slice(0, 200).toLowerCase()
  return head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("<?xml")
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

export default tool({
  description:
    "Fetch several URLs concurrently with a browser User-Agent and convert HTML to clean text. Use it instead of calling webfetch once per page when a search returned multiple links you need to read. Returns per-URL status, byte size and truncated text, capped by a total character budget. Known limits: login-walled or JS-only sites (zhihu, xiaohongshu, weibo) still return 403 or empty; use CDP/Tabbit for those.",
  args: {
    urls: tool.schema.array(tool.schema.string()).describe("URLs to fetch (http/https)."),
    maxCharsPerPage: tool.schema.number().optional().describe("Truncate each page to this many chars (default 4000)."),
    maxTotalChars: tool.schema
      .number()
      .optional()
      .describe("Stop adding content after this many chars in total (default 30000)."),
    concurrency: tool.schema.number().optional().describe("Parallel requests (default 5, max 10)."),
    timeoutSeconds: tool.schema.number().optional().describe("Per-request timeout in seconds (default 30)."),
    includeHtml: tool.schema
      .boolean()
      .optional()
      .describe("Return raw HTML instead of cleaned text (default false)."),
    referer: tool.schema
      .string()
      .optional()
      .describe(
        "Referer header. 'same' (default) sends the URL itself and is required for some SSR sites such as nowcoder; 'none' omits it; or pass a full URL.",
      ),
  },
  async execute(args) {
    const urls = args.urls ?? []
    if (urls.length === 0) return "[batch_fetch] no urls given"

    const mode = (args.referer ?? "same").trim()
    const refererFor = (url: string): string | null => {
      if (mode === "none" || mode === "") return null
      if (mode === "same") return url
      return mode
    }

    const perPage = Math.max(500, args.maxCharsPerPage ?? 4000)
    const total = Math.max(perPage, args.maxTotalChars ?? 30000)
    const conc = Math.max(1, Math.min(args.concurrency ?? 5, 10))
    const timeout = Math.max(5, Math.min(args.timeoutSeconds ?? 30, 60))

    const results = await mapLimit(urls, conc, async (url) => {
      try {
        const r = await curl(url, timeout, refererFor(url))
        return { url, ...r }
      } catch (e: any) {
        return { url, status: 0, body: "", error: String(e?.message ?? e) }
      }
    })

    const needsRetry = (r: { url: string; status: number; body: string; error?: string }) => {
      if (r.error) return true
      if (r.status === 429 || r.status === 503 || r.status === 0) return true
      if (r.status === 401 || r.status === 403 || r.status === 412) return false
      return looksLikeHtml(r.body) && htmlToText(r.body).length < 40
    }

    const retryIdx = results.map((r, i) => (needsRetry(r) ? i : -1)).filter((i) => i >= 0)
    for (const i of retryIdx) {
      await new Promise((res) => setTimeout(res, 900))
      try {
        const r = await curl(urls[i], Math.max(timeout, 30), refererFor(urls[i]))
        results[i] = { url: urls[i], ...r }
      } catch {
        // keep the first attempt
      }
    }

    const parts: string[] = []
    let used = 0
    let skipped = 0

    results.forEach((r, idx) => {
      const head = `### ${idx + 1}. ${r.url}`
      if (r.error) {
        parts.push(`${head}\n[ERROR] ${r.error}`)
        return
      }
      if (!r.body) {
        parts.push(`${head}\n[EMPTY] HTTP ${r.status}`)
        return
      }
      if (r.status === 401 || r.status === 403 || r.status === 412) {
        parts.push(
          `${head}\n[BLOCKED] HTTP ${r.status} — anti-bot or login wall (${r.body.length}B). Needs a logged-in browser (CDP/Tabbit) or a platform MCP, not plain fetch.`,
        )
        return
      }
      if (r.status >= 400) {
        parts.push(`${head}\n[HTTP ${r.status}] ${r.body.length}B`)
        return
      }
      if (used >= total) {
        skipped++
        parts.push(`${head}\n[SKIPPED] total character budget reached (${total})`)
        return
      }

      const text = args.includeHtml || !looksLikeHtml(r.body) ? r.body : htmlToText(r.body)
      if (!args.includeHtml && looksLikeHtml(r.body) && text.length < 40) {
        parts.push(
          `${head}\n[NO TEXT] HTTP ${r.status}, ${r.body.length}B raw but ${text.length} chars of text — page is client-rendered (SPA) or content is behind JS/login. Use CDP/Tabbit or a platform MCP.`,
        )
        return
      }
      const budget = Math.min(perPage, total - used)
      const clipped = text.length > budget
      const body = clipped ? text.slice(0, budget) + `\n...[truncated ${text.length - budget} chars]` : text
      used += Math.min(text.length, budget)

      parts.push(`${head}\n[HTTP ${r.status}, ${r.body.length}B raw, ${text.length} chars text]\n${body}`)
    })

    const summary = `[batch_fetch] urls=${urls.length} ok=${results.filter((r) => r.status >= 200 && r.status < 400).length} used=${used}/${total} chars${skipped ? ` skipped=${skipped}` : ""}`
    return `${summary}\n\n${parts.join("\n\n")}`
  },
})
