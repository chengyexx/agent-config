#!/usr/bin/env node
import {
  searchRepos,
  enrich,
  codeSearch,
  getReadme,
  rateLimit,
  hasToken,
} from './lib/github.mjs';
import { npmSearch, npmDownloads, pypiDownloads, pypiInfo, repoFromUrl } from './lib/registry.mjs';
import {
  applyHardFilters,
  applyRelevanceGate,
  queryTerms,
  scoreRepo,
  dedupe,
  mergeEnrichment,
  markdownTable,
  warnings,
  daysSince,
} from './lib/rank.mjs';
import { memo, stats as cacheStats, clear as cacheClear } from './lib/cache.mjs';

const README_TTL = 7 * 86400000;
const SEARCH_TTL = 6 * 3600000;

function parseArgs(argv) {
  const opts = {
    query: '',
    lang: null,
    minStars: 100,
    months: 12,
    minMatch: 0.5,
    matchGate: true,
    exclude: [],
    limit: 10,
    candidates: 50,
    npm: true,
    verify: false,
    verifyTop: 5,
    codeTerms: null,
    deep: true,
    json: false,
    pageSize: 30,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--lang': case '--language': opts.lang = next(); break;
      case '--min-stars': opts.minStars = Number(next()); break;
      case '--months': opts.months = Number(next()); break;
      case '--min-match': opts.minMatch = Number(next()); break;
      case '--no-match-gate': opts.matchGate = false; break;
      case '--exclude': opts.exclude = String(next()).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean); break;
      case '--limit': opts.limit = Number(next()); break;
      case '--candidates': case '--top': opts.candidates = Number(next()); break;
      case '--no-npm': opts.npm = false; break;
      case '--verify': opts.verify = true; break;
      case '--verify-top': opts.verifyTop = Number(next()); opts.verify = true; break;
      case '--code-terms': opts.codeTerms = next(); opts.verify = true; break;
      case '--no-deep': opts.deep = false; break;
      case '--json': opts.json = true; break;
      case '--page-size': opts.pageSize = Number(next()); break;
      default:
        if (a.startsWith('--')) throw new Error(`unknown option: ${a}`);
        positional.push(a);
    }
  }
  opts.query = positional.join(' ').trim();
  return opts;
}

const isoDaysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

function buildGitHubQuery(query, opts, field) {
  const parts = [query, `in:${field}`];
  if (opts.lang) parts.push(`language:${opts.lang}`);
  if (opts.minStars > 0) parts.push(`stars:>=${opts.minStars}`);
  parts.push('archived:false', 'fork:false');
  if (opts.months > 0) parts.push(`pushed:>${isoDaysAgo(opts.months * 30.44)}`);
  return parts.join(' ');
}

async function recallGitHub(query, opts) {
  const queries = [
    { q: buildGitHubQuery(query, opts, 'name,description'), sort: 'stars' },
    { q: buildGitHubQuery(query, opts, 'description,readme'), sort: 'best-match' },
  ];
  const items = [];
  const errors = [];
  for (const { q, sort } of queries) {
    try {
      const out = await memo(`ghsearch:${q}:${sort}`, SEARCH_TTL, () =>
        searchRepos({ q, sort, perPage: Math.min(opts.candidates, opts.pageSize) })
      );
      items.push(...out.items);
    } catch (e) {
      errors.push(e.message);
    }
  }
  return { items, errors };
}

async function recallNpm(query, opts) {
  if (!opts.npm) return { items: [], errors: [] };
  try {
    const pkgs = await npmSearch(query, 25);
    const items = [];
    for (const p of pkgs) {
      const fullName = repoFromUrl(p.repository);
      if (!fullName) continue;
      const [owner, name] = fullName.split('/');
      items.push({
        fullName, owner, name,
        url: 'https://github.com/' + fullName,
        description: p.description,
        npmPackage: p.name,
        npmScore: p.npmScore,
        sources: ['npm'],
      });
    }
    return { items, errors: [] };
  } catch (e) {
    return { items: [], errors: [e.message] };
  }
}

