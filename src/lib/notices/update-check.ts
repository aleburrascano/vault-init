import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import type { Logger } from '../logger.js';

const CACHE_PATH = join(homedir(), '.vaultkit-update-check.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
const PACKAGE_PATH = '/@aleburrascano%2Fvaultkit/latest';

interface CacheEntry {
  latest: string;
  checkedAt: number;
}

function readCache(): CacheEntry | null {
  try {
    const parsed = JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as Partial<CacheEntry>;
    if (typeof parsed.latest !== 'string' || typeof parsed.checkedAt !== 'number') return null;
    return { latest: parsed.latest, checkedAt: parsed.checkedAt };
  } catch {
    return null;
  }
}

function writeCache(entry: CacheEntry): void {
  try { writeFileSync(CACHE_PATH, JSON.stringify(entry), 'utf8'); } catch { /* ignore */ }
}

function isStale(entry: CacheEntry): boolean {
  return Date.now() - entry.checkedAt > CACHE_TTL_MS;
}

// Compares "1.2.3"-shaped versions. Returns true if `latest` is strictly
// newer than `current`. Ignores prerelease tags -- vaultkit ships plain
// MAJOR.MINOR.PATCH, so this is sufficient.
export function _isNewer(latest: string, current: string): boolean {
  const parse = (v: string): number[] => v.split('.').map(s => parseInt(s, 10));
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (Number.isNaN(ai) || Number.isNaN(bi)) return false;
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  return false;
}

function backgroundFetch(): void {
  const req = request({
    hostname: 'registry.npmjs.org',
    path: PACKAGE_PATH,
    method: 'GET',
    timeout: FETCH_TIMEOUT_MS,
    headers: { Accept: 'application/json' },
  }, (res) => {
    if (res.statusCode !== 200) { res.resume(); return; }
    let body = '';
    res.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
    res.on('end', () => {
      try {
        const parsed = JSON.parse(body) as { version?: string };
        if (typeof parsed.version === 'string') {
          writeCache({ latest: parsed.version, checkedAt: Date.now() });
        }
      } catch { /* ignore */ }
    });
  });
  req.on('error', () => { /* ignore */ });
  req.on('timeout', () => req.destroy());
  // Detach from the event loop so the CLI can exit even if the request
  // is still in flight. If the response doesn't arrive before exit, the
  // cache stays stale and the next invocation retries -- acceptable
  // because the user-facing warning is best-effort.
  req.on('socket', (socket) => socket.unref());
  req.end();
}

export function checkForUpdate(currentVersion: string, log: Logger): void {
  if (process.env.VAULTKIT_NO_UPDATE_CHECK === '1') return;

  const cached = readCache();
  if (cached && _isNewer(cached.latest, currentVersion)) {
    log.warn(`vaultkit ${cached.latest} is available (you have ${currentVersion}).`);
    log.warn(`Update: npm update -g @aleburrascano/vaultkit`);
  }

  if (!cached || isStale(cached)) {
    backgroundFetch();
  }
}
