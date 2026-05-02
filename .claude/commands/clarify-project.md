---
name: clarify-project
description: Evaluate the project from a fresh-user perspective and surface drift between docs, CLI behavior, and reality
---

Pretend you've never seen this package before. Evaluate it as a fresh user discovering it via npm or GitHub for the first time.

Focus area (optional): "$ARGUMENTS". If empty, do a comprehensive evaluation; otherwise narrow the read to the named area (e.g. "security model", "install path").

## Method

The point is finding drift, not praising the README. Adversarially compare what's promised to what actually exists.

1. **Read the discovery surface** end-to-end: `README.md`, `package.json` (scripts/deps/files), `CHANGELOG.md` (latest section + dates), `CONTRIBUTING.md`, `SECURITY.md`, any `install.sh` at the repo root, the CLI entry (`bin/vaultkit.ts`), and any `docs/` files the README links to.

2. **Run the actual CLI** as a user would, after `npm run build`:
   ```bash
   node dist/bin/vaultkit.js --version
   node dist/bin/vaultkit.js --help
   node dist/bin/vaultkit.js help
   node dist/bin/vaultkit.js init --help        # plus 2-3 other subcommands
   ```
   For each output, ask: does this match what the README/CHANGELOG promised?

3. **Test falsifiable doc claims.** List every concrete claim you can find ("--version prints version + runtime info", "every command supports --help for detailed usage", "connect accepts owner/repo and HTTPS URLs") and verify each against source or CLI output.

4. **Check git state** for hidden signals: `git log --format='%h %ad %s' --date=short -20` (do the CHANGELOG dates match commit dates?); the file listing for dead files (e.g., a script the README never references); `~/.claude.json` for orphaned vault registrations the user might have forgotten about.

## Output

Write the evaluation to a plan file (or wherever the host tells you to write). Use exactly these section headings and order:

- **What Works Well** — strengths a fresh user would actually appreciate
- **Pain Points** — drift, broken promises, friction; one numbered entry per issue (P1, P2, …) with the file path + line where it breaks down
- **Missing Pieces** — examples / FAQ / demo / badges / sample content (M1, M2, …)
- **Quick Wins** — small edits with outsized impact (S effort)
- **Larger Improvements** — real features or restructures (M / L effort)
- **Specific Suggestions** — table mapping each item to Update / Add / Remove + S/M/L effort
- **Honest Caveats** — what you actually read vs. skimmed; what you didn't check; where you inferred rather than verified; what platform-specific behavior you didn't test

## Anti-patterns

- "The README is comprehensive and well-organized." That's polish, not diagnosis. Find drift.
- Inventing fake friction. Only flag things a real new user would actually hit.
- Doc-only review. The highest-value findings are doc-vs-CLI drift — you must run the CLI.
- Performative sectioning. If a section has no entries (e.g. nothing missing), say so explicitly rather than padding.