async function attachDownloads(repos) {
  const npmNames = [...new Set(repos.map((r) => r.npmPackage).filter(Boolean))];
  if (npmNames.length) {
    const npmMap = await npmDownloads(npmNames).catch(() => ({}));
    for (const r of repos) {
      if (r.npmPackage && typeof npmMap[r.npmPackage] === 'number') {
        r.downloads = npmMap[r.npmPackage];
        r.downloadsSource = `npm:${r.npmPackage}`;
      }
    }
  }
  const pending = repos.filter((r) => r.downloads === undefined).slice(0, 15);
  for (const r of pending) {
    const guess = ((r.name || r.fullName.split('/')[1]) || '').toLowerCase();
    if (!guess) continue;
    const info = await memo(`pypiinfo:${guess}`, README_TTL, () => pypiInfo(guess)).catch(() => null);
    const mapped = info && repoFromUrl(info.repository);
    if (!mapped || mapped.toLowerCase() !== r.fullName.toLowerCase()) continue;
    const d = await memo(`pypi:${guess}`, README_TTL, () => pypiDownloads(guess)).catch(() => null);
    if (typeof d === 'number') {
      r.downloads = d;
      r.downloadsSource = `pypi:${guess}`;
    }
  }
}

async function attachReadmeLen(repos) {
  for (const r of repos) {
    const md = await memo(`readme:${r.fullName}`, README_TTL, () => getReadme(r.fullName)).catch(() => null);
    if (typeof md === 'string') r.readmeLen = md.length;
    else r.readmeUnavailable = true;
  }
}

async function verifyTop(repos, opts) {
  if (!opts.verify || !hasToken()) return;
  const term = (opts.codeTerms || opts.query).trim();
  if (!term) return;
  for (const r of repos.slice(0, Math.max(0, opts.verifyTop))) {
    try {
      const res = await memo(`code:${r.fullName}:${term}`, SEARCH_TTL, () =>
        codeSearch(`repo:${r.fullName} ${term}`, 3)
      );
      if (res && res.ok) r.verified = { total: res.total, samples: res.items.slice(0, 2) };
      else if (res) r.verifyError = res.status;
    } catch (e) {
      r.verifyError = e.message.slice(0, 60);
    }
  }
}

async function runDiscover(opts) {
  if (!opts.query) throw new Error('missing query');
  const notes = [];
  if (!hasToken()) {
    notes.push('no GITHUB_TOKEN: GraphQL enrichment + code search disabled (degraded mode)');
  }

  const gh = await recallGitHub(opts.query, opts);
  const npm = await recallNpm(opts.query, opts);
  notes.push(...gh.errors, ...npm.errors);

  let repos = dedupe([...gh.items, ...npm.items]);
  const recalled = repos.length;

  if (hasToken()) {
    const names = repos.map((r) => r.fullName);
    const en = await enrich(names).catch(() => ({}));
    repos = repos.map((r) => mergeEnrichment(r, en[r.fullName]));
    const got = Object.keys(en).length;
    if (names.length) {
      if (got === 0) notes.push(`GraphQL enrichment returned 0/${names.length}; scores fall back to REST fields only (activity/community/maturity unavailable)`);
      else if (got < names.length * 0.5) notes.push(`GraphQL enrichment partial: ${got}/${names.length} repos`);
    }
  }

  await attachDownloads(repos);

  const f = applyHardFilters(repos, { minStars: opts.minStars, months: opts.months });
  let kept = f.kept;
  const dropped = [...f.dropped];

  if (opts.matchGate) {
    const g = applyRelevanceGate(kept, queryTerms(opts.query), opts.minMatch);
    kept = g.kept;
    dropped.push(...g.dropped);
  }

  if (opts.exclude.length) {
    const keep = [];
    for (const r of kept) {
      const hay = [r.fullName, r.description, (r.topics || []).join(' ')].filter(Boolean).join(' ').toLowerCase();
      const hit = opts.exclude.find((t) => hay.includes(t));
      if (hit) dropped.push({ fullName: r.fullName, reasons: [`excluded(${hit})`] });
      else keep.push(r);
    }
    kept = keep;
  }

  if (opts.deep) {
    const pre = [...kept].sort((a, b) => (b.stars || 0) - (a.stars || 0));
    const readmeCount = hasToken() ? Math.max(opts.limit * 3, 20) : opts.limit;
    await attachReadmeLen(pre.slice(0, readmeCount));
  }

  for (const r of kept) {
    r.score = scoreRepo(r);
    r.warnings = warnings(r);
  }
  kept.sort((a, b) => b.score.total - a.score.total);

  if (opts.verify) await verifyTop(kept, opts);

  return { recalled, afterFilter: kept.length, dropped, top: kept.slice(0, opts.limit), notes };
}

