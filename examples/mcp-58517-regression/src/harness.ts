/**
 * Request recording harness for the MCP #58517 regression tests.
 *
 * Records every HTTP request received by a mock server, with a timestamp,
 * a redacted header snapshot, the parsed body (if any), and the response
 * status/content-type the mock ultimately sent. Provides a bounded
 * `waitFor` so tests can turn "no request arrived" into recorded timeout
 * evidence rather than a hang.
 *
 * Header redaction: only an allow-list of protocol-relevant headers is kept
 * verbatim; every other header value is replaced with "[redacted]" so that
 * authorization cookies, API keys, or machine identifiers never end up in
 * logs or test output.
 */
import type { IncomingMessage } from 'node:http';

const LOGGED_HEADERS = new Set([
  'accept',
  'content-type',
  'mcp-protocol-version',
  'mcp-session-id',
  'user-agent',
]);

export interface RecordedExchange {
  seq: number;
  receivedAt: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  responseStatus: number | null;
  responseContentType: string | null;
  /** Free-form annotation added by the mock server (e.g. "rejected: bad Accept"). */
  note?: string;
}

export function snapshotHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (LOGGED_HEADERS.has(lower)) {
      out[lower] = Array.isArray(value) ? value.join(', ') : String(value ?? '');
    } else {
      out[lower] = '[redacted]';
    }
  }
  return out;
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function parseJsonSafe(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class RequestRecorder {
  private exchanges: RecordedExchange[] = [];
  private seq = 0;

  /**
   * Store one request/response exchange. Called by mock servers after they
   * have decided on (or sent) their response so the status is captured too.
   */
  add(partial: Omit<RecordedExchange, 'seq' | 'receivedAt'>): RecordedExchange {
    const exchange: RecordedExchange = {
      seq: ++this.seq,
      receivedAt: new Date().toISOString(),
      ...partial,
    };
    this.exchanges.push(exchange);
    return exchange;
  }

  /** Fill in responseStatus/responseContentType/note on the most recent exchange matching `method` + `url` prefix. */
  annotate(
    method: string,
    urlPrefix: string,
    fields: Pick<RecordedExchange, 'responseStatus' | 'responseContentType' | 'note'>,
  ): void {
    for (let i = this.exchanges.length - 1; i >= 0; i--) {
      const ex = this.exchanges[i]!;
      if (ex.method === method && ex.url.startsWith(urlPrefix) && ex.responseStatus === null) {
        Object.assign(ex, fields);
        return;
      }
    }
  }

  get list(): readonly RecordedExchange[] {
    return this.exchanges;
  }

  clear(): void {
    this.exchanges = [];
    this.seq = 0;
  }

  find(predicate: (e: RecordedExchange) => boolean): RecordedExchange | undefined {
    return this.exchanges.find(predicate);
  }

  /**
   * Wait until `predicate` matches a recorded exchange, or `timeoutMs` elapses.
   * Always resolves; on timeout the result carries `timedOut: true` and the
   * elapsed time, which tests log as explicit timeout evidence.
   */
  waitFor(
    predicate: (e: RecordedExchange) => boolean,
    timeoutMs: number,
  ): Promise<{ exchange: RecordedExchange | undefined; elapsedMs: number; timedOut: boolean }> {
    const start = Date.now();
    return new Promise((resolve) => {
      const poll = () => {
        const exchange = this.find(predicate);
        if (exchange) {
          resolve({ exchange, elapsedMs: Date.now() - start, timedOut: false });
          return;
        }
        if (Date.now() - start >= timeoutMs) {
          resolve({ exchange: undefined, elapsedMs: Date.now() - start, timedOut: true });
          return;
        }
        setTimeout(poll, 100);
      };
      poll();
    });
  }

  /** Human-readable, log-safe summary (bodies truncated). */
  summary(maxBodyChars = 300): string {
    if (this.exchanges.length === 0) return '(no requests recorded)';
    return this.exchanges
      .map((e) => {
        const rawBody =
          e.body === undefined || e.body === null
            ? ''
            : typeof e.body === 'string'
              ? e.body
              : JSON.stringify(e.body);
        const body = rawBody.length > maxBodyChars ? `${rawBody.slice(0, maxBodyChars)}…` : rawBody;
        return [
          `#${e.seq} ${e.receivedAt} ${e.method} ${e.url}`,
          `    accept=${e.headers['accept'] ?? '(absent)'} content-type=${e.headers['content-type'] ?? '(absent)'}`,
          `    response=${e.responseStatus ?? '?'} ${e.responseContentType ?? ''}${e.note ? ` (${e.note})` : ''}`,
          body ? `    body: ${body}` : '    body: (empty)',
        ].join('\n');
      })
      .join('\n');
  }
}

export interface RunningServer {
  url: string;
  port: number;
  close(): Promise<void>;
}
