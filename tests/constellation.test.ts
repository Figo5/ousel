/**
 * The fold: stream in, field out. Pure, no DOM, no canvas.
 *
 * The canvas is only a projection of what `foldConstellation` returns, so the
 * facts it draws are asserted here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EventRecord } from "../src/core/events.js";
import {
  ACTIVITY_WINDOW_MS,
  CARD_LIMIT,
  EDGE_WINDOW_MS,
  STAR_RETENTION_MS,
  foldConstellation,
  starLayout,
} from "../src/ui/constellation.js";

const NOW = Date.parse("2026-10-15T12:00:00.000Z");

let nextId = 1;
function event(partial: Partial<EventRecord> & { actor: string }): EventRecord {
  return {
    id: nextId++,
    createdAt: new Date(NOW - 1_000).toISOString(),
    action: "step",
    session: null,
    provider: null,
    target: null,
    parent: null,
    summary: null,
    status: null,
    verdict: null,
    issues: [],
    source: "reported",
    project: null,
    task: null,
    files: [],
    checks: [],
    detail: {},
    ...partial,
  };
}

function ago(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

test("layout is deterministic and keeps actors apart", () => {
  const actors = ["planner", "implementer", "reviewer", "verifier"];
  const first = starLayout(actors);
  const second = starLayout([...actors].reverse());
  for (const actor of actors)
    assert.deepEqual(first.get(actor), second.get(actor));

  const points = actors.map((a) => first.get(a)!);
  for (const point of points) {
    assert.ok(point.x > 0 && point.x < 1, "inside the field horizontally");
    assert.ok(point.y > 0 && point.y < 1, "inside the field vertically");
  }
  for (let a = 0; a < points.length; a += 1)
    for (let b = a + 1; b < points.length; b += 1)
      assert.ok(
        Math.hypot(points[a]!.x - points[b]!.x, points[a]!.y - points[b]!.y) >
          0.1,
        "no two actors land on top of each other",
      );
});

test("two colliding names are still separated", () => {
  // Deliberately many actors in a small field: the relaxation pass has to run.
  const actors = Array.from({ length: 12 }, (_, i) => `agent-${i}`);
  const layout = starLayout(actors);
  const points = actors.map((a) => layout.get(a)!);
  for (let a = 0; a < points.length; a += 1)
    for (let b = a + 1; b < points.length; b += 1)
      assert.ok(
        Math.hypot(points[a]!.x - points[b]!.x, points[a]!.y - points[b]!.y) >
          0.02,
        `${actors[a]} and ${actors[b]} overlap`,
      );
});

test("an actor appears from its first event, with no registration", () => {
  const state = foldConstellation({
    events: [event({ actor: "claude-code", action: "hello" })],
    now: NOW,
  });
  assert.equal(state.stars.length, 1);
  assert.equal(state.stars[0]!.actor, "claude-code");
  assert.equal(state.stars[0]!.lastAction, "hello");
  assert.deepEqual(state.stars[0]!.x > 0, true);
});

test("activity fades on recency and a running actor stays lit", () => {
  const half = foldConstellation({
    events: [event({ actor: "a", createdAt: ago(ACTIVITY_WINDOW_MS / 2) })],
    now: NOW,
  });
  assert.ok(half.stars[0]!.activity > 0.4 && half.stars[0]!.activity < 0.6);

  const cold = foldConstellation({
    events: [event({ actor: "a", createdAt: ago(ACTIVITY_WINDOW_MS + 1) })],
    now: NOW,
  });
  assert.equal(cold.stars[0]!.activity, 0);

  // Still running: lit however long it has been going.
  const working = foldConstellation({
    events: [
      event({
        actor: "a",
        status: "running",
        createdAt: ago(ACTIVITY_WINDOW_MS * 5),
      }),
    ],
    now: NOW,
  });
  assert.equal(working.stars[0]!.activity, 1);
  assert.equal(working.stars[0]!.live, true);
  assert.equal(working.liveActors, 1);
});

test("an actor leaves the field once it is older than the retention window", () => {
  const state = foldConstellation({
    events: [event({ actor: "a", createdAt: ago(STAR_RETENTION_MS + 1000) })],
    now: NOW,
  });
  assert.deepEqual(state.stars, []);
});

test("parent and target draw reported edges; order draws a weaker one", () => {
  const state = foldConstellation({
    events: [
      event({ actor: "sub", parent: "orchestrator", session: "s1" }),
      event({ actor: "sub", target: "reviewer", session: "s1" }),
      event({ actor: "reviewer", session: "s1" }),
      event({ actor: "writer", session: "s1" }),
    ],
    now: NOW,
  });
  const drawn = state.edges.map((e) => `${e.from}>${e.to}:${e.kind}`).sort();
  assert.deepEqual(drawn, [
    "orchestrator>sub:spawn",
    "reviewer>writer:sequence",
    "sub>reviewer:handoff",
  ]);
  // One line per pair: a reported handoff must not also be drawn as the
  // weaker edge that ordering alone would have inferred.
  const pairs = state.edges.map((e) => `${e.from}>${e.to}`);
  assert.equal(new Set(pairs).size, pairs.length, "no pair is drawn twice");
});

test("a reported edge is preferred over one derived from ordering", () => {
  const state = foldConstellation({
    events: [
      event({ actor: "a", session: "s1" }),
      event({ actor: "b", session: "s1", target: "c" }),
    ],
    now: NOW,
  });
  // b named a target, so no `sequence` edge is invented from a -> b.
  assert.deepEqual(
    state.edges.map((e) => `${e.from}>${e.to}:${e.kind}`),
    ["b>c:handoff"],
  );
});

test("edges age out of their window", () => {
  const events = [
    event({ actor: "a", session: "s1", createdAt: ago(EDGE_WINDOW_MS + 1) }),
    event({
      actor: "b",
      session: "s1",
      parent: "a",
      createdAt: ago(EDGE_WINDOW_MS + 1),
    }),
  ];
  assert.deepEqual(foldConstellation({ events, now: NOW }).edges, []);
});

test("a verdict becomes a card carrying the sender's own summary", () => {
  const state = foldConstellation({
    events: [
      event({
        actor: "reviewer",
        action: "review",
        provider: "openai",
        session: "s1",
        verdict: "needs-fixes",
        summary: "Error message leaks the path",
        issues: [
          {
            description: "Unbounded read",
            severity: "major",
            path: "a.ts",
            line: 42,
          },
        ],
      }),
    ],
    now: NOW,
  });
  assert.equal(state.cards.length, 1);
  const card = state.cards[0]!;
  assert.equal(card.summary, "Error message leaks the path");
  assert.equal(card.verdict, "needs-fixes");
  assert.equal(card.tone, "warn");
  assert.equal(card.issues[0]!.line, 42);
  assert.equal(state.flares.length, 1);
  assert.equal(state.flares[0]!.actor, "reviewer");
});

test("ordinary steps do not become cards", () => {
  const state = foldConstellation({
    events: [
      event({ actor: "a", action: "tool_call", summary: "ran grep" }),
      event({ actor: "a", action: "tool_call", status: "ok" }),
    ],
    now: NOW,
  });
  assert.deepEqual(state.cards, []);
  assert.equal(state.stars.length, 1);
});

test("a blocker waits until something in its session moves on", () => {
  const blocked = foldConstellation({
    events: [
      event({
        actor: "agent",
        session: "s1",
        status: "blocked",
        summary: "Needs a decision on the schema",
      }),
    ],
    now: NOW,
  });
  assert.equal(blocked.cards[0]!.awaitingYou, true);

  const answered = foldConstellation({
    events: [
      event({ actor: "agent", session: "s1", status: "blocked", summary: "?" }),
      event({
        actor: "operator",
        action: "reply",
        session: "s1",
        status: "ok",
      }),
    ],
    now: NOW,
  });
  assert.equal(
    answered.cards.find((c) => c.actor === "agent")!.awaitingYou,
    false,
    "a later event in the session resolves the blocker",
  );
});

test("only the newest blocker of a session is the one waiting", () => {
  const state = foldConstellation({
    events: [
      event({ actor: "a", session: "s1", status: "error", summary: "first" }),
      event({ actor: "a", session: "s1", status: "error", summary: "second" }),
    ],
    now: NOW,
  });
  assert.equal(state.cards[0]!.summary, "second");
  assert.equal(state.cards[0]!.awaitingYou, true);
  assert.equal(state.cards[1]!.awaitingYou, false);
});

test("sessions are summarized and can filter the fold", () => {
  const events = [
    event({ actor: "a", session: "s1", provider: "claude", status: "running" }),
    event({ actor: "b", session: "s1", provider: "openai" }),
    event({ actor: "c", session: "s2", provider: "google" }),
  ];
  const all = foldConstellation({ events, now: NOW });
  assert.equal(all.stars.length, 3);
  const first = all.sessions.find((s) => s.session === "s1")!;
  assert.equal(first.actors, 2);
  assert.equal(first.events, 2);
  assert.deepEqual(first.providers, ["claude", "openai"]);
  assert.equal(first.live, true);

  const scoped = foldConstellation({ events, now: NOW, session: "s2" });
  assert.deepEqual(
    scoped.stars.map((s) => s.actor),
    ["c"],
  );
});

test("a later event fills in what an earlier minimal one omitted", () => {
  const state = foldConstellation({
    events: [
      event({ actor: "a", createdAt: ago(5000) }),
      event({
        actor: "a",
        provider: "opencode",
        session: "s1",
        status: "running",
        createdAt: ago(1000),
      }),
    ],
    now: NOW,
  });
  assert.equal(state.stars[0]!.provider, "opencode");
  assert.equal(state.stars[0]!.session, "s1");
  assert.equal(state.stars[0]!.events, 2);
});

test("the column is capped and keeps the newest", () => {
  const events = Array.from({ length: CARD_LIMIT + 6 }, (_, index) =>
    event({ actor: "r", verdict: "approve", summary: `verdict ${index}` }),
  );
  const state = foldConstellation({ events, now: NOW });
  assert.equal(state.cards.length, CARD_LIMIT);
  assert.equal(state.cards[0]!.summary, `verdict ${CARD_LIMIT + 5}`);
});

test("an empty stream is an empty field", () => {
  const state = foldConstellation({ events: [], now: NOW });
  assert.deepEqual(state.stars, []);
  assert.deepEqual(state.edges, []);
  assert.deepEqual(state.cards, []);
  assert.deepEqual(state.sessions, []);
  assert.equal(state.liveActors, 0);
});
