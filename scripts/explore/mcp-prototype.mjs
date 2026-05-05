#!/usr/bin/env node
// THROWAWAY — Phase 0.1 (P1) validation prototype.
// Hand-rolled JSON-RPC 2.0 stdio MCP server with one tool (`vk_ping`).
// Goal: confirm Claude Code can talk to a non-SDK MCP server.
// If this works end-to-end, we're cleared to drop @modelcontextprotocol/sdk.

import { stdin, stdout, stderr } from 'node:process';
import readline from 'node:readline';

const SERVER_INFO = { name: 'vk-prototype', version: '0.0.0' };
const TOOLS = [
  {
    name: 'vk_ping',
    title: 'Ping the prototype',
    description: 'Returns "pong" plus the input string. Used to verify wiring.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Anything to echo back.' },
      },
      required: [],
    },
  },
];

function send(msg) {
  stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function error(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function handle(req) {
  // Notifications have no `id`; never reply to them.
  const isNotification = req.id === undefined || req.id === null;

  if (req.method === 'initialize') {
    // Echo the client's protocolVersion so version negotiation lands.
    const protocolVersion = req.params?.protocolVersion ?? '2025-11-25';
    reply(req.id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
    return;
  }

  if (req.method === 'notifications/initialized') {
    return; // no reply
  }

  if (req.method === 'tools/list') {
    reply(req.id, { tools: TOOLS });
    return;
  }

  if (req.method === 'tools/call') {
    const { name, arguments: args } = req.params ?? {};
    if (name !== 'vk_ping') {
      error(req.id, -32601, `Unknown tool: ${name}`);
      return;
    }
    const echoed = args?.message ?? '(no message)';
    reply(req.id, {
      content: [{ type: 'text', text: `pong: ${echoed}` }],
      isError: false,
    });
    return;
  }

  if (isNotification) return;
  error(req.id, -32601, `Method not found: ${req.method}`);
}

// Newline-delimited JSON-RPC 2.0 over stdio.
const rl = readline.createInterface({ input: stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch (e) {
    stderr.write(`[vk-prototype] parse error: ${e.message}\n`);
    return;
  }
  try {
    handle(req);
  } catch (e) {
    stderr.write(`[vk-prototype] handler error: ${e.message ?? e}\n`);
    if (req.id !== undefined) error(req.id, -32603, String(e?.message ?? e));
  }
});

stderr.write('[vk-prototype] ready\n');
