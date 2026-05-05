#!/usr/bin/env node
// THROWAWAY — Phase 0.1 (P1) validation prototype test driver.
// Spawns mcp-prototype.mjs, pipes JSON-RPC requests, and checks responses.
// Validates the protocol shape end-to-end without needing Claude Code yet.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import readline from 'node:readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const proto = join(__dirname, 'mcp-prototype.mjs');

const child = spawn(process.execPath, [proto], { stdio: ['pipe', 'pipe', 'pipe'] });

const responses = new Map();
const rl = readline.createInterface({ input: child.stdout });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id !== undefined && msg.id !== null) responses.set(msg.id, msg);
});
child.stderr.on('data', (chunk) => process.stderr.write(chunk));

function send(req) {
  child.stdin.write(JSON.stringify(req) + '\n');
}

function waitFor(id, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (responses.has(id)) return resolve(responses.get(id));
      if (Date.now() - t0 > timeoutMs) return reject(new Error(`timeout waiting for id=${id}`));
      setTimeout(tick, 5);
    };
    tick();
  });
}

function assertEq(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    console.log(`  expected: ${JSON.stringify(expected)}`);
    console.log(`  actual:   ${JSON.stringify(actual)}`);
    process.exitCode = 1;
  }
}

function assert(label, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` -- ${detail}` : ''}`);
  if (!cond) process.exitCode = 1;
}

async function main() {
  // Give the server a beat to print "ready".
  await new Promise((r) => setTimeout(r, 50));

  // 1. initialize
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'vk-test-driver', version: '0.0.0' },
    },
  });
  const initResp = await waitFor(1);
  assertEq('initialize.jsonrpc', initResp.jsonrpc, '2.0');
  assertEq('initialize.id', initResp.id, 1);
  assertEq('initialize.result.protocolVersion', initResp.result?.protocolVersion, '2025-11-25');
  assert('initialize.result.serverInfo.name present', !!initResp.result?.serverInfo?.name);
  assert('initialize.result.capabilities.tools present', !!initResp.result?.capabilities?.tools);

  // 2. notifications/initialized — must NOT generate a reply
  send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  await new Promise((r) => setTimeout(r, 30));

  // 3. tools/list
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const listResp = await waitFor(2);
  assertEq('tools/list.id', listResp.id, 2);
  assert('tools/list.result.tools is array', Array.isArray(listResp.result?.tools));
  assertEq('tools/list.result.tools[0].name', listResp.result?.tools?.[0]?.name, 'vk_ping');
  assert('tools/list.result.tools[0].inputSchema present', !!listResp.result?.tools?.[0]?.inputSchema);

  // 4. tools/call vk_ping with message
  send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'vk_ping', arguments: { message: 'hello' } },
  });
  const callResp = await waitFor(3);
  assertEq('tools/call.id', callResp.id, 3);
  assertEq('tools/call.result.isError', callResp.result?.isError, false);
  assertEq(
    'tools/call.result.content[0].text',
    callResp.result?.content?.[0]?.text,
    'pong: hello',
  );

  // 5. tools/call with unknown tool name → error
  send({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'nonexistent', arguments: {} },
  });
  const errResp = await waitFor(4);
  assertEq('tools/call unknown.id', errResp.id, 4);
  assert('tools/call unknown.error present', !!errResp.error);

  // 6. unknown method → error
  send({ jsonrpc: '2.0', id: 5, method: 'unknown/method' });
  const unknownResp = await waitFor(5);
  assertEq('unknown method.id', unknownResp.id, 5);
  assert('unknown method.error present', !!unknownResp.error);

  // Done
  child.stdin.end();
  child.kill();
  console.log('---');
  console.log(process.exitCode ? 'FAIL — see above' : 'OK — protocol surface verified');
}

main().catch((e) => {
  console.error('test driver fatal:', e);
  process.exit(1);
});
