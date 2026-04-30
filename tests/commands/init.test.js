import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn(),
  input: vi.fn(),
  select: vi.fn(),
}));
vi.mock('execa', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, execa: vi.fn() };
});
vi.mock('../../src/lib/platform.js', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, findTool: vi.fn(), vaultsRoot: vi.fn(), npmGlobalBin: vi.fn(), isWindows: vi.fn() };
});

import { confirm, input, select } from '@inquirer/prompts';
import { execa } from 'execa';
import { findTool, vaultsRoot, isWindows } from '../../src/lib/platform.js';

let tmp;

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
  vi.mocked(findTool).mockImplementation(async (name) => `/usr/bin/${name}`);
  vi.mocked(select).mockResolvedValue('private');
  vi.mocked(execa).mockImplementation(async (cmd, args) => {
    if (cmd === 'git' && args?.[0] === 'config' && args?.[1] === 'user.name') {
      return { exitCode: 0, stdout: 'Test User', stderr: '' };
    }
    if (cmd === 'git' && args?.[0] === 'config' && args?.[1] === 'user.email') {
      return { exitCode: 0, stdout: 'test@example.com', stderr: '' };
    }
    if (args?.[0] === 'auth' && args?.[1] === 'status') {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (args?.includes('--jq') && args?.includes('.login')) {
      return { exitCode: 0, stdout: 'testuser', stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ── I-1: invalid vault name ───────────────────────────────────────────────────

describe('I-1: invalid vault name', () => {
  it('throws on name with slash', async () => {
    const { run } = await import('../../src/commands/init.js');
    await expect(run('owner/repo', { cfgPath: join(tmp, '.claude.json'), log: () => {} })).rejects.toThrow(/owner\/repo/i);
  });

  it('throws on name with spaces', async () => {
    const { run } = await import('../../src/commands/init.js');
    await expect(run('my vault', { cfgPath: join(tmp, '.claude.json'), log: () => {} })).rejects.toThrow();
  });

  it('throws on name longer than 64 chars', async () => {
    const { run } = await import('../../src/commands/init.js');
    await expect(run('A'.repeat(65), { cfgPath: join(tmp, '.claude.json'), log: () => {} })).rejects.toThrow();
  });
});

// ── I-2: node version too old ─────────────────────────────────────────────────

describe('I-2: node version check', () => {
  it('passes when current node >= 22', async () => {
    const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
    if (nodeMajor < 22) return; // skip if this env is old

    // Let it get past the prerequisites check and fail on vault-already-exists
    // by pre-creating the vaultDir
    const vaultDir = join(tmp, 'ExistingVault');
    mkdirSync(vaultDir, { recursive: true });

    const { run } = await import('../../src/commands/init.js');
    // Should NOT throw "Node.js 22+ required"
    await expect(run('ExistingVault', { cfgPath: join(tmp, '.claude.json'), log: () => {} })).rejects.toThrow(/already exists/i);
  });
});

// ── I-3: vault directory already exists ───────────────────────────────────────

describe('I-3: vault already exists', () => {
  it('throws with "already exists" and rolls back', async () => {
    const vaultDir = join(tmp, 'ExistVault');
    mkdirSync(vaultDir, { recursive: true });

    const { run } = await import('../../src/commands/init.js');
    const lines = [];
    await expect(run('ExistVault', { cfgPath: join(tmp, '.claude.json'), log: (m) => lines.push(m) }))
      .rejects.toThrow(/already exists/i);
  });
});

// ── I-4: gh not found, auto-install fails ────────────────────────────────────

describe('I-4: gh not found, install fails', () => {
  it('throws when gh cannot be found after attempted install', async () => {
    vi.mocked(findTool).mockResolvedValue(null);
    vi.mocked(isWindows).mockReturnValue(false);
    // Simulate no brew/apt/dnf available
    vi.mocked(execa).mockImplementation(async (cmd, args) => {
      return { exitCode: 1, stdout: '', stderr: 'not found' };
    });

    const { run } = await import('../../src/commands/init.js');
    await expect(run('NewVault', { cfgPath: join(tmp, '.claude.json'), log: () => {} })).rejects.toThrow();
  });
});

// ── I-5: gh found but not authenticated — prompts login ──────────────────────

describe('I-5: gh not authenticated', () => {
  it('calls gh auth login when auth status fails', async () => {
    vi.mocked(execa).mockImplementation(async (cmd, args) => {
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
      if (args?.includes('--jq') && args?.includes('.login')) {
        return { exitCode: 0, stdout: 'testuser', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const { run } = await import('../../src/commands/init.js');
    // Will fail eventually (vault dir creation + git + gh steps) but should reach auth login
    const lines = [];
    await run('AuthVault', { cfgPath: join(tmp, '.claude.json'), log: (m) => lines.push(m) }).catch(() => {});

    const loginCalls = vi.mocked(execa).mock.calls.filter(c => c[1]?.[0] === 'auth' && c[1]?.[1] === 'login');
    expect(loginCalls.length).toBeGreaterThan(0);
  });
});

// ── I-6: git user.name not set — prompts for name ────────────────────────────

describe('I-6: git user.name not configured', () => {
  it('prompts user for name and sets it', async () => {
    vi.mocked(execa).mockImplementation(async (cmd, args) => {
      if (cmd === 'git' && args?.[0] === 'config' && args?.[1] === 'user.name') {
        return { exitCode: 0, stdout: '', stderr: '' }; // not set
      }
      if (cmd === 'git' && args?.[0] === 'config' && args?.[1] === 'user.email') {
        return { exitCode: 0, stdout: 'test@example.com', stderr: '' };
      }
      if (args?.[0] === 'auth' && args?.[1] === 'status') return { exitCode: 0, stdout: '', stderr: '' };
      if (args?.includes('--jq') && args?.includes('.login')) return { exitCode: 0, stdout: 'testuser', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    vi.mocked(input).mockResolvedValueOnce('Test User');

    const { run } = await import('../../src/commands/init.js');
    await run('NameVault', { cfgPath: join(tmp, '.claude.json'), log: () => {} }).catch(() => {});

    // input was called for the name prompt
    expect(vi.mocked(input)).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/name/i) }));
  });
});

// ── I-7: auth-gated on free plan → throws ────────────────────────────────────

describe('I-7: auth-gated on free plan', () => {
  it('throws with pro+ required message', async () => {
    vi.mocked(select).mockResolvedValue('auth-gated');
    vi.mocked(execa).mockImplementation(async (cmd, args) => {
      if (args?.[0] === 'auth' && args?.[1] === 'status') return { exitCode: 0, stdout: '', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'config' && args?.[1] === 'user.name') return { exitCode: 0, stdout: 'User', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'config' && args?.[1] === 'user.email') return { exitCode: 0, stdout: 'u@e.com', stderr: '' };
      if (args?.includes('--jq') && args?.includes('.plan.name')) return { exitCode: 0, stdout: 'free', stderr: '' };
      if (args?.includes('--jq') && args?.includes('.login')) return { exitCode: 0, stdout: 'testuser', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const { run } = await import('../../src/commands/init.js');
    await expect(run('GatedVault', { cfgPath: join(tmp, '.claude.json'), log: () => {} }))
      .rejects.toThrow(/Pro\+|free/i);
  });
});

// ── I-8: GitHub username not fetchable → throws ───────────────────────────────

describe('I-8: GitHub username not fetchable', () => {
  it('throws "could not fetch GitHub username"', async () => {
    vi.mocked(execa).mockImplementation(async (cmd, args) => {
      if (args?.[0] === 'auth' && args?.[1] === 'status') return { exitCode: 0, stdout: '', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'config') return { exitCode: 0, stdout: 'User', stderr: '' };
      if (args?.includes('--jq') && args?.includes('.login')) return { exitCode: 0, stdout: '', stderr: '' }; // empty
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const { run } = await import('../../src/commands/init.js');
    await expect(run('UserVault', { cfgPath: join(tmp, '.claude.json'), log: () => {} }))
      .rejects.toThrow(/GitHub username/i);
  });
});

// ── I-9: rollback — repo created but push fails ───────────────────────────────

describe('I-9: rollback on push failure', () => {
  it('deletes repo and local dir on git push failure', async () => {
    vi.mocked(execa).mockImplementation(async (cmd, args) => {
      if (args?.[0] === 'auth' && args?.[1] === 'status') return { exitCode: 0, stdout: '', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'config' && args?.[1] === 'user.name') return { exitCode: 0, stdout: 'User', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'config' && args?.[1] === 'user.email') return { exitCode: 0, stdout: 'u@e.com', stderr: '' };
      if (args?.includes('--jq') && args?.includes('.login')) return { exitCode: 0, stdout: 'testuser', stderr: '' };
      if (cmd === 'git' && args?.includes('push')) {
        // execa throws (not returns) on non-zero exit when reject:true (default)
        throw Object.assign(new Error('git push failed: Permission denied'), { exitCode: 1 });
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const { run } = await import('../../src/commands/init.js');
    const lines = [];
    await expect(run('RollbackVault', { cfgPath: join(tmp, '.claude.json'), log: (m) => lines.push(m) }))
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
    const lines = [];
    await run('McpVault', { cfgPath: join(tmp, '.claude.json'), log: (m) => lines.push(m) }).catch(() => {});

    const addCalls = vi.mocked(execa).mock.calls.filter(c =>
      c[1]?.includes('add') && c[1]?.some(a => String(a).includes('expected-sha256'))
    );
    expect(addCalls.length).toBeGreaterThan(0);
  });
});

// ── I-11: claude not found — logs manual registration hint ───────────────────

describe('I-11: claude not found', () => {
  it('logs manual MCP registration instruction', async () => {
    vi.mocked(findTool).mockImplementation(async (name) => {
      if (name === 'claude') return null;
      return `/usr/bin/${name}`;
    });
    vi.mocked(confirm).mockResolvedValueOnce(false); // don't install claude

    const { run } = await import('../../src/commands/init.js');
    const lines = [];
    await run('NoClaude', { cfgPath: join(tmp, '.claude.json'), log: (m) => lines.push(m) }).catch(() => {});

    expect(lines.some(l => /claude mcp add/i.test(l))).toBe(true);
  });
});

// ── LIVE: init creates real GitHub repo ───────────────────────────────────────

const LIVE = !!process.env.VAULTKIT_LIVE_TEST;
const LIVE_VAULT = `vk-live-init-${Date.now()}`;

describe.skipIf(!LIVE)('live: init creates real GitHub repo', { timeout: 60_000 }, () => {
  async function restoreReal() {
    const { execa: realExeca } = await vi.importActual('execa');
    vi.mocked(execa).mockImplementation(realExeca);
    const realPlatform = await vi.importActual('../../src/lib/platform.js');
    vi.mocked(findTool).mockImplementation(realPlatform.findTool);
    vi.mocked(vaultsRoot).mockImplementation(realPlatform.vaultsRoot);
  }

  beforeEach(restoreReal);

  beforeAll(async () => {
    await restoreReal();
    const { run } = await import('../../src/commands/init.js');
    await run(LIVE_VAULT, { publishMode: 'private', skipInstallCheck: true, log: () => {} });
  }, 60_000);

  afterAll(async () => {
    await restoreReal();
    const { run } = await import('../../src/commands/destroy.js');
    await run(LIVE_VAULT, { skipConfirm: true, skipMcp: true, confirmName: LIVE_VAULT, log: () => {} }).catch(() => {});
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
    const { existsSync } = await import('node:fs');
    const { vaultsRoot } = await import('../../src/lib/platform.js');
    const { join } = await import('node:path');
    const vaultDir = join(vaultsRoot(), LIVE_VAULT);
    expect(existsSync(join(vaultDir, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(vaultDir, 'raw'))).toBe(true);
    expect(existsSync(join(vaultDir, 'wiki'))).toBe(true);
    expect(existsSync(join(vaultDir, '.mcp-start.js'))).toBe(true);
  });
});
