# MCP #58517 regression harness

Black-box regression harness for [anthropics/claude-code#58517](https://github.com/anthropics/claude-code/issues/58517):

- **Bug 1:** `"type": "http"` MCP servers allegedly silently ignored (no connection, no error).
- **Bug 2:** legacy `"type": "sse"` transport allegedly never POSTs `initialize` when the server's
  `endpoint` SSE event contains a **relative** URL (e.g. `data: /message?sessionId=test123`), as emitted
  by the Visual Studio MCP extension.
- **Related symptom (comment thread):** Streamable HTTP servers that require
  `Accept: application/json, text/event-stream` answer **406** to Claude Code.

The public `anthropics/claude-code` repository does **not** contain Claude Code's MCP transport
implementation, so this harness cannot patch it. It instead provides:

1. **SDK conformance tests** (no Claude Code) that capture the reference behavior of the official
   MCP TypeScript SDK and validate the harness itself.
2. **Opt-in Claude Code black-box probes** that run the locally installed `claude` CLI against
   loopback-only mock servers and report a VERDICT strictly from recorded server-side traffic.

> This harness never claims a Claude Code bug is reproduced unless the recorded traffic demonstrates it.

## Prerequisites

- **Node.js ≥ 22.18** (the tests are TypeScript run directly by Node's native type stripping; verified on v24).
- `npm` (network access needed once, for `npm install`).
- For the black-box probes only: a locally installed, working **Claude Code CLI** (`claude` on PATH,
  or set `CLAUDE_BIN` to its full path). Probes that spawn a real session may require Claude Code to
  be authenticated; an unauthenticated run can still produce useful MCP-startup evidence, because MCP
  servers connect at session startup.

## Install

```powershell
# PowerShell (Windows)
cd examples\mcp-58517-regression
npm install
```

```sh
# POSIX
cd examples/mcp-58517-regression
npm install
```

## Run: SDK conformance tests (safe, no Claude Code, no model calls)

```powershell
npm test
```

```sh
npm test
```

These verify, against loopback servers only:

| # | What it proves |
|---|----------------|
| 1 | Control: SDK client completes `initialize` + `tools/list` over an **SDK SSE server** |
| 2 | Control: SDK client completes `initialize` + `tools/list` over an **SDK Streamable HTTP server** |
| 3 | Reference behavior for bug 2: the SDK SSE client **resolves** the relative endpoint `/message?sessionId=test123` and POSTs `initialize` there |
| 4 | Reference behavior for Accept negotiation: the SDK Streamable HTTP client sends `Accept` with both `application/json` and `text/event-stream` and gets HTTP 200 |
| 5 | Negative control: a POST with a non-conformant `Accept` is rejected with **406** by the strict mock (proving the strict server actually validates) |

If any of these fail, do **not** run or trust the Claude Code probes until they pass — a probe
failure would be a setup problem, not evidence about Claude Code.

## Run: Claude Code black-box probes (opt-in)

```powershell
npm run test:claude
```

```sh
npm run test:claude
```

Optional environment variables:

| Variable | Effect |
|----------|--------|
| `CLAUDE_BIN` | Full path to the claude binary (default: `claude` on PATH) |
| `CLAUDE_PROBE_TIMEOUT_MS` | Kill timeout per probe (default 60000) |
| `KEEP_TMP=1` | Keep the temp dir (MCP config + Claude `--debug-file` log) for inspection |
| `VERBOSE=1` | Print truncated stdout/stderr excerpts from the spawned CLI |

Each probe:

1. Starts a loopback-only mock (127.0.0.1, ephemeral port).
2. Writes a temporary MCP config in Claude Code's documented shape
   (`{ "mcpServers": { ... } }` — note: the issue report used a top-level `"servers"` key, which is
   not Claude Code's documented format; this harness deliberately uses `mcpServers`).
3. Spawns: `claude -p "Reply with the single word OK." --mcp-config <tmp> --strict-mcp-config --tools "" --permission-mode dontAsk --no-session-persistence --debug=mcp --debug-file <tmp>`
   (flags verified against the installed CLI's `--help`).
4. Kills the process at the timeout if still running, then prints the recorded exchanges and a VERDICT.

### Exit codes (Claude Code probes only)

`npm run test:claude` (and a direct `node --test test/claude-code.integration.test.ts` run with
`RUN_CLAUDE_CODE_TESTS=1`) classifies every probe as exactly one of three verdicts, based solely on
recorded server-side traffic, and maps them to the process exit code:

| Exit code | Meaning |
|-----------|---------|
| `0` | **Not reproduced.** Every probe reached this verdict only via *positive recorded evidence* (an observed `initialize` exchange with a successful HTTP status). |
| `2` | **Reproduced.** At least one probe demonstrated the reported behavior from recorded traffic (e.g., `GET /sse` accepted but no `initialize` POST to the relative endpoint; `initialize` rejected with HTTP 406). |
| `3` | **Inconclusive / setup failure.** Missing CLI executable (spawn error), no traffic observed, or other setup problems. **Never treated as success.** |
| other nonzero | A `node:test` assertion or harness failure — see the assertion output and VERDICT lines above. |

Notes:

- The structured verdict file (`MCP58517_VERDICT_FILE`, set automatically by `npm run test:claude`)
  is what lets the wrapper distinguish `2` from `3`; direct `node --test` runs set the process exit
  code from the same rules, but the node test runner may normalize it to `1` — either way nonzero.
- **Missing login is never treated as proof of success or failure by itself.** An unauthenticated
  CLI may exit with "Not logged in" *while the MCP handshake still completes at startup*; verdicts
  use only the recorded traffic. If a login failure prevents any MCP traffic, the probe is
  classified *inconclusive* (exit `3`), not as a pass.
- Without `RUN_CLAUDE_CODE_TESTS=1` the suite is skipped (exit `0`); `npm test` never includes
  these probes.

## Interpreting the results

### Bug 1 probe (`type: "http"`)

| Observed on the mock server | Interpretation | Typical exit |
|-----------------------------|----------------|--------------|
| `initialize` POST → **200** | The HTTP transport **handshake** succeeds on this build: Claude Code connected to the `"type": "http"` server and completed `initialize` (and `tools/list` where observed) with a conformant `Accept` header. **Scope:** transport-level handshake only — this run does **not** establish that tools register in an authenticated session or that tool use succeeds in a model turn. Bug 1 not reproduced. | `0` |
| POST → **406** | Claude Code reached the server but sends a non-conformant `Accept` header — reproduces the n8n symptom, not "silently ignored". | `2` |
| **No POST at all**, CLI exited/killed normally | Inconclusive: consistent with bug 1 (silently ignored), but setup failures (auth, CLI startup error before MCP init) can look identical. Rule them out first: rerun with `KEEP_TMP=1` and check the Claude debug log for MCP config-load errors. Only after that would "silently ignored" be demonstrated. | `3` |
| Spawn error | Harness/setup problem (CLI missing); not evidence either way. | `3` |

### Bug 2 probe (SSE relative endpoint)

| Observed on the mock server | Interpretation | Typical exit |
|-----------------------------|----------------|--------------|
| `GET /sse` → 200 **and** `POST /message?sessionId=test123` with `initialize` | Bug 2 **not reproduced**; the relative endpoint was resolved (transport-level handshake only). | `0` |
| `GET /sse` → 200, **no POST** within the observation window | **Demonstrates** the bug 2 behavior on this build (assuming SDK conformance test 3 passed, which proves the mock + relative endpoint are correct). | `2` |
| `POST` to `/message` that is not an `initialize` | Inconclusive; inspect the recorded exchange. | `3` |
| No `GET /sse` at all | Inconclusive; Claude Code never connected (config/setup issue possible). | `3` |
| Spawn error | Harness/setup problem (CLI missing); not evidence either way. | `3` |

### SDK conformance tests

All 5 passing = the mock servers, relative-endpoint emission, Accept validation, loopback
networking, and SDK reference behavior are correct. Any Claude Code verdict is then attributable to
Claude Code's client behavior (subject to the setup caveats above).

## Safety

- All mock servers bind **127.0.0.1 only** (loopback), on ephemeral ports.
- The mock tools (`sse_echo`, `strict_echo`, `control_echo`) only echo text; **no received MCP
  message is ever executed as a shell command** or anywhere else.
- Headers are recorded through an **allow-list** (`accept`, `content-type`, `mcp-*`, `user-agent`);
  everything else is stored as `[redacted]`.
- Request bodies are JSON-RPC parsed and truncated in summaries; the Claude debug log is never
  printed and is deleted on cleanup unless `KEEP_TMP=1`.
- No API keys, tokens, or user config files are read or written. The temporary MCP config contains
  only loopback URLs. The probe uses `--strict-mcp-config` so no other MCP configuration is loaded.

## Cleanup

- Probe temp dirs (`$TMP/mcp-58517-*`) are deleted automatically unless `KEEP_TMP=1`; delete them
  manually if retained: `Remove-Item -Recurse $env:TEMP\mcp-58517-*` (PowerShell) or
  `rm -rf "$TMPDIR"/mcp-58517-*` / `rm -rf /tmp/mcp-58517-*` (POSIX).
  On Windows, deletion runs only after the spawned CLI has exited and the mock server has closed,
  and transient `EBUSY`/`EPERM`/`ENOTEMPTY` locks (process-teardown or antivirus timing) are
  retried with bounded exponential backoff (5 retries, ≤ ~4.7 s total). A lock that outlives the
  retries fails the test — cleanup errors are never suppressed.
- Remove the harness itself: delete `examples/mcp-58517-regression/` (its `node_modules/` and
  `tmp/` are git-ignored; nothing outside this directory is modified).
- The harness never modifies user MCP configuration, settings files, or the Claude Code binary.

## Layout

```
src/harness.ts             Request recorder (timestamps, redacted headers, responses, timeouts)
src/sse-relative.ts        Bug 2 mock: legacy SSE server emitting a relative endpoint event
src/streamable-strict.ts   Strict Streamable HTTP mock (406 unless Accept is conformant)
src/control.ts             Control servers built on the official MCP TypeScript SDK
src/claude-code.ts         Opt-in adapter that spawns the local Claude Code CLI (verified flags)
test/sdk-conformance.test.ts        SDK-only tests (run with `npm test`)
test/claude-code.integration.test.ts  Black-box probes (run with `npm run test:claude`)
test/run-claude-tests.mjs   Cross-platform opt-in wrapper (Windows-compatible env handling)
```

SDK verified against: `@modelcontextprotocol/sdk` v1.32.2 (npm package name; the project repository
is `modelcontextprotocol/typescript-sdk`). Reference behaviors confirmed in its source: the SSE
client resolves `new URL(event.data, baseUrl)` (client/sse.js), the server SSE transport emits a
relative `/message?sessionId=<uuid>` endpoint event, and the Streamable HTTP server enforces the
dual Accept header with 406.
