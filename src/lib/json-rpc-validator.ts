/**
 * Tiny hand-rolled validator for MCP tool input arguments. Replaces
 * `zod` for the per-vault MCP server: the validation surface we use is
 * a fixed set of primitives (string, integer, optional, min/max/enum)
 * — small enough that ~60 LOC of explicit checks is lighter than
 * carrying ~5.9 MB of zod on every user's install. See ADR-0011
 * (forthcoming) for the cost-benefit accounting.
 *
 * Design: per-tool handlers extract the fields they care about via
 * `validateString`, `validateInteger`, `validateOptionalString`, etc.
 * Each helper throws a `ValidationError` with a clear message on
 * failure; `mcp-stdio.ts`'s `tools/call` dispatcher catches it and
 * surfaces the message to the LLM as `{ isError: true, content: ... }`
 * so Claude can correct and retry.
 */

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

interface StringOpts {
  minLength?: number;
  maxLength?: number;
  enum?: readonly string[];
}

/** Required string field. Throws if missing, wrong type, or constraints fail. */
export function validateString(
  args: Record<string, unknown>,
  field: string,
  opts: StringOpts = {},
): string {
  const v = args[field];
  if (v === undefined || v === null) {
    throw new ValidationError(`Missing required field '${field}'`);
  }
  if (typeof v !== 'string') {
    throw new ValidationError(`Field '${field}' must be a string`);
  }
  return checkString(v, field, opts);
}

/** Optional string field. Returns undefined when absent. */
export function validateOptionalString(
  args: Record<string, unknown>,
  field: string,
  opts: StringOpts = {},
): string | undefined {
  const v = args[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') {
    throw new ValidationError(`Field '${field}' must be a string`);
  }
  return checkString(v, field, opts);
}

interface IntegerOpts {
  minimum?: number;
  maximum?: number;
}

/** Optional integer field. Returns undefined when absent. */
export function validateOptionalInteger(
  args: Record<string, unknown>,
  field: string,
  opts: IntegerOpts = {},
): number | undefined {
  const v = args[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new ValidationError(`Field '${field}' must be an integer`);
  }
  if (opts.minimum !== undefined && v < opts.minimum) {
    throw new ValidationError(`Field '${field}' must be >= ${opts.minimum}`);
  }
  if (opts.maximum !== undefined && v > opts.maximum) {
    throw new ValidationError(`Field '${field}' must be <= ${opts.maximum}`);
  }
  return v;
}

function checkString(v: string, field: string, opts: StringOpts): string {
  if (opts.minLength !== undefined && v.length < opts.minLength) {
    throw new ValidationError(
      `Field '${field}' must be at least ${opts.minLength} character${opts.minLength === 1 ? '' : 's'}`,
    );
  }
  if (opts.maxLength !== undefined && v.length > opts.maxLength) {
    throw new ValidationError(`Field '${field}' must be at most ${opts.maxLength} characters`);
  }
  if (opts.enum && !opts.enum.includes(v)) {
    throw new ValidationError(
      `Field '${field}' must be one of: ${opts.enum.join(', ')}`,
    );
  }
  return v;
}
