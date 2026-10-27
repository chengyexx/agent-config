import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
export const CACHE_DIR = path.join(HERE, '..', '..', '.cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

function fileFor(key) {
  const h = crypto.createHash('sha1').update(String(key)).digest('hex');
  return path.join(CACHE_DIR, h + '.json');
}

export function get(key) {
  const f = fileFor(key);
  if (!fs.existsSync(f)) return undefined;
  try {
    const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (rec.exp && rec.exp < Date.now()) return undefined;
    return rec.v;
  } catch {
    return undefined;
  }
}

export function set(key, value, ttlMs = 0) {
  const rec = { exp: ttlMs ? Date.now() + ttlMs : 0, v: value };
  try {
    fs.writeFileSync(fileFor(key), JSON.stringify(rec));
  } catch {}
}

export async function memo(key, ttlMs, fn) {
  const hit = get(key);
  if (hit !== undefined) return hit;
  const val = await fn();
  set(key, val, ttlMs);
  return val;
}

export function stats() {
  const files = fs.existsSync(CACHE_DIR) ? fs.readdirSync(CACHE_DIR) : [];
  let bytes = 0;
  for (const f of files) {
    try { bytes += fs.statSync(path.join(CACHE_DIR, f)).size; } catch {}
  }
  return { entries: files.length, bytes, dir: CACHE_DIR };
}

export function clear() {
  for (const f of fs.readdirSync(CACHE_DIR)) {
    try { fs.unlinkSync(path.join(CACHE_DIR, f)); } catch {}
  }
}
