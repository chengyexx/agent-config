import { execFileSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

// UA identifies this client to APIs (good practice; some gateways require a
// non-generic SDK user agent).
const USER_AGENT = 'opencode-tech-paradigm/0.1';
const PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
const NO_PROXY = (process.env.NO_PROXY || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 按主机的自愈代理 ──────────────────────────────────────────────────────────
// 某些域名(实测:huggingface.co)在本机 DNS 被污染,直连必超时;而公司代理
// (PAC)可以访问它。fetch 的 dispatcher 需要 undici(本机不可用),所以这里用
// node:http CONNECT 隧道实现 HTTPS-over-proxy,不依赖任何第三方包。
// 策略:默认直连;某主机直连出现连接级错误后,该主机永久改走 CONNECT 隧道。
const TUNNEL_HOSTS = new Set();       // 已确认需要隧道的主机
const TUNNELABLE = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'EHOSTUNREACH', 'ETIMEDOUT']);

function connectTunnel(targetUrl, { timeoutMs = 25000, method = 'GET', headers = {} }) {
  const u = new URL(targetUrl);
  const proxy = new URL(PROXY);
  const proxyHost = proxy.hostname;
  const proxyPort = Number(proxy.port || 8080);
  return new Promise((resolve, reject) => {
    const creq = http.request({
      host: proxyHost, port: proxyPort, method: 'CONNECT',
      path: `${u.hostname}:443`, headers: { Host: `${u.hostname}:443` },
      timeout: timeoutMs,
    });
    creq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return reject(new Error(`proxy CONNECT ${res.statusCode}`)); }
      const tlsSocket = tls.connect({ socket, servername: u.hostname });
      tlsSocket.on('error', (e) => reject(e));
      tlsSocket.once('secureConnect', () => {
        const req = https.request(
          {
            host: u.hostname, path: u.pathname + u.search, method,
            headers: { Host: u.host, ...headers },
            createConnection: () => tlsSocket,
          },
          (r) => {
            let buf = '';
            r.on('data', (c) => { buf += c; });
            r.on('end', () => resolve({ status: r.statusCode, text: buf }));
            r.on('error', reject);
          }
        );
        req.setTimeout(timeoutMs, () => req.destroy(new Error('tunnel request timeout')));
        req.on('error', reject);
        req.end();
      });
    });
    creq.on('timeout', () => creq.destroy(new Error('proxy CONNECT timeout')));
    creq.on('error', reject);
    creq.end();
  });
}

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
      // Preferred: Node's built-in proxy support (NODE_USE_ENV_PROXY=1) makes
      // global fetch honor HTTPS_PROXY via EnvHttpProxyAgent, which also
      // respects NO_PROXY. No undici dependency needed.
      if (process.env.NODE_USE_ENV_PROXY === '1') dispatcherState = null;
      else {
        try {
          const undici = await import('undici');
          if (undici.ProxyAgent) dispatcherState = undici.ProxyAgent;
        } catch {
          dispatcherState = null;
        }
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

  const needsTunnel = () => {
    if (!PROXY) return false;
    try { return TUNNEL_HOSTS.has(new URL(targetUrl).hostname); } catch { return false; }
  };

  let lastErr;
  const maxAttempts = hasToken() ? retries : Math.min(retries, 2);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await throttle(key, minIntervalMs);
    // 已确认该主机直连不通 -> 直接走隧道
    if (needsTunnel()) {
      try {
        const t = await connectTunnel(targetUrl, { timeoutMs, method, headers: { 'User-Agent': USER_AGENT, ...headers } });
        let tdata = t.text;
        try { tdata = JSON.parse(t.text); } catch {}
        return { ok: t.status >= 200 && t.status < 300, status: t.status, headers: new Map(), data: tdata };
      } catch (err) {
        lastErr = err;
        if (attempt < maxAttempts - 1) await sleep(700 * (attempt + 1));
        continue;
      }
    }
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
      // 连接级失败 + 有代理可用 -> 该主机改走 CONNECT 隧道后重试(不消耗重试额度)
      const code = err?.cause?.code || err?.code || '';
      if (PROXY && TUNNELABLE.has(code) && !needsTunnel()) {
        try { TUNNEL_HOSTS.add(new URL(targetUrl).hostname); } catch {}
        attempt = Math.max(-1, attempt - 1); // 留出至少一次隧道重试
        await sleep(500);
      } else if (attempt < maxAttempts - 1) {
        await sleep(700 * (attempt + 1));
      }
    }
  }
  throw lastErr || new Error('request failed: ' + targetUrl);
}

export async function requestJson(targetUrl, opts = {}) {
  return request(targetUrl, opts);
}
