---
name: release
description: Prepare a vaultkit release with version bump and tagging
---

Prepare a vaultkit release.

1. Run `git log --oneline $(git describe --tags --abbrev=0)..HEAD` to show commits since last tag.
2. Read the current version from `package.json`.
3. Based on the commits, suggest a version bump: patch (bug fixes), minor (new command or feature), major (breaking change).
4. Update `version` in `package.json` to the suggested version.
5. Move the `## [Unreleased]` section in `CHANGELOG.md` to a new `## [X.Y.Z] - YYYY-MM-DD` section, and add a fresh empty `## [Unreleased]` heading at the top.
6. **If `lib/mcp-start.js.tmpl` changed since the last tag** (run `git diff $(git describe --tags --abbrev=0)..HEAD -- lib/mcp-start.js.tmpl` and check it's non-empty), this is a launcher-breaking release. Per [ADR-0014](../../docs/decisions/0014-npm-deprecate-on-launcher-breaking-change.md), do BOTH of these together:
   - Add an entry to `HISTORICAL_LAUNCHER_SHAS` in [src/lib/launcher-history.ts](../../src/lib/launcher-history.ts) for the prior template's SHA-256 (compute via `git show $(git describe --tags --abbrev=0):lib/mcp-start.js.tmpl | sha256sum` and via `node -e "require('child_process').execSync('git show ' + 'TAG' + ':lib/mcp-start.js.tmpl', { encoding: 'buffer' }).pipe…"` — include both LF and platform-converted bytes if uncertain), labeled with the prior version range.
   - Plan to run `npm deprecate @aleburrascano/vaultkit@"<X.Y.Z" "Launcher template changed in X.Y.Z. After upgrading run: vaultkit setup && vaultkit update --all"` after the new version is published in step 9. (Run it manually after watching `release.yml` complete; the deprecation lives on the npm registry side, not in vaultkit's code.)
7. Run `npm run check && npm run build && npm test` to confirm the release will pass CI (type-check, build dist/, run the full test suite).
8. Run `git add package.json CHANGELOG.md && git commit -m "chore: bump version to X.Y.Z"`. (Step 6's `launcher-history.ts` edit, if applicable, goes in this same commit.)
9. Run `git tag vX.Y.Z`.
10. Run `git push && git push --tags`. Pushing the tag triggers `.github/workflows/release.yml`, which runs `npm test` again and then publishes to npm with provenance — no manual `npm publish` needed.
11. Report the tag URL and the Actions URL (e.g. `https://github.com/aleburrascano/vaultkit/actions`) so I can watch the publish workflow.
12. **If step 6 fired**: after the publish workflow succeeds, run the `npm deprecate` command from step 6 to flag pre-X.Y.Z installs with the migration instruction. Confirm via `npm view @aleburrascano/vaultkit versions --json` that the prior versions show the deprecation message.
