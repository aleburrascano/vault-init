import { describe, it, expect, beforeEach, vi } from 'vitest';
import { arrayLogger } from '../helpers/logger.js';

vi.mock('@inquirer/prompts', () => ({ confirm: vi.fn(), input: vi.fn() }));
vi.mock('execa', async (importOriginal) => {
  const real = await importOriginal<typeof import('execa')>();
  return { ...real, execa: vi.fn() };
});
vi.mock('../../src/lib/platform.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/platform.js')>();
  return { ...real, findTool: vi.fn(), installGhForPlatform: vi.fn() };
});

import { confirm } from '@inquirer/prompts';
import { execa } from 'execa';
import { findTool, installGhForPlatform } from '../../src/lib/platform.js';

beforeEach(() => {
  vi.mocked(confirm).mockReset();
  vi.mocked(execa).mockReset();
  vi.mocked(findTool).mockReset();
  vi.mocked(installGhForPlatform).mockReset();
});

describe('setup command', () => {
  it('returns 0 when every prerequisite is already satisfied', async () => {
    vi.mocked(findTool).mockImplementation(async (name: string) => {
      if (name === 'gh') return '/usr/bin/gh';
      if (name === 'claude') return '/usr/bin/claude';
      return null;
    });
    // gh auth status returns 0 with the requested scopes already present
    vi.mocked(execa).mockImplementation((async (_cmd: string, args?: readonly string[]) => {
      if (args?.[0] === 'auth' && args?.[1] === 'status') {
        return { exitCode: 0, stdout: '', stderr: "Token scopes: 'repo', 'workflow', 'gist'" };
      }
      if (args?.[0] === 'config' && args?.[1] === 'user.name') {
        return { exitCode: 0, stdout: 'Test User', stderr: '' };
      }
      if (args?.[0] === 'config' && args?.[1] === 'user.email') {
        return { exitCode: 0, stdout: 'test@example.com', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }) as never);

    const { run } = await import('../../src/commands/setup.js');
    const lines: string[] = [];
    const issues = await run({ skipInstallCheck: true, log: arrayLogger(lines) });

    expect(issues).toBe(0);
    expect(lines.some(l => /Setup complete/.test(l))).toBe(true);
    expect(lines.some(l => /\+ ok\s+gh:/.test(l))).toBe(true);
    expect(lines.some(l => /\+ ok\s+gh auth:/.test(l))).toBe(true);
    expect(lines.some(l => /\+ ok\s+git config:/.test(l))).toBe(true);
    expect(lines.some(l => /\+ ok\s+claude:/.test(l))).toBe(true);
  });

  it('refreshes scopes when gh is authed but missing repo/workflow', async () => {
    vi.mocked(findTool).mockImplementation(async (name: string) => {
      if (name === 'gh') return '/usr/bin/gh';
      if (name === 'claude') return '/usr/bin/claude';
      return null;
    });
    const ghCalls: readonly string[][] = [];
    vi.mocked(execa).mockImplementation((async (_cmd: string, args?: readonly string[]) => {
      if (args && args[0] === 'auth' && args[1] === 'status') {
        // Authed, but only has 'gist' scope — repo + workflow are missing
        return { exitCode: 0, stdout: '', stderr: "Token scopes: 'gist'" };
      }
      if (args && args[0] === 'auth' && args[1] === 'refresh') {
        (ghCalls as string[][]).push([...args]);
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args?.[0] === 'config' && args?.[1] === 'user.name') return { exitCode: 0, stdout: 'X', stderr: '' };
      if (args?.[0] === 'config' && args?.[1] === 'user.email') return { exitCode: 0, stdout: 'x@y', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    }) as never);

    const { run } = await import('../../src/commands/setup.js');
    const lines: string[] = [];
    const issues = await run({ skipInstallCheck: true, log: arrayLogger(lines) });

    expect(issues).toBe(0);
    expect(ghCalls.length).toBeGreaterThan(0);
    const refreshArgs = ghCalls[0]!;
    expect(refreshArgs).toContain('refresh');
    expect(refreshArgs.join(',')).toMatch(/repo|workflow/);
  });

  it('warns when claude is missing but does not increment issues', async () => {
    vi.mocked(findTool).mockImplementation(async (name: string) => {
      if (name === 'gh') return '/usr/bin/gh';
      if (name === 'claude') return null;
      return null;
    });
    vi.mocked(confirm).mockResolvedValue(false);
    vi.mocked(execa).mockImplementation((async (_cmd: string, args?: readonly string[]) => {
      if (args?.[0] === 'auth' && args?.[1] === 'status') {
        return { exitCode: 0, stdout: '', stderr: "Token scopes: 'repo', 'workflow'" };
      }
      if (args?.[0] === 'config' && args?.[1] === 'user.name') return { exitCode: 0, stdout: 'X', stderr: '' };
      if (args?.[0] === 'config' && args?.[1] === 'user.email') return { exitCode: 0, stdout: 'x@y', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    }) as never);

    const { run } = await import('../../src/commands/setup.js');
    const lines: string[] = [];
    const issues = await run({ log: arrayLogger(lines) });

    expect(issues).toBe(0);
    expect(lines.some(l => /! warn\s+claude:/.test(l))).toBe(true);
  });
});
