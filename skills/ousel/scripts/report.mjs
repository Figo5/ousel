#!/usr/bin/env node
import { parseArgs } from "node:util";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
// Keep this helper portable with the skill: only Node built-ins are required.
const secretValue =
  /(?:\bBearer\s+\S|\bBasic\s+\S|\bsk-[\w-]{8,}|\bgh[pousr]_[\w]{8,}|\bAKIA[\w]{8,}|\beyJ[\w-]+\.[\w-]+\.|:\/\/[^\s/]+@)/;
const secretAssignment =
  /\b(?:token|secret|password|passwd|authorization|api[-_]?key|credential|private[-_ ]key)\b\s*[:=]\s*\S{4,}|--?(?:token|secret|password|api[-_]?key|credential)\b\s+\S+/i;

// Prefer dropping a suspicious field to partially exposing a credential.
function clean(value, max = 200) {
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

function viewerUrl(raw = "http://127.0.0.1:4317") {
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

export async function report(args = process.argv.slice(2), env = process.env) {
  const checking = args.includes("--health");
  try {
    const fields = [
      "actor",
      "action",
      "summary",
      "status",
      "verdict",
      "session",
      "target",
      "parent",
      "project",
      "task",
      "url",
    ];
    const { values } = parseArgs({
      args,
      options: {
        ...Object.fromEntries(
          fields.map((field) => [field, { type: "string" }]),
        ),
        health: { type: "boolean" },
      },
    });
    const url = viewerUrl(values.url ?? env.OUSEL_URL);
    if (values.health) {
      const response = await fetch(`${url}/api/health`, {
        signal: AbortSignal.timeout(1500),
        redirect: "error",
      });
      const body = await response.json();
      if (
        !response.ok ||
        body?.ok !== true ||
        typeof body.version !== "string" ||
        !Number.isSafeInteger(body.latestId) ||
        !Number.isSafeInteger(body.total)
      )
        throw new Error();
      console.log("reachable");
      return 0;
    }
    const event = { source: "reported" };
    for (const field of fields.filter((field) => field !== "url")) {
      const value = clean(
        values[field] ??
          (field === "project"
            ? env.OUSEL_PROJECT
            : field === "task"
              ? env.OUSEL_TASK
              : undefined),
        field === "summary" ? 2000 : field === "verdict" ? 100 : 200,
      );
      if (value) event[field] = value;
    }
    if (
      !event.actor ||
      !event.action ||
      (event.status &&
        !["running", "ok", "error", "blocked"].includes(event.status))
    )
      throw new Error();
    const response = await fetch(`${url}/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(1500),
      redirect: "error",
    });
    const body = await response.json();
    if (
      ![200, 202].includes(response.status) ||
      body?.accepted !== 1 ||
      !Array.isArray(body.rejected) ||
      body.rejected.length
    )
      throw new Error();
    return 0;
  } catch {
    if (checking) {
      console.log("unreachable");
      return 2;
    }
    console.error("Ousel report not delivered; continuing work.");
    return 0;
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
  process.exitCode = await report();
}
