import { readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { claudeJsonPath } from './platform.js';
import type { ClaudeConfig, McpServerEntry, VaultRecord } from '../types.js';

function parseConfig(cfgPath: string): ClaudeConfig | null {
  try {
    return JSON.parse(readFileSync(cfgPath, 'utf8')) as ClaudeConfig;
  } catch {
    return null;
  }
}

function extractVaultEntry(name: string, server: McpServerEntry | undefined): VaultRecord | null {
  const args = server?.args;
  if (!Array.isArray(args)) return null;
  const scriptArg = args.find((a): a is string => typeof a === 'string' && a.endsWith('.mcp-start.js'));
  if (!scriptArg) return null;
  const hashArg = args.find((a): a is string => typeof a === 'string' && a.startsWith('--expected-sha256='));
  return {
    name,
    dir: dirname(scriptArg),
    hash: hashArg ? hashArg.slice('--expected-sha256='.length) : null,
  };
}

export async function getAllVaults(cfgPath: string = claudeJsonPath()): Promise<VaultRecord[]> {
  const config = parseConfig(cfgPath);
  if (!config) return [];
  const servers = config.mcpServers ?? {};
  const vaults: VaultRecord[] = [];
  for (const [name, server] of Object.entries(servers)) {
    const entry = extractVaultEntry(name, server);
    if (entry) vaults.push(entry);
  }
  return vaults.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getVaultDir(name: string, cfgPath: string = claudeJsonPath()): Promise<string | null> {
  const config = parseConfig(cfgPath);
  if (!config) return null;
  const server = config.mcpServers?.[name];
  const entry = extractVaultEntry(name, server);
  return entry?.dir ?? null;
}

export async function getExpectedHash(name: string, cfgPath: string = claudeJsonPath()): Promise<string | null> {
  const config = parseConfig(cfgPath);
  if (!config) return null;
  const server = config.mcpServers?.[name];
  const entry = extractVaultEntry(name, server);
  return entry?.hash ?? null;
}

export async function removeFromRegistry(name: string, cfgPath: string = claudeJsonPath()): Promise<void> {
  const config = parseConfig(cfgPath);
  if (!config?.mcpServers) return;
  delete config.mcpServers[name];
  writeFileSync(cfgPath, JSON.stringify(config, null, 2), 'utf8');
}

export async function addToRegistry(
  name: string,
  launcherPath: string,
  hash: string | null,
  cfgPath: string = claudeJsonPath(),
): Promise<void> {
  const config: ClaudeConfig = parseConfig(cfgPath) ?? {};
  if (!config.mcpServers) config.mcpServers = {};
  const args: string[] = [launcherPath];
  if (hash) args.push(`--expected-sha256=${hash}`);
  config.mcpServers[name] = { command: 'node', args };
  writeFileSync(cfgPath, JSON.stringify(config, null, 2), 'utf8');
}
