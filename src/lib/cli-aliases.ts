/**
 * Deprecation-alias display helpers for `bin/vaultkit.ts`.
 *
 * The 3.0 release renamed/merged several commands (status→list,
 * pull→sync, verify+update→doctor, disconnect+destroy→remove, dropped
 * backup). To avoid breaking scripted callers on day one, every old
 * name keeps a commander entry that prints one of these notices to
 * stderr and either forwards to the new dispatch or terminates with a
 * migration hint.
 *
 * Lives in `src/lib/` rather than inside `bin/vaultkit.ts` so the
 * functions are unit-testable without booting commander
 * (`bin/vaultkit.ts:program.parseAsync(process.argv)` runs at import
 * time, which would fire commander inside a test).
 *
 * The deprecation aliases themselves disappear in 4.0; this module
 * goes with them.
 */

/**
 * Print a one-line stderr notice that the given command name has been
 * deprecated and routed to a replacement. Used by the `deprecatedAlias`
 * commander wrappers in `bin/vaultkit.ts`.
 */
export function printDeprecationNotice(oldName: string, replacement: string): void {
  process.stderr.write(`Note: 'vaultkit ${oldName}' is deprecated; use 'vaultkit ${replacement}' instead.\n`);
}

/**
 * Print a stderr notice that a command was removed in 3.0 along with a
 * migration hint pointing at the replacement workflow. Used by the
 * `backup` alias, which has no replacement command — git itself is the
 * snapshot mechanism, so the hint points at `git clone --mirror`.
 */
export function printRemovalNotice(oldName: string, migrationHint: string): void {
  process.stderr.write(`Note: 'vaultkit ${oldName}' was removed in 3.0. ${migrationHint}\n`);
}
