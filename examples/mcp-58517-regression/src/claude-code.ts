/**
 * Optional black-box adapter for the locally installed Claude Code CLI.
 *
 * This adapter only *invokes* the CLI with a temporary MCP configuration
 * pointing at loopback mock servers, with a bounded runtime and kill-on-
 * timeout. It does not modify the CLI, any user config, or any settings
 * file. All verdicts come from what the mock servers actually recorded.
 *
 * Verified CLI flags (from `claude --help` / `claude mcp --help` on the
 * machine running this harness, Claude Code native build):
 *   -p/--print, --mcp-config <configs...>, --strict-mcp-config,
 *   --tools <...> ("" disables built-ins), --permission-mode dontAsk,
 *   --no-session-persistence, --debug[mcp], --debug-file <path>
 */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface ClaudeRunResult {
  /** The binary actually spawned (explicit option > CLAUDE_BIN env > "claude" on PATH). */
  bin: string;
  spawnError: string | null;
  killedByTimeout: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  /** Truncated to keep logs small; may contain CLI diagnostics, never echoed by default. */
  stdoutExcerpt: string;
  stderrExcerpt: string;
}

export interface ClaudeRunOptions {
  args: string[];
  cwd: string;
  timeoutMs: number;
  /** Explicit binary path/name. Wins over the CLAUDE_BIN env var and PATH lookup. */
  bin?: string;
}

const EXCERPT_CHARS = 4000;

/** Resolution order: explicit argument > CLAUDE_BIN env var > "claude" on PATH. */
export function claudeBinary(explicit?: string): string {
  const override = explicit?.trim();
  if (override) return override;
  return process.env.CLAUDE_BIN?.trim() || 'claude';
}

/**
 * Spawn the Claude Code CLI. On timeout the child is killed and
 * `killedByTimeout` is set — a timeout is recorded evidence, not an error.
 * stdout/stderr are capped so an unexpected flood cannot stall the harness.
 *
 * Process-termination limits: `child.kill()` / `child.kill(9)` signal only
 * the DIRECT child process; there is no process-tree guarantee, especially
 * on Windows (no detached process group is used, deliberately, to keep the
 * probe simple). The CLI is spawned as the direct child and normally exits
 * on its own well before the timeout; the escalation below only fires if
 * the child has not emitted its close event yet, based on exit state, not
 * on `child.killed` (which merely means a signal was sent).
 */
export function runClaude(opts: ClaudeRunOptions): Promise<ClaudeRunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const bin = claudeBinary(opts.bin);
    let stdout = '';
    let stderr = '';
    let killedByTimeout = false;
    let settled = false;

    const child = spawn(bin, opts.args, {
      cwd: opts.cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let escalateTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      killedByTimeout = true;
      child.kill(); // best effort: direct child only
      escalateTimer = setTimeout(() => {
        if (!settled) child.kill(9); // still no close event after 5s -> force
      }, 5000);
      escalateTimer.unref();
    }, opts.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < EXCERPT_CHARS * 2) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < EXCERPT_CHARS * 2) stderr += chunk.toString('utf8');
    });

    const settle = (result: Omit<ClaudeRunResult, 'bin' | 'durationMs' | 'stdoutExcerpt' | 'stderrExcerpt'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (escalateTimer) clearTimeout(escalateTimer);
      resolve({
        bin,
        ...result,
        durationMs: Date.now() - started,
        stdoutExcerpt: stdout.slice(0, EXCERPT_CHARS),
        stderrExcerpt: stderr.slice(0, EXCERPT_CHARS),
      });
    };

    child.on('error', (err) => {
      settle({
        spawnError: err.message,
        killedByTimeout: false,
        exitCode: null,
        signal: null,
        stdoutBytes: stdout.length,
        stderrBytes: stderr.length,
      });
    });

    child.on('close', (code, signal) => {
      settle({
        spawnError: null,
        killedByTimeout,
        exitCode: code,
        signal,
        stdoutBytes: stdout.length,
        stderrBytes: stderr.length,
      });
    });
  });
}

export interface McpServerEntry {
  type: 'http' | 'sse';
  url: string;
}

/**
 * Write a temporary MCP config file in the documented Claude Code shape
 * (`{ "mcpServers": { ... } }`) pointing exclusively at loopback URLs.
 * Returns the config path and a cleanup function. NOTE: the issue report
 * used a top-level `"servers"` key; Claude Code's documented shape is
 * `mcpServers`, and this harness deliberately uses the documented shape.
 *
 * Cleanup: callers must invoke `cleanup()` only after the spawned CLI has
 * fully settled (the `close` event — process exited, stdio closed) and the
 * mock server has closed. On Windows, the directory can still be busy at
 * that instant because (a) it was the child's current directory, (b) the
 * freshly written `--debug-file` may still be held briefly during process
 * teardown or by an antivirus/indexer scan, or (c) a short-lived
 * grandchild. `fs.rm` retries exactly the transient codes Windows reports
 * (EBUSY, EPERM, ENOTEMPTY) with exponential backoff; the retry is BOUNDED
 * (maxRetries 5, retryDelay 150ms -> at most ~4.7s of backoff). Any error
 * still present after the retries propagates to the caller and fails the
 * test — cleanup failures are never suppressed.
 */
export async function writeTempMcpConfig(
  servers: Record<string, McpServerEntry>,
): Promise<{ dir: string; configPath: string; debugFilePath: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcp-58517-'));
  const configPath = path.join(dir, 'mcp-config.json');
  const debugFilePath = path.join(dir, 'claude-debug.log');
  await writeFile(configPath, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, 'utf8');
  return {
    dir,
    configPath,
    debugFilePath,
    cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }),
  };
}

/** Standard, verified argument vector for a black-box MCP probe session. */
export function claudeProbeArgs(configPath: string, debugFilePath: string): string[] {
  return [
    '-p',
    'Reply with the single word OK.',
    '--mcp-config',
    configPath,
    '--strict-mcp-config',
    '--tools',
    '',
    '--permission-mode',
    'dontAsk',
    '--no-session-persistence',
    '--debug=mcp',
    '--debug-file',
    debugFilePath,
  ];
}
