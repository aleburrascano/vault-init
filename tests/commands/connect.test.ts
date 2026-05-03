/**
 * Tests for the connect command.
 *
 * - _normalizeInput: URL/shorthand parsing
 * - TR-1..TR-5: transactional rollback invariants
 *
 * connect.js uses a `cloned` flag + finally block to ensure that
 * if anything fails after the git clone, the cloned directory is removed.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { silent, arrayLogger } from '../helpers/logger.js';
import { liveDescribe } from '../helpers/live-describe.js';

vi.mock('@inquirer/prompts', () => ({ confirm: vi.fn() }));
vi.mock('execa', async (importOriginal) => {
  const real = await importOriginal<typeof import('execa')>();
  return { ...real, execa: vi.fn() };
});
vi.mock('../../src/lib/platform.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/platform.js')>();
  return { ...real, findTool: vi.fn(), vaultsRoot: vi.fn(), npmGlobalBin: vi.fn() };
});
vi.mock('../../src/lib/git.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/git.js')>();
  return { ...real, clone: vi.fn() };
});

import { confirm } from '@inquirer/prompts';
import { execa } from 'execa';
import { findTool, vaultsRoot } from '../../src/lib/platform.js';
import { clone } from '../../src/lib/git.js';
import { _normalizeInput } from '../../src/commands/connect.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vk-connect-test-'));
  vi.mocked(confirm).mockReset();
  vi.mocked(execa).mockReset();
  vi.mocked(findTool).mockReset();
  vi.mocked(vaultsRoot).mockReset();
  vi.mocked(clone).mockReset();

  vi.mocked(vaultsRoot).mockReturnValue(tmp);
  vi.mocked(findTool).mockResolvedValue('/usr/bin/claude');
  vi.mocked(execa).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } as never);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('_normalizeInput', () => {
  it('accepts owner/repo format', () => {
    expect(_normalizeInput('owner/MyVault')).toEqual({ repo: 'owner/MyVault', name: 'MyVault' });
  });

  it('accepts https GitHub URL', () => {
    expect(_normalizeInput('https://github.com/owner/MyVault')).toEqual({
      repo: 'owner/MyVault', name: 'MyVault',
    });
  });

  it('accepts https GitHub URL with .git suffix', () => {
    expect(_normalizeInput('https://github.com/owner/MyVault.git')).toEqual({
      repo: 'owner/MyVault', name: 'MyVault',
    });
  });

  it('accepts git@ SSH URL', () => {
    expect(_normalizeInput('git@github.com:owner/MyVault.git')).toEqual({
      repo: 'owner/MyVault', name: 'MyVault',
    });
  });

  it('throws for unrecognized format', () => {
    expect(() => _normalizeInput('not-a-repo')).toThrow(/unrecognized/i);
    expect(() => _normalizeInput('http://example.com/repo')).toThrow(/unrecognized/i);
  });

  it('accepts https URL with a trailing slash', () => {
    expect(_normalizeInput('https://github.com/owner/MyVault/')).toEqual({
      repo: 'owner/MyVault', name: 'MyVault',
    });
  });

  it('accepts https URL with a deep path after the repo', () => {
    // Web browser URLs like .../blob/main/README.md should still extract the slug.
    expect(_normalizeInput('https://github.com/owner/MyVault/blob/main/README.md')).toEqual({
      repo: 'owner/MyVault', name: 'MyVault',
    });
  });

  it('accepts repo names with hyphens via shorthand', () => {
    expect(_normalizeInput('owner/my-vault-name')).toEqual({
      repo: 'owner/my-vault-name', name: 'my-vault-name',
    });
  });

  it('throws for empty input', () => {
    expect(() => _normalizeInput('')).toThrow(/unrecognized/i);
  });

  it('throws for owner-only input (missing repo)', () => {
    expect(() => _normalizeInput('owner')).toThrow(/unrecognized/i);
  });
});

// ── TR-1: clone failure — nothing left on disk ─────────────────────────────────

describe('TR-1: clone fails — no directory left', () => {
  it('leaves no directory when clone throws', async () => {
    vi.mocked(clone).mockRejectedValueOnce(new Error('repository not found'));
    const vaultDir = join(tmp, 'MyVault');

    const { run } = await import('../../src/commands/connect.js');
    await expect(run('owner/MyVault', { cfgPath: join(tmp, '.claude.json'), log: silent }))
      .rejects.toThrow(/repository not found/i);

    expect(existsSync(vaultDir)).toBe(false);
  });
});

// ── TR-2: clone succeeds but .mcp-start.js missing — no orphaned dir ──────────

describe('TR-2: clone succeeds, launcher missing', () => {
  it('cloned dir is NOT deleted when launcher is missing (warns and exits cleanly)', async () => {
    // connect.js logs a warning and returns cleanly (doesn't throw) when .mcp-start.js is absent
    const vaultDir = join(tmp, 'NoLauncher');
    vi.mocked(clone).mockImplementation(async () => {
      mkdirSync(vaultDir, { recursive: true });
      // No .mcp-start.js written
    });

    const { run } = await import('../../src/commands/connect.js');
    const lines: string[] = [];
    await run('owner/NoLauncher', { cfgPath: join(tmp, '.claude.json'), log: arrayLogger(lines) });

    // Warning logged, vault dir left intact (user cloned a vault without launcher)
    expect(lines.some(l => /missing .mcp-start.js|MCP registration skipped/i.test(l))).toBe(true);
    expect(existsSync(vaultDir)).toBe(true);
  });
});

// ── TR-3: user declines MCP registration — dir stays, no MCP entry ────────────

describe('TR-3: user declines MCP registration', () => {
  it('keeps cloned dir but skips MCP registration', async () => {
    const vaultDir = join(tmp, 'DeclineVault');
    vi.mocked(clone).mockImplementation(async () => {
      mkdirSync(vaultDir, { recursive: true });
      writeFileSync(join(vaultDir, '.mcp-start.js'), '// launcher');
      writeFileSync(join(vaultDir, 'CLAUDE.md'), '');
      mkdirSync(join(vaultDir, 'raw'), { recursive: true });
      mkdirSync(join(vaultDir, 'wiki'), { recursive: true });
    });
    vi.mocked(confirm).mockResolvedValueOnce(false);

    const { run } = await import('../../src/commands/connect.js');
    const lines: string[] = [];
    await run('owner/DeclineVault', { cfgPath: join(tmp, '.claude.json'), log: arrayLogger(lines) });

    expect(lines.some(l => /skipped|To register later/i.test(l))).toBe(true);
    expect(existsSync(vaultDir)).toBe(true);
    expect(vi.mocked(execa).mock.calls.some(c => {
      const args = c[1] as unknown;
      return Array.isArray(args) && args.includes('add');
    })).toBe(false);
  });
});

// ── TR-4: MCP registration throws — partial clone removed ─────────────────────

describe('TR-4: MCP registration fails — partial clone removed', () => {
  it('removes cloned dir when claude mcp add throws', async () => {
    const vaultDir = join(tmp, 'McpFailVault');
    vi.mocked(clone).mockImplementation(async () => {
      mkdirSync(vaultDir, { recursive: true });
      writeFileSync(join(vaultDir, '.mcp-start.js'), '// launcher');
      writeFileSync(join(vaultDir, 'CLAUDE.md'), '');
      mkdirSync(join(vaultDir, 'raw'), { recursive: true });
      mkdirSync(join(vaultDir, 'wiki'), { recursive: true });
    });
    vi.mocked(confirm).mockResolvedValueOnce(true); // user confirms MCP registration

    vi.mocked(execa).mockImplementation((async (_cmd: string, args?: readonly string[]) => {
      if (args?.includes('add') && args?.includes('--scope')) {
        throw new Error('claude mcp add: permission denied');
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }) as never);

    const { run } = await import('../../src/commands/connect.js');
    const lines: string[] = [];
    await expect(
      run('owner/McpFailVault', { cfgPath: join(tmp, '.claude.json'), log: arrayLogger(lines) })
    ).rejects.toThrow(/permission denied/i);

    expect(lines.some(l => /partial clone|Connect failed/i.test(l))).toBe(true);
    expect(existsSync(vaultDir)).toBe(false);
  });
});

// ── TR-5: successful connect — dir and MCP both present ───────────────────────

describe('TR-5: successful connect', () => {
  it('leaves dir intact and calls mcp add', async () => {
    const vaultDir = join(tmp, 'SuccessVault');
    vi.mocked(clone).mockImplementation(async () => {
      mkdirSync(vaultDir, { recursive: true });
      writeFileSync(join(vaultDir, '.mcp-start.js'), '// launcher');
      writeFileSync(join(vaultDir, 'CLAUDE.md'), '');
      mkdirSync(join(vaultDir, 'raw'), { recursive: true });
      mkdirSync(join(vaultDir, 'wiki'), { recursive: true });
    });
    vi.mocked(confirm).mockResolvedValueOnce(true);
    vi.mocked(execa).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } as never);

    const { run } = await import('../../src/commands/connect.js');
    const lines: string[] = [];
    await run('owner/SuccessVault', { cfgPath: join(tmp, '.claude.json'), log: arrayLogger(lines) });

    expect(existsSync(vaultDir)).toBe(true);
    const addCalls = vi.mocked(execa).mock.calls.filter(c => {
      const args = c[1] as unknown;
      return Array.isArray(args) && args.includes('add') && args.some((a: unknown) => String(a).includes('expected-sha256'));
    });
    expect(addCalls.length).toBeGreaterThan(0);
    expect(lines.some(l => /done/i.test(l))).toBe(true);
  });
});

// ── TR-6: runMcpAdd full canonical argv shape (security invariant) ────────────

describe('TR-6: runMcpAdd argv shape', () => {
  it('passes the full canonical argv including --expected-sha256=<hash>', async () => {
    const vaultDir = join(tmp, 'ArgvVault');
    vi.mocked(clone).mockImplementation(async () => {
      mkdirSync(vaultDir, { recursive: true });
      writeFileSync(join(vaultDir, '.mcp-start.js'), '// launcher');
      writeFileSync(join(vaultDir, 'CLAUDE.md'), '');
      mkdirSync(join(vaultDir, 'raw'), { recursive: true });
      mkdirSync(join(vaultDir, 'wiki'), { recursive: true });
    });
    vi.mocked(confirm).mockResolvedValueOnce(true);

    const { run } = await import('../../src/commands/connect.js');
    await run('owner/ArgvVault', { cfgPath: join(tmp, '.claude.json'), log: silent });

    const mcpAddCalls = vi.mocked(execa).mock.calls.filter(c => {
      const args = c[1] as unknown;
      return Array.isArray(args) && args[0] === 'mcp' && args[1] === 'add';
    });
    expect(mcpAddCalls.length).toBeGreaterThan(0);

    const args = mcpAddCalls[0]?.[1] as readonly unknown[];
    expect(args[2]).toBe('--scope');
    expect(args[3]).toBe('user');
    expect(args[4]).toBe('ArgvVault');
    expect(args[5]).toBe('--');
    expect(args[6]).toBe('node');
    expect(typeof args[7]).toBe('string');
    expect(String(args[7])).toMatch(/\.mcp-start\.js$/);
    expect(typeof args[8]).toBe('string');
    expect(String(args[8])).toMatch(/^--expected-sha256=[a-f0-9]{64}$/);
  });
});

// ── TR-7: runMcpAdd hash value matches on-disk launcher SHA-256 ───────────────

describe('TR-7: runMcpAdd hash value', () => {
  it('passes the actual on-disk launcher SHA-256 to claude mcp add', async () => {
    // Clone writes deterministic launcher bytes; we compute the expected
    // SHA against those exact bytes and assert connect passed that value.
    // This catches regressions like `--expected-sha256=` (blank) or a
    // mutation that passes the template hash instead of the on-disk hash.
    const vaultDir = join(tmp, 'HashVault');
    const launcherBytes = '// launcher with specific bytes for SHA assertion\n';
    vi.mocked(clone).mockImplementation(async () => {
      mkdirSync(vaultDir, { recursive: true });
      writeFileSync(join(vaultDir, '.mcp-start.js'), launcherBytes);
      writeFileSync(join(vaultDir, 'CLAUDE.md'), '');
      mkdirSync(join(vaultDir, 'raw'), { recursive: true });
      mkdirSync(join(vaultDir, 'wiki'), { recursive: true });
    });
    vi.mocked(confirm).mockResolvedValueOnce(true);

    const { run } = await import('../../src/commands/connect.js');
    await run('owner/HashVault', { cfgPath: join(tmp, '.claude.json'), log: silent });

    const mcpAddCalls = vi.mocked(execa).mock.calls.filter(c => {
      const args = c[1] as unknown;
      return Array.isArray(args) && args[0] === 'mcp' && args[1] === 'add';
    });
    const args = mcpAddCalls[0]?.[1] as readonly unknown[];
    const passedHash = String(args[8]).replace('--expected-sha256=', '');

    const { sha256 } = await import('../../src/lib/vault.js');
    const actualHash = await sha256(join(vaultDir, '.mcp-start.js'));
    expect(passedHash).toBe(actualHash);
  });
});

// ── TR-8: pre-clone collision — name already in registry ─────────────────────

describe('TR-8: pre-clone collision (name in registry)', () => {
  it('throws ALREADY_REGISTERED before any clone attempt', async () => {
    const cfgPath = join(tmp, '.claude.json');
    // Pre-register a vault under the name we'll try to connect to.
    writeFileSync(cfgPath, JSON.stringify({
      mcpServers: {
        AlreadyHere: {
          command: 'node',
          args: [join(tmp, 'AlreadyHere', '.mcp-start.js'), '--expected-sha256=' + 'a'.repeat(64)],
        },
      },
    }), 'utf8');

    const { run } = await import('../../src/commands/connect.js');
    await expect(run('owner/AlreadyHere', { cfgPath, log: silent }))
      .rejects.toThrow(/ALREADY_REGISTERED|already registered/i);

    // clone was NEVER called — collision detected before
    expect(vi.mocked(clone)).not.toHaveBeenCalled();
  });
});

// ── TR-9: pre-clone collision — vault dir exists on disk but not in registry ──

describe('TR-9: pre-clone collision (dir on disk)', () => {
  it('throws ALREADY_REGISTERED when target dir exists but is not registered', async () => {
    const cfgPath = join(tmp, '.claude.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), 'utf8');
    // Pre-create the target directory (without registering the vault).
    mkdirSync(join(tmp, 'OrphanDir'), { recursive: true });

    const { run } = await import('../../src/commands/connect.js');
    await expect(run('owner/OrphanDir', { cfgPath, log: silent }))
      .rejects.toThrow(/already exists/i);

    expect(vi.mocked(clone)).not.toHaveBeenCalled();
  });
});

// ── TR-10: SECURITY MODEL — connect registers any launcher (no template check) ─

describe('TR-10: connect intentionally does NOT compare launcher to canonical template', () => {
  // This test pins a deliberate threat-model decision documented in
  // `.claude/rules/security-invariants.md`. If you are tempted to "fix"
  // this by adding a `sha256(template) === sha256(onDisk)` check, read the
  // "Threat model" section first — the runtime self-verification is
  // registry-based, so template comparison adds little real security and
  // breaks legitimate cross-version vaults. The user makes the trust call.
  //
  // Concretely: connecting a vault whose .mcp-start.js bytes differ from
  // the current vaultkit's lib/mcp-start.js.tmpl SHOULD succeed; we only
  // refuse if the vault is already registered or the dir already exists.
  it('registers a launcher whose bytes differ from the canonical template', async () => {
    const vaultDir = join(tmp, 'NonCanonicalVault');
    // Deliberately non-template bytes — would fail a template-comparison check.
    const nonCanonicalBytes = '// THIS IS NOT THE CANONICAL VAULTKIT LAUNCHER\n';
    vi.mocked(clone).mockImplementation(async () => {
      mkdirSync(vaultDir, { recursive: true });
      writeFileSync(join(vaultDir, '.mcp-start.js'), nonCanonicalBytes);
      writeFileSync(join(vaultDir, 'CLAUDE.md'), '');
      mkdirSync(join(vaultDir, 'raw'), { recursive: true });
      mkdirSync(join(vaultDir, 'wiki'), { recursive: true });
    });
    vi.mocked(confirm).mockResolvedValueOnce(true);

    const { run } = await import('../../src/commands/connect.js');
    await run('owner/NonCanonicalVault', { cfgPath: join(tmp, '.claude.json'), log: silent });

    // Confirm the registration happened with the non-canonical bytes' SHA.
    const mcpAddCalls = vi.mocked(execa).mock.calls.filter(c => {
      const args = c[1] as unknown;
      return Array.isArray(args) && args[0] === 'mcp' && args[1] === 'add';
    });
    expect(mcpAddCalls.length).toBe(1);

    const args = mcpAddCalls[0]?.[1] as readonly unknown[];
    const passedHash = String(args[8]).replace('--expected-sha256=', '');
    const { sha256 } = await import('../../src/lib/vault.js');
    const nonCanonicalHash = await sha256(join(vaultDir, '.mcp-start.js'));
    expect(passedHash).toBe(nonCanonicalHash);

    // And the vault dir is intact (not rolled back).
    expect(existsSync(vaultDir)).toBe(true);
  });
});

// ── LIVE: connect clones a real GitHub repo ───────────────────────────────────

const LIVE_VAULT = `vk-live-connect-${Date.now()}`;

liveDescribe('live: connect clones real GitHub repo', { timeout: 90_000 }, () => {
  let repoSlug = '';

  async function restoreReal() {
    const { execa: realExeca } = await vi.importActual<typeof import('execa')>('execa');
    vi.mocked(execa).mockImplementation(realExeca as never);
    const realPlatform = await vi.importActual<typeof import('../../src/lib/platform.js')>('../../src/lib/platform.js');
    vi.mocked(findTool).mockImplementation(realPlatform.findTool);
    vi.mocked(vaultsRoot).mockImplementation(realPlatform.vaultsRoot);
    const realGit = await vi.importActual<typeof import('../../src/lib/git.js')>('../../src/lib/git.js');
    vi.mocked(clone).mockImplementation(realGit.clone);
  }

  beforeEach(restoreReal);

  beforeAll(async () => {
    await restoreReal();
    // Create a vault (creates the GitHub repo)
    const { run: initRun } = await import('../../src/commands/init.js');
    await initRun(LIVE_VAULT, { publishMode: 'private', skipInstallCheck: true, log: silent });

    // Get the repo slug for later use
    const { getCurrentUser } = await import('../../src/lib/github.js');
    const user = await getCurrentUser();
    repoSlug = `${user}/${LIVE_VAULT}`;

    // Disconnect locally (remove local dir + registry entry, but keep GitHub repo)
    const { run: disconnectRun } = await import('../../src/commands/disconnect.js');
    await disconnectRun(LIVE_VAULT, { skipConfirm: true, skipMcp: true, confirmName: LIVE_VAULT, log: silent });
  }, 60_000);

  afterAll(async () => {
    try { await restoreReal(); } catch { /* don't let mock-restore failures skip the cleanup below */ }
    // Remove local clone if test left it
    const { getVaultDir } = await import('../../src/lib/registry.js');
    const dir = await getVaultDir(LIVE_VAULT).catch(() => null);
    if (dir) {
      const { run: disconnectRun } = await import('../../src/commands/disconnect.js');
      await disconnectRun(LIVE_VAULT, { skipConfirm: true, skipMcp: true, confirmName: LIVE_VAULT, log: silent }).catch(() => {});
    }
    // Delete GitHub repo
    const { repoExists } = await import('../../src/lib/github.js');
    const { execa: realExeca } = await vi.importActual<typeof import('execa')>('execa');
    const { findTool: realFindTool } = await vi.importActual<typeof import('../../src/lib/platform.js')>('../../src/lib/platform.js');
    if (repoSlug && await repoExists(repoSlug).catch(() => false)) {
      const gh = await realFindTool('gh');
      if (gh) await realExeca(gh, ['repo', 'delete', repoSlug, '--yes'], { reject: false });
    }
  }, 60_000);

  it('clones repo and registers vault', async () => {
    const { run: connectRun } = await import('../../src/commands/connect.js');
    await connectRun(repoSlug, { skipMcp: true, log: silent });

    const { getVaultDir } = await import('../../src/lib/registry.js');
    const dir = await getVaultDir(LIVE_VAULT);
    expect(dir).not.toBeNull();
    expect(typeof dir).toBe('string');

    expect(existsSync(dir as string)).toBe(true);
  });
});