function printDiscovery(result, opts) {
  const { recalled, afterFilter, top, dropped, notes } = result;
  if (opts.json) {
    console.log(JSON.stringify({ query: opts.query, recalled, afterFilter, top, dropped, notes }, null, 2));
    return;
  }
  console.log(`# Open-source discovery: "${opts.query}"`);
  console.log('');
  console.log(`recalled=${recalled}  afterFilter=${afterFilter}  showing=${top.length}  token=${hasToken() ? 'yes' : 'NO (degraded)'}`);
  console.log('');
  if (!top.length) {
    console.log('_No candidates passed the filters. Loosen --min-stars / --months / --min-match or broaden the query._');
  } else {
    console.log(markdownTable(top));
    console.log('');
    console.log('## Detail');
    for (const r of top) {
      const d = daysSince(r.pushedAt);
      const p = r.score.parts;
      console.log(`- **${r.fullName}** — ${r.description || '(no description)'}`);
      console.log(`  - score ${r.score.total} (pop ${p.popularity.toFixed(0)}/25, act ${p.activity.toFixed(0)}/25, comm ${p.community.toFixed(0)}/15, mat ${p.maturity.toFixed(0)}/15, adopt ${p.adoption.toFixed(0)}/10, docs ${p.docs.toFixed(0)}/10)`);
      console.log(`  - stars ${r.stars} · forks ${r.forks} · commits ${r.commits ?? '-'} · releases ${r.releases ?? '-'} · issues open/closed ${r.openIssues ?? '-'}/${r.closedIssues ?? '-'} · last push ${d === Infinity ? '-' : Math.round(d) + 'd'}`);
      console.log(`  - license ${r.license || 'NONE'} · language ${r.language || '-'} · downloads ${r.downloads ?? '-'}${r.downloadsSource ? ' (' + r.downloadsSource + ')' : ''} · sources ${(r.sources || []).join('+')}`);
      if (r.topics && r.topics.length) console.log(`  - topics ${r.topics.slice(0, 8).join(', ')}`);
      if (r.verified) console.log(`  - code match: ${r.verified.total} hits${r.verified.samples.length ? ' e.g. ' + r.verified.samples.map((s) => s.path).join(', ') : ''}`);
      if (r.warnings.length) console.log(`  - warnings: ${r.warnings.join(', ')}`);
    }
  }
  if (dropped.length) {
    console.log('');
    console.log(`## Filtered out (${dropped.length})`);
    const byReason = {};
    for (const d of dropped) {
      for (const why of d.reasons) {
        const k = why.replace(/\(.*\)/, '');
        byReason[k] = (byReason[k] || 0) + 1;
      }
    }
    console.log(Object.entries(byReason).map(([k, v]) => `${k}×${v}`).join(', '));
  }
  if (notes.length) {
    console.log('');
    console.log('## Notes');
    for (const n of notes) console.log('- ' + n);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0];

  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    console.log(`github-discovery

  node discover.mjs "<need>" [options]
    --lang <name>        filter by language
    --min-stars <n>      default 100
    --months <n>         require push within N months (default 12; 0 = off)
    --min-match <0..1>   keyword-relevance gate (default 0.5)
    --no-match-gate      disable the relevance gate
    --exclude <a,b,c>    drop repos whose name/description/topics contain any term
    --limit <n>          rows to show (default 10)
    --candidates <n>     recall size per query (default 50)
    --no-npm             disable npm recall
    --no-deep            skip README length enrichment
    --verify             run code search on top results
    --code-terms <s>     literal code terms for verification
    --verify-top <n>     verify top N (default 5)
    --json               JSON output

  node discover.mjs readme <owner/repo>
  node discover.mjs rate
  node discover.mjs cache stats|clear`);
    return;
  }

  if (sub === 'readme') {
    const target = argv[1];
    if (!target) throw new Error('usage: discover.mjs readme <owner/repo>');
    console.log((await getReadme(target)) || '');
    return;
  }

  if (sub === 'rate') {
    console.log(JSON.stringify(await rateLimit(), null, 2));
    return;
  }

  if (sub === 'cache') {
    if (argv[1] === 'clear') { cacheClear(); console.log('cache cleared'); }
    else console.log(JSON.stringify(cacheStats(), null, 2));
    return;
  }

  const opts = parseArgs(argv);
  printDiscovery(await runDiscover(opts), opts);
}

main().catch((e) => {
  console.error('ERROR: ' + e.message);
  process.exit(1);
});
