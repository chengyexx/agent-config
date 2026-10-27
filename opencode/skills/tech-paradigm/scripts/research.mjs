#!/usr/bin/env node
// tech-paradigm —— 技术范式调研的数据采集层
//
// 设计分工(务必保持):
//   脚本只做确定性工作:多源召回、限流、缓存、客观硬闸门、跨源合并、证据压缩。
//   查询扩展、语义复核、可信度定级、综合判断 = agent 的职责(见 SKILL.md)。
//
// 数据源(2026-09-23 逐个实测直连可达):
//   GitHub Search API     实现/项目(token 可选,有 token 提额)
//   HN Algolia API        文章/社区讨论(points 社区票)
//   arXiv API             论文(recent + relevance 双切片)
//   HuggingFace papers    论文(upvotes)
//   OpenAlex              引用数(best-effort,共享出口 IP 下常 429,失败仅声明降级)
//
// 已知失效源,不要试图加回:
//   Semantic Scholar 未认证 = 全 429(共享池不可用),需申请 key,已砍
//   Papers With Code /api/v1 = 返回 HTML 不是 JSON,API 已死(agent 可 webfetch 页面兜底)

import { request, hasToken, resolveToken, sleep } from './lib/http.mjs';
import { memo, stats as cacheStats, clear as cacheClear } from './lib/cache.mjs';

const VERSION = '0.1.0';

// ── CLI 解析 ──────────────────────────────────────────────────────────────────

const HELP = `tech-paradigm research gatherer

node research.mjs gather "<q1; q2; ...>"   多查询采集 -> 证据包(默认输出 md 摘要 + JSON 文件)
  --days 365        论文/文章时间窗(天)
  --months 12       仓库最近 push 窗口(月)
  --per 8           每查询每源条数上限
  --depth full      full=含 OpenAlex+arXiv relevance 切片; quick=跳过
  --min-stars 50    仓库星数下限(0=不限)
  --min-points 10   HN points 下限
  --gate 1          1=关键词命中闸门(0=关,结果会混入噪声)
  --exclude "a,b"   追加黑名单词(默认已含 awesome/tutorial/... )
  --out <file>      JSON 输出路径(默认 ./research-evidence-<slug>.json)
node research.mjs readme <owner/repo>    读 README 前 120 行(语义复核用)
node research.mjs rate                   各源连通性/限额自检
node research.mjs cache stats|clear
`;

function parseArgs() {
  const a = process.argv.slice(2);
  const sub = a[0] || '';
  const flags = {};
  const rest = [];
  for (let i = 1; i < a.length; i++) {
    if (a[i].startsWith('--')) flags[a[i].slice(2)] = a[i + 1] !== undefined && !a[i + 1].startsWith('--') ? a[++i] : true;
    else rest.push(a[i]);
  }
  return { sub, rest, flags };
}

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

// ── 工具函数 ─────────────────────────────────────────────────────────────────

const tokenize = (s) =>
  String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);

const normTitle = (s) => (String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''));

const normUrl = (u) => {
  try {
    const p = new URL(String(u || ''));
    return (p.hostname.replace(/^www\./, '') + p.pathname.replace(/\/+$/, '')).toLowerCase();
  } catch { return String(u || '').toLowerCase(); }
};

const decode = (s) =>
  String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ');

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

function toPackItem({ title, year, kind, source, url, signals = {}, desc = '' }) {
  return { title: clip(title, 180), year: year ?? null, kinds: [kind], sources: [source], urls: url ? [url] : [], signals, desc: clip(desc, 320) };
}

// ── 数据源 ───────────────────────────────────────────────────────────────────

