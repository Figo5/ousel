import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/server/app.js";

function runDemo(
  port: number,
): Promise<{ code: number | null; error: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../scripts/demo.mjs", import.meta.url)),
        "--fast",
      ],
      {
        env: { ...process.env, AGENTOPS_PORT: String(port) },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let error = "";
    child.stderr.on("data", (chunk) => (error += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, error }));
  });
}

test("the demo stores a labeled synthetic workflow through the real HTTP surface", async () => {
  const app = createApp();
  const port = await app.listen(0);
  try {
    const result = await runDemo(port);
    assert.equal(result.code, 0, result.error);
    const events = app.store.list();
    assert.equal(events.length, 10);
    assert.equal(new Set(events.map((event) => event.session)).size, 1);
    assert.equal(new Set(events.map((event) => event.actor)).size, 3);
    assert.ok(
      events.every(
        (event) =>
          event.session?.startsWith("demo-") &&
          event.summary?.startsWith("DEMO:") &&
          event.source === "synthetic" &&
          event.project === "demo" &&
          event.task === "sample-workflow",
      ),
    );
    assert.ok(events.some((event) => event.target === "demo-reviewer"));
    assert.ok(events.some((event) => event.verdict === "needs-fixes"));
    assert.ok(events.some((event) => event.verdict === "approve"));
  } finally {
    await app.close();
  }
});

test("the demo stops after the first rejected event", async () => {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.writeHead(403);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const result = await runDemo(address.port);
    assert.equal(result.code, 1);
    assert.match(result.error, /HTTP 403/);
    assert.equal(requests, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
