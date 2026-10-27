import { tool } from "@opencode-ai/plugin"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"

const UVX = "uvx"
const SERVER_ARGS = ["--python", "3.12", "--from", "cn-scraper-mcp", "cn-scraper-mcp"]
const IDLE_MS = 10 * 60 * 1000
const BOOT_TIMEOUT = 120000
const CALL_TIMEOUT = 90000

type Pending = { resolve: (v: any) => void; reject: (e: any) => void; timer: NodeJS.Timeout }

let proc: ChildProcessWithoutNullStreams | null = null
let booting: Promise<void> | null = null
let buf = ""
let nextId = 1
const pending = new Map<number, Pending>()
let idleTimer: NodeJS.Timeout | null = null

const KEYWORD_FIELD: Record<string, string | null> = {
  bilibili_search: "keyword",
  douban_search: "keyword",
  zhihu_search: "keyword",
  weibo_search: "keyword",
  xiaohongshu_search: "keyword",
  douyin_search: "keyword",
  taobao_search: "keyword",
  jd_search: "keyword",
  dianping_search: "keyword",
  bilibili_popular: null,
  bilibili_video: "bvid",
  bilibili_comments: "bvid",
  zhihu_hot_list: null,
  zhihu_answer: "answer_id",
  zhihu_question_answers: "question_id",
  zhihu_comments: "answer_id",
  weibo_hot_list: null,
  weibo_post: "mid",
  weibo_comments: "mid",
  weibo_user_timeline: "uid",
  douban_subject: "subject_id",
  douban_reviews: "subject_id",
  xiaohongshu_note: "note_id",
  xiaohongshu_comments: "note_id",
}

function touchIdle() {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    try {
      proc?.kill()
    } catch {
      // ignore
    }
    proc = null
    buf = ""
  }, IDLE_MS)
  idleTimer.unref?.()
}

function failAll(err: Error) {
  for (const [, p] of pending) {
    clearTimeout(p.timer)
    p.reject(err)
  }
  pending.clear()
}

function onData(chunk: Buffer) {
  buf += chunk.toString("utf8")
  let i: number
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.id != null && pending.has(msg.id)) {
      const p = pending.get(msg.id)!
      pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(msg.error?.message ?? JSON.stringify(msg.error)))
      else p.resolve(msg.result)
    }
  }
}

function send(obj: any) {
  if (!proc) throw new Error("cn-scraper-mcp is not running")
  proc.stdin.write(JSON.stringify(obj) + "\n")
}

function rpc(method: string, params: any, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!proc) {
      reject(new Error("cn-scraper-mcp is not running"))
      return
    }
    const id = nextId++
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${method} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    timer.unref?.()
    pending.set(id, { resolve, reject, timer })
    try {
      send({ jsonrpc: "2.0", id, method, params })
    } catch (e: any) {
      pending.delete(id)
      clearTimeout(timer)
      reject(e)
    }
  })
}

async function boot(): Promise<void> {
  if (proc && !proc.killed) return
  if (booting) return booting
  booting = (async () => {
    const child = spawn(UVX, SERVER_ARGS, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: process.env,
    })
    proc = child
    buf = ""
    child.stdout.on("data", onData)
    child.stderr.on("data", () => {})
    child.on("exit", () => {
      proc = null
      failAll(new Error("cn-scraper-mcp process exited"))
    })
    await rpc(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "opencode-gateway", version: "1" },
      },
      BOOT_TIMEOUT,
    )
    send({ jsonrpc: "2.0", method: "notifications/initialized" })
  })()
  try {
    await booting
  } finally {
    booting = null
  }
}

function extract(result: any): string {
  if (!result) return "(empty result)"
  if (Array.isArray(result.content)) {
    const parts = result.content.map((c: any) =>
      c?.type === "text" ? String(c.text ?? "") : `[${c?.type ?? "unknown"}]`,
    )
    const text = parts.join("\n").trim()
    return text.length ? text : "(empty content)"
  }
  return JSON.stringify(result)
}

