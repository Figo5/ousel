# Claude Code integration: implementation and verification

Worktree: `/Users/giofiore/work/ousel-integration`, branch
`feat/claude-integration`, base `0142bda`. Only the seven owned integration,
CLI, skill, test, and documentation files were added. Package scripts and
viewer implementation were left unchanged.

## Design

The hook whitelists lifecycle metadata and emits v3 events without reading
transcripts or transmitting conversation/tool-output bodies. Missing durations
remain absent. Validation recognition is conservative; complex shell programs
and background launches do not become passed checks. Credential-like fields
are replaced before truncation. File changes are reported only for successful
Edit/Write/NotebookEdit calls. The helper always identifies explicit reports as
`source: "reported"`.

The setup command registers the absolute checkout hook and Node executable.
No credentials are needed for ingest. It requires valid `/api/health` before
writing, preserves unrelated settings, and writes mode 0600 via atomic rename.
Removal does not emit an `integration_connected` event. Dry-run only prints JSON.
The base viewer has not yet implemented the v3 health endpoint or promoted v3
fields out of `detail`; the companion viewer changes are required for live use.

[Official hook reference](https://code.claude.com/docs/en/hooks) was read on
2026-10-30. The requested `.md` endpoint returned an unsupported-content-type
error through the web reader, so its HTML equivalent was used. Command handlers
receive stdin JSON; these handlers are asynchronous, silent, and use
`onFailure: "continue"`. Async handlers need their own deadline and can be
cancelled at session teardown. This implementation adds a 2500 ms process limit
and a 1500 ms fetch timeout. Timing is omitted when `duration_ms` is absent.

## Commands actually run

All commands were run from the integration worktree unless their paths below
are absolute. No live Claude coding session was launched.

| Command                                                                                                     | Observed result                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `node --version`                                                                                            | `v26.8.1`                                                                                                                                                                                  |
| `claude --version`                                                                                          | `2.1.311 (Claude Code)`                                                                                                                                                                    |
| `git branch --show-current`                                                                                 | `feat/claude-integration`                                                                                                                                                                  |
| `git log -1 --oneline`                                                                                      | `0142bda Document the Ousel v3 event contract`                                                                                                                                             |
| `npm ci --offline --ignore-scripts --no-audit --no-fund --cache /Users/giofiore/.npm`                       | Exit 0; installed 29 cached packages, no package/lockfile edits.                                                                                                                           |
| `node --import tsx --test tests/integration.test.ts`                                                        | 27 tests: 20 passed, 0 failed, 7 explicitly skipped because loopback listeners are denied.                                                                                                 |
| `node --check integrations/claude-code/hook.mjs`                                                            | Exit 0; no output.                                                                                                                                                                         |
| `node --check skills/ousel/scripts/report.mjs`                                                              | Exit 0; no output.                                                                                                                                                                         |
| `npm run check`                                                                                             | Typecheck passed. Suite: 63 tests, 46 passed, 10 failed, 7 skipped. All 10 failures were existing `tests/server.test.ts` tests with `listen EPERM`. Build was not reached by this command. |
| `npm run build`                                                                                             | Exit 0; typecheck passed, Vite built 24 modules.                                                                                                                                           |
| `npm run format:check`                                                                                      | Exit 1; existing formatting in `src/ui/constellation.ts` and `docs/event-contract-v3.md`. Neither file was edited.                                                                         |
| `OUSEL_EVIDENCE=1 node --import tsx --test tests/integration.test.ts > /tmp/ousel-integration-evidence.txt` | Exit 0; output below was captured from actual subprocesses with a fetch stub.                                                                                                              |

Initial testing exposed a command-recognition bug and a formatting-sensitive
TypeScript suppression; both were fixed before the reported final results.
No TCP test is silently counted as passed: the initial listener probe produced
`Error: listen EPERM: operation not permitted 127.0.0.1`. The tests explicitly
skip only the seven checks requiring TCP when that exact sandbox error occurs.
Other listener errors fail the suite.

## Captured subprocess evidence (simulated transport, not HTTP)

The requested fake HTTP server could not bind inside this sandbox. Therefore
**the end-to-end HTTP verification is not completed**. The suite contains the
real temporary-server test, including POST recording, ready to run in an
environment permitting loopback sockets.

As additional evidence, subprocesses ran `hook.mjs` with documentation-shaped
SessionStart/PostToolUse/Stop payloads. A test-only fetch stub recorded the JSON
requests. The payloads included transcript paths, tool stdout/stderr, and final
assistant text; none appears in these events. `npm run check` and its duration
in this fixture are fixture inputs, not a claim that this fixture ran that
command. These fixture events were never sent to a live viewer. Their
`source: "captured"` is the hook's contract output under test, not synthetic data
inserted into a production stream.

```json
[
  {
    "actor": "claude-code",
    "source": "captured",
    "provider": "claude",
    "session": "fixture-session",
    "project": "fixture-project",
    "task": "integration",
    "action": "session_start",
    "status": "running",
    "summary": "Claude Code session started"
  },
  {
    "actor": "claude-code",
    "source": "captured",
    "provider": "claude",
    "session": "fixture-session",
    "project": "fixture-project",
    "task": "integration",
    "action": "tool_completed",
    "status": "ok",
    "summary": "Bash completed",
    "detail": {
      "tool": "Bash",
      "durationMs": 42
    },
    "checks": [
      {
        "name": "npm run check",
        "result": "passed",
        "evidence": "captured",
        "command": "npm run check",
        "durationMs": 42
      }
    ]
  },
  {
    "actor": "claude-code",
    "source": "captured",
    "provider": "claude",
    "session": "fixture-session",
    "project": "fixture-project",
    "task": "integration",
    "action": "turn_complete",
    "status": "ok",
    "summary": "Claude Code finished responding"
  }
]
```

The real CLI ran against a temporary project, with health and ingest responses
simulated by the same fetch stub. Its recorded output (local paths redacted):

```text
Health: {"ok":true,"version":"3.0.0-simulated","latestId":0,"total":0}
Settings: /tmp/PROJECT/.claude/settings.json
Ousel hooks: 8
Ingest: HTTP 200, accepted=1, rejected=0
```

Generated settings JSON, read back from disk (only absolute local paths redacted):

```json
{
  "permissions": {
    "allow": ["Read"]
  },
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "echo keep"
          }
        ]
      },
      {
        "hooks": [
          {
            "type": "command",
            "command": "OUSEL_URL='http://127.0.0.1:4317' OUSEL_PROJECT='/tmp/PROJECT' OUSEL_TASK='integration' OUSEL_ACTOR='claude-code' '/absolute/node' '/absolute/ousel-integration/integrations/claude-code/hook.mjs' >/dev/null 2>&1 || :",
            "async": true,
            "timeout": 5,
            "onFailure": "continue"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "OUSEL_URL='http://127.0.0.1:4317' OUSEL_PROJECT='/tmp/PROJECT' OUSEL_TASK='integration' OUSEL_ACTOR='claude-code' '/absolute/node' '/absolute/ousel-integration/integrations/claude-code/hook.mjs' >/dev/null 2>&1 || :",
            "async": true,
            "timeout": 5,
            "onFailure": "continue"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "OUSEL_URL='http://127.0.0.1:4317' OUSEL_PROJECT='/tmp/PROJECT' OUSEL_TASK='integration' OUSEL_ACTOR='claude-code' '/absolute/node' '/absolute/ousel-integration/integrations/claude-code/hook.mjs' >/dev/null 2>&1 || :",
            "async": true,
            "timeout": 5,
            "onFailure": "continue"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "OUSEL_URL='http://127.0.0.1:4317' OUSEL_PROJECT='/tmp/PROJECT' OUSEL_TASK='integration' OUSEL_ACTOR='claude-code' '/absolute/node' '/absolute/ousel-integration/integrations/claude-code/hook.mjs' >/dev/null 2>&1 || :",
            "async": true,
            "timeout": 5,
            "onFailure": "continue"
          }
        ]
      }
    ],
    "PostToolUseFailure": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "OUSEL_URL='http://127.0.0.1:4317' OUSEL_PROJECT='/tmp/PROJECT' OUSEL_TASK='integration' OUSEL_ACTOR='claude-code' '/absolute/node' '/absolute/ousel-integration/integrations/claude-code/hook.mjs' >/dev/null 2>&1 || :",
            "async": true,
            "timeout": 5,
            "onFailure": "continue"
          }
        ]
      }
    ],
    "SubagentStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "OUSEL_URL='http://127.0.0.1:4317' OUSEL_PROJECT='/tmp/PROJECT' OUSEL_TASK='integration' OUSEL_ACTOR='claude-code' '/absolute/node' '/absolute/ousel-integration/integrations/claude-code/hook.mjs' >/dev/null 2>&1 || :",
            "async": true,
            "timeout": 5,
            "onFailure": "continue"
          }
        ]
      }
    ],
    "SubagentStop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "OUSEL_URL='http://127.0.0.1:4317' OUSEL_PROJECT='/tmp/PROJECT' OUSEL_TASK='integration' OUSEL_ACTOR='claude-code' '/absolute/node' '/absolute/ousel-integration/integrations/claude-code/hook.mjs' >/dev/null 2>&1 || :",
            "async": true,
            "timeout": 5,
            "onFailure": "continue"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "OUSEL_URL='http://127.0.0.1:4317' OUSEL_PROJECT='/tmp/PROJECT' OUSEL_TASK='integration' OUSEL_ACTOR='claude-code' '/absolute/node' '/absolute/ousel-integration/integrations/claude-code/hook.mjs' >/dev/null 2>&1 || :",
            "async": true,
            "timeout": 5,
            "onFailure": "continue"
          }
        ]
      }
    ]
  }
}
```

The tests checked mode 0600, repeat installation byte equality, unrelated-hook
preservation, dry-run with no settings mutation, removal, invalid JSON, failed
health with no settings directory created, and simulated 207/400 responses.
Shell execution tests also passed paths containing apostrophes, spaces, command
substitution text, and backticks as literal values; a missing hook launcher was
silent and exited zero. Direct malformed/oversized/unknown input and failed
connection paths exited zero with empty stdout/stderr. A stalled stdin process
exited zero at its own deadline. Reporter failures exited zero with a short
stderr note; explicit health diagnostics exited 2 and printed `unreachable`.

## Outstanding verification and commits

A live v3 viewer, real TCP delivery/timeout, and a real Claude Code session have
not been verified. Only Claude Code 2.1.311 is the target; no automatic capture
claims are made for other agents or versions. Async events can be dropped or
reordered, and there is no retry/queue. The local redaction filter is best
effort, and validation recognition intentionally misses complex commands.

Run the following where loopback sockets are permitted; successful output must
include the actual `HOOK_POSTS`, `CONNECT_OUTPUT`, `SETTINGS_JSON`, and
`CONNECT_POST` sections from the fake HTTP test, and no skipped TCP checks:

```sh
OUSEL_EVIDENCE=1 node --import tsx --test tests/integration.test.ts
```

Local commits could not be created. The attempted command was:

```sh
git add integrations/claude-code/hook.mjs && git commit -m 'feat(integration): capture Claude Code hook events safely'
```

It exited 128 before staging with:

```text
fatal: Unable to create '/Users/giofiore/agentops/.git/worktrees/ousel-integration/index.lock': Operation not permitted
```

The worktree's Git metadata is outside the writable sandbox. No permission
bypass or alternate repository was attempted. There are no new commit hashes
and nothing was pushed. The intended four local commits, once metadata writes
are permitted, group capture, setup CLI, reporting skill, and tests/evidence.
