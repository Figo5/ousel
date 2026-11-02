# Setting up Ousel

You are a coding agent and someone asked you to set this up. This file is
everything you need. Work through it in order; each step says what success looks
like, so you can tell whether it worked rather than guessing.

Ousel is a viewer that runs on this machine. Agents post what they are doing
to it over HTTP and it organizes that by project and task. It orchestrates
nothing and launches nothing. The only thing it changes is the local database
and data directory it is pointed at; an existing AgentOps database is migrated
in place, so use a disposable `OUSEL_DATA_DIR` when testing.

## 1. Check the requirements

```bash
node --version
```

Must be **v24 or newer**. The server uses the built-in `node:sqlite`, which
older releases do not have — if this prints v22 or lower, stop and tell the
human they need to upgrade Node. You also need `git` and `npm`, on macOS or
Linux.

There is nothing else to obtain: no account, no API key, no database, no network
call at any point after install.

## 2. Install and start

```bash
git clone https://github.com/Figo5/ousel.git
cd ousel
npm install
npm run build
npm start
```

**Success:** `npm start` prints a line containing `http://127.0.0.1:4317` and
stays running. It is a server — it does not exit, so start it in the background
or in its own terminal.

If it exits instead, read the error. The two likely causes are a Node version
below 24, and port 4317 already in use — in which case start it as
`OUSEL_PORT=4318 npm start` and use that port everywhere below.

## 3. Verify it works

```bash
curl -s localhost:4317/ingest \
  -H 'content-type: application/json' \
  -d '{"actor":"setup-check","action":"verify","status":"ok","summary":"Install verified"}'
```

**Success:** `{"accepted":1,"rejected":[],"latestId":1}`.

- `415` means you left off the `content-type: application/json` header. It is
  required.
- Connection refused means the server is not running — go back to step 2.

Now confirm it is stored:

```bash
curl -s localhost:4317/api/health
curl -s localhost:4317/api/bootstrap | head -c 200
```

**Success:** JSON containing `"actor":"setup-check"`.

If you can open a browser, <http://127.0.0.1:4317> shows a `setup-check`
event in the task view. If you cannot, the two curls above are a complete verification —
do not report failure merely because you could not look at it.

## 4. Tell the human it is ready

Say that Ousel is running at <http://127.0.0.1:4317>, that they should open
it, and that any agent can now report into it. If you changed the port, say so.

## 5. Report your own work into it

Pick a stable `session` id for the conversation you are in, and a short `actor`
name for yourself. Then post as you work:

```bash
curl -s -m 2 localhost:4317/ingest \
  -H 'content-type: application/json' \
  -d '{"actor":"<you>","action":"<what>","session":"<session>","provider":"<claude|openai|google|opencode|openrouter>","status":"running","summary":"<one line>"}'
```

Report:

| When                   | Send                                                             |
| ---------------------- | ---------------------------------------------------------------- |
| You start a task       | `status: "running"` with a `summary`                             |
| You finish one         | `status: "ok"` with a `summary`                                  |
| You fail               | `status: "error"` with a `summary` saying what broke             |
| **You need the human** | `status: "blocked"` with a `summary` stating the decision needed |
| You are a subagent     | `parent: "<the actor that spawned you>"`                         |
| You hand work off      | `target: "<the other actor>"`                                    |
| You judge something    | `verdict` plus a `summary`, and `issues` if you have specifics   |

`blocked` is the one that gets their attention — it appears in **Needs
attention** and on the field. Silence is never turned into `blocked`; a quiet
agent is labelled as inferred from inactivity, not as stuck.

**Rules**

- **Never block on it.** Short timeout, ignore failures. The viewer is never a
  dependency of your real work, and a human watching is not worth a stall.
- One event per meaningful step, not per token. Batch up to 100 with
  `{"events":[…]}` if you are chatty.
- Set `project` and `task` on every event so it lands in the task view. They are
  omitted only by legacy clients, which appear under `unassigned`.
