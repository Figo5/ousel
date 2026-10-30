# Claude Code capture

From this Ousel checkout, with Node >=24 and a running v3 viewer:

```sh
claude --version
node --import tsx src/cli/connect.ts --project /absolute/project --task integration
# or, from npm: npm run connect:claude -- --project /absolute/project --task integration
```

Supported target: Claude Code 2.1.311, macOS/Linux shell commands. No automatic
capture support is claimed for other hosts. The installer registers this
checkout's absolute `hook.mjs` path and Node executable in the project's
`.claude/settings.json`; it does not copy scripts or install packages. Keep
this checkout in place. No account, token, or credential is configured.

`--url` selects a viewer, `--dry-run` prints the proposed JSON, and `--remove`
removes only handlers referencing this checkout's hook path. Installation
requires a successful health response; `--dry-run` and `--remove` are local
edits and work with the viewer stopped. Unrelated settings and hook handlers
remain.
Writes use an atomic rename and mode 0600. Setup reports ingest failures after a
write honestly; it does not roll back installed settings after a viewer outage.

The eight installed handlers are synchronous command hooks with `timeout: 5`
and `onFailure: "continue"`. Synchronous means a headless `claude -p` session
cannot tear one down before it posts. The hook itself aborts after 1500 ms and
always exits 0. Their shell commands quote all values and suppress
output, including interpreter failures. The hook also has its own 2500 ms
process deadline and 1500 ms HTTP timeout. It always exits 0 when runnable.
No output is returned to Claude and no transcript is read.

Environment: `OUSEL_URL` (default `http://127.0.0.1:4317`), `OUSEL_PROJECT`,
`OUSEL_TASK`, and `OUSEL_ACTOR` (default `claude-code`). The installer sets these
explicitly for each handler; direct invocations can override them.

Lifecycle events, prompt character counts, tool names, optional durations, and
file paths are captured. Successful Edit/Write/NotebookEdit calls reference
modified paths; failed edits do not claim a change. Read only references a path.
Missing durations are omitted. Subagents with absent identity are dropped.

Only recognizable validation commands get captured checks. Simple commands
such as `npm test`, `npm run check`, `tsc`, `vitest`, and `node --test` are
recognized, including environment assignments and `cd dir && npm test`.
Complex shell programs, pipelines, substitutions, background execution, and
interrupted results do not generate validation evidence. This conservative
recognizer can miss real checks. A recognized command's hook outcome describes
that tool invocation; it is not a test-by-test report or proof of coverage.

Prompt text, assistant messages, file bodies, error bodies, and stdout/stderr
are never sent. Suspicious credential-bearing strings are replaced wholesale
with `[redacted]` before truncation. This is a best-effort pattern filter, not
a guarantee that arbitrary user text contains no secrets. Keep credentials out
of command arguments and project/task identities.

Unknown events, malformed or oversized input, network errors, rejection, and
timeouts are silently dropped. There are no retries, durable queues, or ordering
guarantees, and a slow viewer adds latency to the tool call. Use the companion
`skills/ousel/SKILL.md` for explicit handoffs, blockers, and review judgments.

See [implementation evidence](../../docs/claude-code-integration.md) and the
[event contract](../../docs/event-contract-v3.md). Hook schema and lifecycle
reference: [official Claude Code hooks docs](https://code.claude.com/docs/en/hooks).
