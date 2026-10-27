/**
 * Mock legacy SSE MCP server reproducing the server-side conditions of
 * anthropics/claude-code#58517 bug 2: on `GET /sse` it emits a *relative*
 * endpoint URL, exactly like the Visual Studio MCP extension:
 *
 *     event: endpoint
 *     data: /message?sessionId=test123
 *
 * Per the MCP spec (2024-11-05, "SSE" transport) clients must resolve that
 * path against the SSE base URL before POSTing. This mock:
 *   - records every request (headers redacted) via the RequestRecorder,
 *   - answers JSON-RPC `initialize`, `tools/list`, `tools/call` over the
 *     open SSE stream, so a conformant client completes the handshake,
 *   - binds to 127.0.0.1 only, and never executes anything it receives.
 */
import http from 'node:http';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { RequestRecorder, readBody, parseJsonSafe, snapshotHeaders, type RunningServer } from './harness.ts';

/** Deterministic session id used in the relative endpoint event. */
export const SESSION_ID = 'test123';

export interface SseRelativeServer extends RunningServer {
  /** Number of accepted SSE connections (GET /sse), for evidence logging. */
  sseConnectionCount(): number;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

function isRequest(msg: JsonRpcRequest): boolean {
  return typeof msg.method === 'string' && msg.id !== undefined && msg.id !== null;
}

function initializeResult(params: Record<string, unknown> | undefined) {
  return {
    protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05',
    capabilities: { tools: {} },
    serverInfo: { name: 'sse-relative-mock', version: '1.0.0' },
  };
}

const TOOLS = [
  {
    name: 'sse_echo',
    description: 'Loopback-only mock tool. Echoes the given text. Never executes commands.',
    inputSchema: {
      type: 'object' as const,
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
];

export async function startSseRelativeServer(recorder: RequestRecorder): Promise<SseRelativeServer> {
  let sseResponse: ServerResponse | null = null;
  let sseConnections = 0;

  const sendOverSse = (message: unknown): boolean => {
    if (!sseResponse || sseResponse.writableEnded) return false;
    sseResponse.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
    return true;
  };

  const handleClientMessage = (msg: JsonRpcRequest): void => {
    if (!isRequest(msg)) return; // notifications need no reply
    const id = msg.id!;
    let result: unknown;
    switch (msg.method) {
      case 'initialize':
        result = initializeResult(msg.params);
        break;
      case 'tools/list':
        result = { tools: TOOLS };
        break;
      case 'tools/call': {
        const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
        result = { content: [{ type: 'text', text: String(args.text ?? 'ok') }] };
        break;
      }
      default:
        sendOverSse({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
        return;
    }
    sendOverSse({ jsonrpc: '2.0', id, result });
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';

    void (async () => {
      if (method === 'GET' && url.pathname === '/sse') {
        sseConnections += 1;
        recorder.add({
          method,
          url: req.url ?? '/sse',
          headers: snapshotHeaders(req),
          body: undefined,
          responseStatus: 200,
          responseContentType: 'text/event-stream',
          note: 'SSE stream opened; endpoint event emitted with RELATIVE url',
        });
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        });
        res.write(`event: endpoint\ndata: /message?sessionId=${SESSION_ID}\n\n`);
        sseResponse = res;
        res.on('close', () => {
          if (sseResponse === res) sseResponse = null;
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/message') {
        const raw = await readBody(req);
        const body = parseJsonSafe(raw);
        const sessionId = url.searchParams.get('sessionId');
        if (sessionId !== SESSION_ID) {
          recorder.add({
            method,
            url: req.url ?? '',
            headers: snapshotHeaders(req),
            body,
            responseStatus: 400,
            responseContentType: 'application/json',
            note: `rejected: sessionId mismatch (got ${JSON.stringify(sessionId)})`,
          });
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid sessionId' }));
          return;
        }
        const streamOpen = sseResponse !== null && !sseResponse.writableEnded;
        recorder.add({
          method,
          url: req.url ?? '',
          headers: snapshotHeaders(req),
          body,
          responseStatus: streamOpen ? 202 : 409,
          responseContentType: streamOpen ? null : 'application/json',
          note: streamOpen
            ? 'message accepted; reply queued on SSE stream'
            : 'POST arrived but SSE stream is not open',
        });
        if (Array.isArray(body)) {
          for (const item of body as JsonRpcRequest[]) handleClientMessage(item);
        } else {
          handleClientMessage(body as JsonRpcRequest);
        }
        res.writeHead(streamOpen ? 202 : 409, streamOpen ? undefined : { 'Content-Type': 'application/json' });
        res.end();
        return;
      }

      recorder.add({
        method,
        url: req.url ?? '',
        headers: snapshotHeaders(req),
        body: undefined,
        responseStatus: 404,
        responseContentType: 'text/plain',
        note: 'unexpected path for legacy SSE mock',
      });
      res.writeHead(404);
      res.end();
    })().catch((err: unknown) => {
      recorder.add({
        method,
        url: req.url ?? '',
        headers: {},
        body: undefined,
        responseStatus: 500,
        responseContentType: 'text/plain',
        note: `mock server internal error: ${err instanceof Error ? err.message : String(err)}`,
      });
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    sseConnectionCount: () => sseConnections,
    close: () =>
      new Promise<void>((resolve) => {
        if (sseResponse && !sseResponse.writableEnded) sseResponse.end();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