- `source: "captured"` means an integration observed it. Use `reported` when you
  are making a claim. Never send `inferred`; Ousel derives and labels that itself.
- A check is `reported` unless an integration captured the command result. A
  reviewer approval is not proof that tests ran.
- Never send secrets. Credentials are stripped on arrival, but do not rely on
  that.

Read replies from the human on your own session:

```bash
curl -N "localhost:4317/api/events?session=<session>"
```

A reply arrives as an event with `actor: "operator"` and `action: "reply"`.

For automatic Claude Code capture:

```bash
npm run connect:claude -- --project /path/to/project --task <task-slug>
```

If the viewer uses a different port, pass its URL explicitly:

```bash
npm run connect:claude -- --project /path/to/project --task <task-slug> --url http://127.0.0.1:4318
```

The connection command does not read `OUSEL_PORT`; use the actual viewer URL
for both connection setup and the health/reporting commands above.

See [docs/claude-code-integration.md](docs/claude-code-integration.md). Codex and
other hosts use explicit reporting above; no automatic capture is claimed for
them. A companion reporting skill is in [skills/ousel](skills/ousel/SKILL.md).

[README.md](README.md) has the full contract: every field, every limit, every
response code. The running server serves it at
<http://127.0.0.1:4317/README.md>.

---

## Working on this codebase

Only relevant if you were asked to change Ousel itself.

```bash
npm run dev       # server, watched
npm run dev:ui    # vite on :5173, proxies /api and /ingest to the server
npm test          # node:test
npm run check     # typecheck + test + build — run this before you commit
npm run format    # prettier
```

`npm run check` plus `npm run format:check` is exactly what CI runs. If both
pass locally, CI passes.

**Where things are**

| Path                               | What it owns                                    |
| ---------------------------------- | ----------------------------------------------- |
| `src/core/events.ts`               | the event model and all validation              |
| `src/db/store.ts`                  | one append-only SQLite table, migrated in place |
| `src/server/app.ts`                | `/ingest`, SSE, the static client               |
| `src/ui/constellation.ts`          | stream → stars, edges, cards (pure, tested)     |
| `src/ui/taskview.ts`               | stream → task view, attention (pure, tested)    |
| `src/server/config.ts`             | data dir / port resolution (pure, tested)       |
| `src/ui/components/TaskPanels.tsx` | task view panels                                |
| `src/ui/components/Field.tsx`      | the canvas                                      |
| `src/ui/App.tsx`                   | the one screen, Task and Field views            |
| `src/ui/theme.css`                 | greyscale chrome; the field has its own colour  |

**Conventions that matter here**

- `src/ui/constellation.ts` and `src/ui/taskview.ts` are pure and stay that way — no React, no DOM, no
  network. That is how the whole picture is tested in Node without a browser.
  Put rendering in `Field.tsx` and decisions in those two modules.
- **Never invent data the stream did not report.** An absent field renders as an
  absence, not a default. Anything derived rather than reported is labelled as
  such — see the `sequence` edge kind, which exists precisely so a guessed
  relationship can be drawn as weaker than a stated one.
- **Source and evidence.** Every event has a `source` (`captured`, `reported`,
  `synthetic`; absent means `reported`) and every check an `evidence`. Never
  upgrade `reported` to `captured`, never accept `inferred` from a sender, and
  never treat a verdict as test evidence. The only inferred state is "quiet",
  derived in `taskview.ts`, labelled as inferred, and never shown as blocked.
- **Ousel never launches agents.** It receives, organizes and displays.
  Do not add spawning, routing or orchestration.
- The chrome is greyscale, so no state may depend on hue: every tone is also a
  glyph and a border treatment. The field is the one coloured surface and keeps
  its own palette in `Field.tsx`, deliberately separate from the CSS tokens.
- The root `tsconfig.json` is the Node side and excludes `src/ui`, which is a
  DOM project with its own config. Keep them separate — they have different
  `lib` settings for a reason.
- No `alert()`, `confirm()` or `prompt()` in the UI. Errors render in place.
