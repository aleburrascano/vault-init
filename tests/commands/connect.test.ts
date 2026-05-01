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

// ── LIVE: connect clones a real GitHub repo ───────────────────────────────────

const LIVE_VAULT = `vk-live-connect-${Date.now()}`;

describe('live: connect clones real GitHub repo', { timeout: 90_000 }, () => {
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
    await restoreReal();
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
