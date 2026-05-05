import { readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { claudeJsonPath } from './platform.js';
import { VaultkitError } from './errors.js';
import { CURRENT_SCHEMA_VERSION } from './breaking-changes.js';
import type { ClaudeConfig, McpServerEntry, VaultRecord } from '../types.js';

function parseConfig(cfgPath: string): ClaudeConfig | null {
  let raw: string;
  try {
    raw = readFileSync(cfgPath, 'utf8');
  } catch (err) {
    // ENOENT is the legitimate first-run case — no Claude Code config exists yet.
    // Anything else (permission denied, IO error) we surface rather than mask.
    const code = (err as { code?: string })?.code;
    if (code === 'ENOENT') return null;
    throw err;
  }
  try {
    return JSON.parse(raw) as ClaudeConfig;
  } catch {
    throw new VaultkitError(
      'UNRECOGNIZED_INPUT',
      `${cfgPath} is not valid JSON. Inspect or restore the file before continuing.`,
    );
  }
}

function extractVaultEntry(name: string, server: McpServerEntry | undefined): VaultRecord | null {
  const args = server?.args;
  if (!Array.isArray(args)) return null;
  const scriptArg = args.find((a): a is string => typeof a === 'string' && a.endsWith('.mcp-start.js'));
  if (!scriptArg) return null;
  const hashArg = args.find((a): a is string => typeof a === 'string' && a.startsWith('--expected-sha256='));
  const schemaArg = args.find((a): a is string => typeof a === 'string' && a.startsWith('--schema-version='));
  let schemaVersion: number | null = null;
  if (schemaArg) {
    const parsed = parseInt(schemaArg.slice('--schema-version='.length), 10);
    if (Number.isFinite(parsed)) schemaVersion = parsed;
  }
  return {
    name,
    dir: dirname(scriptArg),
    hash: hashArg ? hashArg.slice('--expected-sha256='.length) : null,
    schemaVersion,
  };
}

/**
 * Returns the names of every MCP server registered in `~/.claude.json`,
 * including non-vault entries (servers vaultkit didn't create — e.g. a
 * different MCP tool the user has installed). `getAllVaults` filters
 * down to the vault-shaped subset; this helper is for callers that
 * need the full list (today: `vaultkit doctor`'s "Other MCP servers"
 * section). Returns `[]` on a missing config; throws
 * `VaultkitError('UNRECOGNIZED_INPUT')` on a corrupt one (same as
 * every other registry reader).
 */
export async function getAllMcpServerNames(cfgPath: string = claudeJsonPath()): Promise<string[]> {
  const config = parseConfig(cfgPath);
  if (!config?.mcpServers) return [];
  return Object.keys(config.mcpServers).sort();
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

/**
 * Returns the full {@link VaultRecord} for a single registered vault, or
 * `null` if the name isn't in the registry. Preferred over the per-field
 * `getVaultDir` / `getExpectedHash` getters when a caller needs more than
 * one field — one parse + one extract instead of N independent reads.
 */
export async function getVaultRecord(name: string, cfgPath: string = claudeJsonPath()): Promise<VaultRecord | null> {
  const config = parseConfig(cfgPath);
  if (!config) return null;
  const server = config.mcpServers?.[name];
  return extractVaultEntry(name, server);
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
  args.push(`--schema-version=${CURRENT_SCHEMA_VERSION}`);
  config.mcpServers[name] = { command: 'node', args };
  writeFileSync(cfgPath, JSON.stringify(config, null, 2), 'utf8');
}
