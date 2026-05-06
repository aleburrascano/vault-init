import { describe, it, expect, beforeEach, vi } from 'vitest';
import { arrayLogger } from './helpers/logger.js';

/**
 * Universal bootstrap-gate sweep — exercises `gateOrSkip` for every
 * `src/commands/*.ts` file and asserts:
 *
 *   1. Every command in `COMMANDS_THAT_MUST_BE_GATED` throws
 *      `VaultkitError('SETUP_REQUIRED')` when ANY of the gate's five
 *      preconditions is unmet (Node, gh-on-PATH, gh-authed, scopes,
 *      git config). 11 commands × 3 representative failure modes = 33
 *      parameterized assertions covering the gh-missing, gh-unauthed,
 *      and missing-git-config paths.
 *
 *   2. Every command in `BYPASS` (`setup`, `doctor`) succeeds with no
 *      prereqs whatsoever.
 *
 * The lists below are the canonical declaration of each command's gate
 * posture. The architecture fitness function (added in U4) enforces
 * that every `src/commands/*.ts` file appears in exactly one of the two
 * lists — a new command added via `/add-command` cannot ship without
 * declaring its gate posture here.
 */

vi.mock('execa', async (importOriginal) => {
  const real = await importOriginal<typeof import('execa')>();
  return { ...real, execa: vi.fn() };
});
vi.mock('../src/lib/platform.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/platform.js')>();
  return { ...real, findTool: vi.fn(), installGhForPlatform: vi.fn() };
});

import { execa } from 'execa';
import { findTool } from '../src/lib/platform.js';
import { gateOrSkip, SETUP_BYPASS } from '../src/lib/prereqs.js';
import { isVaultkitError } from '../src/lib/errors.js';

/**
 * Every `src/commands/*.ts` file's name. Update this when adding or
 * removing a command — the architecture fitness function asserts the
 * union of these two lists matches the on-disk command set.
 */
// Includes both new (3.0) names AND the deprecated 3.x aliases —
// commander treats each alias as its own command, so the gate must
// fire for the alias name too. The `pull` / `status` rows fall out
// when the aliases are deleted in 4.0.
export const COMMANDS_THAT_MUST_BE_GATED = [
  'backup',
  'connect',
  'destroy',
  'disconnect',
  'init',
  'list',
  'pull',
  'refresh',
  'remove',
  'status',
  'sync',
  'update',
  'verify',
  'visibility',
] as const;

export const BYPASS = ['setup', 'doctor', 'mcp-server'] as const;

beforeEach(() => {
  vi.mocked(execa).mockReset();
  vi.mocked(findTool).mockReset();
});

/**
 * Configure mocks to a state where the gate would PASS (gh on PATH,
 * authed, full scopes, git config set). Each test then breaks ONE of
 * the preconditions to assert the gate fires.
 */
function mockHealthyPrereqs(): void {
  vi.mocked(findTool).mockResolvedValue('/usr/bin/gh');
  vi.mocked(execa).mockImplementation((async (cmd: string, args?: readonly string[]) => {
    if ((cmd.endsWith('gh') || cmd === '/usr/bin/gh') && args?.[0] === 'auth' && args?.[1] === 'status') {
      return { exitCode: 0, stdout: '', stderr: "Token scopes: 'repo', 'workflow'" };
    }
    if (cmd === 'git' && args?.[0] === 'config') {
      if (args[1] === 'user.name') return { exitCode: 0, stdout: 'Test User', stderr: '' };
      if (args[1] === 'user.email') return { exitCode: 0, stdout: 'test@example.com', stderr: '' };
    }
    throw new Error(`unexpected execa call: ${cmd} ${args?.join(' ')}`);
  }) as never);
}

describe('bootstrap gate: bypass commands run unconditionally', () => {
  it.each(BYPASS)('allows `vaultkit %s` even with NO prereqs at all', async (cmd) => {
    // Pessimistic: no gh, no execa responses at all.
    vi.mocked(findTool).mockResolvedValue(null);
    vi.mocked(execa).mockImplementation((async () => {
      throw new Error('gate should not invoke execa for bypass commands');
    }) as never);
    await expect(gateOrSkip(cmd, arrayLogger([]))).resolves.toBeUndefined();
    // No execa, no findTool — the gate short-circuits before any check.
    expect(vi.mocked(execa)).not.toHaveBeenCalled();
    expect(vi.mocked(findTool)).not.toHaveBeenCalled();
  });

  it('SETUP_BYPASS exposes exactly setup + doctor + mcp-server (no drift)', () => {
    expect(SETUP_BYPASS.has('setup')).toBe(true);
    expect(SETUP_BYPASS.has('doctor')).toBe(true);
    expect(SETUP_BYPASS.has('mcp-server')).toBe(true);
    expect(SETUP_BYPASS.size).toBe(3);
  });
});

