import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execa } from 'execa';
import {
  CANONICAL_LAYOUT_FILES,
  createDirectoryTree,
  writeLayoutFiles,
} from '../../src/lib/vault-layout.js';
import { getLauncherTemplate } from '../../src/lib/template-paths.js';
import { sha256 } from '../../src/lib/vault.js';
import { addToRegistry, removeFromRegistry } from '../../src/lib/registry.js';
import { VAULT_FILES } from '../../src/lib/constants.js';

/**
 * Locally-scaffolded vaultkit vault for live tests that DON'T need a real
 * GitHub remote. Replaces the `init` → `destroy` round-trip in tests like
 * `status` (just reads git state) and `verify` (just hashes the launcher),
 * which previously created a real `vk-live-*` GitHub repo per test file
 * to bootstrap a vault — that's ~10 GH-API calls per test, multiplied
 * across the whole live-test suite, which trips GitHub's secondary rate
 * limit on a fresh PAT account in well under a minute.
 *
 * Use this from beforeAll; remember to call `localVault.cleanup()` in
 * afterAll. The vault is registered in the *real* `~/.claude.json` under
 * the name you provide (which must start with `vk-live-` so vitest's
 * globalTeardown can sweep it if afterAll crashes).
 */
export interface LocalVault {
  name: string;
  vaultDir: string;
  launcherHash: string;
  /** Bare git repo path used as `origin`, only set when `withRemote: true`. */
  bareRepoDir: string | null;
  /** Cleanup helper — removes registry entry + tmp dirs. Idempotent. */
  cleanup: () => Promise<void>;
}

export interface MakeLocalVaultOptions {
  /**
   * Vault name (and registry key). MUST start with `vk-live-` so that
   * tests/global-teardown.ts can sweep stale entries on crash.
   */
  name: string;
  /**
   * When true, creates a local bare git repo and wires it up as the
   * vault's `origin` remote, then commits + pushes the initial vault
   * layout. Required for tests that exercise `git status`'s upstream
   * tracking (status). Defaults to false (verify and similar local-only
   * tests don't need a remote).
   */
  withRemote?: boolean;
  /**
   * Override the launcher hash registered in `~/.claude.json`. Defaults
   * to the launcher's actual SHA-256, which lets `verify` succeed.
   * Pass an explicit string when a test needs a hash mismatch case.
   */
  hashOverride?: string;
}

/**
 * Build a locally-scaffolded vaultkit vault and register it in the real
 * `~/.claude.json`. Returns the metadata + a cleanup callback.
 *
 * The vault is byte-identical to one produced by `vaultkit init` minus
 * the GitHub repo creation and `_vault.json` (which is only relevant
 * for published vaults). All canonical layout files are present, the
 * launcher template is byte-copied via `getLauncherTemplate()` so the
 * SHA-256 invariant holds, and the directory tree (`raw/`, `wiki/`,
 * `.github/workflows/`, etc.) is created via `createDirectoryTree`.
 */
export async function makeLocalVault(opts: MakeLocalVaultOptions): Promise<LocalVault> {
  if (!opts.name.startsWith('vk-live-')) {
    throw new Error(`makeLocalVault: name must start with 'vk-live-' (got "${opts.name}") so globalTeardown can sweep it.`);
  }
  const vaultDir = mkdtempSync(join(tmpdir(), `${opts.name}-`));
  let bareRepoDir: string | null = null;

  // Lay down the canonical vault layout (CLAUDE.md, README, raw/, wiki/, etc.)
  createDirectoryTree(vaultDir);
  writeLayoutFiles(vaultDir, { name: opts.name, siteUrl: '' }, CANONICAL_LAYOUT_FILES);

  // Byte-copy the launcher template so its SHA-256 matches what we'll register.
  const launcherSrc = getLauncherTemplate();
  const launcherDst = join(vaultDir, VAULT_FILES.LAUNCHER);
  copyFileSync(launcherSrc, launcherDst);
  const launcherHash = opts.hashOverride ?? await sha256(launcherDst);

  if (opts.withRemote) {
    // A local bare git repo plays the role of `origin` so commands that
    // shell out to `git status` / `git fetch` find a real remote without
    // touching GitHub.
    bareRepoDir = mkdtempSync(join(tmpdir(), `${opts.name}-origin-`)) + '.git';
    await execa('git', ['init', '--bare', '-b', 'main', bareRepoDir]);

    await execa('git', ['init', '-b', 'main', vaultDir]);
    await execa('git', ['-C', vaultDir, 'config', 'user.email', 'live-test@vaultkit.test']);
    await execa('git', ['-C', vaultDir, 'config', 'user.name', 'vaultkit-live-test']);
    await execa('git', ['-C', vaultDir, 'remote', 'add', 'origin', bareRepoDir]);
    await execa('git', ['-C', vaultDir, 'add', '.']);
    await execa('git', ['-C', vaultDir, 'commit', '-m', 'initial commit']);
    await execa('git', ['-C', vaultDir, 'push', '-u', 'origin', 'main']);
  }

  // Register in the real ~/.claude.json. Using vk-live-* prefix means
  // vitest's globalTeardown will sweep this entry even if afterAll
  // crashes — same safety net as the GitHub-touching live tests.
  await addToRegistry(opts.name, launcherDst, launcherHash);

  return {
    name: opts.name,
    vaultDir,
    launcherHash,
    bareRepoDir,
    cleanup: async () => {
      await removeFromRegistry(opts.name).catch(() => {});
      rmSync(vaultDir, { recursive: true, force: true });
      if (bareRepoDir) rmSync(bareRepoDir, { recursive: true, force: true });
    },
  };
}
