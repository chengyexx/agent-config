import { request } from './http.mjs';

const UA = { 'User-Agent': 'opencode-github-discovery' };

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export function repoFromUrl(u) {
  if (!u || typeof u !== 'string') return null;
  let s = u.trim();
  s = s.replace(/^git\+/, '');
  const m =
    s.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/) ||
    s.match(/^github:([^/]+)\/(.+?)(?:\.git)?$/) ||
    s.match(/github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[#?].*)?$/);
  if (!m) return null;
  return `${m[1]}/${m[2]}`.replace(/\.git$/, '');
}

export async function npmSearch(text, size = 20) {
  const u = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}&size=${size}`;
  const r = await request(u, { headers: UA, retries: 2 });
  if (!r.ok || !r.data || !r.data.objects) return [];
  return r.data.objects.map((o) => {
    const p = o.package || {};
    const links = p.links || {};
    return {
      name: p.name,
      version: p.version,
      description: p.description || '',
      repository: links.repository || null,
      homepage: links.homepage || null,
      npmScore: typeof o.score === 'object' ? o.score.final : null,
    };
  });
}

export async function npmDownloads(names) {
  const out = {};
  const uniq = [...new Set(names.filter(Boolean))];
  const plain = uniq.filter((n) => !n.startsWith('@'));
  const scoped = uniq.filter((n) => n.startsWith('@'));

  for (const batch of chunk(plain, 60)) {
    const u = `https://api.npmjs.org/downloads/point/last-month/${batch.map(encodeURIComponent).join(',')}`;
    const r = await request(u, { headers: UA, retries: 2 });
    if (!r.ok || !r.data) continue;
    if (batch.length === 1) {
      if (typeof r.data.downloads === 'number') out[batch[0]] = r.data.downloads;
    } else {
      for (const [k, v] of Object.entries(r.data)) {
        if (v && typeof v.downloads === 'number') out[k] = v.downloads;
      }
    }
  }

  for (const name of scoped) {
    const u = `https://api.npmjs.org/downloads/point/last-month/${encodeURIComponent(name)}`;
    const r = await request(u, { headers: UA, retries: 2 });
    if (r.ok && r.data && typeof r.data.downloads === 'number') out[name] = r.data.downloads;
  }
  return out;
}

export async function pypiDownloads(pkg) {
  const u = `https://pypistats.org/api/packages/${encodeURIComponent(pkg)}/recent`;
  const r = await request(u, { headers: UA, retries: 2 });
  if (!r.ok || !r.data || !r.data.data) return null;
  return typeof r.data.data.last_month === 'number' ? r.data.data.last_month : null;
}

export async function pypiInfo(pkg) {
  const r = await request(`https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`, {
    headers: UA,
    retries: 2,
  });
  if (!r.ok || !r.data || !r.data.info) return null;
  const info = r.data.info;
  const candidates = [
    info.project_url,
    info.home_page,
    ...Object.values(info.project_urls || {}),
  ].filter(Boolean);
  let repository = null;
  for (const c of candidates) {
    if (repoFromUrl(c)) { repository = c; break; }
  }
  return { name: info.name, repository, summary: info.summary || null };
}
