import { setTimeout as delay } from "node:timers/promises";

const flags = process.argv.slice(2);
if (flags.includes("--help")) {
  console.log(
    "Usage: npm run demo -- [--fast]\nStart the local server first. OUSEL_PORT (or AGENTOPS_PORT) defaults to 4317.\nPosts labeled synthetic events; no agents or providers are launched.",
  );
  process.exit(0);
}
if (flags.some((flag) => flag !== "--fast")) {
  console.error("Unknown option. Use --help.");
  process.exit(1);
}
const port = Number(
  process.env.OUSEL_PORT ?? process.env.AGENTOPS_PORT ?? 4317,
);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error("OUSEL_PORT must be between 1024 and 65535.");
  process.exit(1);
}
const base = `http://127.0.0.1:${port}`;
const session = `demo-${Date.now()}`;
const common = {
  source: "synthetic",
  project: "demo",
  task: "sample-workflow",
};
const events = [
  {
    actor: "demo-planner",
    provider: "openai",
    action: "plan",
    status: "running",
    summary: "DEMO: plan a small change",
  },
  {
    actor: "demo-planner",
    provider: "openai",
    action: "handoff",
    target: "demo-implementer",
    status: "ok",
    summary: "DEMO: hand implementation to another actor",
  },
  {
    actor: "demo-implementer",
    provider: "claude",
    parent: "demo-planner",
    action: "implement",
    status: "running",
    summary: "DEMO: implement the proposed change",
  },
  {
    actor: "demo-implementer",
    provider: "claude",
    action: "handoff",
    target: "demo-reviewer",
    status: "ok",
    summary: "DEMO: implementation ready for review",
  },
  {
    actor: "demo-reviewer",
    provider: "google",
    parent: "demo-planner",
    action: "review",
    status: "running",
    summary: "DEMO: review the change",
  },
  {
    actor: "demo-reviewer",
    provider: "google",
    action: "verdict",
    verdict: "needs-fixes",
    status: "blocked",
    summary: "DEMO: request an empty-input check",
  },
  {
    actor: "demo-implementer",
    provider: "claude",
    action: "revise",
    status: "running",
    summary: "DEMO: add the requested check",
  },
  {
    actor: "demo-implementer",
    provider: "claude",
    action: "handoff",
    target: "demo-reviewer",
    status: "ok",
    summary: "DEMO: revision ready",
  },
  {
    actor: "demo-reviewer",
    provider: "google",
    action: "verdict",
    verdict: "approve",
    status: "ok",
    summary: "DEMO: approve the revised example",
  },
  {
    actor: "demo-planner",
    provider: "openai",
    action: "complete",
    status: "ok",
    summary: "DEMO: sample workflow complete",
  },
];

console.log(`Synthetic demo → ${base}\nSession: ${session}`);
try {
  for (const [index, event] of events.entries()) {
    const response = await fetch(`${base}/ingest`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(3000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...common, ...event, session }),
    });
    if (response.status !== 202)
      throw new Error(`server returned HTTP ${response.status}`);
    const result = await response.json();
    if (result.accepted !== 1 || result.rejected?.length !== 0)
      throw new Error("server did not accept the event");
    console.log(
      `${index + 1}/${events.length} ${event.actor}: ${event.action}`,
    );
    if (!flags.includes("--fast")) await delay(850);
  }
  console.log(
    "Open the viewer and select the demo session. Events remain in the local database.",
  );
} catch (error) {
  console.error(
    `Demo stopped: ${error.message}. Start the local server with npm start and check OUSEL_PORT.`,
  );
  process.exitCode = 1;
}
