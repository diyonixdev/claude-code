/**
 * Claude Code black-box integration tests — OPT-IN.
 *
 * Skipped unless RUN_CLAUDE_CODE_TESTS=1 (use `npm run test:claude`).
 * Requires a locally installed, working `claude` CLI (override with
 * CLAUDE_BIN). Each test:
 *   1. starts a loopback-only mock server with a RequestRecorder,
 *   2. writes a temporary MCP config (`{ "mcpServers": { ... } }`),
 *   3. spawns `claude -p ... --mcp-config <tmp> --strict-mcp-config` with a
 *      bounded runtime (killed on timeout),
 *   4. classifies a VERDICT based ONLY on what the mock server recorded and
 *      sets the process exit code accordingly:
 *
 *        'not-reproduced' -> exit 0  (positive recorded evidence required)
 *        'reproduced'     -> exit 2  (regression demonstrated by recorded traffic)
 *        'inconclusive'   -> exit 3  (spawn error, no traffic, setup failure —
 *                                     never treated as success)
 *
 *     When MCP58517_VERDICT_FILE is set (the `npm run test:claude` wrapper
 *     does this), structured verdicts are also written there so the wrapper
 *     can map them to the final exit code. Direct `node --test` runs use the
 *     process exit code set below; the node test runner may normalize it.
 *
 * These tests never claim a Claude Code bug unless the recorded traffic
 * actually demonstrates it. "No traffic observed" is inconclusive, with
 * setup-failure alternatives listed.
 *
 * Security: servers bind 127.0.0.1 only; recorded bodies are JSON-RPC
 * parsed and truncated; headers are allow-list redacted; nothing received
 * is executed; the Claude debug log (which may contain local paths) stays
 * in the OS temp dir and is deleted on cleanup unless KEEP_TMP=1, and is
 * never printed to the console.
 */
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { RequestRecorder } from '../src/harness.ts';
import { startSseRelativeServer, SESSION_ID } from '../src/sse-relative.ts';
import { startStrictStreamableServer } from '../src/streamable-strict.ts';
import { runClaude, writeTempMcpConfig, claudeProbeArgs, type ClaudeRunResult } from '../src/claude-code.ts';

const OPT_IN = process.env.RUN_CLAUDE_CODE_TESTS === '1';
const KEEP_TMP = process.env.KEEP_TMP === '1';
const PROBE_TIMEOUT_MS = Number(process.env.CLAUDE_PROBE_TIMEOUT_MS ?? 60000);

type VerdictClass = 'not-reproduced' | 'reproduced' | 'inconclusive';

interface Verdict {
  probe: string;
  class: VerdictClass;
  detail: string;
}

const verdicts: Verdict[] = [];

function recordVerdict(probe: string, cls: VerdictClass, detail: string): void {
  verdicts.push({ probe, class: cls, detail });
  console.log(`VERDICT [${cls.toUpperCase()}] (${probe}): ${detail}`);
}

after(() => {
  const verdictFile = process.env.MCP58517_VERDICT_FILE;
  if (verdictFile) {
    try {
      writeFileSync(verdictFile, `${JSON.stringify(verdicts, null, 2)}\n`, 'utf8');
    } catch {
      /* wrapper falls back to the process exit code */
    }
  }
  if (verdicts.some((v) => v.class === 'reproduced')) {
    process.exitCode = 2;
  } else if (verdicts.some((v) => v.class === 'inconclusive')) {
    process.exitCode = 3;
  }
});

function isInitializeMessage(body: unknown): boolean {
  return typeof body === 'object' && body !== null && (body as { method?: unknown }).method === 'initialize';
}

/** Every recorded exchange must carry a response status (annotation completeness). */
function assertAllExchangesAnnotated(recorder: RequestRecorder): void {
  for (const e of recorder.list) {
    assert.notEqual(e.responseStatus, null, `exchange #${e.seq} ${e.method} ${e.url} lacks a recorded response status`);
  }
}

function printEvidence(label: string, recorder: RequestRecorder, run: ClaudeRunResult): void {
  console.log(`\n===== ${label}: recorded server-side evidence =====`);
  console.log(recorder.summary());
  console.log(`----- claude CLI outcome -----`);
  console.log(`binary: ${run.bin}`);
  console.log(
    `exit: code=${run.exitCode} signal=${run.signal ?? '-'} killedByTimeout=${run.killedByTimeout} duration=${run.durationMs}ms spawnError=${run.spawnError ?? '-'}`,
  );
  console.log(`stdout bytes: ${run.stdoutBytes}, stderr bytes: ${run.stderrBytes}${KEEP_TMP ? '' : ' (contents not printed; set VERBOSE=1 to excerpt)'}`);
  if (process.env.VERBOSE === '1') {
    console.log(`--- stdout excerpt ---\n${run.stdoutExcerpt}`);
    console.log(`--- stderr excerpt ---\n${run.stderrExcerpt}`);
  }
  console.log('===================================================\n');
}

