/**
 * Minimal hand-rolled MCP server over newline-delimited JSON-RPC 2.0
 * on stdio. Replaces `@modelcontextprotocol/sdk` for vaultkit's
 * per-vault MCP server: the protocol surface we actually use is small
 * enough (initialize / tools/list / tools/call) that owning ~150 LOC is
 * lighter than carrying the SDK's ~5.6 MB on every user's install. See
 * ADR-0011 (forthcoming) for the cost-benefit accounting.
 *
 * Spec: https://modelcontextprotocol.io/specification/2025-11-25
 *
 * Usage:
 *   ```ts
 *   const server = new McpStdioServer({ name: 'vaultkit-vault', version: '2.7.4' });
 *   server.registerTool({
 *     name: 'vk_ping',
 *     description: '...',
 *     inputSchema: { type: 'object', properties: {} },
 *     handler: async () => ({ content: [{ type: 'text', text: 'pong' }] }),
 *   });
 *   await server.serve();   // blocks until stdin closes
 *   ```
 *
 * Errors during a `tools/call` are surfaced to the client as
 * `{ isError: true, content: [{ type: 'text', text: <message> }] }`
 * rather than propagated as JSON-RPC errors — this matches the
 * `CallToolResult` contract in the spec and lets Claude reason about
 * the failure as part of the conversation.
 */

import readline from 'node:readline';
import { stdin, stdout, stderr } from 'node:process';

/** JSON-Schema-shaped input descriptor. We only use the subset MCP cares about. */
export interface ToolInputSchema {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: readonly string[];
  additionalProperties?: boolean;
}

export interface JsonSchemaProperty {
  type: 'string' | 'number' | 'integer' | 'boolean';
  description?: string;
  /** For string params: list of allowed values. */
  enum?: readonly string[];
  /** For number/integer params: lower bound. */
  minimum?: number;
  /** For number/integer params: upper bound. */
  maximum?: number;
  /** For string params: minimum length. */
  minLength?: number;
  /** Default value (informational; not enforced server-side). */
  default?: string | number | boolean;
}

/** Result content block — text only (we don't emit images/resources). */
export interface ToolContent {
  type: 'text';
  text: string;
}

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  /** Short human-readable label (optional, surfaced in some clients). */
  title?: string;
  /** Long-form description used by the LLM to decide when to call this. */
  description: string;
  inputSchema: ToolInputSchema;
  /** Called with the validated `arguments` object from `tools/call`. */
  handler: (args: Record<string, unknown>) => Promise<ToolResult> | ToolResult;
}

export interface ServerInfo {
  name: string;
  version: string;
  /** Optional human-readable label. */
  title?: string;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Logger interface mirroring the project's `src/lib/logger.ts` shape, narrowed to stderr-only output. */
export interface DiagnosticLog {
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

/** Default diagnostic logger writes to stderr (stdout is the JSON-RPC channel — never log there). */
export const stderrLog: DiagnosticLog = {
  warn: (m) => stderr.write(`[vaultkit-mcp] WARN ${m}\n`),
  error: (m) => stderr.write(`[vaultkit-mcp] ERROR ${m}\n`),
  debug: (m) => {
    if (process.env.VAULTKIT_MCP_DEBUG === '1') {
      stderr.write(`[vaultkit-mcp] DEBUG ${m}\n`);
    }
  },
};

/** Silent logger for tests. */
export const silentLog: DiagnosticLog = { warn: () => {}, error: () => {}, debug: () => {} };

export class McpStdioServer {
  private readonly info: ServerInfo;
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly log: DiagnosticLog;

  constructor(info: ServerInfo, log: DiagnosticLog = stderrLog) {
    this.info = info;
    this.log = log;
  }

  /** Register a tool. Duplicate names overwrite — last registration wins. */
  registerTool(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Read JSON-RPC messages from `input` (defaults to `process.stdin`)
   * and write responses to `output` (defaults to `process.stdout`).
   * Returns when the input stream closes.
   *
   * Tests pass a pair of `Readable` / `Writable` streams to drive the
   * server programmatically without spawning a child process.
   */
  async serve(
    input: NodeJS.ReadableStream = stdin,
    output: NodeJS.WritableStream = stdout,
  ): Promise<void> {
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    const pending = new Set<Promise<void>>();
    return new Promise<void>((resolve) => {
      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (trimmed.length === 0) return;
        let req: JsonRpcRequest;
        try {
          req = JSON.parse(trimmed) as JsonRpcRequest;
        } catch (e) {
          this.log.warn(`parse error on request: ${(e as Error).message}`);
          return; // can't reply — we don't know the id
        }
        // Run handler asynchronously but don't block the readline loop.
        // Track in `pending` so `close` waits for all in-flight dispatches
        // before resolving — otherwise tests (and well-behaved clients
        // that close stdin promptly after the last request) drop replies
        // when serve() returns before the handler finishes.
        const p = this.dispatch(req, output);
        pending.add(p);
        p.finally(() => pending.delete(p));
      });
      rl.on('close', () => {
        void Promise.allSettled([...pending]).then(() => resolve());
      });
    });
  }

