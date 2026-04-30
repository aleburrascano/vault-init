import { readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { claudeJsonPath } from './platform.js';

function parseConfig(cfgPath) {
  try {
    return JSON.parse(readFileSync(cfgPath, 'utf8'));
  } catch {
    return null;
  }
}

function extractVaultEntry(name, server) {
  const args = server?.args;
  if (!Array.isArray(args)) return null;
  const scriptArg = args.find(a => typeof a === 'string' && a.endsWith('.mcp-start.js'));
  if (!scriptArg) return null;
  const hashArg = args.find(a => typeof a === 'string' && a.startsWith('--expected-sha256='));
  return {
    name,
    dir: dirname(scriptArg),
    hash: hashArg ? hashArg.slice('--expected-sha256='.length) : null,
  };
}

export async function getAllVaults(cfgPath = claudeJsonPath()) {
  const config = parseConfig(cfgPath);
  if (!config) return [];
  const servers = config.mcpServers ?? {};
  const vaults = [];
  for (const [name, server] of Object.entries(servers)) {
    const entry = extractVaultEntry(name, server);
    if (entry) vaults.push(entry);
  }
  return vaults.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getVaultDir(name, cfgPath = claudeJsonPath()) {
  const config = parseConfig(cfgPath);
  if (!config) return null;
  const server = config.mcpServers?.[name];
  const entry = extractVaultEntry(name, server);
  return entry?.dir ?? null;
}

export async function getExpectedHash(name, cfgPath = claudeJsonPath()) {
  const config = parseConfig(cfgPath);
  if (!config) return null;
  const server = config.mcpServers?.[name];
  const entry = extractVaultEntry(name, server);
  return entry?.hash ?? null;
}

export async function removeFromRegistry(name, cfgPath = claudeJsonPath()) {
  const config = parseConfig(cfgPath);
  if (!config?.mcpServers) return;
  delete config.mcpServers[name];
  writeFileSync(cfgPath, JSON.stringify(config, null, 2), 'utf8');
}

export async function addToRegistry(name, launcherPath, hash, cfgPath = claudeJsonPath()) {
  let config = parseConfig(cfgPath) ?? {};
  if (!config.mcpServers) config.mcpServers = {};
  const args = [launcherPath];
  if (hash) args.push(`--expected-sha256=${hash}`);
  config.mcpServers[name] = { command: 'node', args };
  writeFileSync(cfgPath, JSON.stringify(config, null, 2), 'utf8');
}
