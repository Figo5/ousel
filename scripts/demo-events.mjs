// Posts clearly labelled SYNTHETIC events to a running Ousel. Not real activity.
// Usage: npm run demo   (OUSEL_PORT / OUSEL_TOKEN honoured)
const port = process.env.OUSEL_PORT ?? process.env.AGENTOPS_PORT ?? "4317";
const base = `http://127.0.0.1:${port}`;
const headers = { "content-type": "application/json" };
if (process.env.OUSEL_TOKEN) headers["x-ousel-token"] = process.env.OUSEL_TOKEN;

try {
  const health = await fetch(`${base}/api/health`, { headers });
  if (!health.ok) throw new Error(`health returned ${health.status}`);
} catch (error) {
  console.error(`Ousel is not reachable at ${base}: ${error.message}`);
  process.exit(1);
}

const common = {
  source: "synthetic",
  project: "demo",
  task: "synthetic-demo",
  session: "demo-session",
};
const events = [
  {
    actor: "demo-planner",
    action: "plan",
    status: "ok",
    target: "demo-coder",
    summary: "[synthetic] Planned the change and handed off",
  },
  {
    actor: "demo-coder",
    action: "edit",
    status: "ok",
    parent: "demo-planner",
    summary: "[synthetic] Edited two files",
    files: [
      { path: "src/example.ts", change: "modified" },
      { path: "src/example.test.ts", change: "added" },
    ],
  },
  {
    actor: "demo-reviewer",
    action: "review",
    status: "ok",
    verdict: "needs-fixes",
    summary: "[synthetic] One finding",
    issues: [
      {
        severity: "medium",
        path: "src/example.ts",
        line: 12,
        description: "Missing null check",
      },
    ],
  },
  {
    actor: "demo-coder",
    action: "test",
    status: "ok",
    summary: "[synthetic] Reported a test run",
    checks: [
      {
        name: "unit tests",
        result: "pass",
        evidence: "reported",
        command: "npm test",
      },
    ],
  },
].map((event) => ({ ...common, ...event }));

const response = await fetch(`${base}/ingest`, {
  method: "POST",
  headers,
  body: JSON.stringify({ events }),
});
console.log(response.status, await response.text());
if (!response.ok) process.exit(1);
