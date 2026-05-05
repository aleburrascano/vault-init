import { describe, it, expect } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { McpStdioServer, silentLog, type ToolDefinition } from '../../src/lib/mcp-stdio.js';

interface JsonRpcReply {
  jsonrpc?: string;
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

function pingTool(): ToolDefinition {
  return {
    name: 'vk_ping',
    description: 'Returns "pong: <message>".',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'echo back' },
      },
    },
    handler: async (args) => {
      const msg = typeof args['message'] === 'string' ? (args['message'] as string) : '(no message)';
      return { content: [{ type: 'text', text: `pong: ${msg}` }] };
    },
  };
}

function throwingTool(): ToolDefinition {
  return {
    name: 'vk_throw',
    description: 'Always throws.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      throw new Error('boom');
    },
  };
}

/**
 * Drive an `McpStdioServer` programmatically via in-memory streams.
 * Returns parsed JSON-RPC reply objects keyed by request id.
 */
async function drive(
  server: McpStdioServer,
  requests: Array<Record<string, unknown>>,
): Promise<JsonRpcReply[]> {
  const lines = requests.map((r) => JSON.stringify(r) + '\n').join('');
  const input = Readable.from([lines]);
  const collected: string[] = [];
  const output = new Writable({
    write(chunk: Buffer, _enc, cb) {
      collected.push(chunk.toString('utf8'));
      cb();
    },
  });
  await server.serve(input, output);
  return collected
    .join('')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as JsonRpcReply);
}

