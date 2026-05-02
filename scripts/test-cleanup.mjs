#!/usr/bin/env node
// Standalone manual recovery of vk-live-* registry entries that the
// vitest globalTeardown didn't get a chance to sweep (e.g. the test
// process was SIGKILL'd before vitest could fire its teardown).
//
// Mirrors the logic of `tests/global-teardown.ts` (sweepVkLiveEntries).
// Keep the two in sync; the TS version is the canonical reference.

import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const cfgPath = join(homedir(), '.claude.json');

if (!existsSync(cfgPath)) {
  console.log(`No file at ${cfgPath}; nothing to clean.`);
  process.exit(0);
}

const raw = readFileSync(cfgPath, 'utf8');
let cfg;
try {
  cfg = JSON.parse(raw);
} catch (err) {
  console.error(`${cfgPath} is not valid JSON; refusing to rewrite. (${err instanceof Error ? err.message : String(err)})`);
  process.exit(1);
}

const servers = cfg.mcpServers;
if (!servers || typeof servers !== 'object') {
  console.log('No mcpServers key; nothing to clean.');
  process.exit(0);
}

const orphans = Object.keys(servers).filter((k) => k.startsWith('vk-live-'));
if (orphans.length === 0) {
  console.log('0 vk-live-* registry entries to remove.');
  process.exit(0);
}

for (const key of orphans) {
  delete servers[key];
}

const tmpPath = `${cfgPath}.tmp`;
writeFileSync(tmpPath, JSON.stringify(cfg, null, 2));
try {
  renameSync(tmpPath, cfgPath);
} catch (err) {
  try { unlinkSync(tmpPath); } catch { /* ignore */ }
  throw err;
}

console.log(`Removed ${orphans.length} vk-live-* registry entr${orphans.length === 1 ? 'y' : 'ies'}: ${orphans.join(', ')}`);
