/**
 * Mock Streamable HTTP MCP server with strict content negotiation,
 * reproducing the server-side conditions of anthropics/claude-code#58517
 * (bug 1 config shape and the HTTP 406 reported for n8n / Visual Studio MCP).
 *
 * Per the MCP Streamable HTTP spec (2025-03-26), a client POST MUST send
 * `Accept: application/json, text/event-stream`. Servers such as n8n's MCP
 * server and the Visual Studio MCP extension enforce that and answer
 * 406 Not Acceptable otherwise — which is what this mock does, recording
 * the evidence either way.
 *
 * Bind: 127.0.0.1 only. Received JSON-RPC is parsed and answered; nothing
 * received is ever executed or logged verbatim beyond the recorder's
 * truncated, redacted view.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RequestRecorder, readBody, parseJsonSafe, snapshotHeaders, type RunningServer } from './harness.ts';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

const TOOLS = [
  {
    name: 'strict_echo',
    description: 'Loopback-only mock tool. Echoes the given text. Never executes commands.',
    inputSchema: {
      type: 'object' as const,
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
];

function acceptIsConformant(accept: string | undefined): boolean {
  if (!accept) return false;
  const lower = accept.toLowerCase();
  return lower.includes('application/json') && lower.includes('text/event-stream');
}

function respondToMessage(msg: JsonRpcRequest): unknown | undefined {
  if (typeof msg.method !== 'string' || msg.id === undefined || msg.id === null) {
    return undefined; // notification: no JSON-RPC response body
  }
  const id = msg.id;
  switch (msg.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion:
            typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'streamable-strict-mock', version: '1.0.0' },
        },
      };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    case 'tools/call': {
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: String(args.text ?? 'ok') }] },
      };
    }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }
}

export function startStrictStreamableServer(recorder: RequestRecorder): Promise<RunningServer> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';

    void (async () => {
      if (method === 'GET' || method === 'DELETE') {
        // Stateless mock: no standalone SSE stream, no session to delete.
        recorder.add({
          method,
          url: req.url ?? '',
          headers: snapshotHeaders(req),
          body: undefined,
          responseStatus: 405,
          responseContentType: 'application/json',
          note: 'stateless mock does not offer standalone GET/DELETE streams',
        });
        res.writeHead(405, { Allow: 'POST', 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method Not Allowed. Use POST.' }));
        return;
      }

      if (method !== 'POST') {
        recorder.add({
          method,
          url: req.url ?? '',
          headers: snapshotHeaders(req),
          body: undefined,
          responseStatus: 405,
          responseContentType: 'application/json',
          note: 'unexpected method',
        });
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end();
        return;
      }

      const raw = await readBody(req);
      const body = parseJsonSafe(raw);
      const accept = req.headers['accept'];
      const acceptStr = Array.isArray(accept) ? accept.join(', ') : accept;

      if (!acceptIsConformant(acceptStr)) {
        recorder.add({
          method,
          url: req.url ?? '',
          headers: snapshotHeaders(req),
          body,
          responseStatus: 406,
          responseContentType: 'application/json',
          note: `rejected: Accept must include application/json AND text/event-stream (got ${JSON.stringify(acceptStr ?? null)})`,
        });
        res.writeHead(406, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            message: 'Not Acceptable: Client must accept both application/json and text/event-stream',
          }),
        );
        return;
      }

      const messages = Array.isArray(body) ? (body as JsonRpcRequest[]) : [body as JsonRpcRequest];
      const responses = messages.map(respondToMessage).filter((r) => r !== undefined);

      let status: number;
      let payload: string | null;
      let contentType: string;
      if (responses.length === 0) {
        status = 202;
        payload = null;
        contentType = 'application/json';
      } else {
        status = 200;
        payload = JSON.stringify(Array.isArray(body) ? responses : responses[0]);
        contentType = 'application/json';
      }

      recorder.add({
        method,
        url: req.url ?? '',
        headers: snapshotHeaders(req),
        body,
        responseStatus: status,
        responseContentType: contentType,
        note: Array.isArray(body) ? 'batch processed' : undefined,
      });
      if (payload === null) {
        res.writeHead(status);
        res.end();
      } else {
        res.writeHead(status, { 'Content-Type': contentType });
        res.end(payload);
      }
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

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
