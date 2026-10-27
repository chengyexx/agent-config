const DAY = 86400000;

const clamp01 = (x) => Math.max(0, Math.min(1, x));

export function daysSince(iso, now = Date.now()) {
  if (!iso) return Infinity;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Infinity;
  return (now - t) / DAY;
}

export function isStale(pushedAt, months) {
  return daysSince(pushedAt) > months * 30.44;
}

export function applyHardFilters(repos, opts = {}) {
  const { minStars = 0, months = 12, allowArchived = false, allowFork = false, license = null } = opts;
  const dropped = [];
  const kept = [];
  for (const r of repos) {
    const reasons = [];
    if (r.archived === true && !allowArchived) reasons.push('archived');
    if (r.isFork === true && !allowFork) reasons.push('fork');
    if (typeof r.stars !== 'number') {
      if (minStars > 0) reasons.push('stars-unknown');
    } else if (r.stars < minStars) {
      reasons.push(`stars<${minStars}`);
    }
    if (months > 0) {
      if (!r.pushedAt) reasons.push('pushed-unknown');
      else if (isStale(r.pushedAt, months)) reasons.push(`stale>${months}mo`);
    }
    if (license && r.license !== license) reasons.push(`license!=${license}`);
    if (reasons.length) dropped.push({ fullName: r.fullName, reasons });
    else kept.push(r);
  }
  return { kept, dropped };
}

export function scoreRepo(r) {
  const now = Date.now();
  const parts = {};

  parts.popularity = clamp01(Math.log10((r.stars || 0) + 1) / Math.log10(50001)) * 25;

  const d = daysSince(r.pushedAt, now);
  parts.activity = clamp01(1 - d / 365) * 25;

  const totalIssues = (r.openIssues || 0) + (r.closedIssues || 0);
  const closeRatio = totalIssues > 0 ? (r.closedIssues || 0) / totalIssues : 0.4;
  parts.community = clamp01(closeRatio) * 15;

  const commitPart = clamp01(Math.min(r.commits || 0, 20000) / 20000) * 0.6;
  const releasePart = clamp01(Math.min(r.releases || 0, 100) / 100) * 0.4;
  parts.maturity = (commitPart + releasePart) * 15;

  if (typeof r.downloads === 'number' && r.downloads > 0) {
    parts.adoption = clamp01(Math.log10(r.downloads + 1) / Math.log10(1e7)) * 10;
  } else {
    parts.adoption = 0;
  }

  if (typeof r.readmeLen === 'number' && r.readmeLen > 0) {
    parts.docs = clamp01(r.readmeLen / 8000) * 10;
  } else {
    parts.docs = 5;
  }

  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  return { total: Math.round(total * 10) / 10, parts };
}

export function dedupe(repos) {
  const byKey = new Map();
  for (const r of repos) {
    const key = (r.fullName || '').toLowerCase();
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...r, sources: [...new Set(r.sources || [])] });
      continue;
    }
    existing.sources = [...new Set([...(existing.sources || []), ...(r.sources || [])])];
    for (const f of ['description', 'license', 'language', 'pushedAt', 'topics', 'homepage']) {
      if (!existing[f] && r[f]) existing[f] = r[f];
    }
    for (const f of ['stars', 'forks', 'openIssues', 'commits', 'releases', 'closedIssues', 'downloads']) {
      if (typeof r[f] === 'number' && (typeof existing[f] !== 'number' || r[f] > existing[f])) {
        existing[f] = r[f];
      }
      else if (typeof existing[f] !== 'number' && typeof r[f] === 'number') existing[f] = r[f];
    }
  }
  return [...byKey.values()];
}

export function mergeEnrichment(repo, en) {
  if (!en) return repo;
  return {
    ...repo,
    stars: typeof en.stars === 'number' ? en.stars : repo.stars,
    forks: typeof en.forks === 'number' ? en.forks : repo.forks,
    archived: typeof en.archived === 'boolean' ? en.archived : repo.archived,
    isFork: typeof en.isFork === 'boolean' ? en.isFork : repo.isFork,
    pushedAt: en.pushedAt || repo.pushedAt,
    createdAt: en.createdAt || repo.createdAt,
    license: en.license || repo.license,
    language: en.language || repo.language,
    commits: en.commits,
    releases: en.releases,
    openIssues: en.openIssues,
    closedIssues: en.closedIssues,
    topics: (en.topics && en.topics.length ? en.topics : repo.topics) || [],
  };
}

export function warnings(r) {
  const w = [];
  if (!r.license) w.push('no-license');
  if (isStale(r.pushedAt, 6)) w.push('low-activity');
  if ((r.openIssues || 0) > 500) w.push('issue-backlog');
  if ((r.commits || 0) > 0 && r.commits < 50) w.push('immature');
  if (r.readmeUnavailable) w.push('readme-unavailable');
  if (r.verifyError) w.push(`verify-failed(${r.verifyError})`);
  return w;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'for', 'with', 'and', 'or', 'to', 'of', 'in', 'on', 'that',
  'which', 'is', 'are', 'be', 'it', 'its', 'as', 'at', 'by', 'from', 'into',
  'support', 'supports', 'supported', 'library', 'tool', 'framework', 'like',
  'using', 'use', 'need', 'want', 'find', 'open', 'source', 'best', 'good',
]);

export function queryTerms(query) {
  const raw = String(query)
    .toLowerCase()
    .replace(/[^a-z0-9+#.\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  return [...new Set(raw)];
}

export function relevance(r, terms) {
  if (!terms.length) return { ratio: 1, hits: [] };
  const hay = [r.fullName, r.name, r.description, (r.topics || []).join(' ')]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const hits = terms.filter((t) => termHit(hay, t));
  return { ratio: hits.length / terms.length, hits };
}

function termHit(hay, term) {
  if (!/^[a-z0-9]/.test(term)) return hay.includes(term);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return new RegExp('\\b' + escaped).test(hay);
  } catch {
    return hay.includes(term);
  }
}

export function applyRelevanceGate(repos, terms, minRatio) {
  const kept = [];
  const dropped = [];
  for (const r of repos) {
    const rel = relevance(r, terms);
    r.match = rel;
    if (rel.ratio >= minRatio) kept.push(r);
    else dropped.push({ fullName: r.fullName, reasons: [`low-relevance(${rel.ratio.toFixed(2)})`] });
  }
  return { kept, dropped };
}

export function formatNumber(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '-';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

export function markdownTable(rows) {
  const header = '| # | Repo | Score | Stars | Last push | License | Downloads/mo | Signals |';
  const sep = '|---|------|-------|-------|-----------|---------|--------------|---------|';
  const lines = rows.map((r, i) => {
    const d = daysSince(r.pushedAt);
    const push = d === Infinity ? '-' : d < 1 ? 'today' : d < 45 ? `${Math.round(d)}d ago` : `${Math.round(d / 30.44)}mo ago`;
    const sig = [
      r.verified ? 'code:verified(' + r.verified.total + ')' : null,
      r.sources && r.sources.length > 1 ? 'multi-source' : null,
      ...warnings(r),
    ].filter(Boolean).join(', ') || '-';
    return `| ${i + 1} | [${r.fullName}](${r.url || 'https://github.com/' + r.fullName}) | ${r.score.total} | ${formatNumber(r.stars)} | ${push} | ${r.license || '-'} | ${formatNumber(r.downloads)} | ${sig} |`;
  });
  return [header, sep, ...lines].join('\n');
}
