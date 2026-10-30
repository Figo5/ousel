import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
// The directly runnable zero-dependency hook intentionally ships as JavaScript.
// @ts-expect-error No declaration file for the standalone .mjs entry point.
import * as capture from "../integrations/claude-code/hook.mjs";
const { mapHook, isValidationCommand } = capture;
import {
  HOOK_EVENTS,
  HOOK_PATH,
  hookCommand,
  mergeSettings,
} from "../src/cli/connect.js";

const env = {
  OUSEL_PROJECT: "demo",
  OUSEL_TASK: "integration",
  OUSEL_ACTOR: "main",
};
const payload = (name: string, extra = {}) => ({
  hook_event_name: name,
  session_id: "session-1",
  ...extra,
});
const run = (args: string[], input = "", extraEnv = {}, shell = false) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, args, {
        env: { ...process.env, ...extraEnv },
        shell,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (s) => {
        stdout += s;
      });
      child.stderr.on("data", (s) => {
        stderr += s;
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    },
  );

async function viewer(status = 200, stall = false) {
  const posts: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    if (stall) return;
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/health") {
      res.end(
        JSON.stringify({
          ok: true,
          version: "3.0.0-fixture",
          latestId: posts.length,
          total: posts.length,
        }),
      );
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    posts.push(JSON.parse(body));
    res.statusCode = status;
    res.end(
      JSON.stringify({
        accepted: status === 200 ? 1 : 0,
        rejected: status === 200 ? [] : [{ reason: "fixture rejection" }],
        latestId: posts.length,
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, posts, url: `http://127.0.0.1:${address.port}` };
}
const close = async (server: Server) => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
};

// Transport simulation supplements, but never substitutes for, the TCP tests.
// It lets a restricted sandbox exercise the real CLI and filesystem operations.
function simulatedTransport(record: string, status = 200, healthOk = true) {
  const code = `
    import { appendFileSync } from 'node:fs';
    globalThis.fetch = async (url, options = {}) => {
      appendFileSync(${JSON.stringify(record)}, JSON.stringify({url, method: options.method ?? 'GET', headers: options.headers, event: options.body ? JSON.parse(options.body) : undefined}) + '\\n');
      const health = String(url).endsWith('/api/health');
      return new Response(JSON.stringify(health ? {ok: ${healthOk}, version: '3.0.0-simulated', latestId: 0, total: 0} : {accepted: ${status === 200 ? 1 : 0}, rejected: ${status === 200 ? "[]" : '[{reason:"fixture rejection"}]'}, latestId: 1}), {status: health ? 200 : ${status}});
    };
  `;
  return `data:text/javascript,${encodeURIComponent(code)}`;
}

test("simulated transport: runnable hooks, atomic CLI writes, idempotence, dry-run, removal, and reporter", async () => {
  const project = await mkdtemp(path.join(tmpdir(), "ousel-simulated-"));
  const record = path.join(project, "requests.jsonl");
  const preload = ["--import", simulatedTransport(record)];
  const url = "http://127.0.0.1:4317";
  try {
    const common = {
      session_id: "fixture-session",
      transcript_path: "/not/read/transcript.jsonl",
      cwd: project,
      permission_mode: "default",
    };
    for (const extra of [
      { hook_event_name: "SessionStart", source: "startup" },
      {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "npm run check" },
        tool_response: {
          stdout: "not transmitted",
          stderr: "",
          interrupted: false,
        },
        tool_use_id: "toolu_fixture",
        duration_ms: 42,
      },
      {
        hook_event_name: "Stop",
        stop_hook_active: false,
        last_assistant_message: "not transmitted",
      },
    ]) {
      assert.deepEqual(
        await run(
          [...preload, HOOK_PATH],
          JSON.stringify({ ...common, ...extra }),
          {
            OUSEL_URL: url,
            OUSEL_PROJECT: "fixture-project",
            OUSEL_TASK: "integration",
            OUSEL_ACTOR: "claude-code",
          },
        ),
        { code: 0, stdout: "", stderr: "" },
      );
    }
    await mkdir(path.join(project, ".claude"));
    const settingsPath = path.join(project, ".claude/settings.json");
    const original = {
      permissions: { allow: ["Read"] },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo keep" }] }] },
    };
    await writeFile(settingsPath, JSON.stringify(original));
    const args = [
      ...preload,
      "--import",
      "tsx",
      "src/cli/connect.ts",
      "--project",
      project,
      "--task",
      "integration",
      "--url",
      url,
    ];
    const installed = await run(args);
    assert.equal(installed.code, 0, installed.stderr);
    const json = await readFile(settingsPath, "utf8");
    assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
    assert.equal((await run(args)).code, 0);
    assert.equal(await readFile(settingsPath, "utf8"), json);
    const requests = (await readFile(record, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const events = requests
      .filter((r) => r.method === "POST")
      .map((r) => r.event);
    assert.deepEqual(
      events.map((e) => e.action),
      [
        "session_start",
        "tool_completed",
        "turn_complete",
        "integration_connected",
        "integration_connected",
      ],
    );
    assert.equal(events[3].source, "reported");
    assert.equal(requests[3].url, `${url}/api/health`);
    assert.equal(requests[0].headers["content-type"], "application/json");
    if (process.env.OUSEL_EVIDENCE === "1") {
      console.log(
        "SIMULATED_HOOK_POSTS (fetch stub, not HTTP)\n" +
          JSON.stringify(events.slice(0, 3), null, 2),
      );
      console.log("SIMULATED_CONNECT_OUTPUT\n" + installed.stdout);
      console.log("SIMULATED_SETTINGS_JSON\n" + json);
    }
    const dry = await run([...args, "--remove", "--dry-run"]);
    assert.equal(dry.code, 0);
    assert.deepEqual(JSON.parse(dry.stdout), original);
    assert.equal(await readFile(settingsPath, "utf8"), json);
    assert.equal((await run([...args, "--remove"])).code, 0);
    assert.deepEqual(
      JSON.parse(await readFile(settingsPath, "utf8")),
      original,
    );
    const reportArgs = [
      ...preload,
      "skills/ousel/scripts/report.mjs",
      "--url",
      url,
      "--actor",
      "reviewer",
      "--action",
      "review",
      "--summary",
      "Actual fixture validation",
      "--status",
      "ok",
      "--verdict",
      "approve",
      "--session",
      "s",
      "--target",
      "author",
      "--parent",
      "lead",
      "--project",
      "fixture-project",
      "--task",
      "integration",
    ];
    assert.deepEqual(await run(reportArgs), {
      code: 0,
      stdout: "",
      stderr: "",
    });
    const reports = (await readFile(record, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(reports.at(-1).event.source, "reported");
    assert.equal(reports.at(-1).event.target, "author");
    assert.deepEqual(
      await run([
        ...preload,
        "skills/ousel/scripts/report.mjs",
        "--url",
        url,
        "--health",
      ]),
      { code: 0, stdout: "reachable\n", stderr: "" },
    );
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("simulated transport: failed health writes nothing and 207/400 are reported honestly", async () => {
  const project = await mkdtemp(path.join(tmpdir(), "ousel-simulated-fail-"));
  try {
    const record = path.join(project, "requests.jsonl");
    const args = [
      "--import",
      "tsx",
      "src/cli/connect.ts",
      "--project",
      project,
      "--task",
      "integration",
    ];
    const failed = await run([
      "--import",
      simulatedTransport(record, 200, false),
      ...args,
    ]);
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /npm start/);
    await assert.rejects(stat(path.join(project, ".claude")));
    for (const status of [207, 400]) {
      const result = await run([
        "--import",
        simulatedTransport(record, status),
        ...args,
      ]);
      assert.equal(result.code, 1);
      assert.match(result.stdout, new RegExp(`HTTP ${status}`));
      assert.match(result.stderr, /Settings written/);
      assert.deepEqual(
        await run(
          ["--import", simulatedTransport(record, status), HOOK_PATH],
          JSON.stringify(payload("Stop")),
        ),
        { code: 0, stdout: "", stderr: "" },
      );
      const report = await run([
        "--import",
        simulatedTransport(record, status),
        "skills/ousel/scripts/report.mjs",
        "--actor",
        "reviewer",
        "--action",
        "review",
      ]);
      assert.equal(report.code, 0);
      assert.match(report.stderr, /not delivered/);
    }
    const settingsPath = path.join(project, ".claude/settings.json");
    await writeFile(settingsPath, "{invalid");
    assert.equal(
      (await run(["--import", simulatedTransport(record), ...args])).code,
      1,
    );
    assert.equal(await readFile(settingsPath, "utf8"), "{invalid");
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("unavailable reporter and explicit health diagnostics have distinct exit codes", async () => {
  const args = [
    "skills/ousel/scripts/report.mjs",
    "--url",
    "http://127.0.0.1:1",
  ];
  const result = await run([...args, "--actor", "worker", "--action", "start"]);
  assert.equal(result.code, 0);
  assert.match(result.stderr, /continuing work/);
  assert.deepEqual(await run([...args, "--health"]), {
    code: 2,
    stdout: "unreachable\n",
    stderr: "",
  });
});

test("hook exits silently with stalled stdin", async () => {
  const started = Date.now();
  const result = await run([
    "-e",
    "const {spawn}=require('node:child_process');const p=spawn(process.execPath,[process.argv[1]],{stdio:['pipe','inherit','inherit']});p.on('exit',c=>process.exit(c));",
    HOOK_PATH,
  ]);
  assert.deepEqual(result, { code: 0, stdout: "", stderr: "" });
  assert.ok(Date.now() - started < 4000);
});

test("generated shell command preserves quotes and suppresses launcher errors", async () => {
  const project = await mkdtemp(path.join(tmpdir(), "ousel-quoted-"));
  try {
    const capture = path.join(project, "capture.mjs");
    const record = path.join(project, "env.json");
    await writeFile(
      capture,
      `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(record)}, JSON.stringify({project:process.env.OUSEL_PROJECT,task:process.env.OUSEL_TASK}));`,
    );
    const identity = "/tmp/project ' $(exit 99) `exit 98`";
    const runShell = (command: string) =>
      run([
        "-e",
        "const {spawn}=require('node:child_process');const p=spawn('/bin/sh',['-c',process.argv[1]],{stdio:'inherit'});p.on('exit',c=>process.exit(c));",
        command,
      ]);
    assert.deepEqual(
      await runShell(
        hookCommand(
          identity,
          "task ' quoted",
          "http://127.0.0.1:4317",
          capture,
        ),
      ),
      { code: 0, stdout: "", stderr: "" },
    );
    assert.deepEqual(JSON.parse(await readFile(record, "utf8")), {
      project: identity,
      task: "task ' quoted",
    });
    assert.deepEqual(
      await runShell(
        hookCommand(
          identity,
          "task",
          "http://127.0.0.1:4317",
          "/missing/hook.mjs",
        ),
      ),
      { code: 0, stdout: "", stderr: "" },
    );
    const quotedPath = "/tmp/it's a hook.mjs";
    const settings = mergeSettings(
      {},
      hookCommand(identity, "task", "http://127.0.0.1:4317", quotedPath),
      quotedPath,
    );
    assert.deepEqual(mergeSettings(settings, "", quotedPath, true), {
      hooks: {},
    });
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
let networkSkip: string | false = false;
try {
  const probe = await viewer();
  await close(probe.server);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  networkSkip =
    "Sandbox denies loopback listeners (listen EPERM); requires a network-enabled test environment";
}

for (const [name, action, status, summary] of [
  ["SessionStart", "session_start", "running", "Claude Code session started"],
  [
    "UserPromptSubmit",
    "prompt_submitted",
    "running",
    "Prompt submitted (6 chars)",
  ],
  ["PostToolUse", "tool_completed", "ok", "Bash completed"],
  ["PostToolUseFailure", "tool_failed", "error", "Bash failed"],
  ["SubagentStart", "subagent_start", "running", "Subagent Explore started"],
  ["SubagentStop", "subagent_stop", "ok", "Subagent Explore stopped"],
  ["Stop", "turn_complete", "ok", "Claude Code finished responding"],
  ["SessionEnd", "session_end", "ok", "Claude Code session ended"],
]) {
  test(`maps ${name}`, () => {
    const result = mapHook(
      payload(name!, {
        prompt: "hello!",
        tool_name: "Bash",
        tool_input: { command: "npm test" },
        agent_id: "agent-1",
        agent_type: "Explore",
        duration_ms: 42,
      }),
      env,
    );
    assert.equal(result.action, action);
    assert.equal(result.status, status);
    assert.equal(result.summary, summary);
    assert.equal(result.source, "captured");
    assert.equal(result.provider, "claude");
    assert.equal(result.project, "demo");
    assert.equal(result.task, "integration");
    if (name!.startsWith("Subagent")) {
      assert.equal(result.actor, "claude:Explore");
      assert.equal(result.session, "agent-1");
      assert.equal(result.parent, "main");
    } else {
      assert.equal(result.session, "session-1");
      assert.equal(result.actor, "main");
    }
    if (name!.startsWith("PostToolUse")) {
      assert.deepEqual(result.checks, [
        {
          name: "npm test",
          result: status === "ok" ? "passed" : "failed",
          evidence: "captured",
          command: "npm test",
          durationMs: 42,
        },
      ]);
    }
  });
}

test("never leaks prompts, assistant messages, errors, file contents, or tool output", () => {
  for (const name of HOOK_EVENTS) {
    const result = mapHook(
      payload(name, {
        prompt: "PRIVATE_PROMPT",
        last_assistant_message: "PRIVATE_ASSISTANT",
        error: "PRIVATE_ERROR",
        tool_name: "Write",
        tool_input: { file_path: "src/a.ts", content: "PRIVATE_FILE" },
        tool_response: { stdout: "PRIVATE_STDOUT", stderr: "PRIVATE_STDERR" },
        agent_id: "agent-1",
        agent_type: "Explore",
        transcript_path: "PRIVATE_TRANSCRIPT",
      }),
    );
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
  }
});

test("file tools expose paths only and failed edits do not claim changes", () => {
  for (const tool of ["Read", "Edit", "Write", "NotebookEdit"]) {
    const extra = {
      tool_name: tool,
      tool_input: {
        file_path: "src/a.ts",
        notebook_path: "notes.ipynb",
        content: "private",
      },
    };
    const event = mapHook(payload("PostToolUse", extra));
    assert.equal(
      event.detail.path,
      tool === "NotebookEdit" ? "notes.ipynb" : "src/a.ts",
    );
    assert.equal(
      event.files?.[0]?.change,
      tool === "Read" ? undefined : "modified",
    );
    assert.equal(
      mapHook(payload("PostToolUseFailure", extra)).files,
      undefined,
    );
  }
});

test("validation detection does not turn mentions or background starts into evidence", () => {
  for (const command of [
    "npm test",
    "npm run check",
    "pnpm run typecheck",
    "yarn lint",
    "npx vitest run",
    "tsc --noEmit",
    "node --import tsx --test tests/a.ts",
    "cd app && npm run build",
    "CI=1 npm test",
  ])
    assert.ok(isValidationCommand(command), command);
  for (const command of [
    'echo "npm test"',
    "cat test.txt",
    "git diff --check",
    "npm install",
    "npm test || true",
    "npm test; echo done",
    "node -e 'code' --test",
    "echo hi && npm test",
    "npm test &",
    "npm test $(cat .env)",
  ])
    assert.equal(isValidationCommand(command), false, command);
  for (const extra of [
    { tool_input: { command: "npm test", run_in_background: true } },
    { tool_response: { backgroundTaskId: "id" } },
    { tool_response: { interrupted: true } },
  ]) {
    assert.equal(
      mapHook(
        payload("PostToolUse", {
          tool_name: "Bash",
          tool_input: { command: "npm test" },
          ...extra,
        }),
      ).checks,
      undefined,
    );
  }
});

test("secret-like commands are dropped locally before truncation", () => {
  for (const command of [
    "API_KEY=private npm test",
    "npm test --token private",
    "npm test --password='very private'",
    "npm test --header 'Authorization: Bearer private'",
    "npm test https://user:private@example.com",
    "npm test sk-veryprivate",
    `npm test ${"x".repeat(1200)} --secret private`,
  ]) {
    const result = mapHook(
      payload("PostToolUse", { tool_name: "Bash", tool_input: { command } }),
    );
    assert.equal(result.checks[0].command, "[redacted]");
    assert.doesNotMatch(JSON.stringify(result), /private/);
  }
});

test("caps strings and omits unavailable or invalid durations and identities", () => {
  const result = mapHook(
    payload("PostToolUse", {
      tool_name: "Write",
      tool_input: { file_path: "x".repeat(2000) },
      duration_ms: -1,
    }),
    { OUSEL_PROJECT: "p".repeat(300) },
  );
  assert.equal(result.actor, "claude-code");
  assert.equal(result.project.length, 200);
  assert.equal(result.files[0].path.length, 1000);
  assert.equal(result.detail.durationMs, undefined);
  for (const duration of [undefined, NaN, 1.5, -1, Infinity])
    assert.equal(
      mapHook(
        payload("PostToolUse", {
          tool_name: "Bash",
          tool_input: { command: "npm test" },
          duration_ms: duration,
        }),
      ).checks[0].durationMs,
      undefined,
    );
  for (const input of [
    null,
    [],
    1,
    {},
    payload("Unknown"),
    payload("SubagentStart"),
    payload("UserPromptSubmit"),
  ])
    assert.equal(mapHook(input), null);
});

test("settings merge is idempotent and preserves unrelated hooks and mixed groups", () => {
  const other = { type: "command", command: "echo unrelated" };
  const initial = {
    permissions: { allow: ["Read"] },
    model: "keep",
    hooks: {
      Stop: [
        {
          matcher: "",
          custom: true,
          hooks: [other, { type: "command", command: `node '${HOOK_PATH}'` }],
        },
      ],
      Notification: [{ hooks: [other] }],
    },
  };
  const before = structuredClone(initial);
  const command = hookCommand("/tmp/project", "task", "http://127.0.0.1:4317");
  const first = mergeSettings(initial, command);
  assert.deepEqual(mergeSettings(first, command), first);
  assert.deepEqual(initial, before);
  assert.deepEqual(first.permissions, initial.permissions);
  const hooks = first.hooks as typeof initial.hooks;
  assert.deepEqual(hooks.Stop[0], {
    matcher: "",
    custom: true,
    hooks: [other],
  });
  assert.deepEqual(hooks.Notification, initial.hooks.Notification);
  const removed = mergeSettings(first, command, HOOK_PATH, true);
  assert.deepEqual(removed, {
    ...initial,
    hooks: {
      Stop: [{ matcher: "", custom: true, hooks: [other] }],
      Notification: initial.hooks.Notification,
    },
  });
  assert.deepEqual(mergeSettings({}, command, HOOK_PATH, true), {});
  assert.throws(() => mergeSettings({ hooks: [] }, command));
  const similar = {
    hooks: {
      Stop: [
        { hooks: [{ type: "command", command: `node '${HOOK_PATH}.backup'` }] },
      ],
    },
  };
  assert.deepEqual(mergeSettings(similar, command, HOOK_PATH, true), similar);
});

test(
  "shell quoting preserves apostrophes and metacharacters without evaluation",
  { skip: networkSkip },
  async () => {
    const fake = await viewer();
    const project = "/tmp/a project ' $(exit 99) `exit 98`";
    try {
      const command = hookCommand(project, "task ' quoted", fake.url);
      const result = await run(
        [
          "-e",
          "const {spawn}=require('node:child_process'); const p=spawn('/bin/sh',['-c',process.argv[1]],{stdio:'inherit'});p.on('exit',c=>process.exit(c));",
          command,
        ],
        JSON.stringify(payload("SessionStart")),
      );
      assert.deepEqual(result, { code: 0, stdout: "", stderr: "" });
      assert.equal(fake.posts[0]?.project, project);
      assert.equal(fake.posts[0]?.task, "task ' quoted");
      const quotedPath = "/tmp/it's a hook.mjs";
      const settings = mergeSettings(
        {},
        hookCommand(project, "task", fake.url, quotedPath),
        quotedPath,
      );
      assert.deepEqual(mergeSettings(settings, "", quotedPath, true), {
        hooks: {},
      });
    } finally {
      await close(fake.server);
    }
  },
);

test("hook process silently exits zero for malformed, oversized, unknown, and refused input", async () => {
  const url = "http://127.0.0.1:1";
  for (const input of [
    "{",
    "x".repeat(1024 * 1024 + 1),
    JSON.stringify(payload("Unknown")),
    JSON.stringify(payload("SessionStart")),
  ]) {
    assert.deepEqual(await run([HOOK_PATH], input, { OUSEL_URL: url }), {
      code: 0,
      stdout: "",
      stderr: "",
    });
  }
});

test(
  "hook HTTP timeout and stalled stdin have bounded silent exits",
  { skip: networkSkip },
  async () => {
    const fake = await viewer(200, true);
    try {
      const started = Date.now();
      assert.deepEqual(
        await run([HOOK_PATH], JSON.stringify(payload("SessionStart")), {
          OUSEL_URL: fake.url,
        }),
        { code: 0, stdout: "", stderr: "" },
      );
      assert.ok(Date.now() - started < 4000);
      const result = await run([
        "-e",
        "const {spawn}=require('node:child_process');const p=spawn(process.execPath,[process.argv[1]],{stdio:['pipe','inherit','inherit']});p.on('exit',c=>process.exit(c));",
        HOOK_PATH,
      ]);
      assert.deepEqual(result, { code: 0, stdout: "", stderr: "" });
    } finally {
      await close(fake.server);
    }
  },
);

test(
  "end-to-end hook fixtures and connect settings (evidence mode prints observations)",
  { skip: networkSkip },
  async () => {
    const fake = await viewer();
    const project = await mkdtemp(path.join(tmpdir(), "ousel-integration-"));
    try {
      const common = {
        session_id: "fixture-session",
        transcript_path: "/not/read/transcript.jsonl",
        cwd: project,
        permission_mode: "default",
      };
      for (const extra of [
        {
          hook_event_name: "SessionStart",
          source: "startup",
          model: "fixture-model",
        },
        {
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_input: { command: "npm run check", description: "Validate" },
          tool_response: {
            stdout: "not transmitted",
            stderr: "",
            interrupted: false,
          },
          tool_use_id: "toolu_fixture",
          duration_ms: 42,
        },
        {
          hook_event_name: "Stop",
          stop_hook_active: false,
          last_assistant_message: "not transmitted",
        },
      ]) {
        assert.deepEqual(
          await run([HOOK_PATH], JSON.stringify({ ...common, ...extra }), {
            OUSEL_URL: fake.url,
            OUSEL_PROJECT: "fixture-project",
            OUSEL_TASK: "integration",
            OUSEL_ACTOR: "claude-code",
          }),
          { code: 0, stdout: "", stderr: "" },
        );
      }
      assert.equal(fake.posts.length, 3);
      assert.deepEqual(
        fake.posts.map((p) => p.action),
        ["session_start", "tool_completed", "turn_complete"],
      );
      const args = [
        "--import",
        "tsx",
        "src/cli/connect.ts",
        "--project",
        project,
        "--task",
        "integration",
        "--url",
        fake.url,
      ];
      const connected = await run(args);
      assert.equal(connected.code, 0, connected.stderr);
      const settingsPath = path.join(project, ".claude/settings.json");
      const json = await readFile(settingsPath, "utf8");
      assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
      const settings = JSON.parse(json);
      for (const event of HOOK_EVENTS) {
        const handler = settings.hooks[event][0].hooks[0];
        assert.equal(handler.timeout, 5);
        assert.equal(handler.onFailure, "continue");
        assert.equal(handler.async, true);
      }
      assert.equal(fake.posts[3]?.source, "reported");
      assert.equal(fake.posts[3]?.action, "integration_connected");
      if (process.env.OUSEL_EVIDENCE === "1") {
        console.log(
          "HOOK_POSTS " + JSON.stringify(fake.posts.slice(0, 3), null, 2),
        );
        console.log("CONNECT_OUTPUT\n" + connected.stdout);
        console.log("SETTINGS_JSON\n" + json);
        console.log("CONNECT_POST " + JSON.stringify(fake.posts[3], null, 2));
      }
      assert.equal((await run(args)).code, 0);
      assert.equal(await readFile(settingsPath, "utf8"), json);
      const count = fake.posts.length;
      const dry = await run([...args, "--remove", "--dry-run"]);
      assert.equal(dry.code, 0);
      assert.deepEqual(JSON.parse(dry.stdout), { hooks: {} });
      assert.equal(await readFile(settingsPath, "utf8"), json);
      assert.equal(fake.posts.length, count);
      assert.equal((await run([...args, "--remove"])).code, 0);
      assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
        hooks: {},
      });
      assert.equal(fake.posts.length, count);
    } finally {
      await close(fake.server);
      await rm(project, { recursive: true, force: true });
    }
  },
);

test(
  "connect refuses unavailable health and invalid settings without writes",
  { skip: networkSkip },
  async () => {
    const fake = await viewer();
    const project = await mkdtemp(path.join(tmpdir(), "ousel-invalid-"));
    const args = [
      "--import",
      "tsx",
      "src/cli/connect.ts",
      "--project",
      project,
      "--task",
      "test",
      "--url",
      fake.url,
    ];
    try {
      await mkdir(path.join(project, ".claude"));
      const settingsPath = path.join(project, ".claude/settings.json");
      await writeFile(settingsPath, "{invalid");
      assert.equal((await run(args)).code, 1);
      assert.equal(await readFile(settingsPath, "utf8"), "{invalid");
      await close(fake.server);
      const result = await run(args);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /npm start/);
      assert.equal(await readFile(settingsPath, "utf8"), "{invalid");
      await rm(path.join(project, ".claude"), { recursive: true });
      assert.equal((await run(args)).code, 1);
      await assert.rejects(stat(path.join(project, ".claude")));
    } finally {
      if (fake.server.listening) await close(fake.server);
      await rm(project, { recursive: true, force: true });
    }
  },
);

for (const status of [207, 400])
  test(
    `connect honestly reports HTTP ${status} after writing`,
    { skip: networkSkip },
    async () => {
      const fake = await viewer(status);
      const project = await mkdtemp(path.join(tmpdir(), "ousel-reject-"));
      try {
        const result = await run([
          "--import",
          "tsx",
          "src/cli/connect.ts",
          "--project",
          project,
          "--task",
          "test",
          "--url",
          fake.url,
        ]);
        assert.equal(result.code, 1);
        assert.match(result.stdout, new RegExp(`HTTP ${status}`));
        assert.match(result.stderr, /Settings written/);
        assert.ok(await stat(path.join(project, ".claude/settings.json")));
        assert.deepEqual(
          await run([HOOK_PATH], JSON.stringify(payload("Stop")), {
            OUSEL_URL: fake.url,
          }),
          { code: 0, stdout: "", stderr: "" },
        );
      } finally {
        await close(fake.server);
        await rm(project, { recursive: true, force: true });
      }
    },
  );

test(
  "report helper always reports claims and soft fails; health has its own exit code",
  { skip: networkSkip },
  async () => {
    const fake = await viewer();
    const script = "skills/ousel/scripts/report.mjs";
    const args = [
      script,
      "--url",
      fake.url,
      "--actor",
      "reviewer",
      "--action",
      "review",
      "--summary",
      "Review complete",
      "--status",
      "ok",
      "--verdict",
      "approve",
      "--session",
      "s",
      "--target",
      "author",
      "--parent",
      "lead",
      "--project",
      "demo",
      "--task",
      "integration",
    ];
    try {
      assert.deepEqual(await run(args), { code: 0, stdout: "", stderr: "" });
      assert.equal(fake.posts[0]?.source, "reported");
      assert.equal(fake.posts[0]?.target, "author");
      assert.equal(fake.posts[0]?.verdict, "approve");
      assert.deepEqual(await run([script, "--health", "--url", fake.url]), {
        code: 0,
        stdout: "reachable\n",
        stderr: "",
      });
      await close(fake.server);
      const down = await run(args);
      assert.equal(down.code, 0);
      assert.match(down.stderr, /continuing work/);
      assert.deepEqual(await run([script, "--health", "--url", fake.url]), {
        code: 2,
        stdout: "unreachable\n",
        stderr: "",
      });
    } finally {
      if (fake.server.listening) await close(fake.server);
    }
  },
);