describe('bootstrap gate: every non-bypass command blocks when gh is missing from PATH', () => {
  it.each(COMMANDS_THAT_MUST_BE_GATED)('blocks `vaultkit %s` when gh is missing', async (cmd) => {
    mockHealthyPrereqs();
    vi.mocked(findTool).mockResolvedValue(null);
    let caught: unknown;
    try {
      await gateOrSkip(cmd, arrayLogger([]));
    } catch (err) {
      caught = err;
    }
    expect(isVaultkitError(caught), `gate did not throw VaultkitError for ${cmd}`).toBe(true);
    expect((caught as { code: string }).code).toBe('SETUP_REQUIRED');
    expect((caught as { message: string }).message).toMatch(/gh.*not installed/i);
    expect((caught as { message: string }).message).toMatch(/vaultkit setup/);
  });
});

describe('bootstrap gate: every non-bypass command blocks when gh is unauthed', () => {
  it.each(COMMANDS_THAT_MUST_BE_GATED)('blocks `vaultkit %s` when gh auth status fails', async (cmd) => {
    mockHealthyPrereqs();
    // Override the mock to return non-zero on auth status.
    vi.mocked(execa).mockImplementation((async (c: string, args?: readonly string[]) => {
      if (args?.[0] === 'auth' && args?.[1] === 'status') {
        return { exitCode: 1, stdout: '', stderr: '' };
      }
      if (c === 'git' && args?.[0] === 'config') {
        return { exitCode: 0, stdout: 'x', stderr: '' };
      }
      throw new Error(`unexpected execa call: ${c} ${args?.join(' ')}`);
    }) as never);
    let caught: unknown;
    try {
      await gateOrSkip(cmd, arrayLogger([]));
    } catch (err) {
      caught = err;
    }
    expect(isVaultkitError(caught), `gate did not throw VaultkitError for ${cmd}`).toBe(true);
    expect((caught as { code: string }).code).toBe('SETUP_REQUIRED');
    expect((caught as { message: string }).message).toMatch(/not authenticated/i);
    expect((caught as { message: string }).message).toMatch(/vaultkit setup/);
  });
});

describe('bootstrap gate: every non-bypass command blocks when git config is empty', () => {
  it.each(COMMANDS_THAT_MUST_BE_GATED)('blocks `vaultkit %s` when git config user.name is empty', async (cmd) => {
    mockHealthyPrereqs();
    vi.mocked(execa).mockImplementation((async (c: string, args?: readonly string[]) => {
      if (args?.[0] === 'auth' && args?.[1] === 'status') {
        return { exitCode: 0, stdout: '', stderr: "Token scopes: 'repo', 'workflow'" };
      }
      if (c === 'git' && args?.[0] === 'config') {
        if (args[1] === 'user.name') return { exitCode: 0, stdout: '', stderr: '' };
        if (args[1] === 'user.email') return { exitCode: 0, stdout: 'x', stderr: '' };
      }
      throw new Error(`unexpected execa call: ${c} ${args?.join(' ')}`);
    }) as never);
    let caught: unknown;
    try {
      await gateOrSkip(cmd, arrayLogger([]));
    } catch (err) {
      caught = err;
    }
    expect(isVaultkitError(caught), `gate did not throw VaultkitError for ${cmd}`).toBe(true);
    expect((caught as { code: string }).code).toBe('SETUP_REQUIRED');
    expect((caught as { message: string }).message).toMatch(/git config/);
  });
});

describe('bootstrap gate: every non-bypass command passes when prereqs are healthy', () => {
  it.each(COMMANDS_THAT_MUST_BE_GATED)('allows `vaultkit %s` when prereqs are met', async (cmd) => {
    mockHealthyPrereqs();
    await expect(gateOrSkip(cmd, arrayLogger([]))).resolves.toBeUndefined();
  });
});
