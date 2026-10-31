/**
 * The ingest contract: what an agent may send, and what it gets back.
 *
 * These assert the promise the README makes to the agents that read it, so a
 * change here is a change to a published contract.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateEvent, verdictTone } from "../src/core/events.js";

test("two fields are enough", () => {
  const result = validateEvent({ actor: "claude-code", action: "tool_call" });
  assert.ok(result.ok);
  assert.equal(result.value.actor, "claude-code");
  assert.equal(result.value.action, "tool_call");
  // Everything optional is an explicit absence, never an invented default.
  assert.equal(result.value.session, null);
  assert.equal(result.value.provider, null);
  assert.equal(result.value.summary, null);
  assert.equal(result.value.status, null);
  assert.equal(result.value.verdict, null);
  assert.deepEqual(result.value.issues, []);
  assert.deepEqual(result.value.detail, {});
});

test("actor and action are required and named in the error", () => {
  const missing = validateEvent({});
  assert.equal(missing.ok, false);
  assert.ok(!missing.ok && missing.errors.some((e) => e.includes("actor")));
  assert.ok(!missing.ok && missing.errors.some((e) => e.includes("action")));

  const blank = validateEvent({ actor: "   ", action: "x" });
  assert.equal(blank.ok, false);

  assert.equal(validateEvent("nope").ok, false);
  assert.equal(validateEvent(null).ok, false);
  assert.equal(validateEvent([1, 2]).ok, false);
});

test("a rich event keeps every field it sent", () => {
  const result = validateEvent({
    actor: "reviewer",
    action: "review",
    session: "sess_1",
    provider: "openai",
    target: "implementer",
    parent: "orchestrator",
    summary: "Parser is correct but the error message leaks the path",
    status: "blocked",
    verdict: "needs-fixes",
    issues: [
      {
        description: "Unbounded read",
        severity: "major",
        path: "a.ts",
        line: 42,
      },
      { description: "Missing test" },
    ],
  });
  assert.ok(result.ok);
  const value = result.value;
  assert.equal(value.session, "sess_1");
  assert.equal(value.provider, "openai");
  assert.equal(value.target, "implementer");
  assert.equal(value.parent, "orchestrator");
  assert.equal(value.status, "blocked");
  assert.equal(value.verdict, "needs-fixes");
  assert.equal(value.issues.length, 2);
  assert.equal(value.issues[0]!.line, 42);
  // Absent issue fields stay absent rather than being filled in.
  assert.equal(value.issues[1]!.severity, null);
  assert.equal(value.issues[1]!.path, null);
  assert.equal(value.issues[1]!.line, null);
});

test("status must be one of the four, and says so", () => {
  assert.ok(validateEvent({ actor: "a", action: "b", status: "running" }).ok);
  assert.ok(validateEvent({ actor: "a", action: "b", status: "OK" }).ok);
  const bad = validateEvent({ actor: "a", action: "b", status: "finished" });
  assert.equal(bad.ok, false);
  assert.ok(!bad.ok && bad.errors[0]!.includes("running, ok, error, blocked"));
});

test("an issue without a description is rejected, not silently dropped", () => {
  const result = validateEvent({
    actor: "a",
    action: "b",
    issues: [{ severity: "major" }],
  });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.errors.some((e) => e.includes("description")));
});

test("unknown top-level keys are kept in detail rather than refused", () => {
  const result = validateEvent({
    actor: "a",
    action: "b",
    tokens: 1200,
    model: "claude-opus-5",
    detail: { cost: 0.03 },
  });
  assert.ok(result.ok);
  assert.deepEqual(result.value.detail, {
    cost: 0.03,
    tokens: 1200,
    model: "claude-opus-5",
  });
});

test("credentials are stripped before anything is stored", () => {
  const result = validateEvent({
    actor: "a",
    action: "b",
    summary:
      "ran with sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  });
  assert.ok(result.ok);
  assert.ok(
    !/sk-ant-api03-AAAA/.test(result.value.summary ?? ""),
    "the key must not survive into storage",
  );
});

test("oversized strings are truncated, not rejected", () => {
  const result = validateEvent({
    actor: "a",
    action: "b",
    summary: "x".repeat(5000),
  });
  assert.ok(result.ok);
  assert.ok((result.value.summary ?? "").length <= 2000);
  assert.ok((result.value.summary ?? "").endsWith("…"));
});

test("an oversized detail is refused with an actionable message", () => {
  const result = validateEvent({
    actor: "a",
    action: "b",
    detail: { blob: "x".repeat(20_000) },
  });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.errors[0]!.includes("send a reference"));
});

test("the v3 fields default to explicit absences", () => {
  const result = validateEvent({ actor: "a", action: "b" });
  assert.ok(result.ok);
  assert.equal(result.value.source, "reported");
  assert.equal(result.value.project, null);
  assert.equal(result.value.task, null);
  assert.deepEqual(result.value.files, []);
  assert.deepEqual(result.value.checks, []);
});

test("source accepts captured, reported and synthetic, and nothing else", () => {
  for (const source of ["captured", "reported", "synthetic"] as const) {
    const result = validateEvent({ actor: "a", action: "b", source });
    assert.ok(result.ok);
    assert.equal(result.value.source, source);
  }
  const upper = validateEvent({ actor: "a", action: "b", source: "CAPTURED" });
  assert.ok(upper.ok);
  assert.equal(upper.value.source, "captured");

  const inferred = validateEvent({
    actor: "a",
    action: "b",
    source: "inferred",
  });
  assert.equal(inferred.ok, false);
  assert.ok(
    !inferred.ok &&
      inferred.errors.some(
        (e) => e.includes("inferred") && e.includes("never stores"),
      ),
  );
  const unknown = validateEvent({ actor: "a", action: "b", source: "guess" });
  assert.equal(unknown.ok, false);
  assert.equal(validateEvent({ actor: "a", action: "b", source: 3 }).ok, false);
});

test("source is a known key: it is not folded into detail", () => {
  const result = validateEvent({
    actor: "a",
    action: "b",
    source: "captured",
    project: "p",
    task: "t",
    files: [],
    checks: [],
  });
  assert.ok(result.ok);
  assert.deepEqual(result.value.detail, {});
});

test("project and task are trimmed, truncated strings", () => {
  const result = validateEvent({
    actor: "a",
    action: "b",
    project: "  ousel  ",
    task: "t".repeat(500),
  });
  assert.ok(result.ok);
  assert.equal(result.value.project, "ousel");
  assert.equal(result.value.task!.length, 200);
  assert.ok(result.value.task!.endsWith("…"));

  assert.equal(
    validateEvent({ actor: "a", action: "b", project: 4 }).ok,
    false,
  );
  assert.equal(validateEvent({ actor: "a", action: "b", task: {} }).ok, false);
});

test("files keep a path and an optional change", () => {
  const result = validateEvent({
    actor: "a",
    action: "b",
    files: [{ path: "src/a.ts", change: "modified" }, { path: "src/b.ts" }],
  });
  assert.ok(result.ok);
  assert.deepEqual(result.value.files, [
    { path: "src/a.ts", change: "modified" },
    { path: "src/b.ts", change: null },
  ]);
});

test("files reject structural errors and truncate long strings", () => {
  const notArray = validateEvent({ actor: "a", action: "b", files: "a.ts" });
  assert.equal(notArray.ok, false);
  assert.ok(!notArray.ok && notArray.errors[0]!.includes("files"));

  const notObject = validateEvent({ actor: "a", action: "b", files: ["a.ts"] });
  assert.equal(notObject.ok, false);

  const noPath = validateEvent({
    actor: "a",
    action: "b",
    files: [{ change: "added" }],
  });
  assert.equal(noPath.ok, false);
  assert.ok(!noPath.ok && noPath.errors.some((e) => e.includes("path")));

  const long = validateEvent({
    actor: "a",
    action: "b",
    files: [{ path: "p".repeat(2000), change: "c".repeat(100) }],
  });
  assert.ok(long.ok);
  assert.equal(long.value.files[0]!.path.length, 1000);
  assert.equal(long.value.files[0]!.change!.length, 40);
});

test("files beyond the limit are dropped, not rejected", () => {
  const result = validateEvent({
    actor: "a",
    action: "b",
    files: Array.from({ length: 80 }, (_, i) => ({ path: `f${i}.ts` })),
  });
  assert.ok(result.ok);
  assert.equal(result.value.files.length, 50);
});

test("checks default evidence to reported and keep what was sent", () => {
  const result = validateEvent({
    actor: "a",
    action: "b",
    source: "captured",
    checks: [
      {
        name: "npm test",
        result: "pass",
        evidence: "captured",
        command: "npm test",
        durationMs: 4200,
      },
      { name: "lint", result: "fail" },
    ],
  });
  assert.ok(result.ok);
  assert.deepEqual(result.value.checks, [
    {
      name: "npm test",
      result: "pass",
      evidence: "captured",
      command: "npm test",
      durationMs: 4200,
    },
    {
      name: "lint",
      result: "fail",
      evidence: "reported",
      command: null,
      durationMs: null,
    },
  ]);
});

test("checks reject structural errors", () => {
  const bad = (checks: unknown) =>
    validateEvent({ actor: "a", action: "b", checks });
  assert.equal(bad("npm test").ok, false);
  assert.equal(bad(["npm test"]).ok, false);
  assert.equal(bad([{ result: "pass" }]).ok, false);
  assert.equal(bad([{ name: "t" }]).ok, false);
  assert.equal(
    bad([{ name: "t", result: "pass", evidence: "inferred" }]).ok,
    false,
  );
  assert.equal(bad([{ name: "t", result: "pass", durationMs: -1 }]).ok, false);
  assert.equal(bad([{ name: "t", result: "pass", durationMs: 1.5 }]).ok, false);
  assert.equal(bad([{ name: "t", result: "pass", durationMs: "9" }]).ok, false);
  assert.equal(bad([{ name: "t", result: "pass", command: 7 }]).ok, false);
  const named = bad([{ result: "pass" }]);
  assert.ok(
    !named.ok && named.errors.some((e) => e.includes("checks[0].name")),
  );
});

test("checks truncate long strings, cap the list, and redact commands", () => {
  const long = validateEvent({
    actor: "a",
    action: "b",
    checks: [
      {
        name: "n".repeat(500),
        result: "r".repeat(100),
        command: "c".repeat(2000),
      },
    ],
  });
  assert.ok(long.ok);
  assert.equal(long.value.checks[0]!.name.length, 200);
  assert.equal(long.value.checks[0]!.result.length, 40);
  assert.equal(long.value.checks[0]!.command!.length, 1000);

  const many = validateEvent({
    actor: "a",
    action: "b",
    checks: Array.from({ length: 30 }, (_, i) => ({
      name: `c${i}`,
      result: "pass",
    })),
  });
  assert.ok(many.ok);
  assert.equal(many.value.checks.length, 20);

  const secret = validateEvent({
    actor: "a",
    action: "b",
    checks: [
      {
        name: "deploy",
        result: "pass",
        command:
          "run --key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
    ],
  });
  assert.ok(secret.ok);
  assert.ok(!/sk-ant-api03-AAAA/.test(secret.value.checks[0]!.command ?? ""));
});

test("verdict tone reads the common vocabularies and stays neutral otherwise", () => {
  assert.equal(verdictTone("APPROVE"), "success");
  assert.equal(verdictTone("passed"), "success");
  assert.equal(verdictTone("lgtm"), "success");
  assert.equal(verdictTone("needs fixes"), "warn");
  assert.equal(verdictTone("REJECT"), "danger");
  assert.equal(verdictTone("failed"), "danger");
  // Unrecognised is neutral: never reported as a failure nobody claimed.
  assert.equal(verdictTone("ship-it-friday"), "neutral");
  assert.equal(verdictTone(null), "neutral");
  // Status fills in when there is no verdict at all.
  assert.equal(verdictTone(null, "error"), "danger");
  assert.equal(verdictTone(null, "blocked"), "warn");
});

test("a reported event cannot label its own check as captured", () => {
  const result = validateEvent({
    actor: "a",
    action: "b",
    checks: [{ name: "npm test", result: "pass", evidence: "captured" }],
  });
  assert.equal(result.ok, false);
  if (!result.ok)
    assert.ok(
      result.errors.some((error) =>
        error.includes('requires source "captured"'),
      ),
    );
});

test("new enum fields require strings, not coercible arrays", () => {
  assert.equal(
    validateEvent({ actor: "a", action: "x", source: ["captured"] }).ok,
    false,
  );
  assert.equal(
    validateEvent({
      actor: "a",
      action: "x",
      checks: [{ name: "n", result: "ok", evidence: ["captured"] }],
    }).ok,
    false,
  );
});
