/**
 * The task fold: identities, handoffs, decisions, evidence and attention.
 *
 * Pure, so every claim the task view makes is asserted here in Node.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EventRecord } from "../src/core/events.js";
import {
  QUIET_AFTER_MS,
  QUIET_LABEL,
  UNASSIGNED,
  attentionItems,
  checkPassed,
  foldTaskView,
  formatDuration,
  isApprovalVerdict,
  isNegativeVerdict,
  listTasks,
  pickTask,
  relativeTime,
  shortSession,
  sourceHint,
  sourceLabel,
} from "../src/ui/taskview.js";

const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const P = "ousel";
const T = "task-view";

let nextId = 1;
function ago(ms: number): string {
  return new Date(NOW - ms).toISOString();
}
function event(partial: Partial<EventRecord> & { actor: string }): EventRecord {
  return {
    id: nextId++,
    createdAt: ago(1_000),
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
    project: P,
    task: T,
    files: [],
    checks: [],
    detail: {},
    ...partial,
  };
}
const fold = (events: EventRecord[]) => foldTaskView(events, P, T, NOW);
const titles = (events: EventRecord[]) =>
  attentionItems(fold(events), NOW).map((item) => item.title);

test("legacy events share the unassigned task", () => {
  const legacy = event({ actor: "a", project: null, task: null });
  const view = foldTaskView([legacy], UNASSIGNED, UNASSIGNED, NOW);
  assert.equal(view.activityCount, 1);
  assert.equal(fold([legacy]).activityCount, 0);
  assert.deepEqual(
    listTasks([legacy]).map((ref) => [ref.project, ref.task]),
    [[UNASSIGNED, UNASSIGNED]],
  );
});

test("the fold only includes the selected project and task, in order", () => {
  const late = event({ actor: "b", id: 50 });
  const early = event({ actor: "a", id: 49 });
  const other = event({ actor: "x", task: "other" });
  const view = fold([late, other, early]);
  assert.deepEqual(
    view.events.map((e) => e.actor),
    ["a", "b"],
  );
  assert.equal(view.lastReported?.actor, "b");
});

test("an empty fold has no last report and no attention", () => {
  const view = fold([]);
  assert.equal(view.lastReported, null);
  assert.equal(view.activityCount, 0);
  assert.deepEqual(attentionItems(view, NOW), []);
});

test("listTasks orders by most recent activity and counts events", () => {
  const refs = listTasks([
    event({ actor: "a", task: "old" }),
    event({ actor: "a", task: "new" }),
    event({ actor: "b", task: "old" }),
    event({ actor: "c", project: "other", task: "old" }),
  ]);
  assert.deepEqual(
    refs.map((ref) => `${ref.project}/${ref.task}:${ref.events}`),
    ["other/old:1", `${P}/old:2`, `${P}/new:1`],
  );
});

test("pickTask keeps a valid saved selection and falls back to the newest", () => {
  const refs = listTasks([
    event({ actor: "a", task: "one" }),
    event({ actor: "a", task: "two" }),
  ]);
  assert.deepEqual(pickTask(refs, { project: P, task: "one" }), {
    project: P,
    task: "one",
  });
  assert.deepEqual(pickTask(refs, { project: P, task: "gone" }), {
    project: P,
    task: "two",
  });
  assert.deepEqual(pickTask(refs, null), { project: P, task: "two" });
  assert.equal(pickTask([], { project: P, task: "one" }), null);
});

test("participants keep actor and session identities distinct", () => {
  const view = fold([
    event({ actor: "impl", session: "s1", source: "captured" }),
    event({ actor: "impl", session: "s2", summary: "second session" }),
    event({ actor: "reviewer", session: "s1" }),
  ]);
  const impl = view.participants.find((p) => p.actor === "impl")!;
  assert.deepEqual(impl.sessions, ["s1", "s2"]);
  assert.deepEqual(impl.sourceKinds, ["captured", "reported"]);
  assert.equal(impl.lastSummary, "second session");
  const reviewer = view.participants.find((p) => p.actor === "reviewer")!;
  assert.deepEqual(reviewer.sessions, ["s1"]);
  assert.equal(view.participants.length, 2);
});

test("a participant with no session has no session ids", () => {
  const view = fold([event({ actor: "solo" })]);
  assert.deepEqual(view.participants[0]!.sessions, []);
});

test("handoffs come only from explicit targets", () => {
  const view = fold([
    event({ actor: "impl", target: "reviewer", source: "captured" }),
    event({ actor: "reviewer", session: "s1" }),
    event({ actor: "sub", parent: "impl" }),
  ]);
  assert.equal(view.handoffs.length, 1);
  assert.deepEqual(
    { from: view.handoffs[0]!.from, to: view.handoffs[0]!.to },
    { from: "impl", to: "reviewer" },
  );
  assert.equal(view.handoffs[0]!.source, "captured");
});

test("reviewer decisions carry verdict, summary, issues and source", () => {
  const view = fold([
    event({ actor: "impl", summary: "no verdict here" }),
    event({
      actor: "reviewer",
      verdict: "needs-fixes",
      summary: "leaks a path",
      issues: [{ description: "leak", severity: null, path: null, line: null }],
    }),
  ]);
  assert.equal(view.reviewerDecisions.length, 1);
  const decision = view.reviewerDecisions[0]!;
  assert.equal(decision.actor, "reviewer");
  assert.equal(decision.verdict, "needs-fixes");
  assert.equal(decision.summary, "leaks a path");
  assert.equal(decision.issues.length, 1);
  assert.equal(decision.source, "reported");
});

test("checks are counted by evidence and files are flattened with their actor", () => {
  const view = fold([
    event({
      actor: "impl",
      files: [{ path: "a.ts", change: "added" }],
      checks: [
        {
          name: "npm test",
          result: "pass",
          evidence: "captured",
          command: "npm test",
          durationMs: 900,
        },
        {
          name: "manual",
          result: "pass",
          evidence: "reported",
          command: null,
          durationMs: null,
        },
      ],
    }),
    event({
      actor: "ci",
      checks: [
        {
          name: "lint",
          result: "fail",
          evidence: "captured",
          command: null,
          durationMs: null,
        },
      ],
    }),
  ]);
  assert.equal(view.capturedChecks, 1);
  assert.equal(view.capturedFailedChecks, 1);
  assert.equal(view.reportedChecks, 1);
  assert.equal(view.checks.length, 3);
  assert.equal(view.checks[0]!.actor, "impl");
  assert.equal(view.checks[0]!.durationMs, 900);
  assert.deepEqual(
    view.files.map((f) => [f.path, f.change, f.actor]),
    [["a.ts", "added", "impl"]],
  );
});

test("running and silent past ten minutes is quiet — and only that", () => {
  const view = fold([
    event({
      actor: "stale",
      status: "running",
      createdAt: ago(QUIET_AFTER_MS + 1000),
    }),
    event({ actor: "fresh", status: "running", createdAt: ago(60_000) }),
    event({
      actor: "finished",
      status: "ok",
      createdAt: ago(QUIET_AFTER_MS * 3),
    }),
  ]);
  const byActor = (name: string) =>
    view.participants.find((p) => p.actor === name)!;
  assert.equal(byActor("stale").quiet, true);
  assert.equal(byActor("stale").inferredQuiet, true);
  assert.equal(byActor("fresh").quiet, false);
  assert.equal(byActor("finished").quiet, false);
  // The recorded status is untouched: quiet does not rewrite it.
  assert.equal(byActor("stale").lastStatus, "running");
});

test("quiet is surfaced as inferred and low, never as blocked", () => {
  const items = attentionItems(
    fold([
      event({
        actor: "stale",
        status: "running",
        createdAt: ago(QUIET_AFTER_MS * 2),
      }),
    ]),
    NOW,
  );
  const quiet = items.find((item) => item.id === "quiet:stale")!;
  assert.equal(quiet.source, "inferred");
  assert.equal(quiet.tone, "low");
  assert.ok(quiet.title.includes(QUIET_LABEL));
  assert.ok(!items.some((item) => /blocked/i.test(item.title)));
  assert.ok(!items.some((item) => item.tone === "high"));
});

test("an explicit blocked status is a high item with its own source", () => {
  const items = attentionItems(
    fold([
      event({
        actor: "impl",
        session: "s1",
        status: "blocked",
        summary: "Need the schema decision",
        source: "captured",
      }),
    ]),
    NOW,
  );
  assert.equal(items.length >= 1, true);
  const blocked = items[0]!;
  assert.equal(blocked.tone, "high");
  assert.equal(blocked.source, "captured");
  assert.ok(blocked.title.includes("blocked"));
  assert.ok(blocked.detail.includes("Need the schema decision"));
  assert.ok(blocked.detail.includes("s1"));
});

test("a blocker clears when that actor and session reports progress", () => {
  const cleared = titles([
    event({ actor: "impl", session: "s1", status: "blocked" }),
    event({ actor: "impl", session: "s1", status: "running" }),
  ]);
  assert.ok(!cleared.some((t) => t.includes("blocked")));

  // Another actor's progress does not clear it.
  const stillBlocked = titles([
    event({ actor: "impl", session: "s1", status: "blocked" }),
    event({ actor: "other", session: "s1", status: "ok" }),
  ]);
  assert.ok(stillBlocked.some((t) => t.includes("impl reported blocked")));

  // Nor does the same actor's progress in a different session.
  const otherSession = titles([
    event({ actor: "impl", session: "s1", status: "blocked" }),
    event({ actor: "impl", session: "s2", status: "ok" }),
  ]);
  assert.ok(otherSession.some((t) => t.includes("impl reported blocked")));
});

test("an error stands until the same actor and session reports ok", () => {
  assert.ok(
    titles([
      event({ actor: "impl", session: "s1", status: "error", summary: "boom" }),
    ]).some((t) => t.includes("impl reported an error")),
  );
  assert.ok(
    !titles([
      event({ actor: "impl", session: "s1", status: "error" }),
      event({ actor: "impl", session: "s1", status: "ok" }),
    ]).some((t) => t.includes("error")),
  );
  assert.ok(
    titles([
      event({ actor: "impl", session: "s1", status: "error" }),
      event({ actor: "impl", session: "s2", status: "ok" }),
    ]).some((t) => t.includes("impl reported an error")),
  );
  assert.ok(
    titles([
      event({ actor: "impl", session: "s1", status: "error" }),
      event({ actor: "other", session: "s1", status: "ok" }),
    ]).some((t) => t.includes("impl reported an error")),
  );
});

test("a negative reviewer verdict is high until that reviewer approves", () => {
  for (const verdict of [
    "needs-fixes",
    "changes requested",
    "reject",
    "fail",
  ]) {
    const items = attentionItems(
      fold([event({ actor: "reviewer", verdict, summary: "see notes" })]),
      NOW,
    );
    const item = items.find((i) => i.id === "verdict:reviewer");
    assert.ok(item, `${verdict} should raise an item`);
    assert.equal(item.tone, "high");
  }
  const resolved = attentionItems(
    fold([
      event({ actor: "reviewer", verdict: "needs-fixes" }),
      event({ actor: "reviewer", verdict: "approve" }),
    ]),
    NOW,
  );
  assert.ok(!resolved.some((i) => i.id === "verdict:reviewer"));
});

test("approval without captured checks says a verdict is not test evidence", () => {
  const items = attentionItems(
    fold([event({ actor: "reviewer", verdict: "approve" })]),
    NOW,
  );
  const gap = items.find(
    (i) => i.title === "Review approved without captured validation",
  )!;
  assert.equal(gap.tone, "medium");
  assert.match(gap.detail, /not test evidence/);
  assert.match(gap.detail, /no passing captured check was recorded/);
});

test("reported checks do not satisfy the captured-validation gap", () => {
  const items = attentionItems(
    fold([
      event({
        actor: "impl",
        checks: [
          {
            name: "tests",
            result: "pass",
            evidence: "reported",
            command: null,
            durationMs: null,
          },
        ],
      }),
      event({ actor: "reviewer", verdict: "lgtm" }),
    ]),
    NOW,
  );
  const gap = items.find((i) => i.id === "approval-without-captured-checks")!;
  assert.ok(gap);
  assert.match(gap.detail, /1 check is reported but none were captured/);
});

test("approval with a captured check raises no validation gap", () => {
  const items = attentionItems(
    fold([
      event({
        actor: "impl",
        checks: [
          {
            name: "npm test",
            result: "pass",
            evidence: "captured",
            command: "npm test",
            durationMs: null,
          },
        ],
      }),
      event({ actor: "reviewer", verdict: "approve" }),
    ]),
    NOW,
  );
  assert.ok(!items.some((i) => i.id === "approval-without-captured-checks"));
});

test("several approvals produce one validation gap, not one each", () => {
  const items = attentionItems(
    fold([
      event({ actor: "r1", verdict: "approve" }),
      event({ actor: "r2", verdict: "approved" }),
    ]),
    NOW,
  );
  assert.equal(
    items.filter((i) => i.id === "approval-without-captured-checks").length,
    1,
  );
});

test("a handoff awaits its target until the target reports anything", () => {
  const waiting = attentionItems(
    fold([event({ actor: "impl", target: "reviewer", summary: "ready" })]),
    NOW,
  );
  const item = waiting.find((i) => i.id === "handoff:reviewer")!;
  assert.equal(item.title, "Handoff awaiting reviewer");
  assert.equal(item.tone, "medium");

  const answered = titles([
    event({ actor: "impl", target: "reviewer" }),
    event({ actor: "reviewer" }),
  ]);
  assert.ok(!answered.some((t) => t.startsWith("Handoff awaiting")));

  // A later handoff to the same target replaces the earlier one.
  const repeated = attentionItems(
    fold([
      event({ actor: "impl", target: "reviewer" }),
      event({ actor: "impl", target: "reviewer" }),
    ]),
    NOW,
  );
  assert.equal(repeated.filter((i) => i.id === "handoff:reviewer").length, 1);
});

test("no reviewer decision is a low, inferred note once something finished", () => {
  const none = attentionItems(
    fold([event({ actor: "impl", status: "ok" })]),
    NOW,
  );
  const item = none.find((i) => i.title === "No reviewer decision yet")!;
  assert.equal(item.tone, "low");
  assert.equal(item.source, "inferred");

  const completedAction = titles([
    event({ actor: "impl", action: "completed" }),
  ]);
  assert.ok(completedAction.includes("No reviewer decision yet"));

  assert.ok(
    !titles([event({ actor: "impl", status: "running" })]).includes(
      "No reviewer decision yet",
    ),
    "nothing finished, so nothing is waiting on a review",
  );
  assert.ok(
    !titles([
      event({ actor: "impl", status: "ok" }),
      event({ actor: "reviewer", verdict: "reject" }),
    ]).includes("No reviewer decision yet"),
  );
});

test("attention is ordered high, medium, low", () => {
  const items = attentionItems(
    fold([
      event({ actor: "impl", status: "ok", target: "reviewer" }),
      event({ actor: "tester", session: "s", status: "blocked" }),
    ]),
    NOW,
  );
  const tones = items.map((i) => i.tone);
  const rank = { high: 0, medium: 1, low: 2 } as const;
  assert.deepEqual(
    tones,
    [...tones].sort((a, b) => rank[a] - rank[b]),
  );
  assert.equal(tones[0], "high");
});

test("items are deduplicated by identity", () => {
  const items = attentionItems(
    fold([
      event({ actor: "impl", session: "s1", status: "blocked" }),
      event({ actor: "impl", session: "s1", status: "blocked" }),
      event({ actor: "impl", session: "s1", status: "blocked" }),
    ]),
    NOW,
  );
  const ids = items.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(items.filter((i) => i.title.includes("blocked")).length, 1);
});

test("a calm task reports nothing that needs attention", () => {
  const items = attentionItems(
    fold([
      event({ actor: "impl", status: "running" }),
      event({
        actor: "impl",
        status: "ok",
        checks: [
          {
            name: "npm test",
            result: "pass",
            evidence: "captured",
            command: null,
            durationMs: null,
          },
        ],
      }),
      event({ actor: "reviewer", verdict: "approve" }),
    ]),
    NOW,
  );
  assert.deepEqual(items, []);
});

test("synthetic events keep their source on attention items", () => {
  const items = attentionItems(
    fold([event({ actor: "demo", status: "blocked", source: "synthetic" })]),
    NOW,
  );
  assert.equal(items[0]!.source, "synthetic");
});

test("verdict families", () => {
  assert.equal(isNegativeVerdict("needs-fixes"), true);
  assert.equal(isNegativeVerdict("Changes requested"), true);
  assert.equal(isNegativeVerdict("no changes needed"), false);
  assert.equal(isApprovalVerdict("approved"), true);
  assert.equal(isApprovalVerdict("LGTM"), true);
  assert.equal(isApprovalVerdict("failed"), false);
  assert.equal(isApprovalVerdict("ship-it-friday"), false);
});

test("relative time never goes negative and falls back to a date", () => {
  assert.equal(relativeTime(ago(5_000), NOW), "5s ago");
  assert.equal(relativeTime(ago(4 * 60_000), NOW), "4m ago");
  assert.equal(relativeTime(ago(3 * 3_600_000), NOW), "3h ago");
  assert.equal(
    relativeTime(new Date(NOW + 60_000).toISOString(), NOW),
    "0s ago",
  );
  assert.equal(relativeTime("not a date", NOW), "");
  assert.notEqual(relativeTime(ago(3 * 86_400_000), NOW), "");
});

test("source labels never present inferred as reported", () => {
  for (const source of [
    "captured",
    "reported",
    "synthetic",
    "inferred",
  ] as const) {
    assert.equal(sourceLabel(source), source);
    assert.ok(sourceHint(source).length > 0);
  }
  assert.match(sourceHint("captured"), /not independently verified/);
  assert.match(sourceHint("inferred"), /Nothing reported this/);
  assert.match(sourceHint("synthetic"), /Not real activity/);
});

test("session ids and durations are shortened for rows only", () => {
  assert.equal(shortSession("abc"), "abc");
  assert.equal(shortSession("a".repeat(40)).length, 12);
  assert.ok(shortSession("a".repeat(40)).endsWith("…"));
  assert.equal(formatDuration(null), "");
  assert.equal(formatDuration(450), "450ms");
  assert.equal(formatDuration(2500), "2.5s");
  assert.equal(formatDuration(75_000), "1m 15s");
});

test("synthetic checks are not counted as captured validation", () => {
  const view = fold([
    event({
      actor: "demo",
      source: "synthetic",
      checks: [
        {
          name: "demo test",
          result: "passed",
          evidence: "captured",
          command: "npm test",
          durationMs: null,
        },
      ],
    }),
    event({ actor: "reviewer", verdict: "approve", source: "reported" }),
  ]);
  assert.equal(view.capturedChecks, 0);
  assert.equal(view.syntheticChecks, 1);
  assert.ok(
    attentionItems(view, NOW).some(
      (item) => item.id === "approval-without-captured-checks",
    ),
  );
});

test("a later approval lowers, but does not erase, an earlier change request", () => {
  const view = fold([
    event({
      actor: "reviewer-a",
      verdict: "needs-fixes",
      summary: "Add a test",
    }),
    event({ actor: "implementer", status: "ok", summary: "Added it" }),
    event({ actor: "reviewer-b", verdict: "approve", summary: "Looks right" }),
  ]);
  const item = attentionItems(view, NOW).find((entry) =>
    entry.id.startsWith("verdict:reviewer-a"),
  );
  assert.ok(item);
  assert.equal(item.tone, "medium");
  assert.match(item.title, /later approved/);
  assert.match(item.detail, /confirm the finding was actually addressed/);
});

test("the integration's connection receipt is not a participant", () => {
  const view = fold([
    event({ actor: "ousel", action: "integration_connected" }),
    event({ actor: "claude-code", action: "session_start" }),
  ]);
  assert.deepEqual(
    view.participants.map((p) => p.actor),
    ["claude-code"],
  );
  assert.equal(view.events.length, 2, "the receipt stays in the timeline");
});

test("a failed captured check is not validation and survives an unrelated ok", () => {
  const view = fold([
    event({
      actor: "claude-code",
      status: "error",
      action: "tool_failed",
      source: "captured",
      checks: [
        {
          name: "npm test",
          result: "failed",
          evidence: "captured",
          command: "npm test",
          durationMs: 10,
        },
      ],
    }),
    event({ actor: "claude-code", status: "ok", action: "tool_completed" }),
    event({ actor: "reviewer", verdict: "approve", source: "reported" }),
  ]);
  assert.equal(view.capturedChecks, 0);
  assert.equal(view.capturedFailedChecks, 1);
  const items = attentionItems(view, NOW);
  assert.ok(items.some((item) => item.id === "check-failed:npm test"));
  assert.ok(
    items.some((item) => item.id === "approval-without-captured-checks"),
  );
});

test("a later passing check of the same name clears a captured failure", () => {
  const view = fold([
    event({
      actor: "claude-code",
      status: "error",
      source: "captured",
      checks: [
        {
          name: "npm test",
          result: "failed",
          evidence: "captured",
          command: "npm test",
          durationMs: null,
        },
      ],
    }),
    event({
      actor: "claude-code",
      status: "ok",
      source: "captured",
      checks: [
        {
          name: "npm test",
          result: "passed",
          evidence: "captured",
          command: "npm test",
          durationMs: null,
        },
      ],
    }),
  ]);
  assert.equal(view.capturedChecks, 1);
  assert.equal(view.capturedFailedChecks, 0);
  assert.ok(
    !attentionItems(view, NOW).some((item) =>
      item.id.startsWith("check-failed:"),
    ),
  );
});

test("check results are not passes unless they say so unambiguously", () => {
  for (const result of ["passed", "PASS", "ok", "success", "green"])
    assert.equal(checkPassed(result), true, result);
  for (const result of ["failed", "not passed", "0 passed, 1 failed", ""])
    assert.equal(checkPassed(result), false, result);
});

test("reported checks cannot clear a captured failure", () => {
  const view = fold([
    event({
      actor: "claude-code",
      status: "error",
      source: "captured",
      checks: [
        {
          name: "npm test",
          result: "failed",
          evidence: "captured",
          command: "npm test",
          durationMs: null,
        },
      ],
    }),
    event({
      actor: "reviewer",
      source: "reported",
      checks: [
        {
          name: "npm test",
          result: "passed",
          evidence: "reported",
          command: "npm test",
          durationMs: null,
        },
      ],
    }),
  ]);
  assert.ok(
    attentionItems(view, NOW).some((item) =>
      item.id.startsWith("check-failed:npm test"),
    ),
  );
});
