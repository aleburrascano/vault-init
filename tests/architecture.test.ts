import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, basename, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { glob } from 'node:fs/promises';

/**
 * Architectural fitness functions. These tests encode the boundary rules
 * documented in `.claude/rules/architecture.md`,
 * `.claude/rules/security-invariants.md`, and `.claude/rules/code-style.md`
 * as runnable CI checks. When a test here fails, the diff has crossed a
 * documented boundary — either fix the violation, grandfather it in
 * `EXCEPTIONS` below with a `// <ratchet>` ticket-style comment, or
 * update the rule file if the boundary itself moved.
 *
 * Implementation note: all checks are file-text grep, not AST. That
 * keeps the suite zero-dependency and fast, but means false positives
 * on tricky regex are possible. The escape hatch is `EXCEPTIONS` — add
 * the offending file there and explain why.
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Files that are known to cross a boundary today and have been chosen
 * (with rationale) NOT to fix. Each entry should pin a follow-up:
 * either an issue number, a planned refactor, or "permanent" with the
 * reason. Future contributors should resist adding entries without a
 * written justification.
 *
 * Empty today — every category enumerated below is enforced without
 * exemptions. New violations must either fix or earn an entry here.
 *
 * History: the `git-bypass-execa` category was used during the A2-A8
 * migration (May 2026, ADR-0007) to grandfather six pre-existing raw
 * `execa('git', …)` call sites while they were unwound one commit at
 * a time. The category was cleared in A8 and removed in A9. The pattern
 * is the template for future unwinding work — start with EXCEPTIONS
 * populated, then drain it.
 */
const EXCEPTIONS: Record<string, string[]> = {
  'rmSync-without-isVaultLike': [
    // init.ts's rollback rmSync is guarded by `createdDir && existsSync(vaultDir)` — the
    // command just created the directory moments earlier. isVaultLike() may return false if
    // init fails before writing the vault marker files, which would block legitimate rollback.
    'src/commands/init.ts',
  ],
  'rmSync-without-registry-path': [
    // init.ts computes vaultDir as path.join(vaultsRoot, name) — a validated name under the
    // vaults root, not a registry lookup (the vault doesn't exist yet at init time). The
    // rollback rmSync is safe: vaultDir was determined by the command itself, not raw user input.
    'src/commands/init.ts',
  ],
};

async function readSourceFiles(pattern: string): Promise<Array<{ path: string; text: string }>> {
  const files: Array<{ path: string; text: string }> = [];
  for await (const abs of glob(pattern, { cwd: REPO_ROOT })) {
    const rel = relative(REPO_ROOT, join(REPO_ROOT, abs)).split(sep).join('/');
    files.push({ path: rel, text: readFileSync(join(REPO_ROOT, abs), 'utf8') });
  }
  return files;
}

function isExempt(category: keyof typeof EXCEPTIONS, path: string): boolean {
  return EXCEPTIONS[category]?.includes(path) ?? false;
}

