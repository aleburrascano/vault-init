import { VaultkitError } from './errors.js';

export interface PollOptions {
  /** Maximum total wait before throwing. Default 30s. */
  timeoutMs?: number;
  /** Delay between attempts. Default 500ms. */
  intervalMs?: number;
  /** Human-readable description for the timeout error. Default 'condition'. */
  description?: string;
}

/**
 * Poll a read function until a predicate returns true, or throw on timeout.
 *
 * Use to bridge eventual-consistency gaps between an external service's
 * mutation API and its read API — e.g., GitHub returning 200 on a
 * `PATCH /repos/<slug>` for visibility but downstream endpoints still
 * seeing the previous value for several seconds. The retry-with-backoff
 * layer in `gh-retry.ts` only fires when an API call fails; this helper
 * is for the case where one call succeeded but its effect isn't visible
 * to the next call yet.
 *
 * Throws `VaultkitError('NETWORK_TIMEOUT')` on timeout. The error message
 * includes the description and the last-observed value so failures don't
 * become "the loop just timed out."
 *
 * `read()` errors propagate immediately — this is not a retry-on-error
 * helper. Pair with `gh-retry.ts:ghJson` if the read itself is flaky.
 */
export async function pollUntil<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  { timeoutMs = 30_000, intervalMs = 500, description = 'condition' }: PollOptions = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | undefined;
  for (;;) {
    lastValue = await read();
    if (predicate(lastValue)) return lastValue;
    if (Date.now() >= deadline) {
      throw new VaultkitError(
        'NETWORK_TIMEOUT',
        `Timed out waiting for ${description} after ${timeoutMs}ms (last value: ${JSON.stringify(lastValue)}).`,
      );
    }
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
}
