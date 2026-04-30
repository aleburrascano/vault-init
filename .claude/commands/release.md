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
6. Run `npm run check && npm run build && npm test` to confirm the release will pass CI (type-check, build dist/, run the full test suite).
7. Run `git add package.json CHANGELOG.md && git commit -m "chore: bump version to X.Y.Z"`.
8. Run `git tag vX.Y.Z`.
9. Run `git push && git push --tags`. Pushing the tag triggers `.github/workflows/release.yml`, which runs `npm test` again and then publishes to npm with provenance — no manual `npm publish` needed.
10. Report the tag URL and the Actions URL (e.g. `https://github.com/aleburrascano/vaultkit/actions`) so I can watch the publish workflow.
