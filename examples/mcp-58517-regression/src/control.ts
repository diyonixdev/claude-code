/**
 * Control servers built on the official @modelcontextprotocol/sdk.
 *
 * Purpose: prove the harness, loopback networking, and SDK client stack work
 * end-to-end, so that a general setup failure is never mistaken for the
 * target Claude Code bug.
 *
 * Notes:
 *  - The SDK's SSEServerTransport itself emits a *relative* endpoint event
 *    (`/message?sessionId=<uuid>`), and the SDK client resolves it via
 *    `new URL(event.data, baseUrl)`. A successful SDK<->SDK SSE round-trip is
 *    therefore also the reference implementation for bug 2 behavior.
 *  - The Streamable HTTP control uses stateless mode (sessionIdGenerator:
 *    undefined), matching servers like the strict mock.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { RequestRecorder, readBody, parseJsonSafe, snapshotHeaders, type RunningServer } from './harness.ts';

const CONTROL_TOOL = {
  name: 'control_echo',
  description: 'Loopback-only control tool. Echoes the given text. Never executes commands.',
  inputSchema: {
    type: 'object' as const,
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
};

function buildControlServer(): Server {
  const server = new Server(
    { name: 'sdk-control-mock', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [CONTROL_TOOL] }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const text = (req.params.arguments as Record<string, unknown> | undefined)?.text;
    return { content: [{ type: 'text', text: String(text ?? 'ok') }] };
  });
  return server;
}

export function startControlSseServer(recorder: RequestRecorder): Promise<RunningServer> {
  const transports = new Map<string, SSEServerTransport>();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';

    void (async () => {
      if (method === 'GET' && url.pathname === '/sse') {
        recorder.add({
          method,
          url: req.url ?? '/sse',
          headers: snapshotHeaders(req),
          body: undefined,
          responseStatus: 200,
          responseContentType: 'text/event-stream',
          note: 'control SSE stream opened (SDK transport; relative endpoint event)',
        });
        const transport = new SSEServerTransport('/message', res);
        transports.set(transport.sessionId, transport);
        transport.onclose = () => transports.delete(transport.sessionId);
        const mcpServer = buildControlServer();
        await mcpServer.connect(transport);
        return;
      }

      if (method === 'POST' && url.pathname === '/message') {
        const raw = await readBody(req);
        const body = parseJsonSafe(raw);
        const sessionId = url.searchParams.get('sessionId');
        const transport = sessionId ? transports.get(sessionId) : undefined;
        if (!transport) {
          recorder.add({
            method,
            url: req.url ?? '',
            headers: snapshotHeaders(req),
            body,
            responseStatus: 404,
            responseContentType: 'application/json',
            note: `no control transport for sessionId ${JSON.stringify(sessionId)}`,
          });
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unknown sessionId' }));
          return;
        }
        recorder.add({
          method,
          url: req.url ?? '',
          headers: snapshotHeaders(req),
          body,
          responseStatus: null,
          responseContentType: null,
          note: 'delegated to SDK SSEServerTransport.handlePostMessage',
        });
        await transport.handlePostMessage(req, res, body);
        recorder.annotate('POST', '/message', {
          responseStatus: res.statusCode,
          responseContentType: res.getHeader('content-type')?.toString() ?? null,
        });
        return;
      }

      recorder.add({
        method,
        url: req.url ?? '',
        headers: snapshotHeaders(req),
        body: undefined,
        responseStatus: 404,
        responseContentType: 'text/plain',
        note: 'unexpected path for control SSE server',
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
        note: `control server internal error: ${err instanceof Error ? err.message : String(err)}`,
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

export function startControlStreamableServer(recorder: RequestRecorder): Promise<RunningServer> {
  // SDK 1.32.2: stateless StreamableHTTPServerTransport instances are
  // SINGLE-USE ("Stateless transport cannot be reused across requests.
  // Create a new transport per request."). Fresh Server + transport per POST.
  const server = http.createServer((req, res) => {
    const method = req.method ?? 'GET';
    void (async () => {
      const raw = method === 'POST' ? await readBody(req) : undefined;
      const body = raw !== undefined ? parseJsonSafe(raw) : undefined;
      recorder.add({
        method,
        url: req.url ?? '/',
        headers: snapshotHeaders(req),
        body,
        responseStatus: null,
        responseContentType: null,
        note: 'delegated to a fresh SDK StreamableHTTPServerTransport (stateless, single-use)',
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
      });
      const mcpServer = buildControlServer();
      await mcpServer.connect(transport);
      try {
        await transport.handleRequest(req, res, body);
        recorder.annotate(method, req.url ?? '/', {
          responseStatus: res.statusCode,
          responseContentType: res.getHeader('content-type')?.toString() ?? null,
        });
      } finally {
        await transport.close().catch(() => {});
      }
    })().catch((err: unknown) => {
      recorder.add({
        method,
        url: req.url ?? '/',
        headers: {},
        body: undefined,
        responseStatus: 500,
        responseContentType: 'text/plain',
        note: `control server internal error: ${err instanceof Error ? err.message : String(err)}`,
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
