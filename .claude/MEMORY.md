# VaultKit Context Index

This index tracks key project knowledge. Each entry points to a rule file that auto-loads when relevant.

## Always Loaded
- [Testing Rules](rules/testing.md) — npm test, syntax checks, linting discipline
- [Domain Language](rules/domain-language.md) — vault, launcher, dispatch, helpers, registry

## Context-Triggered (lazy-loaded by paths)
- [Shell Script Conventions](rules/shell-conventions.md) — bash patterns for vault-*.sh (required headers, validation, Windows paths)
- [Code Style](rules/code-style.md) — bash, JavaScript, and template conventions

## Emerging Patterns
- [Hallucination Patterns](rules/hallucination-patterns.md) — populated via `/ce-compound` after slip-ups
