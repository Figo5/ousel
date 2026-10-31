#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Strong credential shapes, regardless of surrounding words.
const secretValue =
  /(?:\bBearer\s+\S|\bBasic\s+\S|\bsk-[\w-]{8,}|\bgh[pousr]_[\w]{8,}|\bAKIA[\w]{8,}|\beyJ[\w-]+\.[\w-]+\.|:\/\/[^\s/]+@)/;
// A keyword only redacts when it is being assigned a value. This keeps paths
// such as src/auth/token.ts and summaries such as "token refresh fix" intact.
const secretAssignment =
  /\b(?:token|secret|password|passwd|authorization|api[-_]?key|credential|private[-_ ]key)\b\s*[:=]\s*\S{4,}|--?(?:token|secret|password|api[-_]?key|credential)\b\s+\S+/i;

// Prefer dropping a suspicious field to partially exposing a credential.
export function clean(value, max = 200) {
  if (typeof value !== "string") return undefined;
  if (secretValue.test(value) || secretAssignment.test(value))
    return "[redacted]";
  return (
    value
      .replace(/[\x00-\x1f\x7f]/g, " ")
      .trim()
      .slice(0, max) || undefined
  );
}

// Deliberately conservative: do not mistake `echo "npm test"` for a test run.
// Complex shell programs cannot be classified reliably without a shell parser.
export function isValidationCommand(command) {
  if (typeof command !== "string" || command.length > 32_768) return false;
  if (
    /[\n\r;|`$<>]/.test(command) ||
    command.replaceAll("&&", "").includes("&")
  )
    return false;
  const parts = command.split("&&");
  return parts.every((part, index) => {
    const tokens = part.match(/(?:[^\s'"\\]+|'[^']*'|"[^"]*")+/g) ?? [];
    if (tokens.join(" ") !== part.trim().replace(/\s+/g, " ")) return false;
    while (/^[A-Za-z_][\w]*=/.test(tokens[0] ?? "")) tokens.shift();
    const [bin, arg, script] = tokens;
    // `lint:fix` mutates; `build:prod` is not a distinct validation command.
    // Allow only exact runners plus test:* variants.
    const validation = /^(?:test(?::[\w-]+)?|build|lint|typecheck|check|tsc|vitest)$/;
    if (bin === "cd")
      return (
        parts.length > 1 && index < parts.length - 1 && tokens.length === 2
      );
    if (["npm", "pnpm", "yarn", "bun"].includes(bin))
      return validation.test(arg === "run" ? (script ?? "") : (arg ?? ""));
    if (bin === "npx") return ["tsc", "vitest"].includes(arg);
    if (bin === "node") {
      const testIndex = tokens.findIndex(
        (token) => token === "--test" || token.startsWith("--test="),
      );
      // A script path before --test (node app.js --test) is not a test run.
      if (testIndex < 1 || !(tokens[1] ?? "").startsWith("-")) return false;
      return !tokens.some((t) => ["-e", "--eval", "-p", "--print"].includes(t));
    }
    // Only known runners count. A bare `test`, `build`, `lint` or `check` is
    // often a shell builtin or another tool, and must not become evidence.
    return ["tsc", "vitest"].includes(bin ?? "");
  });
}

/** Pure whitelist mapping. Never read transcripts or spread tool payloads. */
export function mapHook(payload, env = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return null;
  const actor = clean(env.OUSEL_ACTOR) ?? "claude-code";
  const event = { actor, source: "captured", provider: "claude" };
  for (const [key, value] of Object.entries({
    session: payload.session_id,
    project: env.OUSEL_PROJECT,
    task: env.OUSEL_TASK,
  })) {
    const safe = clean(value);
    if (safe) event[key] = safe;
  }
  switch (payload.hook_event_name) {
    case "SessionStart":
      return {
        ...event,
        action: "session_start",
        status: "running",
        summary: "Claude Code session started",
      };
    case "UserPromptSubmit":
      if (typeof payload.prompt !== "string") return null;
      return {
        ...event,
        action: "prompt_submitted",
        status: "running",
        summary: `Prompt submitted (${payload.prompt.length} chars)`,
      };
    case "PostToolUse":
    case "PostToolUseFailure": {
      const tool = clean(payload.tool_name);
      if (!tool) return null;
      const failed = payload.hook_event_name === "PostToolUseFailure";
      // Subagent tool calls arrive with the parent's session_id plus their own
      // agent_id/agent_type. Attribute them to the subagent, not the parent.
      if (payload.agent_id) {
        const type = clean(payload.agent_type, 193);
        const id = clean(payload.agent_id);
        if (type && id) {
          event.actor = `claude:${type}`;
          event.session = id;
          event.parent = actor;
        }
      }
      const detail = { tool };
      if (Number.isSafeInteger(payload.duration_ms) && payload.duration_ms >= 0)
        detail.durationMs = payload.duration_ms;
      const result = {
        ...event,
        action: failed ? "tool_failed" : "tool_completed",
        status: failed ? "error" : "ok",
        summary: `${tool} ${failed ? "failed" : "completed"}`,
        detail,
      };
      const input = payload.tool_input;
      if (["Read", "Edit", "Write", "NotebookEdit"].includes(tool)) {
        const path = clean(
          tool === "NotebookEdit" ? input?.notebook_path : input?.file_path,
          1000,
        );
        if (path) {
          detail.path = path;
          if (!failed && ["Edit", "Write", "NotebookEdit"].includes(tool))
            result.files = [
              {
                path,
                change:
                  tool === "Write" && payload.tool_response?.type === "create"
                    ? "added"
                    : "modified",
              },
            ];
        }
      }
      if (
        tool === "Bash" &&
        input?.run_in_background !== true &&
        !payload.tool_response?.backgroundTaskId &&
        !payload.tool_response?.interrupted &&
        isValidationCommand(input?.command)
      ) {
        const command = clean(input.command, 1000);
        const check = {
          name: command.slice(0, 200),
          result: failed ? "failed" : "passed",
          evidence: "captured",
          command,
        };
        if (detail.durationMs !== undefined)
          check.durationMs = detail.durationMs;
        result.checks = [check];
      }
      return result;
    }
    case "SubagentStart":
    case "SubagentStop": {
      const type = clean(payload.agent_type, 193);
      const session = clean(payload.agent_id);
      if (!type || !session) return null;
      const stopped = payload.hook_event_name === "SubagentStop";
      return {
        ...event,
        actor: `claude:${type}`,
        session,
        parent: actor,
        action: stopped ? "subagent_stop" : "subagent_start",
        status: stopped ? "ok" : "running",
        summary: `Subagent ${type} ${stopped ? "stopped" : "started"}`,
      };
    }
    case "Stop":
      return {
        ...event,
        action: "turn_complete",
        status: "ok",
        summary: "Claude Code finished responding",
      };
    case "SessionEnd":
      return {
        ...event,
        action: "session_end",
        status: "ok",
        summary: "Claude Code session ended",
      };
    default:
      return null;
  }
}

export function viewerUrl(raw = "http://127.0.0.1:4317") {
  const url = new URL(raw);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid viewer URL");
  return url.href.replace(/\/$/, "");
}

export async function runHook(input = process.stdin, env = process.env) {
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of input) {
      size += Buffer.byteLength(chunk);
      if (size > 1024 * 1024) return;
      chunks.push(Buffer.from(chunk));
    }
    const event = mapHook(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
      env,
    );
    if (!event) return;
    const response = await fetch(`${viewerUrl(env.OUSEL_URL)}/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(1500),
      redirect: "error",
    });
    await response.body?.cancel();
  } catch {
    // Capture is best effort. No output can be interpreted as a hook decision.
  }
}

function isMain() {
  try {
    return (
      realpathSync(fileURLToPath(import.meta.url)) ===
      realpathSync(process.argv[1])
    );
  } catch {
    return false;
  }
}

if (process.argv[1] && isMain()) {
  const exit = () => process.exit(0);
  process.on("uncaughtException", exit);
  process.on("unhandledRejection", exit);
  process.on("SIGTERM", exit);
  process.on("SIGINT", exit);
  // The hook is a synchronous command hook, so this deadline also keeps a
  // stalled stdin or half-open viewer from holding up the tool call.
  setTimeout(exit, 2500);
  runHook().then(exit, exit);
}
