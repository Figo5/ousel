---
name: ousel
description: Check the Ousel viewer, connect Claude Code automatic capture, explain the reporting contract, and post concise progress, handoffs, blockers, review verdicts, and completion evidence when automatic capture is unavailable.
---

# Ousel

Ousel observes work; it never launches or controls agents. Reporting must never
interrupt the real task. Run the setup commands from the Ousel checkout. The
reporting script is standalone and can also travel with this skill; adjust its
invocation path when installing the skill elsewhere.

## Check and connect

Check the viewer with a short timeout:

```sh
curl -fsS -m 2 http://127.0.0.1:4317/api/health
```

Expect `{ok, version, latestId, total}` with `ok: true`. If unavailable, say
“The Ousel viewer is unavailable; continuing the task.” Do not stall, repeatedly
retry, or claim reporting succeeded. To start the viewer, run `npm start` from
the Ousel checkout. A viewer implementing the v3 health endpoint is required.

Connect a project to Claude Code automatic capture with this exact command,
substituting the project directory and task slug:

```sh
node --import tsx src/cli/connect.ts --project <dir> --task <slug> --url http://127.0.0.1:4317
```

Use `--dry-run` to inspect settings; use `--remove` to remove this checkout's
hooks. Setup preserves unrelated settings. Keep the checkout at the installed
absolute path. Automatic capture targets Claude Code 2.1.311 on macOS/Linux
with Node >=24. See `docs/claude-code-integration.md` for actual verification
and its limits; availability of a version is not proof of a live hook run.

## Evidence and concise reports

`source: "captured"` means an integration observed a host event.
`source: "reported"` means an agent or person explicitly made a claim.
`source: "synthetic"` means demo or fixture data, which must remain labeled.
Never store `source: "inferred"` or present an inference as observed fact.
Silence does not prove a blocker. A review verdict does not prove tests ran.
Asking a model to report does not guarantee complete capture.

Use one event per meaningful step, with a stable session and shared project/task:

- Start: concise objective with `status: "running"`.
- Handoff: name the recipient with `target` and summarize what they need.
- Blocker: `status: "blocked"` and the specific decision or input needed.
- Review: a `verdict` and concrete `issues`, including paths/lines when known.
- Completion: `status: "ok"` and actual validation commands and observed results;
  explicitly name checks that were not run. Model-posted checks remain
  `evidence: "reported"`, even when describing a command the model ran.

If automatic capture already records a tool completion, report only additional
meaning such as a handoff, blocker, or review judgment. Never duplicate every
tool call manually. Include `parent` when reporting as a subagent.

```sh
node skills/ousel/scripts/report.mjs --actor reviewer --action review --session task-session --project example --task integration --status running --summary 'Reviewing capture boundaries'
node skills/ousel/scripts/report.mjs --actor reviewer --action handoff --session task-session --project example --task integration --target implementer --summary 'Please address the missing duration case'
node skills/ousel/scripts/report.mjs --actor implementer --action blocked --session task-session --project example --task integration --status blocked --summary 'Need a decision on which project to connect'
```

The helper always sends `source: "reported"`. It accepts `--actor`, `--action`,
`--summary`, `--status`, `--verdict`, `--session`, `--target`, `--parent`,
`--project`, `--task`, and `--url`. `OUSEL_URL`, `OUSEL_PROJECT`, and `OUSEL_TASK`
are fallbacks. `--health` prints reachable/unreachable and exits 2 if unavailable;
use that only as an explicit diagnostic, never a prerequisite for real work.

For structured issues or checks, use curl with a short timeout. For example,
after actually observing the described finding (replace the illustrative data):

```sh
curl -sS -m 2 http://127.0.0.1:4317/ingest \
  -H 'content-type: application/json' \
  -d '{"actor":"reviewer","action":"review","session":"task-session","project":"example","task":"integration","source":"reported","verdict":"needs-fixes","summary":"Missing failure handling","issues":[{"description":"Handle connection refusal","severity":"medium","path":"hook.mjs","line":20}]}' || :
```

Completion checks use the shape
`{"name":"<actual check>","result":"passed|failed","evidence":"reported","command":"<actual command>"}`.
Attach them as `checks` to a reported event. Never fabricate durations or results.
HTTP 207 is partial acceptance; 400 is rejection. Neither proves delivery of
every event. Consult `docs/event-contract-v3.md` for limits and full semantics.

## When not to report

Do not report token-by-token narration, repetitive heartbeats, speculative state,
or events already adequately captured. Never send secrets, credentials, raw
conversations, prompt/assistant text, environment dumps, file contents, or command
stdout/stderr bodies. Short summaries and file references are sufficient.

The helper stops waiting after 1500 ms, prints a short stderr note on reporting
failure, and exits 0. Curl failures must likewise be ignored. Continue work;
do not turn a viewer outage into a task blocker.