describe('McpStdioServer — protocol surface', () => {
  it('responds to initialize with protocolVersion + serverInfo + tools capability', async () => {
    const server = new McpStdioServer({ name: 'vk-test', version: '0.0.0' }, silentLog);
    const replies = await drive(server, [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'driver', version: '0.0.0' },
        },
      },
    ]);
    expect(replies).toHaveLength(1);
    const r = replies[0]!;
    expect(r.jsonrpc).toBe('2.0');
    expect(r.id).toBe(1);
    const result = r.result as {
      protocolVersion: string;
      capabilities: { tools: unknown };
      serverInfo: { name: string; version: string };
    };
    expect(result.protocolVersion).toBe('2025-11-25');
    expect(result.capabilities.tools).toBeDefined();
    expect(result.serverInfo.name).toBe('vk-test');
    expect(result.serverInfo.version).toBe('0.0.0');
  });

  it('echoes a different protocolVersion when the client offers one', async () => {
    const server = new McpStdioServer({ name: 'vk-test', version: '0.0.0' }, silentLog);
    const replies = await drive(server, [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {} },
      },
    ]);
    expect((replies[0]!.result as { protocolVersion: string }).protocolVersion).toBe('2024-11-05');
  });

  it('falls back to 2025-11-25 when the client omits protocolVersion', async () => {
    const server = new McpStdioServer({ name: 'vk-test', version: '0.0.0' }, silentLog);
    const replies = await drive(server, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } },
    ]);
    expect((replies[0]!.result as { protocolVersion: string }).protocolVersion).toBe('2025-11-25');
  });

  it('does not reply to notifications/initialized', async () => {
    const server = new McpStdioServer({ name: 'vk-test', version: '0.0.0' }, silentLog);
    const replies = await drive(server, [
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
    ]);
    expect(replies).toHaveLength(0);
  });

  it('returns the registered tool list with full schema', async () => {
    const server = new McpStdioServer({ name: 'vk-test', version: '0.0.0' }, silentLog);
    server.registerTool(pingTool());
    const replies = await drive(server, [{ jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
    const tools = (replies[0]!.result as { tools: Array<{ name: string; inputSchema: unknown }> })
      .tools;
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe('vk_ping');
    expect(tools[0]!.inputSchema).toBeDefined();
  });

  it('invokes a registered tool via tools/call', async () => {
    const server = new McpStdioServer({ name: 'vk-test', version: '0.0.0' }, silentLog);
    server.registerTool(pingTool());
    const replies = await drive(server, [
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'vk_ping', arguments: { message: 'hi' } },
      },
    ]);
    const result = replies[0]!.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.content[0]!.text).toBe('pong: hi');
    expect(result.isError).toBeFalsy();
  });

  it('returns isError:true with descriptive text on tool handler exception', async () => {
    const server = new McpStdioServer({ name: 'vk-test', version: '0.0.0' }, silentLog);
    server.registerTool(throwingTool());
    const replies = await drive(server, [
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'vk_throw', arguments: {} },
      },
    ]);
    const result = replies[0]!.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/boom/);
  });

  it('returns isError:true for unknown tool name (NOT a JSON-RPC error)', async () => {
    const server = new McpStdioServer({ name: 'vk-test', version: '0.0.0' }, silentLog);
    server.registerTool(pingTool());
    const replies = await drive(server, [
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'does_not_exist', arguments: {} },
      },
    ]);
    expect(replies[0]!.result).toBeDefined();
    const r = replies[0]!.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/Unknown tool/);
  });

  it('returns JSON-RPC -32601 for an unknown method', async () => {
    const server = new McpStdioServer({ name: 'vk-test', version: '0.0.0' }, silentLog);
    const replies = await drive(server, [
      { jsonrpc: '2.0', id: 6, method: 'unknown/method' },
    ]);
    expect(replies[0]!.error).toBeDefined();
    expect(replies[0]!.error!.code).toBe(-32601);
  });

  it('returns JSON-RPC -32602 for tools/call with bad params shape', async () => {
    const server = new McpStdioServer({ name: 'vk-test', version: '0.0.0' }, silentLog);
    const replies = await drive(server, [
      // missing `name` in params
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { arguments: {} } },
    ]);
    expect(replies[0]!.error).toBeDefined();
    expect(replies[0]!.error!.code).toBe(-32602);
  });

  it('skips replies for notifications even on unknown methods', async () => {
    const server = new McpStdioServer({ name: 'vk-test', version: '0.0.0' }, silentLog);
    const replies = await drive(server, [
      // no `id` field → notification
      { jsonrpc: '2.0', method: 'unknown/notification', params: {} },
    ]);
    expect(replies).toHaveLength(0);
  });

  it('handles malformed JSON without crashing the server', async () => {
    const server = new McpStdioServer({ name: 'vk-test', version: '0.0.0' }, silentLog);
    // Send one malformed line followed by a valid initialize. The first
    // line should be silently dropped (we have no id to reply to); the
    // second should still get a normal response.
    const input = Readable.from([
      'this is not json\n',
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n',
    ]);
    const lines: string[] = [];
    const output = new Writable({
      write(chunk: Buffer, _e, cb) {
        lines.push(chunk.toString('utf8'));
        cb();
      },
    });
    await server.serve(input, output);
    const replies = lines
      .join('')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as JsonRpcReply);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.id).toBe(1);
  });

  it('processes multiple sequential requests in a single session', async () => {
    const server = new McpStdioServer({ name: 'vk-test', version: '0.0.0' }, silentLog);
    server.registerTool(pingTool());
    const replies = await drive(server, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'vk_ping', arguments: { message: 'three' } },
      },
    ]);
    expect(replies).toHaveLength(3);
    expect(replies.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it('overwrites a tool when registered twice with the same name', async () => {
    const server = new McpStdioServer({ name: 'vk-test', version: '0.0.0' }, silentLog);
    server.registerTool({
      name: 'dup',
      description: 'first',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({ content: [{ type: 'text', text: 'first' }] }),
    });
    server.registerTool({
      name: 'dup',
      description: 'second',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({ content: [{ type: 'text', text: 'second' }] }),
    });
    const replies = await drive(server, [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'dup', arguments: {} } },
    ]);
    const r = replies[0]!.result as { content: Array<{ text: string }> };
    expect(r.content[0]!.text).toBe('second');
  });
});