export default tool({
  description:
    "On-demand gateway to Chinese platforms (Bilibili, Douban, Zhihu, Weibo, Xiaohongshu). The MCP server is spawned only when this tool is called and auto-exits after 10 min idle, so it costs no context otherwise. Pass tool name plus keyword (for *_search) or argsJson for anything else. Use tool='__list' to see every available tool. Login-required tools return an action_required hint: zhihu_search/zhihu_answer/weibo_search need a one-time login via tool='guided_login'. Login-walled pages cannot be fetched by batch_fetch; use this gateway instead.",
  args: {
    tool: tool.schema
      .string()
      .describe(
        "MCP tool name, e.g. bilibili_search, bilibili_popular, bilibili_video, bilibili_comments, douban_search, douban_subject, douban_reviews, zhihu_search, zhihu_hot_list, zhihu_answer, weibo_search, weibo_hot_list, xiaohongshu_search, guided_login, check_cookies; or '__list'.",
      ),
    keyword: tool.schema
      .string()
      .optional()
      .describe("Search keyword / id for the tool (mapped to keyword, bvid, note_id, mid, etc. automatically)."),
    argsJson: tool.schema
      .string()
      .optional()
      .describe("Full JSON object of arguments, overrides keyword mapping. Example: {\"keyword\":\"秋招\",\"page\":2}"),
    limit: tool.schema.number().optional().describe("Optional: trim long JSON results to roughly this many chars."),
  },
  async execute(args) {
    const name = (args.tool ?? "").trim()
    if (!name) return "[cn_search] missing tool name"

    try {
      await boot()
    } catch (e: any) {
      return `[cn_search] failed to start cn-scraper-mcp: ${String(e?.message ?? e)}`
    } finally {
      touchIdle()
    }

    try {
      if (name === "__list") {
        const res = await rpc("tools/list", {}, 30000)
        const list = (res?.tools ?? []).map((t: any) => `${t.name} — ${t.description ?? ""}`.trim())
        return `[cn_search] ${list.length} tools\n${list.join("\n")}`
      }

      const payload: Record<string, any> = {}
      if (args.argsJson) {
        try {
          Object.assign(payload, JSON.parse(args.argsJson))
        } catch (e: any) {
          return `[cn_search] argsJson is not valid JSON: ${String(e?.message ?? e)}`
        }
      }
      if (args.keyword) {
        const field = name in KEYWORD_FIELD ? KEYWORD_FIELD[name] : "keyword"
        if (field) payload[field] = args.keyword
      }

      const res = await rpc("tools/call", { name, arguments: payload }, CALL_TIMEOUT)
      touchIdle()

      let text = extract(res)
      if (res?.isError) text = `[cn_search] tool returned an error\n${text}`

      if (/cookies?|登录|login required|ACTION_REQUIRED|action_required/i.test(text)) {
        const platform = /知乎|zhihu/i.test(text)
          ? "zhihu"
          : /微博|weibo/i.test(text)
            ? "weibo"
            : /小红书|xiaohongshu/i.test(text)
              ? "xiaohongshu"
              : ""
        if (platform) {
          text += `\n\n[cn_search] hint: needs a logged-in session. Ask the user to run tool='guided_login' with argsJson='{\"platform\":\"${platform}\"}' — it opens a browser for a one-time QR login and stores cookies locally.`
        }
      }

      const cap = args.limit && args.limit > 0 ? args.limit : 0
      if (cap && text.length > cap) {
        text = text.slice(0, cap) + `\n...[truncated ${text.length - cap} chars; pass limit=0 for full]`
      }
      return `[cn_search] tool=${name}\n${text}`
    } catch (e: any) {
      const msg = String(e?.message ?? e)
      if (/not.*login|login|cookie|ACTION_REQUIRED|action_required/i.test(msg)) {
        return `[cn_search] ${name} needs a logged-in session: ${msg}\nNext: call cn_search with tool='guided_login' and argsJson='{"platform":"zhihu"}' (platform: zhihu/weibo/xiaohongshu).`
      }
      return `[cn_search] ${name} failed: ${msg}`
    } finally {
      touchIdle()
    }
  },
})
