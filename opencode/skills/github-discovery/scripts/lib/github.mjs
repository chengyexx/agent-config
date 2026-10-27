import { request, resolveToken, hasToken } from './http.mjs';

const API = 'https://api.github.com';
const SEARCH_INTERVAL_MS = 2200;
const CODE_INTERVAL_MS = 6200;

export { hasToken };

function baseHeaders() {
  const h = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const t = resolveToken();
  if (t) h.Authorization = `Bearer ${t}`;
  return h;
}

export function normalizeRepo(i) {
  return {
    fullName: i.full_name,
    owner: i.owner && i.owner.login,
    name: i.name,
    url: i.html_url,
    description: i.description || '',
    stars: i.stargazers_count,
    forks: i.forks_count,
    openIssues: i.open_issues_count,
    language: i.language || null,
    license: (i.license && i.license.spdx_id) || null,
    pushedAt: i.pushed_at,
    createdAt: i.created_at,
    archived: Boolean(i.archived),
    isFork: Boolean(i.fork),
    topics: i.topics || [],
    homepage: i.homepage || null,
    sources: ['github'],
  };
}

export async function searchRepos({ q, sort = 'stars', order = 'desc', perPage = 30, page = 1 }) {
  const u =
    `${API}/search/repositories?q=${encodeURIComponent(q)}` +
    `&sort=${sort}&order=${order}&per_page=${perPage}&page=${page}`;
  const r = await request(u, {
    headers: baseHeaders(),
    key: 'github:search',
    minIntervalMs: SEARCH_INTERVAL_MS,
    retries: 4,
  });
  if (!r.ok) {
    const msg = typeof r.data === 'object' ? JSON.stringify(r.data).slice(0, 300) : String(r.data).slice(0, 300);
    throw new Error(`GitHub search failed (${r.status}): ${msg}`);
  }
  return { total: r.data.total_count, items: (r.data.items || []).map(normalizeRepo) };
}

const ENRICH_FIELDS = `
  nameWithOwner
  stargazerCount
  forkCount
  isArchived
  isFork
  pushedAt
  createdAt
  licenseInfo { spdxId }
  primaryLanguage { name }
  repositoryTopics(first: 10) { nodes { topic { name } } }
  openIssues: issues(states: OPEN) { totalCount }
  closedIssues: issues(states: CLOSED) { totalCount }
  releases { totalCount }
  defaultBranchRef { target { ... on Commit { history { totalCount } } } }
`;

export async function graphql(query, variables) {
  const r = await request(`${API}/graphql`, {
    method: 'POST',
    headers: { ...baseHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    timeoutMs: 45000,
    retries: 3,
  });
  const payload = r.data && typeof r.data === 'object' ? r.data : null;
  if (!r.ok && !(payload && payload.data)) {
    throw new Error(`GraphQL failed (${r.status})`);
  }
  return {
    data: (payload && payload.data) || null,
    errors: (payload && payload.errors) || null,
  };
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function toEnriched(v) {
  if (!v || !v.nameWithOwner) return null;
  return {
    fullName: v.nameWithOwner,
    stars: v.stargazerCount,
    forks: v.forkCount,
    archived: typeof v.isArchived === 'boolean' ? v.isArchived : undefined,
    isFork: typeof v.isFork === 'boolean' ? v.isFork : undefined,
    pushedAt: v.pushedAt,
    createdAt: v.createdAt,
    license: (v.licenseInfo && v.licenseInfo.spdxId) || null,
    language: (v.primaryLanguage && v.primaryLanguage.name) || null,
    commits:
      (v.defaultBranchRef &&
        v.defaultBranchRef.target &&
        v.defaultBranchRef.target.history &&
        v.defaultBranchRef.target.history.totalCount) ||
      null,
    releases: (v.releases && v.releases.totalCount) || 0,
    openIssues: (v.openIssues && v.openIssues.totalCount) || 0,
    closedIssues: (v.closedIssues && v.closedIssues.totalCount) || 0,
    topics: ((v.repositoryTopics && v.repositoryTopics.nodes) || []).map((x) => x.topic.name),
  };
}

function repoQuery(fn, alias = 'r') {
  const [owner, name] = fn.split('/');
  return `${alias}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${ENRICH_FIELDS} }`;
}

export async function enrich(fullNames) {
  const result = {};
  const names = [...new Set(fullNames.filter((n) => /^[^/]+\/[^/]+$/.test(n)))];
  const batches = chunk(names, 40);
  for (const batch of batches) {
    let data = null;
    try {
      const res = await graphql(`query { ${batch.map((fn, i) => repoQuery(fn, 'r' + i)).join('\n')} }`);
      data = res.data;
    } catch {
      data = null;
    }
    const missing = [];
    if (data) {
      for (const v of Object.values(data)) {
        const e = toEnriched(v);
        if (e) result[e.fullName] = e;
      }
      for (const fn of batch) if (!result[fn]) missing.push(fn);
    } else {
      missing.push(...batch);
    }
    for (const fn of missing) {
      try {
        const res = await graphql(`query { ${repoQuery(fn)} }`);
        const e = res.data ? toEnriched(res.data.r) : null;
        if (e) result[e.fullName] = e;
      } catch {}
    }
  }
  return result;
}

export async function codeSearch(q, perPage = 5) {
  const u = `${API}/search/code?q=${encodeURIComponent(q)}&per_page=${perPage}`;
  const r = await request(u, {
    headers: baseHeaders(),
    key: 'github:code',
    minIntervalMs: CODE_INTERVAL_MS,
    retries: 2,
  });
  if (!r.ok) return { ok: false, status: r.status, total: 0, items: [] };
  return {
    ok: true,
    total: r.data.total_count,
    items: (r.data.items || []).map((i) => ({
      repo: i.repository.full_name,
      path: i.path,
      url: i.html_url,
    })),
  };
}

export async function getReadme(fullName) {
  const r = await request(`${API}/repos/${fullName}/readme`, {
    headers: { ...baseHeaders(), Accept: 'application/vnd.github.raw+json' },
    retries: 2,
  });
  if (!r.ok) return null;
  return typeof r.data === 'string' ? r.data : null;
}

export async function rateLimit() {
  const r = await request(`${API}/rate_limit`, { headers: baseHeaders(), retries: 2 });
  if (!r.ok) return null;
  const res = r.data.resources || {};
  const pick = (k) => (res[k] ? { remaining: res[k].remaining, limit: res[k].limit } : null);
  return {
    authenticated: hasToken(),
    core: pick('core'),
    search: pick('search'),
    code_search: pick('code_search'),
    graphql: pick('graphql'),
  };
}
