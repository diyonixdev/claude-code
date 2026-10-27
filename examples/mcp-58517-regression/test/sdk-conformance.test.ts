/**
 * SDK conformance tests — NO Claude Code involvement.
 *
 * These tests validate the harness itself and capture the *reference*
 * behavior of the official MCP TypeScript SDK (v1.32.2):
 *
 *  1. Control: SDK client <-> SDK server round-trips over SSE and
 *     Streamable HTTP on loopback (proves harness + networking work).
 *  2. Reference behavior for bug 2: the SDK SSE client resolves a relative
 *     `endpoint` event (`/message?sessionId=test123`) against the SSE base
 *     URL and POSTs initialize there.
 *  3. Reference behavior for Accept negotiation: the SDK Streamable HTTP
 *     client sends `Accept` containing both `application/json` and
 *     `text/event-stream`; a non-conformant POST gets 406 from the strict
 *     mock.
 *
 * If any of these fail, a later Claude Code black-box failure must be
 * treated as a setup problem, not as evidence about Claude Code.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { RequestRecorder } from '../src/harness.ts';
import { startSseRelativeServer, SESSION_ID } from '../src/sse-relative.ts';
import { startStrictStreamableServer } from '../src/streamable-strict.ts';
import { startControlSseServer, startControlStreamableServer } from '../src/control.ts';

function isInitializeMessage(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { method?: unknown }).method === 'initialize'
  );
}

describe('harness control (setup sanity)', () => {
  test('SDK client completes initialize + tools/list over control SSE server', { timeout: 20000 }, async () => {
    const recorder = new RequestRecorder();
    const server = await startControlSseServer(recorder);
    const client = new Client({ name: 'conformance-control-sse', version: '1.0.0' });
    try {
      await client.connect(new SSEClientTransport(new URL(`${server.url}/sse`)));
      const tools = await client.listTools();
      assert.ok(
        tools.tools.some((t) => t.name === 'control_echo'),
        `expected control_echo tool, got: ${tools.tools.map((t) => t.name).join(', ')}`,
      );
      const init = recorder.find((e) => isInitializeMessage(e.body));
      assert.ok(init, `control SSE: no initialize recorded.\n${recorder.summary()}`);
      console.log(`[control-sse] initialize recorded at seq #${init.seq}; handshake OK`);
    } finally {
      await client.close().catch(() => {});
      await server.close();
    }
  });

  test('SDK client completes initialize + tools/list over control Streamable HTTP server', { timeout: 20000 }, async () => {
    const recorder = new RequestRecorder();
    const server = await startControlStreamableServer(recorder);
    const client = new Client({ name: 'conformance-control-http', version: '1.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/`)));
      const tools = await client.listTools();
      assert.ok(
        tools.tools.some((t) => t.name === 'control_echo'),
        `expected control_echo tool, got: ${tools.tools.map((t) => t.name).join(', ')}`,
      );
      const init = recorder.find((e) => isInitializeMessage(e.body) && e.responseStatus === 200);
      assert.ok(init, `control streamable: no successful initialize recorded.\n${recorder.summary()}`);
      console.log(`[control-http] initialize recorded at seq #${init.seq} (HTTP ${init.responseStatus}); handshake OK`);
    } finally {
      await client.close().catch(() => {});
      await server.close();
    }
  });
});

describe('spec reference behavior (bug 2 / Accept negotiation)', () => {
  test('SDK SSE client resolves RELATIVE endpoint /message?sessionId=test123 and POSTs initialize', { timeout: 20000 }, async () => {
    const recorder = new RequestRecorder();
    const server = await startSseRelativeServer(recorder);
    const client = new Client({ name: 'conformance-sse-relative', version: '1.0.0' });
    try {
      await client.connect(new SSEClientTransport(new URL(`${server.url}/sse`)));
      const tools = await client.listTools();
      assert.ok(
        tools.tools.some((t) => t.name === 'sse_echo'),
        `expected sse_echo tool, got: ${tools.tools.map((t) => t.name).join(', ')}`,
      );
      const post = recorder.waitFor(
        (e) => e.method === 'POST' && e.url.startsWith(`/message?sessionId=${SESSION_ID}`) && isInitializeMessage(e.body),
        5000,
      );
      const result = await post;
      assert.ok(
        result.exchange,
        `SDK client never POSTed initialize to the relative endpoint (timed out after ${result.elapsedMs}ms).\n${recorder.summary()}`,
      );
      assert.equal(result.exchange.responseStatus, 202);
      console.log(
        `[sse-relative] SDK client POSTed initialize to ${result.exchange.url} after ${result.elapsedMs}ms — relative endpoint resolved (reference behavior)`,
      );
    } finally {
      await client.close().catch(() => {});
      await server.close();
    }
  });

  test('SDK streamable client sends conformant Accept header; strict mock returns 200', { timeout: 20000 }, async () => {
    const recorder = new RequestRecorder();
    const server = await startStrictStreamableServer(recorder);
    const client = new Client({ name: 'conformance-strict-accept', version: '1.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/`)));
      const tools = await client.listTools();
      assert.ok(
        tools.tools.some((t) => t.name === 'strict_echo'),
        `expected strict_echo tool, got: ${tools.tools.map((t) => t.name).join(', ')}`,
      );
      const init = recorder.find((e) => isInitializeMessage(e.body));
      assert.ok(init, `strict mock: no initialize recorded.\n${recorder.summary()}`);
      assert.equal(init.responseStatus, 200, `expected HTTP 200 for conformant client.\n${recorder.summary()}`);
      const accept = (init.headers['accept'] ?? '').toLowerCase();
      assert.ok(accept.includes('application/json'), `client Accept missing application/json: ${accept}`);
      assert.ok(accept.includes('text/event-stream'), `client Accept missing text/event-stream: ${accept}`);
      console.log(`[strict-accept] SDK client Accept="${init.headers['accept']}" -> HTTP 200 (reference behavior)`);
    } finally {
      await client.close().catch(() => {});
      await server.close();
    }
  });

  test('strict mock REJECTS a POST without proper Accept with 406 (negative control)', { timeout: 10000 }, async () => {
    const recorder = new RequestRecorder();
    const server = await startStrictStreamableServer(recorder);
    try {
      const res = await fetch(`${server.url}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, // missing text/event-stream
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'negative', version: '0' } },
        }),
      });
      assert.equal(res.status, 406, 'strict mock must 406 a non-conformant Accept header');
      const recorded = recorder.find((e) => e.method === 'POST' && e.responseStatus === 406);
      assert.ok(recorded, `406 exchange not recorded.\n${recorder.summary()}`);
      console.log('[strict-accept] non-conformant POST rejected with 406 — strict server validates as intended');
    } finally {
      await server.close();
    }
  });
});
