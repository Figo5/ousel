import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

type ObjectValue = Record<string, unknown>;
export const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "PostToolUseFailure",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "SessionEnd",
] as const;
export const HOOK_PATH = fileURLToPath(
  new URL("../../integrations/claude-code/hook.mjs", import.meta.url),
);
const isObject = (v: unknown): v is ObjectValue =>
  !!v && typeof v === "object" && !Array.isArray(v);

export function shellQuote(value: string): string {
  if (value.includes("\0"))
    throw new Error("NUL is not allowed in hook configuration");
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function hookCommand(
  project: string,
  task: string,
  url: string,
  hookPath = HOOK_PATH,
  nodePath = process.execPath,
): string {
  const env = {
    OUSEL_URL: url,
    OUSEL_PROJECT: project,
    OUSEL_TASK: task,
    OUSEL_ACTOR: "claude-code",
  };
  return `${Object.entries(env)
    .map(([k, v]) => `${k}=${shellQuote(v)}`)
    .join(
      " ",
    )} ${shellQuote(nodePath)} ${shellQuote(hookPath)} >/dev/null 2>&1 || :`;
}

function referencesHook(command: string, hookPath: string): boolean {
  if (command.includes(shellQuote(hookPath))) return true;
  const escaped = hookPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[\\s"'])${escaped}(?=$|[\\s"';])`).test(command);
}

/** Remove only our handlers, retaining mixed groups and unrelated settings. */
export function mergeSettings(
  settings: unknown,
  command: string,
  hookPath = HOOK_PATH,
  remove = false,
): ObjectValue {
  if (!isObject(settings)) throw new Error("Settings must be a JSON object");
  if (settings.hooks !== undefined && !isObject(settings.hooks))
    throw new Error("settings.hooks must be an object");
  const result = structuredClone(settings);
  const hooks: ObjectValue = { ...(result.hooks as ObjectValue | undefined) };
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups))
      throw new Error(`hooks.${event} must be an array`);
    hooks[event] = groups.flatMap((group: unknown) => {
      if (!isObject(group) || !Array.isArray(group.hooks))
        throw new Error(`Invalid hook group for ${event}`);
      const retained = group.hooks.filter(
        (handler: unknown) =>
          !(
            isObject(handler) &&
            handler.type === "command" &&
            typeof handler.command === "string" &&
            referencesHook(handler.command, hookPath)
          ),
      );
      if (retained.length === group.hooks.length) return [group];
      return retained.length ? [{ ...group, hooks: retained }] : [];
    });
    if ((hooks[event] as unknown[]).length === 0 && groups.length > 0)
      delete hooks[event];
  }
  if (!remove) {
    for (const event of HOOK_EVENTS) {
      const groups = (hooks[event] ?? []) as unknown[];
      hooks[event] = [
        ...groups,
        {
          hooks: [
            {
              type: "command",
              command,
              async: true,
              timeout: 5,
              onFailure: "continue",
            },
          ],
        },
      ];
    }
  }
  if (Object.keys(hooks).length || settings.hooks !== undefined || !remove)
    result.hooks = hooks;
  return result;
}

function normalizeUrl(raw: string): string {
  const url = new URL(raw);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Use a viewer URL without credentials, query, or fragment");
  return url.href.replace(/\/$/, "");
}

async function health(url: string): Promise<ObjectValue> {
  const response = await fetch(`${url}/api/health`, {
    signal: AbortSignal.timeout(1500),
    redirect: "error",
  });
  const body: unknown = await response.json();
  if (
    !response.ok ||
    !isObject(body) ||
    body.ok !== true ||
    typeof body.version !== "string" ||
    !Number.isSafeInteger(body.latestId) ||
    !Number.isSafeInteger(body.total)
  )
    throw new Error("Invalid health response");
  return {
    ok: body.ok,
    version: body.version,
    latestId: body.latestId,
    total: body.total,
  };
}