async function ghRepos(query, o) {
  const token = resolveToken();
  const out = { items: [], excluded: [] };
  const url =
    'https://api.github.com/search/repositories?q=' +
    encodeURIComponent(query) +
    '&sort=stars&order=desc&per_page=' + Math.min(o.per * 3, 30);
  try {
    const r = await request(url, {
      key: 'gh-search',
      minIntervalMs: token ? 2300 : 6500,
      headers: {
        Accept: 'application/vnd.github+json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!r.ok) { out.degraded = `http ${r.status}`; return out; }
    for (const it of r.data.items || []) {
      const pushed = it.pushed_at ? it.pushed_at.slice(0, 10) : '';
      const stars = it.stargazers_count || 0;
      const desc = it.description || '';
      const blob = `${it.full_name} ${desc}`.toLowerCase();
      const blacklist = ['awesome', 'tutorial', 'tutorials', 'roadmap', 'cheatsheet', 'interview-questions', 'course', 'resources', 'list-of', 'paper-collection'];
      let reason = '';
      if (it.archived) reason = 'archived';
      else if (it.fork) reason = 'fork';
      else if (o.minStars && stars < o.minStars) reason = `low-stars(${stars}<${o.minStars})`;
      else if (pushed && monthsAgo(pushed) > o.months) reason = `stale(pushed ${pushed}, >${o.months}mo)`;
      else {
        const hit = o.exclude.find((w) => blob.toLowerCase().includes(w));
        if (hit) reason = `blacklist:${hit}`;
      }
      if (reason) { out.excluded.push({ title: it.full_name, reason }); continue; }
      out.items.push(toPackItem({
        title: it.full_name,
        year: pushed ? pushed.slice(0, 4) : null,
        kind: 'repo',
        source: 'GitHub',
        url: it.html_url,
        signals: { stars, pushed_at: pushed, license: it.license?.spdx_id || null, language: it.language || null },
        desc,
      }));
    }
  } catch (e) {
    out.degraded = String(e.message || e).slice(0, 120);
  }
  return out;
}

function monthsAgo(dateStr) {
  const d = new Date(dateStr + (dateStr.length === 10 ? 'T00:00:00Z' : ''));
  return Math.max(0, (Date.now() - d.getTime()) / (30 * 86400e3));
}

async function hnSearch(query, o) {
  const out = { items: [], excluded: [] };
  const since = Math.floor(Date.now() / 1000) - o.days * 86400;
  const url =
    'https://hn.algolia.com/api/v1/search?query=' + encodeURIComponent(query) +
    '&tags=story&hitsPerPage=' + Math.min(o.per * 3, 30) +
    `&numericFilters=points>${o.minPoints},created_at_i>${Math.floor(Date.now() / 1000) - o.days * 86400}`;
  try {
    const r = await request(url, { key: 'hn', minIntervalMs: 400 });
    if (!r.ok) { out.degraded = `http ${r.status}`; return out; }
    for (const h of r.data.hits || []) {
      out.items.push(toPackItem({
        title: h.title || h.story_title || '',
        year: (h.created_at || '').slice(0, 4),
        kind: 'article',
        source: 'HackerNews',
        url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        signals: { points: h.points || 0, num_comments: h.num_comments || 0, hn_date: (h.created_at || '').slice(0, 10) },
        desc: `HN ${h.points || 0} 分 / ${h.num_comments || 0} 评` + (o.note || ''),
      }));
    }
  } catch (e) {
    out.degraded = String(e.message || e).slice(0, 120);
  }
  return out;
}

function parseAtom(xml) {
  const entries = [];
  const re = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const pick = (tag) => {
      const mm = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return mm ? decode(mm[1]).replace(/\s+/g, ' ').trim() : '';
    };
    const id = pick('id');
    entries.push({
      title: pick('title'),
      summary: pick('summary'),
      published: pick('published'),
      id,
    });
  }
  return entries;
}

async function arxivSearch(query, o, mode) {
  const out = { items: [], excluded: [] };
  const sortBy = mode === 'relevance' ? 'relevance' : 'submittedDate';
  const url =
    'https://export.arxiv.org/api/query?search_query=' + encodeURIComponent(`all:"${query}"`) +
    `&sortBy=${sortBy}&sortOrder=descending&max_results=${Math.min(o.per * 2, 20)}`;
  try {
    const r = await request(url, { key: 'arxiv', minIntervalMs: 3200, timeoutMs: 40000 });
    if (!r.ok || typeof r.data !== 'string') { out.degraded = `http ${r.status}`; return out; }
    for (const e of parseAtom(r.data)) {
      const date = (e.published || '').slice(0, 10);
      const arxivId = (e.id || '').replace(/^https?:\/\/arxiv\.org\/abs\//, '');
      if (mode === 'recent' && date && (Date.now() - new Date(date + 'T00:00:00Z') > o.days * 86400e3)) {
        out.excluded.push({ title: e.title, reason: 'outside-window' });
        continue;
      }
      out.items.push(toPackItem({
        title: e.title,
        year: date.slice(0, 4),
        kind: 'paper',
        source: 'arXiv',
        url: `https://arxiv.org/abs/${arxivId}`,
        signals: { published: date, arxiv_id: arxivId },
        desc: e.summary,
      }));
    }
  } catch (e) {
    out.degraded = String(e.message || e).slice(0, 120);
  }
  return out;
}

async function hfPapers(query, o) {
  const out = { items: [], excluded: [] };
  try {
    const r = await request('https://huggingface.co/api/papers/search?q=' + encodeURIComponent(query), { key: 'hf', minIntervalMs: 600 });
    if (!r.ok) { out.degraded = `http ${r.status}`; return out; }
    const arr = Array.isArray(r.data) ? r.data : [];
    for (const p of arr.slice(0, o.per * 2)) {
      const pp = p.paper || p;
      const date = (pp.publishedAt || '').slice(0, 10);
      if (date && (Date.now() - new Date(date + 'T00:00:00Z') > o.days * 86400e3)) {
        out.excluded.push({ title: pp.title, reason: 'outside-window' });
        continue;
      }
      out.items.push(toPackItem({
        title: pp.title,
        year: date.slice(0, 4),
        kind: 'paper',
        source: 'HFPapers',
        url: `https://huggingface.co/papers/${pp.id}`,
        signals: { upvotes: pp.upvotes ?? null, published: date, hf_id: pp.id },
        desc: pp.summary || '',
      }));
    }
  } catch (e) {
    out.degraded = String(e.message || e).slice(0, 120);
  }
  return out;
}

async function openalexEnrich(title, year) {
  // 只做富化(给已召回的论文补引用数),不作为召回源 —— 其 search 相关性差,
  // 高引用的无关老论文会霸榜。带标题相似度门槛,匹配不上就不给数字。
  try {
    const sel = 'id,display_name,publication_year,cited_by_count';
    const url = 'https://api.openalex.org/works?filter=' + encodeURIComponent(`title.search:${title}`) +
      '&per-page=3&select=' + sel + '&mailto=tech-paradigm@localhost';
    const r = await request(url, { key: 'openalex', minIntervalMs: 1200, retries: 1, timeoutMs: 35000 });
    if (r.status === 429) return { skipped: '429' };
    if (!r.ok) return { skipped: `http ${r.status}` };
    const key = normTitle(title);
    for (const w of r.data.results || []) {
      if (normTitle(w.display_name) === key && w.publication_year) {
        return { cited_by_count: w.cited_by_count || 0, year: w.publication_year };
      }
    }
    return null;
  } catch (e) {
    return { skipped: String(e.message || e).slice(0, 60) };
  }
}

// ── 采集主流程 ────────────────────────────────────────────────────────────────

const DEFAULT_EXCLUDE = ['awesome', 'tutorial', 'tutorials', 'roadmap', 'cheatsheet', 'interview', 'course', 'resources', 'list-of'];

async function gather({ queries, days, months, per, depth, gate, minStars, minPoints, exclude }) {
  const degraded = [];
  const excluded = [];
  const buckets = { repos: [], papers: [], articles: [], citations: [] };

  for (const q of queries) {
    const gh = await ghRepos(q, { per, months, minStars, exclude });
    if (gh.degraded) degraded.push({ source: 'GitHub', query: q, reason: gh.degraded });
    buckets.repos.push(...gh.items);
    excluded.push(...gh.excluded);

    const hn = await hnSearch(q, { per, days, minPoints });
    if (hn.degraded) degraded.push({ source: 'HackerNews', reason: hn.degraded });
    buckets.articles.push(...hn.items);
    excluded.push(...hn.excluded);

    for (const mode of depth === 'quick' ? ['recent'] : ['recent', 'relevance']) {
      const ax = await arxivSearch(q, { per }, mode);
      if (ax.degraded) degraded.push({ source: `arXiv:${mode}`, reason: ax.degraded });
      buckets.papers.push(...ax.items);
      excluded.push(...ax.excluded);
    }

    const hf = await hfPapers(q, { per, days });
    if (hf.degraded) degraded.push({ source: 'HFPapers', reason: hf.degraded });
    buckets.papers.push(...hf.items);
    excluded.push(...hf.excluded);
  }

  // ── 跨源合并(标题归一 + URL 归一)──
  const map = new Map();
  const put = (it) => {
    const k = normTitle(it.title) || normUrl(it.urls[0] || '');
    if (!k) return;
    const cur = map.get(k);
    if (!cur) {
      it.kinds = [...new Set(it.kinds)];
      it.sources = [...it.sources];
      map.set(k, it);
      return;
    }
    for (const kind of it.kinds) if (!cur.kinds.includes(kind)) cur.kinds.push(kind);
    for (const s of it.sources) if (!cur.sources.includes(s)) cur.sources.push(s);
    for (const u of it.urls) if (!cur.urls.includes(u)) cur.urls.push(u);
    cur.signals = { ...it.signals, ...cur.signals };
    if ((it.desc || '').length > (cur.desc || '').length) cur.desc = it.desc;
    if (it.url && !cur.urls.includes(it.url)) cur.urls.push(it.url);
    if (it.year && (!cur.year || String(it.year) > String(cur.year))) cur.year = it.year;
    if (!cur.url && it.url) cur.url = it.url;
  };
  for (const arr of [buckets.repos, buckets.papers, buckets.articles, buckets.citations]) for (const it of arr) put(it);

  // ── 关键词命中闸门(词级,语义判断归 agent)──
  const kept = [];
  let gatedOut = 0;
  for (const it of map.values()) {
    if (gate) {
      const blob = `${it.title} ${it.desc}`.toLowerCase();
      const matched = queries.some((q) => tokenize(q).some((w) => new RegExp(`\\b${w}\\b`).test(blob)));
      if (!matched) { gatedOut++; excluded.push({ title: it.title, reason: 'no-keyword-match' }); continue; }
    }
    // 选主 URL:仓库页 > arXiv abs > DOI > 其他
    it.url = it.urls.find((u) => /github\.com/.test(u)) ||
             it.urls.find((u) => /arxiv\.org/.test(u)) || it.urls[0] || '';
    kept.push(it);
  }

  // 重要性排序:跨源数 > 引用数 > 社区票 > 星
  kept.sort((a, b) =>
    (b.sources.length - a.sources.length) ||
    ((b.signals.cited_by_count || 0) - (a.signals.cited_by_count || 0)) ||
    ((b.signals.points || b.signals.upvotes || 0) - (a.signals.points || a.signals.upvotes || 0)) ||
    ((b.signals.stars || 0) - (a.signals.stars || 0)));

  const items = kept.slice(0, 60);

  // ── OpenAlex 引用数富化(best-effort,只对已召回论文,429 静默跳过)──
  let enrichSkipped = null;
  if (depth === 'full') {
    const targets = items
      .filter((it) => it.kinds.includes('paper') && it.signals.cited_by_count === undefined && it.desc)
      .sort((a, b) => (b.sources.length - a.sources.length))
      .slice(0, 10);
    for (const it of targets) {
      const res = await openalexEnrich(it.title, it.year);
      if (res?.skipped) { enrichSkipped = res.skipped; break; }
      if (res?.cited_by_count !== undefined) {
        it.signals.cited_by_count = res.cited_by_count;
        if (!it.sources.includes('OpenAlex')) it.sources.push('OpenAlex');
      }
    }
  }
  if (enrichSkipped) degraded.push({ source: 'OpenAlex(富化)', reason: enrichSkipped });
  return {
    skill: 'tech-paradigm', version: VERSION, generated_at: new Date().toISOString(),
    input: { queries, days, months, per, depth, min_stars: minStars, min_points: minPoints },
    degraded, stats: { raw: [...buckets.repos, ...buckets.papers, ...buckets.articles, ...buckets.citations].length, merged: map.size, gated_out: gatedOut, kept: items.length },
    excluded_note: `共 ${excluded.length} 条被闸门拦下(含同因去重前的重复)。前若干条:` ,
    excluded: excluded.slice(0, 15),
    items,
  };
}

// ── readme / rate ────────────────────────────────────────────────────────────

async function readme(slug) {
  const token = resolveToken();
  const key = `readme:${slug}`;
  return memo(key, 7 * 86400e3, async () => {
    const r = await request(`https://api.github.com/repos/${slug}/readme`, {
      headers: { Accept: 'application/vnd.github.raw', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    if (!r.ok) return { status: r.status, body: null };
    return { status: r.status, body: typeof r.data === 'string' ? r.data.split('\n').slice(0, 120).join('\n') : null };
  });
}

async function rate() {
  const out = {};
  const token = resolveToken();
  out.github = { authenticated: Boolean(token) };
  try {
    const r = await request('https://api.github.com/rate_limit', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      retries: 1,
    });
    out.github.search = r.data?.resources?.search ?? null;
  } catch (e) { out.github.error = String(e.message || e).slice(0, 80); }
  for (const [name, url] of [
    ['hackernews', 'https://hn.algolia.com/api/v1/search?query=test&hitsPerPage=1'],
    ['arxiv', 'https://export.arxiv.org/api/query?search_query=all:test&max_results=1'],
    ['hfpapers', 'https://huggingface.co/api/papers/search?q=test'],
    ['openalex', 'https://api.openalex.org/works?per-page=1&mailto=tech-paradigm@localhost'],
  ]) {
    try {
      const r = await request(url, { retries: 1, key: 'rate', minIntervalMs: 400, timeoutMs: 20000 });
      out[name] = r.ok ? 'ok' : `http ${r.status}`;
    } catch (e) { out[name] = 'unreachable: ' + String(e.message || e).slice(0, 60); }
  }
  return out;
}

// ── 输出 ─────────────────────────────────────────────────────────────────────

function digest(pack) {
  const L = [];
  L.push(`# tech-paradigm 证据包摘要 (${pack.generated_at})`);
  L.push(`查询: ${pack.input.queries.join(' | ')}`);
  L.push(`窗口: 文章/论文 ${pack.input.days} 天, 仓库 push ${pack.input.months} 月, depth=${pack.input.depth}`);
  if (pack.degraded.length) L.push(`⚠ 降级: ${pack.degraded.map((d) => `${d.source}(${d.reason})`).join(', ')}`);
  L.push(`\n条目 ${pack.stats.kept} (原始 ${pack.stats.raw} -> 合并去重 ${pack.stats.merged}, 闸门拦下 ${pack.stats.raw - pack.stats.kept})\n`);
  const byKind = {};
  for (const it of pack.items) for (const k of it.kinds) (byKind[k] ||= []).push(it);
  for (const [kind, arr] of Object.entries(byKind)) {
    L.push(`## ${kind} (${arr.length})`);
    for (const it of arr.slice(0, 12)) {
      const sig = Object.entries(it.signals).filter(([, v]) => v !== null && v !== '').map(([k, v]) => `${k}=${v}`).join(' ');
      L.push(`- [${it.sources.join('+')}] ${it.title}  |  ${it.year || ''}  ${sig}`);
      L.push(`  ${it.url}`);
      if (it.desc) L.push(`  ${it.desc.slice(0, 160)}`);
    }
    L.push('');
  }
  return L.join('\n');
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { sub, rest, flags } = parseArgs();
  const writeOut = async (s) => process.stdout.write(s + '\n');

  if (sub === 'cache') {
    if (rest[0] === 'clear') { cacheClear(); return writeOut('cache cleared'); }
    return writeOut(JSON.stringify(cacheStats(), null, 2));
  }

  if (sub === 'readme') {
    const r = await readme(rest[0] || '');
    if (!r.body) return writeOut(`README unavailable (status ${r.status})`);
    return writeOut(r.body);
  }

  if (sub === 'rate') return writeOut(JSON.stringify(await rate(), null, 2));

  if (sub === 'gather') {
    const raw = rest.join(' ').trim();
    if (!raw) return writeOut(HELP);
    const queries = raw.split(';').map((s) => s.trim()).filter(Boolean).slice(0, 6);
    const opts = {
      queries,
      days: num(flags.days, 365),
      months: num(flags.months, 12),
      per: num(flags.per, 8),
      depth: flags.depth === 'quick' ? 'quick' : 'full',
      gate: flags.gate !== '0' && flags.gate !== '0',
      minStars: num(flags['min-stars'], 50),
      minPoints: num(flags['min-points'], 10),
      exclude: String(flags.exclude || '').split(',').map((s) => s.trim()).filter(Boolean).concat(DEFAULT_EXCLUDE),
    };
    const pack = await gather(opts);
    const slug = queries[0].toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30);
    const file = flags.out || `research-evidence-${slug}.json`;
    const fs = await import('node:fs');
    fs.writeFileSync(file, JSON.stringify(pack, null, 2));
    if (flags.json) return writeOut(JSON.stringify(pack, null, 2));
    return writeOut(digest(pack) + `\n\n[full evidence pack] ${file}`);
  }

  return writeOut(HELP);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
