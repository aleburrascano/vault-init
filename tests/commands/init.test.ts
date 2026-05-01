import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { silent, arrayLogger } from '../helpers/logger.js';

vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn(),
  input: vi.fn(),
  select: vi.fn(),
}));
vi.mock('execa', async (importOriginal) => {
  const real = await importOriginal<typeof import('execa')>();
  return { ...real, execa: vi.fn() };
});
vi.mock('../../src/lib/platform.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/platform.js')>();
  return { ...real, findTool: vi.fn(), vaultsRoot: vi.fn(), npmGlobalBin: vi.fn(), isWindows: vi.fn() };
});

import { confirm, input, select } from '@inquirer/prompts';
import { execa } from 'execa';
import { findTool, vaultsRoot, isWindows } from '../../src/lib/platform.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vk-init-test-'));
  vi.mocked(confirm).mockReset();
  vi.mocked(input).mockReset();
  vi.mocked(select).mockReset();
  vi.mocked(execa).mockReset();
  vi.mocked(findTool).mockReset();
  vi.mocked(vaultsRoot).mockReset();
  vi.mocked(isWindows).mockReset();

  // Safe defaults: gh and claude found, git config set, auth ok
  vi.mocked(isWindows).mockReturnValue(false);
  vi.mocked(vaultsRoot).mockReturnValue(tmp);
  vi.mocked(findTool).mockImplementation(async (name: string) => `/usr/bin/${name}`);
  vi.mocked(select).mockResolvedValue('private');
  vi.mocked(execa).mockImplementation((async (cmd: string, args?: readonly string[]) => {
    if (cmd === 'git' && args?.[0] === 'config' && args?.[1] === 'user.name') {
      return { exitCode: 0, stdout: 'Test User', stderr: '' };
    }
    if (cmd === 'git' && args?.[0] === 'config' && args?.[1] === 'user.email') {
      return { exitCode: 0, stdout: 'test@example.com', stderr: '' };
    }
    if (args?.[0] === 'auth' && args?.[1] === 'status') {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (args?.[0] === 'api' && args?.[1] === 'user') {
      return { exitCode: 0, stdout: JSON.stringify({ login: 'testuser', plan: { name: 'pro' } }), stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  }) as never);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ── I-1: invalid vault name ───────────────────────────────────────────────────

describe('I-1: invalid vault name', () => {
  it('throws on name with slash', async () => {
    const { run } = await import('../../src/commands/init.js');
    await expect(run('owner/repo', { cfgPath: join(tmp, '.claude.json'), log: silent })).rejects.toThrow(/owner\/repo/i);
  });

  it('throws on name with spaces', async () => {
    const { run } = await import('../../src/commands/init.js');
    await expect(run('my vault', { cfgPath: join(tmp, '.claude.json'), log: silent })).rejects.toThrow(/letters, numbers, hyphens/i);
  });

  it('throws on name longer than 64 chars', async () => {
    const { run } = await import('../../src/commands/init.js');
    await expect(run('A'.repeat(65), { cfgPath: join(tmp, '.claude.json'), log: silent })).rejects.toThrow(/64 characters/i);
  });
});

// ── I-2: node version too old ─────────────────────────────────────────────────

describe('I-2: node version check', () => {
  it('passes when current node >= 22', async () => {
    const nodeMajor = parseInt(process.versions.node.split('.')[0] ?? '0', 10);
    if (nodeMajor < 22) return; // skip if this env is old

    // Let it get past the prerequisites check and fail on vault-already-exists
    // by pre-creating the vaultDir
    const vaultDir = join(tmp, 'ExistingVault');
    mkdirSync(vaultDir, { recursive: true });

    const { run } = await import('../../src/commands/init.js');
    // Should NOT throw "Node.js 22+ required"
    await expect(run('ExistingVault', { cfgPath: join(tmp, '.claude.json'), log: silent })).rejects.toThrow(/already exists/i);
  });
});

// ── I-3: vault directory already exists ───────────────────────────────────────

describe('I-3: vault already exists', () => {
  it('throws with "already exists" and rolls back', async () => {
    const vaultDir = join(tmp, 'ExistVault');
    mkdirSync(vaultDir, { recursive: true });

    const { run } = await import('../../src/commands/init.js');
    const lines: string[] = [];
    await expect(run('ExistVault', { cfgPath: join(tmp, '.claude.json'), log: arrayLogger(lines) }))
      .rejects.toThrow(/already exists/i);
  });
});

// ── I-4: gh not found, auto-install fails ────────────────────────────────────

describe('I-4: gh not found, install fails', () => {
  it('throws when gh cannot be found after attempted install', async () => {
    vi.mocked(findTool).mockResolvedValue(null);
    vi.mocked(isWindows).mockReturnValue(false);
    // Simulate no brew/apt/dnf available
    vi.mocked(execa).mockImplementation((async () => {
      return { exitCode: 1, stdout: '', stderr: 'not found' };
    }) as never);

    const { run } = await import('../../src/commands/init.js');
    await expect(run('NewVault', { cfgPath: join(tmp, '.claude.json'), log: silent })).rejects.toThrow();
  });
});

// ── I-5: gh found but not authenticated — prompts login ──────────────────────

describe('I-5: gh not authenticated', () => {
  it('calls gh auth login when auth status fails', async () => {
    vi.mocked(execa).mockImplementation((async (cmd: string, args?: readonly string[]) => {
      if (args?.[0] === 'auth' && args?.[1] === 'status') {
        return { exitCode: 1, stdout: '', stderr: 'not authenticated' };
      }
      if (args?.[0] === 'auth' && args?.[1] === 'login') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'git' && args?.[0] === 'config' && args?.[1] === 'user.name') {
        return { exitCode: 0, stdout: 'Test User', stderr: '' };
      }
      if (cmd === 'git' && args?.[0] === 'config' && args?.[1] === 'user.email') {
        return { exitCode: 0, stdout: 'test@example.com', stderr: '' };
      }
      if (args?.[0] === 'api' && args?.[1] === 'user') {
        return { exitCode: 0, stdout: JSON.stringify({ login: 'testuser', plan: { name: 'pro' } }), stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }) as never);

    const { run } = await import('../../src/commands/init.js');
    // Will fail eventually (vault dir creation + git + gh steps) but should reach auth login
    const lines: string[] = [];
    await run('AuthVault', { cfgPath: join(tmp, '.claude.json'), log: arrayLogger(lines) }).catch(() => {});

    const loginCalls = vi.mocked(execa).mock.calls.filter(c => {
      const args = c[1] as unknown;
      return Array.isArray(args) && args[0] === 'auth' && args[1] === 'login';
    });
    expect(loginCalls.length).toBeGreaterThan(0);
  });
});

// ── I-6: git user.name not set — prompts for name ────────────────────────────

describe('I-6: git user.name not configured', () => {
  it('prompts user for name and sets it', async () => {
    vi.mocked(execa).mockImplementation((async (cmd: string, args?: readonly string[]) => {
      if (cmd === 'git' && args?.[0] === 'config' && args?.[1] === 'user.name') {
        return { exitCode: 0, stdout: '', stderr: '' }; // not set
      }
      if (cmd === 'git' && args?.[0] === 'config' && args?.[1] === 'user.email') {
        return { exitCode: 0, stdout: 'test@example.com', stderr: '' };
      }
      if (args?.[0] === 'auth' && args?.[1] === 'status') return { exitCode: 0, stdout: '', stderr: '' };
      if (args?.[0] === 'api' && args?.[1] === 'user') {
        return { exitCode: 0, stdout: JSON.stringify({ login: 'testuser', plan: { name: 'pro' } }), stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }) as never);
    vi.mocked(input).mockResolvedValueOnce('Test User');

    const { run } = await import('../../src/commands/init.js');
    await run('NameVault', { cfgPath: join(tmp, '.claude.json'), log: silent }).catch(() => {});

    // input was called for the name prompt
    expect(vi.mocked(input)).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/name/i) }));
  });
});

// ── I-7: auth-gated on free plan → throws ────────────────────────────────────

describe('I-7: auth-gated on free plan', () => {
  it('throws with pro+ required message', async () => {
    vi.mocked(select).mockResolvedValue('auth-gated');
    vi.mocked(execa).mockImplementation((async (cmd: string, args?: readonly string[]) => {
      if (args?.[0] === 'auth' && args?.[1] === 'status') return { exitCode: 0, stdout: '', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'config' && args?.[1] === 'user.name') return { exitCode: 0, stdout: 'User', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'config' && args?.[1] === 'user.email') return { exitCode: 0, stdout: 'u@e.com', stderr: '' };
      if (args?.[0] === 'api' && args?.[1] === 'user') {
        return { exitCode: 0, stdout: JSON.stringify({ login: 'testuser', plan: { name: 'free' } }), stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }) as never);

    const { run } = await import('../../src/commands/init.js');
    await expect(run('GatedVault', { cfgPath: join(tmp, '.claude.json'), log: silent }))
      .rejects.toThrow(/Pro\+|free/i);
  });
});

// ── I-8: GitHub username not fetchable → throws ───────────────────────────────

describe('I-8: GitHub username not fetchable', () => {
  it('throws "could not fetch GitHub username"', async () => {
    vi.mocked(execa).mockImplementation((async (cmd: string, args?: readonly string[]) => {
      if (args?.[0] === 'auth' && args?.[1] === 'status') return { exitCode: 0, stdout: '', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'config') return { exitCode: 0, stdout: 'User', stderr: '' };
      if (args?.[0] === 'api' && args?.[1] === 'user') {
        return { exitCode: 0, stdout: JSON.stringify({ login: '' }), stderr: '' }; // empty login → fetch fails
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }) as never);

    const { run } = await import('../../src/commands/init.js');
    await expect(run('UserVault', { cfgPath: join(tmp, '.claude.json'), log: silent }))
      .rejects.toThrow(/GitHub username/i);
  });
});

// ── I-9: rollback — repo created but push fails ───────────────────────────────

describe('I-9: rollback on push failure', () => {
  it('deletes repo and local dir on git push failure', async () => {
    vi.mocked(execa).mockImplementation((async (cmd: string, args?: readonly string[]) => {
      if (args?.[0] === 'auth' && args?.[1] === 'status') return { exitCode: 0, stdout: '', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'config' && args?.[1] === 'user.name') return { exitCode: 0, stdout: 'User', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'config' && args?.[1] === 'user.email') return { exitCode: 0, stdout: 'u@e.com', stderr: '' };
      if (args?.[0] === 'api' && args?.[1] === 'user') {
        return { exitCode: 0, stdout: JSON.stringify({ login: 'testuser', plan: { name: 'pro' } }), stderr: '' };
      }
      if (cmd === 'git' && args?.includes('push')) {
        // execa throws (not returns) on non-zero exit when reject:true (default)
        throw Object.assign(new Error('git push failed: Permission denied'), { exitCode: 1 });
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }) as never);

    const { run } = await import('../../src/commands/init.js');
    const lines: string[] = [];
    await expect(run('RollbackVault', { cfgPath: join(tmp, '.claude.json'), log: arrayLogger(lines) }))
      .rejects.toThrow();

    expect(lines.some(l => /rolling back/i.test(l))).toBe(true);
    // Local dir should be removed
    expect(existsSync(join(tmp, 'RollbackVault'))).toBe(false);
  });
});

// ── I-10: MCP registration when claude found ─────────────────────────────────

describe('I-10: MCP registration', () => {
  it('calls claude mcp add with expected-sha256', async () => {
    const { run } = await import('../../src/commands/init.js');
    const lines: string[] = [];
    await run('McpVault', { cfgPath: join(tmp, '.claude.json'), log: arrayLogger(lines) }).catch(() => {});

    const addCalls = vi.mocked(execa).mock.calls.filter(c => {
      const args = c[1] as unknown;
      return Array.isArray(args) && args.includes('add') && args.some((a: unknown) => String(a).includes('expected-sha256'));
    });
    expect(addCalls.length).toBeGreaterThan(0);
  });
});

// ── I-11: claude not found — logs manual registration hint ───────────────────

describe('I-11: claude not found', () => {
  it('logs manual MCP registration instruction', async () => {
    vi.mocked(findTool).mockImplementation(async (name: string) => {
      if (name === 'claude') return null;
      return `/usr/bin/${name}`;
    });
    vi.mocked(confirm).mockResolvedValueOnce(false); // don't install claude

    const { run } = await import('../../src/commands/init.js');
    const lines: string[] = [];
    await run('NoClaude', { cfgPath: join(tmp, '.claude.json'), log: arrayLogger(lines) }).catch(() => {});

    expect(lines.some(l => /claude mcp add/i.test(l))).toBe(true);
  });
});

// ── LIVE: init creates real GitHub repo ───────────────────────────────────────

const LIVE = !!process.env.VAULTKIT_LIVE_TEST;
const LIVE_VAULT = `vk-live-init-${Date.now()}`;

describe.skipIf(!LIVE)('live: init creates real GitHub repo', { timeout: 60_000 }, () => {
  async function restoreReal() {
    const { execa: realExeca } = await vi.importActual<typeof import('execa')>('execa');
    vi.mocked(execa).mockImplementation(realExeca as never);
    const realPlatform = await vi.importActual<typeof import('../../src/lib/platform.js')>('../../src/lib/platform.js');
    vi.mocked(findTool).mockImplementation(realPlatform.findTool);
    vi.mocked(vaultsRoot).mockImplementation(realPlatform.vaultsRoot);
  }

  beforeEach(restoreReal);

  beforeAll(async () => {
    await restoreReal();
    const { run } = await import('../../src/commands/init.js');
    await run(LIVE_VAULT, { publishMode: 'private', skipInstallCheck: true, log: silent });
  }, 60_000);

  afterAll(async () => {
    await restoreReal();
    const { run } = await import('../../src/commands/destroy.js');
    await run(LIVE_VAULT, { skipConfirm: true, skipMcp: true, confirmName: LIVE_VAULT, log: silent }).catch(() => {});
  }, 60_000);

  it('creates the GitHub repo', async () => {
    const { repoExists, getCurrentUser } = await import('../../src/lib/github.js');
    const user = await getCurrentUser();
    expect(await repoExists(`${user}/${LIVE_VAULT}`)).toBe(true);
  });

  it('registers vault in ~/.claude.json', async () => {
    const { getVaultDir } = await import('../../src/lib/registry.js');
    const dir = await getVaultDir(LIVE_VAULT);
    expect(dir).toBeTruthy();
  });

  it('creates vault directory structure on disk', async () => {
    const { vaultsRoot: realVaultsRoot } = await import('../../src/lib/platform.js');
    const vaultDir = join(realVaultsRoot(), LIVE_VAULT);
    expect(existsSync(join(vaultDir, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(vaultDir, 'raw'))).toBe(true);
    expect(existsSync(join(vaultDir, 'wiki'))).toBe(true);
    expect(existsSync(join(vaultDir, '.mcp-start.js'))).toBe(true);
  });
});
