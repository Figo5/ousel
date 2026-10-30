/**
 * The HTTP surface: ingest, stream, guard.
 *
 * Each test runs a real server on an ephemeral port with an in-memory store.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { createApp } from "../src/server/app.js";

async function withServer(
  run: (base: string, app: ReturnType<typeof createApp>) => Promise<void>,
): Promise<void> {
  const app = createApp();
  const port = await app.listen(0);
  try {
    await run(`http://127.0.0.1:${port}`, app);
  } finally {
    await app.close();
  }
}

function post(
  base: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(`${base}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("an agent can report with no token and no handshake", async () => {
  await withServer(async (base, app) => {
    const response = await post(base, {
      actor: "claude-code",
      action: "hello",
    });
    assert.equal(response.status, 202);
    const body = (await response.json()) as { accepted: number };
    assert.equal(body.accepted, 1);
    assert.equal(app.store.count(), 1);
    assert.equal(app.store.list()[0]!.actor, "claude-code");
  });
});

test("a batch is accepted, and a partial batch reports exactly what failed", async () => {
  await withServer(async (base, app) => {
    const good = await post(base, {
      events: [
        { actor: "a", action: "one" },
        { actor: "b", action: "two" },
      ],
    });
    assert.equal(good.status, 202);
    assert.equal(app.store.count(), 2);

    const mixed = await post(base, {
      events: [{ actor: "c", action: "three" }, { action: "no actor" }],
    });
    // 207: the valid entry was stored and the invalid one is named.
    assert.equal(mixed.status, 207);
    const body = (await mixed.json()) as {
      accepted: number;
      rejected: { index: number; errors: string[] }[];
    };
    assert.equal(body.accepted, 1);
    assert.equal(body.rejected.length, 1);
    assert.equal(body.rejected[0]!.index, 1);
    assert.ok(body.rejected[0]!.errors.some((e) => e.includes("actor")));
    assert.equal(app.store.count(), 3);
  });
});

test("a wholly invalid request is a failure status, not a 2xx", async () => {
  await withServer(async (base, app) => {
    // A sender that only checks `response.ok` must not read "all of your
    // events were rejected" as success.
    const single = await post(base, { action: "no actor" });
    assert.equal(single.status, 400);
    const body = (await single.json()) as {
      accepted: number;
      rejected: { errors: string[] }[];
    };
    assert.equal(body.accepted, 0);
    assert.ok(body.rejected[0]!.errors.some((e) => e.includes("actor")));

    const allBad = await post(base, {
      events: [{ action: "x" }, { action: "y" }],
    });
    assert.equal(allBad.status, 400);
    assert.equal(app.store.count(), 0);
  });
});

test("an empty or oversized batch is refused", async () => {
  await withServer(async (base, app) => {
    assert.equal((await post(base, { events: [] })).status, 400);
    const huge = await post(base, {
      events: Array.from({ length: 101 }, () => ({ actor: "a", action: "b" })),
    });
    assert.equal(huge.status, 413);
    assert.equal(
      app.store.count(),
      0,
      "nothing from a refused batch is stored",
    );
  });
});

test("the guard refuses a cross-origin or cross-site post", async () => {
  await withServer(async (base, app) => {
    const crossOrigin = await post(
      base,
      { actor: "a", action: "b" },
      { origin: "https://evil.example" },
    );
    assert.equal(crossOrigin.status, 403);

    const crossSite = await post(
      base,
      { actor: "a", action: "b" },
      { "sec-fetch-site": "cross-site" },
    );
    assert.equal(crossSite.status, 403);
    assert.equal(app.store.count(), 0);
  });
});

test("the guard refuses an untrusted Host and a non-JSON body", async () => {
  await withServer(async (base, app) => {
    // `fetch` will not let a caller set Host, and Host is the check that stops
    // DNS rebinding, so this one goes over a raw socket.
    const port = Number(new URL(base).port);
    const body = '{"actor":"a","action":"b"}';
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(
          `POST /ingest HTTP/1.1\r\nHost: evil.example\r\n` +
            `Content-Type: application/json\r\n` +
            `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
        );
      });
      let text = "";
      socket.on("data", (chunk) => (text += chunk.toString()));
      socket.on("end", () => resolve(text));
      socket.on("error", reject);
    });
    assert.match(raw, /^HTTP\/1\.1 403/);
    assert.equal(app.store.count(), 0);

    const badType = await fetch(`${base}/ingest`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "actor=a",
    });
    assert.equal(badType.status, 415);
  });
});

test("bootstrap hands back the recent window and the cursor", async () => {
  await withServer(async (base) => {
    await post(base, { actor: "a", action: "one" });
    await post(base, { actor: "b", action: "two" });
    const payload = (await (await fetch(`${base}/api/bootstrap`)).json()) as {
      events: { actor: string }[];
      latestId: number;
      total: number;
      token: string;
    };
    assert.equal(payload.total, 2);
    assert.equal(payload.latestId, 2);
    assert.deepEqual(
      payload.events.map((e) => e.actor),
      ["a", "b"],
      "oldest first, so the client can fold in order",
    );
    assert.ok(payload.token.length > 0);
  });
});

test("bootstrap reports the Ousel version", async () => {
  await withServer(async (base) => {
    const payload = (await (await fetch(`${base}/api/bootstrap`)).json()) as {
      version: string;
    };
    assert.equal(payload.version, "3.0.0");
  });
});

test("health reports liveness, the cursor and the total", async () => {
  await withServer(async (base) => {
    const empty = await fetch(`${base}/api/health`);
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), {
      ok: true,
      version: "3.0.0",
      latestId: 0,
      total: 0,
    });
    await post(base, { actor: "a", action: "one" });
    await post(base, { actor: "b", action: "two" });
    const health = (await (await fetch(`${base}/api/health`)).json()) as {
      ok: boolean;
      latestId: number;
      total: number;
    };
    assert.equal(health.ok, true);
    assert.equal(health.latestId, 2);
    assert.equal(health.total, 2);
  });
});

test("health goes through the normal guard", async () => {
  await withServer(async (base) => {
    const crossSite = await fetch(`${base}/api/health`, {
      headers: { "sec-fetch-site": "cross-site" },
    });
    assert.equal(crossSite.status, 403);
  });
});

test("the v3 fields round-trip through ingest, the store and bootstrap", async () => {
  await withServer(async (base, app) => {
    const response = await post(base, {
      actor: "claude-code",
      action: "test",
      source: "captured",
      project: "ousel",
      task: "task-view",
      files: [{ path: "src/ui/App.tsx", change: "modified" }],
      checks: [
        {
          name: "npm test",
          result: "pass",
          evidence: "captured",
          command: "npm test",
          durationMs: 1234,
        },
      ],
    });
    assert.equal(response.status, 202);
    const stored = app.store.list()[0]!;
    assert.equal(stored.source, "captured");
    assert.equal(stored.project, "ousel");
    assert.equal(stored.task, "task-view");
    assert.equal(stored.files[0]!.path, "src/ui/App.tsx");
    assert.equal(stored.checks[0]!.durationMs, 1234);

    const payload = (await (await fetch(`${base}/api/bootstrap`)).json()) as {
      events: { source: string; checks: { evidence: string }[] }[];
    };
    assert.equal(payload.events[0]!.source, "captured");
    assert.equal(payload.events[0]!.checks[0]!.evidence, "captured");
  });
});

test("an event with no source is stored as reported", async () => {
  await withServer(async (base, app) => {
    await post(base, { actor: "a", action: "x" });
    assert.equal(app.store.list()[0]!.source, "reported");
  });
});

test("source inferred is refused with a reason", async () => {
  await withServer(async (base, app) => {
    const response = await post(base, {
      actor: "a",
      action: "x",
      source: "inferred",
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as {
      rejected: { errors: string[] }[];
    };
    assert.ok(body.rejected[0]!.errors.some((e) => e.includes("inferred")));
    assert.equal(app.store.count(), 0);
  });
});

test("the legacy token header is accepted alongside x-ousel-token", async () => {
  await withServer(async (base, app) => {
    // /ingest needs no token, so the header must simply never get in the way.
    for (const header of ["x-ousel-token", "x-agentops-token"]) {
      const response = await post(
        base,
        { actor: "a", action: "x" },
        { [header]: app.guard.token },
      );
      assert.equal(response.status, 202);
    }
  });
});

async function readStream(
  url: string,
  needle: string,
  forbidden: string[],
): Promise<string> {
  const response = await fetch(url);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + 3000;
  while (!buffer.includes(needle) && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  assert.ok(buffer.includes(needle), `stream never carried ${needle}`);
  for (const text of forbidden)
    assert.ok(!buffer.includes(text), `stream leaked ${text}`);
  return buffer;
}

test("project and task filters only stream that task", async () => {
  await withServer(async (base) => {
    await post(base, {
      actor: "other-project",
      action: "x",
      project: "p2",
      task: "t1",
    });
    await post(base, {
      actor: "other-task",
      action: "x",
      project: "p1",
      task: "t2",
    });
    await post(base, { actor: "legacy", action: "x" });
    await post(base, {
      actor: "wanted",
      action: "x",
      project: "p1",
      task: "t1",
    });

    await readStream(
      `${base}/api/events?project=p1&task=t1`,
      '"actor":"wanted"',
      ['"actor":"other-project"', '"actor":"other-task"', '"actor":"legacy"'],
    );
    await readStream(`${base}/api/events?project=p1`, '"actor":"other-task"', [
      '"actor":"other-project"',
      '"actor":"legacy"',
    ]);
  });
});

test("a filtered stream pages past a full window of unrelated events", async () => {
  await withServer(async (base, app) => {
    // The stream reads 200 rows at a time. If an entire first page is
    // filtered out, the pump must keep going instead of waiting forever.
    // Batches are capped at 100, so send three and check each was accepted.
    for (let start = 0; start < 205; start += 100) {
      const events = Array.from(
        { length: Math.min(100, 205 - start) },
        (_, offset) => ({
          actor: `other-${start + offset}`,
          action: "x",
          project: "p2",
          task: "other",
        }),
      );
      assert.equal((await post(base, { events })).status, 202);
    }
    assert.equal(app.store.count(), 205);
    assert.equal(
      (
        await post(base, {
          actor: "wanted",
          action: "x",
          project: "p1",
          task: "t1",
        })
      ).status,
      202,
    );
    await readStream(
      `${base}/api/events?project=p1&task=t1`,
      '"actor":"wanted"',
      ['"actor":"other-0"'],
    );
  });
});

test("filters combine with the session filter and the cursor", async () => {
  await withServer(async (base) => {
    await post(base, { actor: "old", action: "x", task: "t", session: "s" });
    await post(base, {
      actor: "wrong-session",
      action: "x",
      task: "t",
      session: "z",
    });
    await post(base, { actor: "new", action: "x", task: "t", session: "s" });
    await readStream(
      `${base}/api/events?task=t&session=s&afterId=1`,
      '"actor":"new"',
      ['"actor":"old"', '"actor":"wrong-session"'],
    );
  });
});

test("an over-long filter is a 400 rather than an open stream", async () => {
  await withServer(async (base) => {
    const response = await fetch(
      `${base}/api/events?project=${"p".repeat(201)}`,
    );
    assert.equal(response.status, 400);
  });
});

test("bootstrap can be scoped to a project and task", async () => {
  await withServer(async (base) => {
    await post(base, { actor: "a", action: "x", project: "p", task: "t1" });
    await post(base, { actor: "b", action: "x", project: "p", task: "t2" });
    const payload = (await (
      await fetch(`${base}/api/bootstrap?project=p&task=t2`)
    ).json()) as { events: { actor: string }[]; total: number };
    assert.deepEqual(
      payload.events.map((e) => e.actor),
      ["b"],
    );
    assert.equal(payload.total, 2, "the total is still the whole database");
  });
});

test("the stream replays from a cursor and then delivers live events", async () => {
  await withServer(async (base) => {
    await post(base, { actor: "first", action: "before" });
    const response = await fetch(`${base}/api/events?afterId=0`);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const readUntil = async (needle: string) => {
      const deadline = Date.now() + 5000;
      while (!buffer.includes(needle) && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
      assert.ok(buffer.includes(needle), `stream never carried ${needle}`);
    };

    await readUntil('"actor":"first"');
    await post(base, { actor: "second", action: "after" });
    await readUntil('"actor":"second"');
    // Each frame carries its id, which is what makes Last-Event-ID resumable.
    assert.match(buffer, /\nid: \d+\n/);
    await reader.cancel();
  });
});

test("a session filter only streams that session", async () => {
  await withServer(async (base) => {
    await post(base, { actor: "a", action: "x", session: "keep" });
    await post(base, { actor: "b", action: "y", session: "drop" });
    const response = await fetch(`${base}/api/events?session=keep`);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const deadline = Date.now() + 3000;
    while (!buffer.includes('"actor":"a"') && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    assert.ok(buffer.includes('"actor":"a"'));
    assert.ok(!buffer.includes('"actor":"b"'), "the other session is withheld");
    await reader.cancel();
  });
});

test("an unknown API route is a 404, not the client", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/nope`);
    assert.equal(response.status, 404);
    const body = (await response.json()) as { error: string };
    assert.ok(body.error.length > 0);
  });
});
