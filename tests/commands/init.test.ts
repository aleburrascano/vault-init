import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { silent, arrayLogger } from '../helpers/logger.js';
import { liveDescribe } from '../helpers/live-describe.js';

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
vi.mock('../../src/lib/vault-layout.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/vault-layout.js')>();
  // Spy that delegates to the real implementation by default. Per-test
  // overrides via mockImplementationOnce inject failures (Phase 2/6
  // rollback test). Using vi.fn(impl) instead of bare vi.fn() so the
  // default behavior across the rest of the suite is unchanged.
  return { ...real, writeLayoutFiles: vi.fn(real.writeLayoutFiles) };
});

import { confirm, input, select } from '@inquirer/prompts';
import { execa } from 'execa';
import { findTool, vaultsRoot, isWindows } from '../../src/lib/platform.js';
import { writeLayoutFiles } from '../../src/lib/vault-layout.js';

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

// ── I-0: selectPublishMode pure-derivation matrix ────────────────────────────

describe('I-0: selectPublishMode → PublishConfig matrix', () => {
  // Pins the publishMode-string → 4-tuple translation today only asserted
  // via integration side effects in I-15 / I-16. The auth-gated three-way
  // (private repo + Pages on + Pages PRIVATE) is the most error-prone
  // derivation in the matrix — a future bug like `pagesPrivate: publishMode === 'public'`
  // would still pass I-15 but break here.
  it('private: notes-only (no Pages, no deploy.yml)', async () => {
    const { selectPublishMode } = await import('../../src/commands/init.js');
    const config = await selectPublishMode('private');
    expect(config).toEqual({
      publishMode: 'private',
      repoVisibility: 'private',
      enablePages: false,
      pagesPrivate: false,
      writeDeploy: false,
    });
  });

  it('public: public repo + public Pages + deploy.yml', async () => {
    const { selectPublishMode } = await import('../../src/commands/init.js');
    const config = await selectPublishMode('public');
    expect(config).toEqual({
      publishMode: 'public',
      repoVisibility: 'public',
      enablePages: true,
      pagesPrivate: false,
      writeDeploy: true,
    });
  });

  it('auth-gated: private repo + private Pages + deploy.yml (on Pro plan)', async () => {
    // requireAuthGatedEligible runs internally; the default ambient execa
    // mock returns plan='pro' so the eligibility check passes.
    const { selectPublishMode } = await import('../../src/commands/init.js');
    const config = await selectPublishMode('auth-gated');
    expect(config).toEqual({
      publishMode: 'auth-gated',
      repoVisibility: 'private',
      enablePages: true,
      pagesPrivate: true,
      writeDeploy: true,
    });
  });
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

  it('does not invoke any external process when name is invalid', async () => {
    // validateName throws synchronously at init.ts:159, BEFORE any execa call
    // (prereqs / git / gh). A regression that reorders validation after the
    // prereqs phase would silently let invalid names reach gh/git.
    const { run } = await import('../../src/commands/init.js');
    await expect(run('owner/repo', { cfgPath: join(tmp, '.claude.json'), log: silent })).rejects.toThrow();
    expect(vi.mocked(execa)).not.toHaveBeenCalled();
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

  it('does not call createRepo or runMcpAdd when vault dir already exists', async () => {
    // The collision check at init.ts:184 fires BEFORE createRepo (phase 4/6)
    // and registerMcpForVault (post-phase 6). A broken collision check could
    // silently create a second GitHub repo for an existing local dir.
    const vaultDir = join(tmp, 'ExistGuard');
    mkdirSync(vaultDir, { recursive: true });

    const { run } = await import('../../src/commands/init.js');
    await expect(run('ExistGuard', { cfgPath: join(tmp, '.claude.json'), log: silent }))
      .rejects.toThrow(/already exists/i);

    const repoCreate = vi.mocked(execa).mock.calls.filter(c => {
      const args = c[1] as unknown;
      return Array.isArray(args) && args[0] === 'api' && args.some(a => String(a).includes('/user/repos'));
    });
    expect(repoCreate.length).toBe(0);

    const mcpAdd = vi.mocked(execa).mock.calls.filter(c => {
      const args = c[1] as unknown;
      return Array.isArray(args) && args[0] === 'mcp' && args[1] === 'add';
    });
    expect(mcpAdd.length).toBe(0);
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

// ── I-12: runMcpAdd full argv shape (security invariant) ─────────────────────

describe('I-12: runMcpAdd argv shape', () => {
  it('passes the full canonical argv including --expected-sha256=<hash>', async () => {
    const { run } = await import('../../src/commands/init.js');
    await run('ArgvVault', { cfgPath: join(tmp, '.claude.json'), log: silent }).catch(() => {});

    // The canonical argv from src/lib/mcp.ts:runMcpAdd is:
    //   ['mcp', 'add', '--scope', 'user', name, '--', 'node', launcherPath, `--expected-sha256=${hash}`]
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
    expect(typeof args[7]).toBe('string'); // launcher path
    expect(String(args[7])).toMatch(/\.mcp-start\.js$/);
    expect(typeof args[8]).toBe('string');
    expect(String(args[8])).toMatch(/^--expected-sha256=[a-f0-9]{64}$/);
  });

  it('passes the actual on-disk launcher SHA-256 (not zero, not template-default)', async () => {
    const { run } = await import('../../src/commands/init.js');
    await run('HashVault', { cfgPath: join(tmp, '.claude.json'), log: silent }).catch(() => {});

    const mcpAddCalls = vi.mocked(execa).mock.calls.filter(c => {
      const args = c[1] as unknown;
      return Array.isArray(args) && args[0] === 'mcp' && args[1] === 'add';
    });
    const args = mcpAddCalls[0]?.[1] as readonly unknown[];
    const hashFlag = String(args[8]);
    const passedHash = hashFlag.replace('--expected-sha256=', '');

    // Compute the SHA of the on-disk launcher init wrote.
    const { sha256 } = await import('../../src/lib/vault.js');
    const launcherPath = join(tmp, 'HashVault', '.mcp-start.js');
    const actualHash = await sha256(launcherPath);
    expect(passedHash).toBe(actualHash);
  });

  it('on-disk launcher byte-matches lib/mcp-start.js.tmpl (no copy corruption)', async () => {
    // The launcher template is byte-immutable per
    // .claude/rules/security-invariants.md. The previous it() pins
    // passedHash == sha256(launcherOnDisk), but if some bug corrupted bytes
    // BEFORE both reads, both sides would see the bad bytes and still match.
    // This test pins the SECOND anchor: on-disk == canonical template SHA.
    const { run } = await import('../../src/commands/init.js');
    await run('TmplVault', { cfgPath: join(tmp, '.claude.json'), log: silent }).catch(() => {});

    const { sha256 } = await import('../../src/lib/vault.js');
    // getLauncherTemplate is NOT in the platform mock list (line 19) — it
    // resolves to the real <repo>/lib/mcp-start.js.tmpl path.
    const { getLauncherTemplate } = await import('../../src/lib/platform.js');
    const onDiskHash = await sha256(join(tmp, 'TmplVault', '.mcp-start.js'));
    const templateHash = await sha256(getLauncherTemplate());
    expect(onDiskHash).toBe(templateHash);
  });
});

// ── I-13c: Phase 2/6 mid-failure rollback (writeLayoutFiles throws) ──────────

describe('I-13c: rollback when Phase 2/6 layout write throws', () => {
  it('removes the partially-created vault dir when writeLayoutFiles throws', async () => {
    // After mkdirSync(vaultDir) at init.ts:196, createdDir flips true.
    // If the next layout step (writeLayoutFiles) throws, rollback should:
    // - skip MCP cleanup (registeredMcp=false)
    // - skip deleteRepo (createdRepo=false — repo never created)
    // - rmSync the vault dir (createdDir=true)
    // Existing rollback tests (I-9 / I-13) only exercise [4/6]+ failures,
    // so the mid-Phase-2 cleanup path was uncovered.
    vi.mocked(writeLayoutFiles).mockImplementationOnce(() => {
      throw new Error('disk full while writing CLAUDE.md');
    });

    const { run } = await import('../../src/commands/init.js');
    await expect(run('LayoutFailVault', { cfgPath: join(tmp, '.claude.json'), log: silent }))
      .rejects.toThrow(/disk full/);

    // Local dir MUST be cleaned up — even though createRepo / runMcpAdd never ran.
    expect(existsSync(join(tmp, 'LayoutFailVault'))).toBe(false);

    // No GitHub repo should have been created (would be an orphan)
    const repoCreate = vi.mocked(execa).mock.calls.find(c => {
      const args = c[1] as unknown;
      if (!Array.isArray(args)) return false;
      return args[0] === 'api' && args.some(a => String(a).includes('/user/repos'));
    });
    expect(repoCreate).toBeUndefined();

    // No MCP registration should have been attempted
    const mcpAdd = vi.mocked(execa).mock.calls.find(c => {
      const args = c[1] as unknown;
      return Array.isArray(args) && args[0] === 'mcp' && args[1] === 'add';
    });
    expect(mcpAdd).toBeUndefined();
  });
});

// ── I-13: rollback invokes deleteRepo via gh api DELETE ───────────────────────

describe('I-13: rollback deleteRepo argv', () => {
  it('invokes gh api --method DELETE /repos/<slug> when push fails', async () => {
    vi.mocked(execa).mockImplementation((async (cmd: string, args?: readonly string[]) => {
      if (args?.[0] === 'auth' && args?.[1] === 'status') return { exitCode: 0, stdout: '', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'config' && args?.[1] === 'user.name') return { exitCode: 0, stdout: 'User', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'config' && args?.[1] === 'user.email') return { exitCode: 0, stdout: 'u@e.com', stderr: '' };
      if (args?.[0] === 'api' && args?.[1] === 'user') {
        return { exitCode: 0, stdout: JSON.stringify({ login: 'testuser', plan: { name: 'pro' } }), stderr: '' };
      }
      if (cmd === 'git' && args?.includes('push')) {
        throw Object.assign(new Error('git push failed: Permission denied'), { exitCode: 1 });
      }
      // deleteRepo via gh api DELETE — happy path so rollback can complete.
      if (args?.[0] === 'api' && args?.includes('--method') && args?.includes('DELETE')) {
        return { exitCode: 0, stdout: 'HTTP/2 204\r\n\r\n', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }) as never);

    const { run } = await import('../../src/commands/init.js');
    await expect(run('DeleteRepoVault', { cfgPath: join(tmp, '.claude.json'), log: silent }))
      .rejects.toThrow();

    const deleteCalls = vi.mocked(execa).mock.calls.filter(c => {
      const args = c[1] as unknown;
      if (!Array.isArray(args)) return false;
      return args.includes('api') && args.includes('--method') && args.includes('DELETE')
        && args.some(a => String(a).includes('repos/testuser/DeleteRepoVault'));
    });
    expect(deleteCalls.length).toBeGreaterThan(0);
  });
});

// ── I-13b: rollback when addRemote fails AFTER createRepo succeeded ──────────

describe('I-13b: rollback when addRemote fails mid-phase-4', () => {
  it('cleans up the GitHub repo when addRemote throws after createRepo succeeded', async () => {
    // init.ts:217-218 calls `await createRemoteRepo(...)` then `createdRepo = true`.
    // createRemoteRepo (helper at init.ts:74-77) does createRepo then addRemote.
    // If addRemote throws AFTER createRepo succeeded, the await never resolves,
    // so createdRepo stays false, so rollback at init.ts:249 skips deleteRepo.
    // → GitHub orphan repo. This test pins the EXPECTED behavior (deleteRepo
    // MUST run) and will fail until the flag-tracking is fixed.
    vi.mocked(execa).mockImplementation((async (cmd: string, args?: readonly string[]) => {
      if (args?.[0] === 'auth' && args?.[1] === 'status') return { exitCode: 0, stdout: '', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'config' && args?.[1] === 'user.name') return { exitCode: 0, stdout: 'User', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'config' && args?.[1] === 'user.email') return { exitCode: 0, stdout: 'u@e.com', stderr: '' };
      if (args?.[0] === 'api' && args?.[1] === 'user') {
        return { exitCode: 0, stdout: JSON.stringify({ login: 'testuser', plan: { name: 'pro' } }), stderr: '' };
      }
      // createRepo (POST /user/repos via gh api --include) succeeds
      if (args?.[0] === 'api' && args?.includes('--method') && args?.includes('POST')
          && args.some(a => String(a).includes('/user/repos'))) {
        return { exitCode: 0, stdout: 'HTTP/2 201\r\n\r\n{"name":"name","private":false}', stderr: '' };
      }
      // git remote add throws AFTER createRepo
      if (cmd === 'git' && args?.[0] === '-C' && args?.[2] === 'remote' && args?.[3] === 'add') {
        throw Object.assign(new Error('git remote add failed: existing remote'), { exitCode: 128 });
      }
      // deleteRepo path responds 204 if it's reached
      if (args?.[0] === 'api' && args?.includes('--method') && args?.includes('DELETE')) {
        return { exitCode: 0, stdout: 'HTTP/2 204\r\n\r\n', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }) as never);

    const { run } = await import('../../src/commands/init.js');
    await expect(run('OrphanGuard', { cfgPath: join(tmp, '.claude.json'), log: silent }))
      .rejects.toThrow();

    // The just-created GitHub repo MUST be deleted in rollback. Without this,
    // a transient `git remote add` failure (e.g. a stale .git/config remote
    // entry from a half-cleaned previous run) leaks a real GitHub repo.
    const deleteCalls = vi.mocked(execa).mock.calls.filter(c => {
      const args = c[1] as unknown;
      if (!Array.isArray(args)) return false;
      return args.includes('api') && args.includes('--method') && args.includes('DELETE')
        && args.some(a => String(a).includes('repos/testuser/OrphanGuard'));
    });
    expect(deleteCalls.length).toBeGreaterThan(0);
  });
});

// ── I-14: init NEVER requests delete_repo scope (security invariant) ──────────

describe('I-14: ensureGhAuth scope', () => {
  it('does not request the delete_repo scope at any point during init', async () => {
    const { run } = await import('../../src/commands/init.js');
    await run('ScopeVault', { cfgPath: join(tmp, '.claude.json'), log: silent }).catch(() => {});

    // delete_repo is reserved for `destroy` (granted on-demand via
    // ensureDeleteRepoScope in github.ts). init must never request it,
    // either via gh auth login -s or gh auth refresh -s. This is a
    // structural check across every gh execa call init made.
    const deleteRepoScope = vi.mocked(execa).mock.calls.filter(c => {
      const args = c[1] as unknown;
      if (!Array.isArray(args)) return false;
      const flat = args.map(String).join(' ');
      return flat.includes('delete_repo');
    });
    expect(deleteRepoScope.length).toBe(0);
  });
});

// ── I-15: --publish=public happy path argv shape ─────────────────────────────

describe('I-15: --publish=public', () => {
  it('creates a public repo, enables Pages, and writes deploy.yml', async () => {
    vi.mocked(select).mockResolvedValue('public');

    const { run } = await import('../../src/commands/init.js');
    await run('PublicVault', { cfgPath: join(tmp, '.claude.json'), log: silent }).catch(() => {});

    // Repo creation: gh api POST /user/repos with `private=false`
    const repoCreate = vi.mocked(execa).mock.calls.find(c => {
      const args = c[1] as unknown;
      if (!Array.isArray(args)) return false;
      return args[0] === 'api' && args.some(a => String(a).includes('/user/repos'));
    });
    expect(repoCreate).toBeDefined();
    const repoCreateArgs = (repoCreate?.[1] as readonly unknown[])?.map(String) ?? [];
    expect(repoCreateArgs).toContain('private=false');

    // enablePages uses POST /pages (per github.ts:enablePages)
    const pagesEnable = vi.mocked(execa).mock.calls.find(c => {
      const args = c[1] as unknown;
      if (!Array.isArray(args)) return false;
      const flat = args.map(String).join(' ');
      return flat.includes('/pages') && flat.includes('POST');
    });
    expect(pagesEnable).toBeDefined();

    // deploy.yml present in the scaffolded vault
    expect(existsSync(join(tmp, 'PublicVault', '.github', 'workflows', 'deploy.yml'))).toBe(true);
  });
});

// ── I-16: --publish=auth-gated happy path on pro plan ────────────────────────

describe('I-16: --publish=auth-gated (pro plan)', () => {
  it('creates a private repo, enables Pages, and sets Pages visibility to private', async () => {
    vi.mocked(select).mockResolvedValue('auth-gated');

    const { run } = await import('../../src/commands/init.js');
    await run('GatedVault', { cfgPath: join(tmp, '.claude.json'), log: silent }).catch(() => {});

    // Repo creation: gh api POST /user/repos with `private=true`
    const repoCreate = vi.mocked(execa).mock.calls.find(c => {
      const args = c[1] as unknown;
      if (!Array.isArray(args)) return false;
      return args[0] === 'api' && args.some(a => String(a).includes('/user/repos'));
    });
    expect(repoCreate).toBeDefined();
    const repoCreateArgs = (repoCreate?.[1] as readonly unknown[])?.map(String) ?? [];
    expect(repoCreateArgs).toContain('private=true');

    // enablePages uses POST /pages (per github.ts:enablePages)
    const pagesEnable = vi.mocked(execa).mock.calls.find(c => {
      const args = c[1] as unknown;
      if (!Array.isArray(args)) return false;
      const flat = args.map(String).join(' ');
      return flat.includes('/pages') && flat.includes('POST');
    });
    expect(pagesEnable).toBeDefined();

    // setPagesVisibility uses PUT /pages with `public=false` (per github.ts:setPagesVisibility)
    const pagesPrivate = vi.mocked(execa).mock.calls.find(c => {
      const args = c[1] as unknown;
      if (!Array.isArray(args)) return false;
      const flat = args.map(String).join(' ');
      return flat.includes('/pages') && flat.includes('PUT') && flat.includes('public=false');
    });
    expect(pagesPrivate).toBeDefined();
  });
});

// ── I-17: invalid --publish value rejected ────────────────────────────────────

describe('I-17: invalid publish mode', () => {
  it('throws UNRECOGNIZED_INPUT before any side effect when publishMode is unknown', async () => {
    const { run } = await import('../../src/commands/init.js');
    // 'pulic' is a typo not in PUBLISH_MODES
    await expect(
      run('TypoVault', { cfgPath: join(tmp, '.claude.json'), publishMode: 'pulic' as never, log: silent }),
    ).rejects.toThrow(/Invalid publishMode|pulic/i);

    // Vault dir was NOT created — rejection happened before any filesystem op
    expect(existsSync(join(tmp, 'TypoVault'))).toBe(false);
  });
});

// ── I-17b: invalid publish-mode edge cases ───────────────────────────────────

describe('I-17b: invalid publish mode edge cases', () => {
  // I-17 already covers the typo case ('pulic'). These pin the boundary
  // shapes — empty string, trailing whitespace, case-variant, JS-only null.
  // All MUST hit UNRECOGNIZED_INPUT, never silently fall through to
  // interactive `select()` and never create a vault dir.
  it.each([
    ['empty string', ''],
    ['trailing whitespace', 'public '],
    ['uppercase variant', 'PUBLIC'],
  ])('rejects %s without creating a vault dir', async (_label, mode) => {
    const { run } = await import('../../src/commands/init.js');
    await expect(
      run('EdgeMode', { cfgPath: join(tmp, '.claude.json'), publishMode: mode as never, log: silent }),
    ).rejects.toThrow(/Invalid publishMode/i);
    expect(existsSync(join(tmp, 'EdgeMode'))).toBe(false);
    expect(vi.mocked(select)).not.toHaveBeenCalled();
  });

  it('rejects null (JS caller) without falling through to select()', async () => {
    // TS types say `PublishMode | undefined`, but a JS caller can pass null.
    // The current `publishModeOpt !== undefined` check at init.ts:41 lets
    // null through to isPublishMode(null), which returns false → throws.
    const { run } = await import('../../src/commands/init.js');
    await expect(
      run('NullMode', { cfgPath: join(tmp, '.claude.json'), publishMode: null as never, log: silent }),
    ).rejects.toThrow(/Invalid publishMode/i);
    expect(vi.mocked(select)).not.toHaveBeenCalled();
  });
});

// ── I-19: setupBranchProtection argv shape (Phase 6/6 happy path) ────────────

describe('I-19: branch protection argv', () => {
  it('PUTs branches/main/protection with required_pull_request_reviews body', async () => {
    // init.ts:97-112 calls `gh api repos/<u>/<n>/branches/main/protection
    // --method PUT --input -` with a stdin body declaring the required
    // PR-review count. Today only the `protection` substring is asserted
    // implicitly via I-9 / I-13 side effects; the argv shape (--method PUT,
    // the slug path, the --input - flag) is unpinned.
    let protectionInput: string | undefined;
    vi.mocked(execa).mockImplementation((async (cmd: string, args?: readonly string[], opts?: { input?: string }) => {
      if (args?.[0] === 'auth' && args?.[1] === 'status') return { exitCode: 0, stdout: '', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'config' && args?.[1] === 'user.name') return { exitCode: 0, stdout: 'User', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'config' && args?.[1] === 'user.email') return { exitCode: 0, stdout: 'u@e.com', stderr: '' };
      if (args?.[0] === 'api' && args?.[1] === 'user') {
        return { exitCode: 0, stdout: JSON.stringify({ login: 'testuser', plan: { name: 'pro' } }), stderr: '' };
      }
      if (args?.[0] === 'api' && args?.includes('--method') && args?.includes('PUT')
          && args.some(a => String(a).includes('branches/main/protection'))) {
        protectionInput = opts?.input;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }) as never);

    const { run } = await import('../../src/commands/init.js');
    await run('ProtVault', { cfgPath: join(tmp, '.claude.json'), log: silent }).catch(() => {});

    const protectionCall = vi.mocked(execa).mock.calls.find(c => {
      const args = c[1] as unknown;
      if (!Array.isArray(args)) return false;
      return args[0] === 'api' && args.includes('--method') && args.includes('PUT')
        && args.some(a => String(a).includes('repos/testuser/ProtVault/branches/main/protection'));
    });
    expect(protectionCall).toBeDefined();
    const argv = (protectionCall?.[1] as readonly unknown[])?.map(String) ?? [];
    expect(argv).toContain('--method');
    expect(argv).toContain('PUT');
    expect(argv).toContain('--input');
    expect(argv).toContain('-');

    // The body payload sent on stdin must declare required_pull_request_reviews
    // with required_approving_review_count: 1. A regression that drops the PR
    // gate (e.g. sets count: 0 or omits the block) silently weakens the repo.
    expect(protectionInput).toBeDefined();
    const body = JSON.parse(protectionInput as string);
    expect(body.required_pull_request_reviews?.required_approving_review_count).toBe(1);
    expect(body.enforce_admins).toBe(false);
  });

  it('continues to MCP registration when branch protection PUT exits non-zero (free plan)', async () => {
    // init.ts:108-111 swallows non-zero PUT (typical on free private repos)
    // and logs a manual-setup hint. MCP registration MUST still run.
    vi.mocked(execa).mockImplementation((async (cmd: string, args?: readonly string[]) => {
      if (args?.[0] === 'auth' && args?.[1] === 'status') return { exitCode: 0, stdout: '', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'config' && args?.[1] === 'user.name') return { exitCode: 0, stdout: 'User', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'config' && args?.[1] === 'user.email') return { exitCode: 0, stdout: 'u@e.com', stderr: '' };
      if (args?.[0] === 'api' && args?.[1] === 'user') {
        return { exitCode: 0, stdout: JSON.stringify({ login: 'testuser', plan: { name: 'free' } }), stderr: '' };
      }
      if (args?.[0] === 'api' && args?.includes('--method') && args?.includes('PUT')
          && args.some(a => String(a).includes('branches/main/protection'))) {
        // Mimic GitHub's free-plan rejection — non-zero exit, no throw
        // (the exec call uses `reject: false`).
        return { exitCode: 1, stdout: '', stderr: 'Upgrade to GitHub Pro' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }) as never);

    const { run } = await import('../../src/commands/init.js');
    const lines: string[] = [];
    await run('FreeProtVault', { cfgPath: join(tmp, '.claude.json'), log: arrayLogger(lines) }).catch(() => {});

    // Hint message logged
    expect(lines.some(l => /branch protection|set up manually/i.test(l))).toBe(true);

    // MCP registration still ran despite the protection failure
    const mcpAdd = vi.mocked(execa).mock.calls.find(c => {
      const args = c[1] as unknown;
      return Array.isArray(args) && args[0] === 'mcp' && args[1] === 'add';
    });
    expect(mcpAdd).toBeDefined();
  });
});

// ── I-20: Phase 5/6 enablePages reject is swallowed (still pushes) ───────────

describe('I-20: enablePages reject swallowing', () => {
  it('logs a manual-enable hint when enablePages throws but still runs the git push', async () => {
    // setupGitHubPages (init.ts:79-95) catches enablePages errors and logs
    // a hint pointing at the manual settings URL. pushNewRepo runs
    // unconditionally AFTER setupGitHubPages — a regression that hoists
    // the push inside the try/catch would silently skip the push on any
    // Pages failure, leaving the user with a created-but-empty repo.
    vi.mocked(select).mockResolvedValue('public');
    vi.mocked(execa).mockImplementation((async (cmd: string, args?: readonly string[]) => {
      if (args?.[0] === 'auth' && args?.[1] === 'status') return { exitCode: 0, stdout: '', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'config' && args?.[1] === 'user.name') return { exitCode: 0, stdout: 'User', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'config' && args?.[1] === 'user.email') return { exitCode: 0, stdout: 'u@e.com', stderr: '' };
      if (args?.[0] === 'api' && args?.[1] === 'user') {
        return { exitCode: 0, stdout: JSON.stringify({ login: 'testuser', plan: { name: 'pro' } }), stderr: '' };
      }
      // /pages POST fails fatally (e.g. repo not yet ready for Pages —
      // realistic 422 right after createRepo before GitHub settles).
      if (args?.[0] === 'api' && args?.includes('--method') && args?.includes('POST')
          && args.some(a => String(a).includes('/pages'))) {
        return { exitCode: 1, stdout: '', stderr: 'gh: API request failed: 422 Unprocessable Entity' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }) as never);

    const lines: string[] = [];
    const { run } = await import('../../src/commands/init.js');
    await run('PagesFailVault', { cfgPath: join(tmp, '.claude.json'), log: arrayLogger(lines) }).catch(() => {});

    // The manual-enable hint MUST appear in logs
    expect(lines.some(l => /Could not auto-enable GitHub Pages/i.test(l))).toBe(true);
    expect(lines.some(l => /Enable manually/i.test(l))).toBe(true);

    // pushNewRepo MUST still run
    const pushCall = vi.mocked(execa).mock.calls.find(c => {
      const args = c[1] as unknown;
      return Array.isArray(args) && args.includes('push');
    });
    expect(pushCall).toBeDefined();
  });
});

// ── I-21: Phase 5/6 setPagesVisibility reject is swallowed (auth-gated) ──────

describe('I-21: setPagesVisibility reject swallowing (auth-gated)', () => {
  it('logs a warning when setPagesVisibility fails after enablePages succeeded', async () => {
    // setupGitHubPages (init.ts:88-94) calls setPagesVisibility only when
    // pagesPrivate is true (auth-gated). If that PUT fails, the catch
    // logs a "may be publicly accessible" warning. The flow continues —
    // the repo is private, just the Pages site might be public-readable.
    vi.mocked(select).mockResolvedValue('auth-gated');
    vi.mocked(execa).mockImplementation((async (cmd: string, args?: readonly string[]) => {
      if (args?.[0] === 'auth' && args?.[1] === 'status') return { exitCode: 0, stdout: '', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'config' && args?.[1] === 'user.name') return { exitCode: 0, stdout: 'User', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'config' && args?.[1] === 'user.email') return { exitCode: 0, stdout: 'u@e.com', stderr: '' };
      if (args?.[0] === 'api' && args?.[1] === 'user') {
        return { exitCode: 0, stdout: JSON.stringify({ login: 'testuser', plan: { name: 'pro' } }), stderr: '' };
      }
      // PUT /pages with public=false fails (e.g. permission issue)
      if (args?.[0] === 'api' && args?.includes('--method') && args?.includes('PUT')
          && args.some(a => String(a).includes('/pages'))) {
        return { exitCode: 1, stdout: '', stderr: 'gh: API request failed: 403 Forbidden' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }) as never);

    const lines: string[] = [];
    const { run } = await import('../../src/commands/init.js');
    await run('PrivPagesVault', { cfgPath: join(tmp, '.claude.json'), log: arrayLogger(lines) }).catch(() => {});

    // The "may be publicly accessible" warning MUST appear
    expect(lines.some(l => /Could not set Pages to private/i.test(l))).toBe(true);
    expect(lines.some(l => /publicly accessible/i.test(l))).toBe(true);

    // pushNewRepo MUST still run despite the Pages-visibility failure
    const pushCall = vi.mocked(execa).mock.calls.find(c => {
      const args = c[1] as unknown;
      return Array.isArray(args) && args.includes('push');
    });
    expect(pushCall).toBeDefined();
  });
});

// ── I-18: vault name at NAME_MAX_LENGTH boundary ─────────────────────────────

describe('I-18: vault name boundary', () => {
  it('accepts a name of exactly 64 characters (does not fail validation)', async () => {
    const name = 'a'.repeat(64);
    const { run } = await import('../../src/commands/init.js');
    // run may resolve OR reject — what matters is that the rejection (if any)
    // is NOT a "name too long" message. Catch + assert pattern handles both.
    let err: unknown = null;
    try {
      await run(name, { cfgPath: join(tmp, '.claude.json'), log: silent });
    } catch (e) {
      err = e;
    }
    if (err) {
      expect(String((err as Error).message)).not.toMatch(/64 characters/i);
    }
  });

  it('rejects a name of exactly 65 characters with the canonical message', async () => {
    const name = 'a'.repeat(65);
    const { run } = await import('../../src/commands/init.js');
    await expect(
      run(name, { cfgPath: join(tmp, '.claude.json'), log: silent }),
    ).rejects.toThrow(/64 characters/i);
  });

  it('accepts a single-character name (lower boundary)', async () => {
    const { run } = await import('../../src/commands/init.js');
    let err: unknown = null;
    try {
      await run('a', { cfgPath: join(tmp, '.claude.json'), log: silent });
    } catch (e) {
      err = e;
    }
    if (err) {
      expect(String((err as Error).message)).not.toMatch(/letters, numbers, hyphens|64 characters|provide the vault name/i);
    }
  });
});

// ── LIVE: init creates real GitHub repo ───────────────────────────────────────

const LIVE_VAULT = `vk-live-init-${Date.now()}`;

// liveDescribe skips on Windows — see tests/helpers/live-describe.ts for
// the rate-limit rationale (live tests run only on Ubuntu in CI).
liveDescribe('live: init creates real GitHub repo', { timeout: 60_000 }, () => {
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
    try { await restoreReal(); } catch { /* don't let mock-restore failures skip the destroy below */ }
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
    expect(dir).not.toBeNull();
    expect(typeof dir).toBe('string');
    expect((dir as string).length).toBeGreaterThan(0);
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
