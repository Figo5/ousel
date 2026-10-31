/**
 * Client-side stream merging: the display window may be capped, but evidence
 * and unresolved states must not be silently forgotten.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeEvents } from "../src/ui/api.js";
import type { EventRecord } from "../src/core/events.js";

function event(id: number, extra: Partial<EventRecord> = {}): EventRecord {
  return {
    id,
    createdAt: new Date(1_700_000_000_000 + id).toISOString(),
    actor: `actor-${id}`,
    action: "tool_completed",
    session: "s",
    provider: null,
    target: null,
    parent: null,
    summary: null,
    status: null,
    verdict: null,
    issues: [],
    source: "captured",
    project: "p",
    task: "t",
    files: [],
    checks: [],
    detail: {},
    ...extra,
  };
}

test("routine events outside the cap are dropped, evidence is not", () => {
  const events = Array.from({ length: 50 }, (_, i) =>
    event(i + 1, { actor: "routine" }),
  );
  events[0] = event(1, { status: "blocked", summary: "old blocker" });
  events[1] = event(2, {
    checks: [
      {
        name: "npm test",
        result: "passed",
        evidence: "captured",
        command: "npm test",
        durationMs: 10,
      },
    ],
  });
  const merged = mergeEvents([], events, 10);
  assert.ok(
    merged.some((e) => e.id === 1),
    "old blocker retained",
  );
  assert.ok(
    merged.some((e) => e.id === 2),
    "old check retained",
  );
  assert.ok(
    merged.some((e) => e.id === 50),
    "newest retained",
  );
  assert.ok(!merged.some((e) => e.id === 20), "routine middle dropped");
});

test("replays do not duplicate ids", () => {
  const first = [event(1), event(2)];
  const merged = mergeEvents(first, [event(2), event(3)]);
  assert.deepEqual(
    merged.map((e) => e.id),
    [1, 2, 3],
  );
});

test("routine successful tool events do not defeat the retention cap", () => {
  const events = Array.from({ length: 100 }, (_, i) =>
    event(i + 1, { actor: "claude-code", status: "ok" }),
  );
  events[0] = event(1, { actor: "claude-code", status: "error" });
  const merged = mergeEvents([], events, 10);
  assert.ok(
    merged.some((e) => e.id === 1),
    "old error retained",
  );
  assert.ok(
    merged.some((e) => e.id === 100),
    "newest retained",
  );
  assert.ok(!merged.some((e) => e.id === 50), "routine ok dropped");
});

test("retention keeps an ok that resolved an earlier error", () => {
  const merged = mergeEvents(
    [],
    [
      event(1, { actor: "a", status: "error", session: "s" }),
      event(2, { actor: "a", status: "ok", session: "s" }),
      event(3, { actor: "a", status: "running", session: "s" }),
      event(4, { actor: "b", status: "ok", session: "s" }),
      event(5, { actor: "b", status: "ok", session: "s" }),
    ],
    2,
  );
  assert.deepEqual(
    merged.map((e) => e.id),
    [1, 2, 3, 4, 5],
  );
  assert.ok(
    merged.some((e) => e.id === 1),
    "error retained",
  );
  assert.ok(
    merged.some((e) => e.id === 2),
    "resolving ok retained",
  );
});

test("resolution evidence is scoped to its project and task", () => {
  const merged = mergeEvents(
    [],
    [
      event(1, { actor: "a", status: "error", project: "p", task: "a" }),
      event(2, { actor: "a", status: "ok", project: "p", task: "a" }),
      event(3, { actor: "a", status: "error", project: "p", task: "b" }),
      event(4, { actor: "a", status: "ok", project: "p", task: "b" }),
      event(5, { actor: "a", status: "ok", project: "p", task: "c" }),
      event(6, { actor: "a", status: "ok", project: "p", task: "c" }),
      event(7, { actor: "a", status: "ok", project: "p", task: "c" }),
      event(8, { actor: "a", status: "ok", project: "p", task: "c" }),
    ],
    2,
  );
  assert.ok(
    merged.some((e) => e.id === 2),
    "task A ok retained",
  );
  assert.ok(
    merged.some((e) => e.id === 4),
    "task B ok retained",
  );
});
