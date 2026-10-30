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
  const events = Array.from({ length: 50 }, (_, i) => event(i + 1));
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