  private async dispatch(req: JsonRpcRequest, output: NodeJS.WritableStream): Promise<void> {
    const isNotification = req.id === undefined || req.id === null;
    const id = isNotification ? null : (req.id ?? null);
    try {
      const result = await this.handle(req);
      if (isNotification) return;
      this.write(output, { jsonrpc: '2.0', id, result });
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      this.log.error(`dispatch failed for ${req.method ?? '<no method>'}: ${msg}`);
      if (!isNotification) {
        const code = mapErrorCode(e);
        this.write(output, { jsonrpc: '2.0', id, error: { code, message: msg } });
      }
    }
  }

  private async handle(req: JsonRpcRequest): Promise<unknown> {
    switch (req.method) {
      case 'initialize':
        return this.handleInitialize(req.params);
      case 'notifications/initialized':
        return undefined; // notification — caller will skip the reply
      case 'tools/list':
        return this.handleToolsList();
      case 'tools/call':
        return this.handleToolsCall(req.params);
      default:
        // Unknown method — return JSON-RPC method-not-found error.
        // Throwing here causes `dispatch` to encode it correctly.
        throw new MethodNotFoundError(req.method ?? '<missing>');
    }
  }

  private handleInitialize(params: unknown): unknown {
    // Echo the client's protocolVersion when they offered one. The spec
    // says servers should respond with a version they support; echoing
    // is the simplest correct behavior since we support any version
    // that uses the same initialize/tools/list/tools/call contract
    // we're implementing.
    const offered =
      params !== null && typeof params === 'object' && 'protocolVersion' in params
        ? (params as { protocolVersion?: string }).protocolVersion
        : undefined;
    const protocolVersion = offered ?? '2025-11-25';
    return {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: {
        name: this.info.name,
        version: this.info.version,
        ...(this.info.title !== undefined ? { title: this.info.title } : {}),
      },
    };
  }

  private handleToolsList(): unknown {
    const tools = [...this.tools.values()].map((t) => ({
      name: t.name,
      ...(t.title !== undefined ? { title: t.title } : {}),
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    return { tools };
  }

  private async handleToolsCall(params: unknown): Promise<unknown> {
    if (params === null || typeof params !== 'object') {
      throw new InvalidParamsError('tools/call requires params');
    }
    const { name, arguments: args } = params as { name?: unknown; arguments?: unknown };
    if (typeof name !== 'string' || name.length === 0) {
      throw new InvalidParamsError('tools/call.params.name must be a non-empty string');
    }
    const tool = this.tools.get(name);
    if (!tool) {
      // The MCP spec says unknown tools should surface via CallToolResult
      // with isError: true so the client can reason about it, rather than
      // a JSON-RPC method-not-found. Match the SDK's behavior.
      return {
        content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }
    const argObj: Record<string, unknown> =
      args !== null && typeof args === 'object' ? (args as Record<string, unknown>) : {};
    try {
      const result = await tool.handler(argObj);
      return result;
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      this.log.error(`tool '${name}' threw: ${msg}`);
      // Surface tool errors as CallToolResult with isError: true so the
      // LLM can recover gracefully rather than aborting on a JSON-RPC
      // error. Protocol-level errors stay JSON-RPC; only handler-level
      // failures take this path.
      return {
        content: [{ type: 'text' as const, text: `Error: ${msg}` }],
        isError: true,
      };
    }
  }

  private write(output: NodeJS.WritableStream, msg: JsonRpcResponse): void {
    output.write(JSON.stringify(msg) + '\n');
  }
}

/**
 * Internal: thrown by `handle` for JSON-RPC method-not-found. Caught by
 * `dispatch` and encoded as a JSON-RPC error response (not a tool
 * error) since the request shape itself was invalid, not the tool.
 */
class MethodNotFoundError extends Error {
  constructor(method: string) {
    super(`Method not found: ${method}`);
    this.name = 'MethodNotFoundError';
  }
}

class InvalidParamsError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'InvalidParamsError';
  }
}

/** Map a thrown error to a JSON-RPC error code per the spec. */
function mapErrorCode(e: unknown): number {
  if (e instanceof MethodNotFoundError) return -32601;
  if (e instanceof InvalidParamsError) return -32602;
  return -32603; // internal error (catchall)
}
