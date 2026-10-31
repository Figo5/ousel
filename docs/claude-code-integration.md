# Claude Code automatic capture

Ousel can observe a Claude Code session through the host's documented lifecycle
hooks. This is the one automatic integration in this release. It was built and
tested against **Claude Code 2.1.311** on macOS 27.0.1 with Node 26.8.1. The hook
schema was checked against the official [hooks reference](https://code.claude.com/docs/en/hooks)
for that version; no other Claude Code version is claimed.

## Setup

Start Ousel, then register the hook for one project and task:

```sh
cd /path/to/ousel
npm start

# in another terminal
npm run connect:claude -- \
  --project /path/to/project \
  --task my-task \
  --name my-project
```

`--name` is optional (default: the project directory's basename). `--url`
selects a viewer other than `http://127.0.0.1:4317`. The command:

1. checks `GET /api/health` and stops without writing if no v3 viewer is there;
2. merges eight command hooks into `<project>/.claude/settings.json`, preserving
   unrelated settings and removing only handlers that point at this checkout;
3. writes atomically with the file's existing mode (0600 for a new file);
4. posts a reported `integration_connected` event and prints the receipt.

Use `--dry-run` to print the proposed JSON without writing or contacting the
viewer, and `--remove` to remove only Ousel's handlers. Both local modes work
with the viewer stopped.

The installed command uses the absolute Node executable and this checkout's
absolute `integrations/claude-code/hook.mjs`. Keep the checkout in place; moving
it orphans the handlers (re-run `--remove` from the old path, then connect again).

## What is captured

Eight synchronous command hooks: `SessionStart`, `UserPromptSubmit`,
`PostToolUse`, `PostToolUseFailure`, `SubagentStart`, `SubagentStop`, `Stop`,
`SessionEnd`. Synchronous is deliberate: an async hook can be killed when a
headless `claude -p` session ends. The hook aborts after 1500 ms, and the shell
command also redirects output and returns success, so a viewer outage cannot
block a tool call. With the viewer stopped, the hook exited 0 in about 80 ms in
the verification below.

Events have `source: "captured"` and `provider: "claude"`. Captured fields are:

- session id, event lifecycle, tool name, duration, and file paths for
  Edit/Write/NotebookEdit (no file contents);
- subagent `agent_id`/`agent_type`, with `parent` set to the main actor;
- the fact that a prompt was submitted and its character count — **not** the
  prompt text, the assistant message, tool stdout/stderr, or error bodies;
- a validation check only for a small allowlist of simple commands (`npm test`,
  `npm run check`, `tsc`, `vitest`, `node --test`, with `cd dir &&` and env
  assignments). The result means the tool invocation completed successfully; it
  is not a per-test report or proof of coverage.

This classifier is conservative. During the live review below, Claude ran
`node evaluation/run.mjs`; the hook did **not** turn that into a captured check
because the script name is not recognized. The review's harness run was then
recorded only as a reported claim. Do not read "no captured checks" as "nothing
ran", and do not read an approval as test evidence.

Secrets: obvious credential shapes (`Bearer …`, `sk-…`, URL userinfo, key
assignments, secret flags) are replaced with `[redacted]`. Paths such as
`src/auth/token.ts` and summaries such as "token refresh fix" are preserved.
This is a best-effort filter, not a guarantee. Keep credentials out of commands
and file names.

## Verification (2026-10-30)

Tested on the authoring machine, not a general compatibility matrix.

- `npm run connect:claude -- --project /tmp/review-upgrade-check --task upgrade-check-review --name upgrade-check`
  printed `Health: {"ok":true,"version":"3.0.0",...}`, `Ousel hooks: 8`, and
  `Ingest: HTTP 202, accepted=1, rejected=0`.
- A live `claude -p --model sonnet` review session in that project produced 15
  captured events: session start, prompt count, nine tool completions, two tool
  failures, the `FINDINGS.md` write with its path, turn complete, and session end.
  A bootstrap query showed `source: "captured"` for all 15; no prompt or assistant
  text was present.
- The same command run twice left exactly eight Ousel handlers in
  `settings.json` and preserved an unrelated `Stop` hook.
- With the viewer stopped, a `Stop` hook payload exited 0 in 0.077 s and posted
  nothing. After restarting the viewer on the same data directory, all 30
  recorded events were still returned by `/api/bootstrap`.
- A copy of an existing AgentOps database (634 rows, v2 columns) opened read-write
  through Ousel: 634 rows and ids were preserved, the five new columns were added,
  and every old row read as `source: "reported"` with `project`/`task` null.

Not tested: other Claude Code versions, Windows, headless sessions with hooks
disabled, concurrent migrations, viewer authentication beyond the local guard,
or a long-running session large enough to exercise history retention.

## Codex and other hosts

There is no automatic capture for Codex in this release. Codex participation is
visible through the companion reporting skill in
[`skills/ousel/SKILL.md`](../skills/ousel/SKILL.md), which posts `source: "reported"`
events. Reported means the agent said so; it is labeled as such in the viewer.
Do not describe a reported event as captured evidence.
