import { execFileSync } from 'node:child_process';

const USER_AGENT = 'opencode-github-discovery/1.0';
const PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
const NO_PROXY = (process.env.NO_PROXY || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function winUserEnv(name) {
  if (process.platform !== 'win32') return '';
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `[Environment]::GetEnvironmentVariable('${name}','User')`],
      { encoding: 'utf8', timeout: 10000 }
    );
    return (out || '').trim();
  } catch {
    return '';
  }
}

let tokenCache;
export function resolveToken() {
  if (tokenCache !== undefined) return tokenCache;
  if (process.env.GITHUB_DISCOVERY_NO_TOKEN) {
    tokenCache = '';
    return tokenCache;
  }
  tokenCache =
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    winUserEnv('GITHUB_TOKEN') ||
    winUserEnv('GH_TOKEN') ||
    '';
  return tokenCache;
}

export function hasToken() {
  return Boolean(resolveToken());
}

function hostBypassesProxy(hostname) {
  return NO_PROXY.some((p) => {
    if (p === hostname) return true;
    if (p.startsWith('.')) return hostname.endsWith(p);
    return hostname === p || hostname.endsWith('.' + p);
  });
}

let dispatcherState;
async function getDispatcher(targetUrl) {
  if (dispatcherState === undefined) {
    dispatcherState = null;
    if (PROXY) {
      try {
        const undici = await import('undici');
        if (undici.ProxyAgent) dispatcherState = undici.ProxyAgent;
      } catch {
        dispatcherState = null;
      }
    }
  }
  if (!dispatcherState) return undefined;
  try {
    if (hostBypassesProxy(new URL(targetUrl).hostname)) return undefined;
    return new dispatcherState(PROXY);
  } catch {
    return undefined;
  }
}

const lastCall = new Map();
export async function throttle(key, minIntervalMs) {
  if (!key || !minIntervalMs) return;
  const prev = lastCall.get(key) || 0;
  const wait = prev + minIntervalMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall.set(key, Date.now());
}

function rateLimitWaitMs(res) {
  const cap = hasToken() ? 65000 : 5000;
  const retryAfter = Number(res.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, cap);
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) return Math.min(Math.max(1000, reset * 1000 - Date.now()), cap);
  return 3000;
}

export async function request(targetUrl, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 30000,
    retries = 3,
    key,
    minIntervalMs = 0,
  } = opts;

  let lastErr;
  const maxAttempts = hasToken() ? retries : Math.min(retries, 2);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await throttle(key, minIntervalMs);
    let timer;
    try {
      const dispatcher = await getDispatcher(targetUrl);
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), timeoutMs);
      const init = {
        method,
        headers: { 'User-Agent': USER_AGENT, ...headers },
        signal: controller.signal,
      };
      if (body !== undefined) init.body = body;
      if (dispatcher) init.dispatcher = dispatcher;

      const res = await fetch(targetUrl, init);
      clearTimeout(timer);

      const limited =
        res.status === 429 ||
        (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0');
      if (limited && attempt < maxAttempts - 1) {
        await sleep(rateLimitWaitMs(res));
        continue;
      }

      const text = await res.text();
      let data = text;
      try { data = JSON.parse(text); } catch {}
      return { ok: res.ok, status: res.status, headers: res.headers, data };
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < maxAttempts - 1) await sleep(700 * (attempt + 1));
    }
  }
  throw lastErr || new Error('request failed: ' + targetUrl);
}

export async function requestJson(targetUrl, opts = {}) {
  return request(targetUrl, opts);
}
