// Cross-platform opt-in runner for the Claude Code black-box tests.
// npm scripts cannot use inline POSIX `ENV=1 ...` syntax on Windows, so the
// env var is set here and node --test is spawned as a child process.
//
// Exit-code contract (also documented in README.md):
//   0 -> every probe verdict is "not-reproduced" (backed by recorded evidence)
//   2 -> at least one probe DEMONSTRATED the reported behavior ("reproduced")
//   3 -> inconclusive / setup failure (spawn error, no traffic) — not success
//   other nonzero -> node:test assertion or harness failure (see output above)
// The structured verdicts written by the test file (MCP58517_VERDICT_FILE)
// decide 2/3; otherwise the node --test child exit code is propagated.
import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const testFile = path.join(here, 'claude-code.integration.test.ts');
const verdictFile = path.join(tmpdir(), 'mcp-58517-verdicts.json');

// Never act on a stale verdict file from an earlier run.
try {
  rmSync(verdictFile, { force: true });
} catch {
  /* ignore */
}

const child = spawn(process.execPath, ['--test', testFile], {
  stdio: 'inherit',
  env: {
    ...process.env,
    RUN_CLAUDE_CODE_TESTS: '1',
    MCP58517_VERDICT_FILE: verdictFile,
  },
  cwd: path.join(here, '..'),
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`claude-code tests terminated by signal ${signal}`);
    process.exit(1);
  }
  const childCode = code ?? 1;
  let verdicts = null;
  try {
    verdicts = JSON.parse(readFileSync(verdictFile, 'utf8'));
  } catch {
    /* no verdict file: test crashed before finishing, or suite skipped */
  }

  let finalCode = childCode;
  let reason = 'node:test exit code (assertion/harness failure, or no verdict file)';
  if (Array.isArray(verdicts) && verdicts.length > 0) {
    if (verdicts.some((v) => v.class === 'reproduced')) {
      finalCode = 2;
      reason = 'regression demonstrated by at least one probe';
    } else if (verdicts.some((v) => v.class === 'inconclusive')) {
      finalCode = 3;
      reason = 'at least one probe inconclusive (setup failure / no traffic / missing CLI)';
    } else {
      finalCode = childCode === 0 ? 0 : childCode;
      reason = childCode === 0 ? 'all probes not-reproduced with recorded evidence' : 'node:test failure despite not-reproduced verdicts';
    }
  }

  try {
    rmSync(verdictFile, { force: true });
  } catch {
    /* ignore */
  }
  console.log(`[test:claude] exit ${finalCode} — ${reason}`);
  process.exit(finalCode);
});
