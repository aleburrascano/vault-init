import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { claudeJsonPath } from '../src/lib/platform.js';

/**
 * Vitest globalSetup hook: runs once after the entire suite finishes.
 * Sweeps any `vk-live-*` keys from `~/.claude.json#mcpServers` that
 * survived per-test cleanup (e.g. when an `afterAll` hook crashed or
 * the process was killed before deregistration). Per-test cleanup is
 * primary; this is the safety net.
 *
 * Edge cases:
 * - Missing `~/.claude.json`: no-op.
 * - Missing `mcpServers` key: no-op.
 * - Corrupt JSON: throw, never silently rewrite a user's broken config.
 *
 * Atomic writes: `<path>.tmp` + rename so a crash mid-write can't leave
 * the user with a half-written config.
 */
export async function teardown(): Promise<void> {
  await sweepVkLiveEntries();
}

export async function sweepVkLiveEntries(): Promise<number> {
  const cfgPath = claudeJsonPath();
  if (!existsSync(cfgPath)) return 0;

  const raw = readFileSync(cfgPath, 'utf8');
  let cfg: { mcpServers?: Record<string, unknown> };
  try {
    cfg = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
  } catch (err) {
    throw new Error(
      `vitest globalTeardown: ${cfgPath} is not valid JSON; refusing to rewrite. (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  const servers = cfg.mcpServers;
  if (!servers || typeof servers !== 'object') return 0;

  const orphans = Object.keys(servers).filter((k) => k.startsWith('vk-live-'));
  if (orphans.length === 0) return 0;

  for (const key of orphans) {
    delete servers[key];
  }

  const tmpPath = `${cfgPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(cfg, null, 2));
  try {
    renameSync(tmpPath, cfgPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore — best effort
    }
    throw err;
  }

  process.stderr.write(`globalTeardown: removed ${orphans.length} vk-live-* registry entr${orphans.length === 1 ? 'y' : 'ies'}\n`);
  return orphans.length;
}