describe('architecture: gh CLI Anti-Corruption Layer', () => {
  it('no command file invokes gh via raw execa (must go through github-* or ghJson)', async () => {
    // Match either string-literal `execa('gh',`/`execa("gh",` or a
    // variable named `ghPath` / `gh_path`. The matching git ACL check
    // lives in the next describe block.
    const files = await readSourceFiles('src/commands/*.ts');
    const violations: Array<{ path: string; lines: string[] }> = [];
    for (const { path, text } of files) {
      if (isExempt('gh-bypass-execa', path)) continue;
      const lines = text.split('\n');
      const hits = lines
        .map((line, i) => ({ line: line.trim(), num: i + 1 }))
        // The trailing alternation deliberately drops the `\b` that an
        // earlier draft had — `\b` requires a word-char/non-word-char
        // transition, but a quote `'` is not a word char, so a literal
        // `'gh'` boundary never matched. Today's regex matches the
        // literal-quote form via `['"]gh['"]` (no boundary needed because
        // the closing quote already terminates the match) and the
        // variable form via the explicit identifiers.
        .filter(({ line }) => /\bexeca\s*\(\s*(['"]gh['"]|ghPath|gh_path)/.test(line));
      if (hits.length > 0) {
        violations.push({ path, lines: hits.map(({ line, num }) => `:${num}  ${line}`) });
      }
    }
    if (violations.length > 0) {
      const msg = violations.map(v => `${v.path}\n  ${v.lines.join('\n  ')}`).join('\n');
      expect.fail(
        `Found raw \`execa('gh', ...)\` calls in command files. Route through one of\n` +
        `the github-* facades (createRepo / setRepoVisibility / enablePages / etc.) or\n` +
        `import { ghJson } from '../lib/gh-retry.js' for ad-hoc API calls.\n` +
        `If a follow-up is genuinely required, add the file path to\n` +
        `EXCEPTIONS['gh-bypass-execa'] in tests/architecture.test.ts with a reason.\n\n` +
        `Violations:\n${msg}`,
      );
    }
  });

  it('no command file invokes git via raw execa (must go through src/lib/git.ts)', async () => {
    // Mirror of the gh check for the matching git ACL. Match either
    // `execa('git', …)` / `execa("git", …)` or a variable form
    // (`gitPath` / `git_path`). src/lib/git.ts is the sole authorized
    // call site — it owns retry, abuse-flag classification, and the
    // typed VaultkitError translation. Bypassing it loses those, and
    // makes the wrapper a half-truth ("the git ACL exists but six
    // commands ignore it" — exactly the architecture-erosion case the
    // fitness function category was designed to prevent).
    //
    // Six pre-existing violations are grandfathered in EXCEPTIONS.
    // Migration commits A3-A8 remove them one at a time.
    const files = await readSourceFiles('src/commands/*.ts');
    const violations: Array<{ path: string; lines: string[] }> = [];
    for (const { path, text } of files) {
      if (isExempt('git-bypass-execa', path)) continue;
      const lines = text.split('\n');
      const hits = lines
        .map((line, i) => ({ line: line.trim(), num: i + 1 }))
        .filter(({ line }) => /\bexeca\s*\(\s*(['"]git['"]|gitPath|git_path)/.test(line));
      if (hits.length > 0) {
        violations.push({ path, lines: hits.map(({ line, num }) => `:${num}  ${line}`) });
      }
    }
    if (violations.length > 0) {
      const msg = violations.map(v => `${v.path}\n  ${v.lines.join('\n  ')}`).join('\n');
      expect.fail(
        `Found raw \`execa('git', ...)\` calls in command files. Route through\n` +
        `the src/lib/git.ts wrappers (init/clone/push/pull/getStatus/archiveZip\n` +
        `/pushNewRepo/pushOrPr/getRepoSlug, plus whichever new verb covers your\n` +
        `case). If the verb you need doesn't exist yet, add it to git.ts before\n` +
        `the call site so the ACL stays the sole owner.\n` +
        `If a follow-up is genuinely required, add the file path to\n` +
        `EXCEPTIONS['git-bypass-execa'] in tests/architecture.test.ts with a reason.\n\n` +
        `Violations:\n${msg}`,
      );
    }
  });

  it('no file outside src/lib/mcp.ts spawns `claude mcp` via execa', async () => {
    const files = await readSourceFiles('src/**/*.ts');
    const violations: string[] = [];
    for (const { path, text } of files) {
      if (path === 'src/lib/mcp.ts') continue;
      // Match: execa(<anything>, [..., 'mcp', ...]) where <anything>
      // could be 'claude', a variable named claudePath, etc.
      // Conservative pattern — match the literal `'mcp'` arg in an
      // execa call and let the test fail loudly if it's a false positive.
      if (/\bexeca\s*\([^)]*\[\s*['"]mcp['"]/.test(text)) {
        violations.push(path);
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('architecture: ESM-only invariant', () => {
  it('no source or bin file imports from child_process', async () => {
    const files = [
      ...(await readSourceFiles('src/**/*.ts')),
      ...(await readSourceFiles('bin/**/*.ts')),
    ];
    const violations: string[] = [];
    for (const { path, text } of files) {
      if (/from\s+['"]node:child_process['"]/.test(text) || /from\s+['"]child_process['"]/.test(text)) {
        violations.push(path);
      }
    }
    // tests/lib/launcher-integration.test.ts is intentionally exempt:
    // it spawns the launcher template as a real Node process for end-
    // to-end SHA-256 self-verification, which requires raw spawn().
    // That file lives under tests/ and is not in this glob.
    expect(violations).toEqual([]);
  });
});

describe('architecture: registry file ownership', () => {
  it('only registry.ts and platform.ts reference claudeJsonPath()', async () => {
    const files = await readSourceFiles('src/**/*.ts');
    const violations: string[] = [];
    for (const { path, text } of files) {
      if (path === 'src/lib/registry.ts' || path === 'src/lib/platform.ts') continue;
      if (isExempt('claudeJsonPath-outside-registry', path)) continue;
      if (/\bclaudeJsonPath\b/.test(text)) {
        violations.push(path);
      }
    }
    if (violations.length > 0) {
      expect.fail(
        `Found claudeJsonPath() references outside src/lib/registry.ts and src/lib/platform.ts.\n` +
        `~/.claude.json reads/writes belong in registry.ts so a future schema/format change\n` +
        `is one edit, not many. If a follow-up is required, add the file to\n` +
        `EXCEPTIONS['claudeJsonPath-outside-registry'] in tests/architecture.test.ts.\n\n` +
        `Violations: ${violations.join(', ')}`,
      );
    }
  });
});

describe('architecture: command module shape', () => {
  it('every src/commands/*.ts exports an async function run(...)', async () => {
    const files = await readSourceFiles('src/commands/*.ts');
    const violations: string[] = [];
    for (const { path, text } of files) {
      // The contract per code-style.md and the CommandModule sentinel
      // type: each command file exports a top-level `async function run`.
      // We accept either a top-level `export async function run(`
      // declaration or a `export const run = async (...) =>` form.
      const hasFunction = /export\s+async\s+function\s+run\s*\(/.test(text);
      const hasArrow = /export\s+const\s+run\s*=\s*async\s*\(/.test(text);
      if (!hasFunction && !hasArrow) {
        violations.push(path);
      }
    }
    if (violations.length > 0) {
      expect.fail(
        `Files under src/commands/ without an exported \`async function run(...)\`:\n` +
        `  ${violations.join('\n  ')}\n` +
        `Per code-style.md, every command module must satisfy the CommandModule contract.`,
      );
    }
  });

  it('command files include the CommandModule sentinel type-check', async () => {
    const files = await readSourceFiles('src/commands/*.ts');
    const violations: string[] = [];
    for (const { path, text } of files) {
      // The sentinel `const _module: CommandModule<...> = { run };`
      // exists so a drifted run() signature fails compile, not at
      // runtime. Skip files where the module-level declaration is
      // intentional (today: none — every command has it).
      if (!/const\s+_module\s*:\s*CommandModule/.test(text)) {
        violations.push(basename(path));
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('architecture: layer dependency rule', () => {
  it('no file in src/lib/ imports from src/commands/', async () => {
    // The layering is bin → commands → libs. A lib importing from a command
    // would create either a cycle or an upward dependency — both signal the
    // wrong layer for whatever is being shared. If the shared logic exists,
    // it belongs in another lib that both the source command AND consumers
    // can import.
    const files = await readSourceFiles('src/lib/**/*.ts');
    const violations: Array<{ path: string; lines: string[] }> = [];
    for (const { path, text } of files) {
      const lines = text.split('\n');
      const hits = lines
        .map((line, i) => ({ line: line.trim(), num: i + 1 }))
        .filter(({ line }) =>
          /from\s+['"](?:\.\.\/commands\/|\.\.\/\.\.\/src\/commands\/)/.test(line),
        );
      if (hits.length > 0) {
        violations.push({ path, lines: hits.map(({ line, num }) => `:${num}  ${line}`) });
      }
    }
    if (violations.length > 0) {
      const msg = violations.map(v => `${v.path}\n  ${v.lines.join('\n  ')}`).join('\n');
      expect.fail(
        `Files in src/lib/ that import from src/commands/ — this inverts the\n` +
        `intended layering. If the logic needs to be shared, extract it to a\n` +
        `new lib both commands and libs can import.\n\n` +
        `Violations:\n${msg}`,
      );
    }
  });
});

describe('architecture: logger boundary', () => {
  it('no file in src/ outside src/lib/logger.ts uses console.*', async () => {
    // The Logger interface is the project's only DI seam (per code-style.md
    // and ADR-0009 context). Reaching for console.* directly bypasses
    // ConsoleLogger / SilentLogger and breaks tests that assert on
    // arrayLogger output. The bin/ layer is intentionally allowed (verbose
    // debug telemetry — there's no Logger plumbed at that level), so this
    // check is scoped to src/ only.
    const files = await readSourceFiles('src/**/*.ts');
    const violations: Array<{ path: string; lines: string[] }> = [];
    for (const { path, text } of files) {
      if (path === 'src/lib/logger.ts') continue;
      const lines = text.split('\n');
      const hits = lines
        .map((line, i) => ({ line: line.trim(), num: i + 1 }))
        .filter(({ line }) => /\bconsole\.(log|warn|error|info|debug)\s*\(/.test(line));
      if (hits.length > 0) {
        violations.push({ path, lines: hits.map(({ line, num }) => `:${num}  ${line}`) });
      }
    }
    if (violations.length > 0) {
      const msg = violations.map(v => `${v.path}\n  ${v.lines.join('\n  ')}`).join('\n');
      expect.fail(
        `Files in src/ outside src/lib/logger.ts using console.* directly.\n` +
        `Route through the Logger interface (RunOptions.log for commands;\n` +
        `accept a Logger parameter for lib functions that print).\n\n` +
        `Violations:\n${msg}`,
      );
    }
  });
});

describe('architecture: inter-command imports', () => {
  it('no src/commands/*.ts file imports from another src/commands/*.ts', async () => {
    // Commands are the user-facing entry points. If one command needs
    // another's logic, the logic should be extracted to a lib so both can
    // call it without coupling commands to each other. The current pattern
    // (e.g. init's rollback path uses `runMcpRemove` from mcp.ts, not
    // `disconnect.run`) is the right shape — preserve it.
    const files = await readSourceFiles('src/commands/*.ts');
    const violations: Array<{ path: string; lines: string[] }> = [];
    for (const { path, text } of files) {
      const lines = text.split('\n');
      const hits = lines
        .map((line, i) => ({ line: line.trim(), num: i + 1 }))
        .filter(({ line }) => /from\s+['"]\.\/[a-z]/.test(line));
      if (hits.length > 0) {
        violations.push({ path, lines: hits.map(({ line, num }) => `:${num}  ${line}`) });
      }
    }
    if (violations.length > 0) {
      const msg = violations.map(v => `${v.path}\n  ${v.lines.join('\n  ')}`).join('\n');
      expect.fail(
        `Command files importing from sibling command files. Extract the\n` +
        `shared logic to a lib and have both commands call it.\n\n` +
        `Violations:\n${msg}`,
      );
    }
  });
});

describe('architecture: isVaultLike guard before directory deletion', () => {
  it('every command using rmSync also guards with isVaultLike', async () => {
    // Commands that delete directory trees must call isVaultLike (or vault.isVaultLike())
    // before proceeding — prevents rm-ing an arbitrary path if vault resolution returns
    // something unexpected. Invariant from security-invariants.md.
    const files = await readSourceFiles('src/commands/*.ts');
    const violations: string[] = [];
    for (const { path, text } of files) {
      if (isExempt('rmSync-without-isVaultLike', path)) continue;
      if (!/\brmSync\s*\(/.test(text)) continue;
      if (!/\bisVaultLike\b/.test(text)) violations.push(path);
    }
    if (violations.length > 0) {
      expect.fail(
        `Command files calling rmSync without an isVaultLike guard:\n` +
        `  ${violations.join('\n  ')}\n` +
        `Per security-invariants.md, isVaultLike (or vault.isVaultLike()) must be checked\n` +
        `before any directory deletion. If the rmSync is rolling back a directory the command\n` +
        `itself just created, add the file to EXCEPTIONS['rmSync-without-isVaultLike']\n` +
        `in tests/architecture.test.ts with a reason.`,
      );
    }
  });
});

describe('architecture: vault path from registry before deletion', () => {
  it('every command using rmSync resolves the path through the registry', async () => {
    // Vault dirs for destructive ops must come from the MCP registry
    // (Vault.tryFromName / Vault.requireFromName / getVaultDir), never raw user input or
    // filesystem fallbacks. Invariant from security-invariants.md.
    const files = await readSourceFiles('src/commands/*.ts');
    const violations: string[] = [];
    for (const { path, text } of files) {
      if (isExempt('rmSync-without-registry-path', path)) continue;
      if (!/\brmSync\s*\(/.test(text)) continue;
      const hasRegistryLookup = /\bVault\.(?:tryFromName|requireFromName)\b|\bgetVaultDir\b/.test(text);
      if (!hasRegistryLookup) violations.push(path);
    }
    if (violations.length > 0) {
      expect.fail(
        `Command files calling rmSync without a registry path lookup:\n` +
        `  ${violations.join('\n  ')}\n` +
        `Vault directories for destructive operations must come from the MCP registry\n` +
        `(Vault.tryFromName / Vault.requireFromName / getVaultDir), not raw user input.\n` +
        `If the rmSync rolls back a directory the command just created, add the file to\n` +
        `EXCEPTIONS['rmSync-without-registry-path'] in tests/architecture.test.ts.`,
      );
    }
  });
});

describe('architecture: SearchIndex closed after use', () => {
  it('every command that opens a SearchIndex also closes it', async () => {
    // openSearchIndex() returns a SQLite-backed object that must be closed to flush WAL
    // frames and release the file lock. A missing close() causes resource leaks in long-
    // running processes and write-lock contention in tests. Canonical pattern: try/finally
    // with index.close() in the finally block — see pull.ts.
    const files = await readSourceFiles('src/commands/*.ts');
    const violations: string[] = [];
    for (const { path, text } of files) {
      if (isExempt('searchindex-not-closed', path)) continue;
      if (!/\bopenSearchIndex\s*\(/.test(text)) continue;
      if (!/\.close\s*\(\)/.test(text)) violations.push(path);
    }
    if (violations.length > 0) {
      expect.fail(
        `Command files that open a SearchIndex without calling .close():\n` +
        `  ${violations.join('\n  ')}\n` +
        `Wrap openSearchIndex() in try/finally and call index.close() in the finally block.\n` +
        `Add to EXCEPTIONS['searchindex-not-closed'] only if the lifecycle is managed externally.`,
      );
    }
  });
});

describe('architecture: catch blocks do not rethrow as plain Error', () => {
  it('command catch blocks that rethrow use VaultkitError, not plain Error', async () => {
    // Rethrowing inside a catch block with `throw new Error(...)` loses the VaultkitErrorCode
    // and maps to exit code 1 (unknown), breaking the documented exit-code contract for
    // scripted callers. Inside a catch, either re-throw the original `err` or wrap it in
    // `throw new VaultkitError(code, message)`. Plain `throw new Error(...)` belongs only
    // at top-level validation where no error code is being discarded.
    const files = await readSourceFiles('src/commands/*.ts');
    const violations: Array<{ path: string; line: number; text: string }> = [];

    for (const { path, text } of files) {
      if (isExempt('catch-rethrows-plain-error', path)) continue;
      const lines = text.split('\n');
      let inCatch = false;
      let braceDepth = 0;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (!inCatch && /}\s*catch\s*\(/.test(line)) {
          inCatch = true;
          // Find the `{` that opens the catch body (after the `catch (...)` clause).
          const catchKeyIdx = line.indexOf('catch');
          const openBrace = line.indexOf('{', catchKeyIdx);
          braceDepth = openBrace >= 0 ? 1 : 0;
          continue; // Don't scan the catch-header line for throw
        }
        if (inCatch) {
          for (const ch of line) {
            if (ch === '{') braceDepth++;
            else if (ch === '}') braceDepth--;
          }
          if (braceDepth > 0 && /\bthrow new Error\s*\(/.test(line)) {
            violations.push({ path, line: i + 1, text: line.trim() });
          }
          if (braceDepth <= 0) {
            inCatch = false;
            braceDepth = 0;
          }
        }
      }
    }

    if (violations.length > 0) {
      const msg = violations.map((v) => `${v.path}:${v.line}  ${v.text}`).join('\n');
      expect.fail(
        `Catch blocks rethrowing as plain Error — use VaultkitError with an appropriate\n` +
        `error code so wrap() maps to a distinct exit code. Plain Error exits as 1 (unknown),\n` +
        `indistinguishable from an unexpected crash for scripted callers.\n\n` +
        `Violations:\n${msg}`,
      );
    }
  });
});

describe('architecture: MCP tool context depends on ISearchIndex, not SearchIndex', () => {
  it('src/mcp-tools/context.ts imports ISearchIndex (not the concrete class)', async () => {
    // The ToolContext.index field must be typed as the ISearchIndex interface so
    // tool unit tests can inject a FakeSearchIndex without SQLite. If this file
    // imports the concrete SearchIndex class, tool tests are forced to construct a
    // real (or :memory:) database, coupling them to implementation details.
    const [contextFile] = await readSourceFiles('src/mcp-tools/context.ts');
    expect(contextFile, 'could not read src/mcp-tools/context.ts').toBeDefined();
    const text = contextFile!.text;
    expect(
      text,
      'context.ts must import ISearchIndex (the interface), not SearchIndex (the class)',
    ).toMatch(/import\s+type\s+\{[^}]*\bISearchIndex\b[^}]*\}/);
    expect(
      text,
      'context.ts must not import the concrete SearchIndex class (use ISearchIndex instead)',
    ).not.toMatch(/import\s+(?:type\s+)?\{[^}]*(?<![A-Za-z])SearchIndex(?![A-Za-z])[^}]*\}\s+from/);
  });
});

describe('architecture: bootstrap gate is wired', () => {
  it('bin/vaultkit.ts:wrap() applies gateOrSkip before running the command handler', async () => {
    const text = readFileSync(join(REPO_ROOT, 'bin/vaultkit.ts'), 'utf8');
    // The gate must be invoked from inside wrap() — assert both the
    // import and a top-level call exist. Catches the regression where
    // someone removes the gate call but leaves the import (or vice versa).
    expect(text, 'bin/vaultkit.ts is not importing gateOrSkip from prereqs').toMatch(
      /import\s+\{[^}]*\bgateOrSkip\b[^}]*\}\s+from\s+['"]\.\.\/src\/lib\/prereqs\.js['"]/,
    );
    // Match a non-commented line: line-start, optional whitespace, then
    // `await gateOrSkip(commandName, ...)`. The `^\s*await` anchor is
    // important — without it, a commented-out `// await gateOrSkip(...)`
    // would still match and the regression would slip through.
    expect(text, 'bin/vaultkit.ts is not calling gateOrSkip(commandName, ...) in an active line').toMatch(
      /^\s*await\s+gateOrSkip\s*\(\s*commandName\s*,/m,
    );
  });

  it('every src/commands/*.ts file declares its gate posture in tests/bootstrap-gate.test.ts', async () => {
    // Self-maintaining check: a new command added via /add-command must
    // appear in either COMMANDS_THAT_MUST_BE_GATED or BYPASS in the
    // bootstrap-gate test. Otherwise this fitness function fails and
    // points the contributor at the test file to declare the posture.
    const commandFiles = await readSourceFiles('src/commands/*.ts');
    const commandNames = commandFiles.map(f => basename(f.path).replace(/\.ts$/, ''));
    const gateTestText = readFileSync(join(REPO_ROOT, 'tests/bootstrap-gate.test.ts'), 'utf8');
    const undeclared: string[] = [];
    for (const name of commandNames) {
      // Match the command name as a quoted literal anywhere in the file —
      // the lists currently use single quotes, but accept double quotes
      // and backticks too in case future formatting changes.
      const literal = new RegExp(`['"\`]${name}['"\`]`);
      if (!literal.test(gateTestText)) {
        undeclared.push(name);
      }
    }
    if (undeclared.length > 0) {
      expect.fail(
        `Commands missing gate-posture declaration in tests/bootstrap-gate.test.ts:\n` +
        `  ${undeclared.join(', ')}\n\n` +
        `Each new command must appear in either COMMANDS_THAT_MUST_BE_GATED (the\n` +
        `default — gate fires when prereqs are missing) or BYPASS (rare — only for\n` +
        `setup and doctor today). The /add-command skill should remind you, but\n` +
        `this fitness function is the backstop.`,
      );
    }
  });
});