export async function connect(args = process.argv.slice(2)): Promise<number> {
  try {
    const { values } = parseArgs({
      args,
      options: {
        project: { type: "string" },
        task: { type: "string" },
        url: { type: "string" },
        remove: { type: "boolean" },
        "dry-run": { type: "boolean" },
      },
    });
    if (!values.project || !values.task?.trim())
      throw new Error(
        "Usage: node --import tsx src/cli/connect.ts --project <dir> --task <slug> [--url http://127.0.0.1:4317] [--remove] [--dry-run]",
      );
    if (values.task.length > 200 || /[\x00-\x1f\x7f]/.test(values.task))
      throw new Error(
        "Task must be at most 200 characters without control characters",
      );
    const url = normalizeUrl(values.url ?? "http://127.0.0.1:4317");
    let state: ObjectValue;
    try {
      state = await health(url);
    } catch {
      console.error(
        "Ousel viewer unavailable. Run `npm start` in the Ousel checkout, then retry this command (use a v3 viewer with /api/health).",
      );
      return 1;
    }
    const project = await realpath(path.resolve(values.project));
    if (!(await lstat(project)).isDirectory())
      throw new Error("Project must be a directory");
    if (project.length > 200)
      throw new Error(
        "Project path exceeds the 200-character event contract limit",
      );
    const directory = path.join(project, ".claude");
    const settingsPath = path.join(directory, "settings.json");
    let settings: unknown = {};
    try {
      if (!(await lstat(directory)).isDirectory())
        throw new Error(".claude must be a real directory");
      if (!(await lstat(settingsPath)).isFile())
        throw new Error("settings.json must be a regular file");
      settings = JSON.parse(await readFile(settingsPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const result = mergeSettings(
      settings,
      hookCommand(project, values.task, url),
      HOOK_PATH,
      values.remove,
    );
    const json = JSON.stringify(result, null, 2) + "\n";
    if (values["dry-run"]) {
      process.stdout.write(json);
      return 0;
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.settings-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, json, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, settingsPath);
    } finally {
      await rm(temporary, { force: true });
    }
    console.log(`Health: ${JSON.stringify(state)}`);
    console.log(`Settings: ${settingsPath}`);
    console.log(`Ousel hooks: ${values.remove ? 0 : HOOK_EVENTS.length}`);
    if (values.remove) {
      console.log("Removed Ousel hooks; no connection event posted.");
      return 0;
    }
    try {
      const response = await fetch(`${url}/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          actor: "ousel",
          action: "integration_connected",
          source: "reported",
          project,
          task: values.task,
          summary: `Claude Code integration connected for task ${values.task}`,
        }),
        signal: AbortSignal.timeout(1500),
        redirect: "error",
      });
      const receipt: unknown = await response.json();
      const accepted =
        response.status === 200 &&
        isObject(receipt) &&
        receipt.accepted === 1 &&
        Array.isArray(receipt.rejected) &&
        receipt.rejected.length === 0;
      // Print counts, never arbitrary response bodies that could contain secrets.
      console.log(
        `Ingest: HTTP ${response.status}, accepted=${isObject(receipt) && typeof receipt.accepted === "number" ? receipt.accepted : "unknown"}, rejected=${isObject(receipt) && Array.isArray(receipt.rejected) ? receipt.rejected.length : "unknown"}`,
      );
      if (!accepted) {
        console.error(
          "Settings written, but ingest verification failed; inspect the viewer before relying on capture.",
        );
        return 1;
      }
      return 0;
    } catch {
      console.error(
        "Settings written, but ingest verification was unavailable or invalid.",
      );
      return 1;
    }
  } catch (error) {
    console.error(
      error instanceof SyntaxError
        ? "Invalid settings JSON; nothing written."
        : error instanceof Error
          ? error.message
          : "Connection setup failed.",
    );
    return 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  process.exitCode = await connect();
}