describe('Claude Code black-box probes (opt-in)', { skip: !OPT_IN }, () => {
  test(
    'bug 1 probe: does Claude Code connect to a "type": "http" loopback server (strict Accept)?',
    { timeout: PROBE_TIMEOUT_MS + 30000 },
    async () => {
      const recorder = new RequestRecorder();
      const server = await startStrictStreamableServer(recorder);
      const tmp = await writeTempMcpConfig({
        'strict-http': { type: 'http', url: `${server.url}/` },
      });
      try {
        // The temp config must actually contain the documented shape and a loopback URL.
        const cfg = JSON.parse(await readFile(tmp.configPath, 'utf8')) as {
          mcpServers?: Record<string, { type?: string; url?: string }>;
        };
        assert.equal(cfg.mcpServers?.['strict-http']?.type, 'http', 'temp MCP config must declare type http');
        assert.match(
          cfg.mcpServers?.['strict-http']?.url ?? '',
          /^http:\/\/127\.0\.0\.1:\d+\//,
          'temp MCP config URL must be loopback',
        );

        const run = await runClaude({
          args: claudeProbeArgs(tmp.configPath, tmp.debugFilePath),
          cwd: tmp.dir,
          timeoutMs: PROBE_TIMEOUT_MS,
        });
        printEvidence('bug 1 (type: http)', recorder, run);
        assertAllExchangesAnnotated(recorder);

        const anyPost = recorder.find((e) => e.method === 'POST');
        const initialized = recorder.find((e) => isInitializeMessage(e.body) && e.responseStatus === 200);
        const rejected406 = recorder.find((e) => e.responseStatus === 406);

        let cls: VerdictClass;
        let detail: string;
        if (initialized) {
          cls = 'not-reproduced';
          const accept = (initialized.headers['accept'] ?? '').toLowerCase();
          assert.match(initialized.url, /^\//, 'initialize must target the configured root path');
          assert.ok(accept.includes('application/json'), `initialize Accept must include application/json: ${accept}`);
          assert.ok(accept.includes('text/event-stream'), `initialize Accept must include text/event-stream: ${accept}`);
          detail =
            '"type": "http" connection OBSERVED (initialize HTTP 200 with a conformant Accept header). ' +
            'Scope: transport-level HTTP handshake only — this run does NOT establish tool registration in an ' +
            'authenticated session or tool use in a model turn. Bug 1 not reproduced on this Claude Code build.';
        } else if (rejected406) {
          cls = 'reproduced';
          assert.equal(rejected406.responseStatus, 406);
          detail =
            'Claude Code reached the server but was REJECTED with HTTP 406 (non-conformant Accept header). ' +
            'Reproduces the n8n-report Accept symptom, not the "silently ignored" symptom.';
        } else if (anyPost) {
          cls = 'inconclusive';
          detail = `POST(s) observed (last status ${anyPost.responseStatus}) but no successful initialize — inspect the recorded exchange above.`;
        } else if (run.spawnError) {
          cls = 'inconclusive';
          detail = `Could not spawn claude CLI (${run.spawnError}) — missing executable or prerequisite. This is NOT evidence that the bug is or is not present.`;
        } else {
          cls = 'inconclusive';
          detail =
            'NO HTTP traffic observed toward the "type": "http" server. Consistent with bug 1 (server silently ' +
            'ignored), but setup failures (auth, CLI startup error before MCP init) can look identical — rerun ' +
            'with KEEP_TMP=1 and check the Claude debug log for MCP config load errors before concluding. ' +
            'Classified inconclusive, not success and not a demonstration.';
        }
        // Verdict integrity: a "not reproduced" claim always requires recorded evidence.
        if (cls === 'not-reproduced') {
          assert.ok(recorder.list.length > 0, 'verdict "not-reproduced" requires at least one recorded exchange');
          assert.ok(initialized, 'verdict "not-reproduced" requires an observed successful initialize');
        }
        recordVerdict('bug-1 (type: http)', cls, detail);
      } finally {
        // Settle order: mock-server connections are closed first (close()
        // awaits connection termination), then the temp dir is removed —
        // and only after runClaude resolved via the child's `close` event
        // (process exited, stdio drained). Cleanup still runs if
        // server.close() throws, and any cleanup error propagates and
        // fails the test; nothing is suppressed here.
        try {
          await server.close();
        } finally {
          if (KEEP_TMP) {
            console.log(`[KEEP_TMP] temp dir retained: ${tmp.dir}`);
          } else {
            await tmp.cleanup();
          }
        }
      }
    },
  );

  test(
    'bug 2 probe: does Claude Code POST initialize after a RELATIVE SSE endpoint event?',
    { timeout: PROBE_TIMEOUT_MS + 30000 },
    async () => {
      const recorder = new RequestRecorder();
      const server = await startSseRelativeServer(recorder);
      const tmp = await writeTempMcpConfig({
        'sse-relative': { type: 'sse', url: `${server.url}/sse` },
      });
      try {
        const cfg = JSON.parse(await readFile(tmp.configPath, 'utf8')) as {
          mcpServers?: Record<string, { type?: string; url?: string }>;
        };
        assert.equal(cfg.mcpServers?.['sse-relative']?.type, 'sse', 'temp MCP config must declare type sse');
        assert.match(
          cfg.mcpServers?.['sse-relative']?.url ?? '',
          /^http:\/\/127\.0\.0\.1:\d+\/sse$/,
          'temp MCP config URL must be the loopback SSE endpoint',
        );

        const run = await runClaude({
          args: claudeProbeArgs(tmp.configPath, tmp.debugFilePath),
          cwd: tmp.dir,
          timeoutMs: PROBE_TIMEOUT_MS,
        });
        printEvidence('bug 2 (SSE relative endpoint)', recorder, run);
        assertAllExchangesAnnotated(recorder);

        const sseGet = recorder.find((e) => e.method === 'GET' && e.url.startsWith('/sse'));
        const initPost = recorder.find(
          (e) => e.method === 'POST' && e.url.startsWith(`/message`) && isInitializeMessage(e.body),
        );
        const anyPost = recorder.find((e) => e.method === 'POST');

        let cls: VerdictClass;
        let detail: string;
        if (initPost) {
          cls = 'not-reproduced';
          assert.match(initPost.url, /^\/message\?/, 'initialize must target the endpoint-event path');
          assert.ok(initPost.url.includes(`sessionId=${SESSION_ID}`), `initialize must carry the emitted sessionId: ${initPost.url}`);
          assert.equal(initPost.responseStatus, 202, 'SSE mock must accept the initialize POST');
          detail =
            `initialize POST observed at ${initPost.url} (HTTP ${initPost.responseStatus}) after ` +
            `${server.sseConnectionCount()} SSE connection(s) — the relative endpoint was resolved. ` +
            'Scope: transport-level handshake only. Bug 2 not reproduced on this Claude Code build.';
        } else if (anyPost) {
          cls = 'inconclusive';
          detail = `POST observed (status ${anyPost.responseStatus}) but not an initialize message — inspect the recorded exchange above.`;
        } else if (sseGet) {
          cls = 'reproduced';
          detail =
            `Claude Code OPENED the SSE stream (GET /sse -> 200) but NEVER POSTed initialize to the relative ` +
            `endpoint within the observation window. This DEMONSTRATES the bug 2 behavior (relative endpoint ` +
            `URL not resolved, or handshake otherwise stalled) on this Claude Code build — valid only if the ` +
            `SDK conformance suite (\`npm test\`) passes, which proves the mock emits a correct relative endpoint.`;
        } else if (run.spawnError) {
          cls = 'inconclusive';
          detail = `Could not spawn claude CLI (${run.spawnError}) — missing executable or prerequisite. This is NOT evidence that the bug is or is not present.`;
        } else {
          cls = 'inconclusive';
          detail =
            'NO traffic at all — Claude Code never opened the SSE stream. Inconclusive: config/setup failure ' +
            'possible (rerun with KEEP_TMP=1 and inspect the Claude debug log). Not counted as success.';
        }
        if (cls === 'not-reproduced') {
          assert.ok(recorder.list.length > 0, 'verdict "not-reproduced" requires at least one recorded exchange');
          assert.ok(initPost, 'verdict "not-reproduced" requires an observed initialize POST');
        }
        recordVerdict('bug-2 (sse-relative)', cls, detail);
      } finally {
        // Settle order: mock-server connections are closed first (close()
        // awaits connection termination), then the temp dir is removed —
        // and only after runClaude resolved via the child's `close` event
        // (process exited, stdio drained). Cleanup still runs if
        // server.close() throws, and any cleanup error propagates and
        // fails the test; nothing is suppressed here.
        try {
          await server.close();
        } finally {
          if (KEEP_TMP) {
            console.log(`[KEEP_TMP] temp dir retained: ${tmp.dir}`);
          } else {
            await tmp.cleanup();
          }
        }
      }
    },
  );
});
