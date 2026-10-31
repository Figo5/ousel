/**
 * The store: migration of a v2 database in place, and the new filters.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { validateEvent, type IngestedEvent } from "../src/core/events.js";
import { Store } from "../src/db/store.js";

function tempDb(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "ousel-store-"));
  return {
    file: path.join(dir, "legacy.sqlite"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function event(partial: Record<string, unknown>): IngestedEvent {
  const result = validateEvent({ actor: "a", action: "step", ...partial });
  assert.ok(result.ok, "fixture event must validate");
  return result.value;
}

/** The table exactly as AgentOps v2 created it. */
function writeLegacyV2(file: string): void {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      session TEXT,
      provider TEXT,
      target TEXT,
      parent TEXT,
      summary TEXT,
      status TEXT,
      verdict TEXT,
      issues TEXT NOT NULL DEFAULT '[]',
      detail TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX events_session_idx ON events (session, id);
    CREATE INDEX events_actor_idx ON events (actor, id);
  `);
  const insert = db.prepare(
    `INSERT INTO events (created_at, actor, action, session, provider, target,
       parent, summary, status, verdict, issues, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(
    "2026-01-01T00:00:00.000Z",
    "legacy-agent",
    "tool_call",
    "s1",
    "claude",
    null,
    null,
    "old summary",
    "ok",
    null,
    "[]",
    '{"tokens":12}',
  );
  insert.run(
    "2026-01-01T00:01:00.000Z",
    "legacy-reviewer",
    "review",
    "s1",
    null,
    null,
    null,
    "looked fine",
    null,
    "approve",
    '[{"description":"nit","severity":null,"path":null,"line":null}]',
    "{}",
  );
  db.close();
}

test("a v2 database is migrated in place and keeps its rows", () => {
  const { file, cleanup } = tempDb();
  try {
    writeLegacyV2(file);
    const store = new Store({ path: file });
    const rows = store.list();
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.actor, "legacy-agent");
    assert.equal(rows[0]!.summary, "old summary");
    assert.deepEqual(rows[0]!.detail, { tokens: 12 });
    assert.equal(rows[1]!.verdict, "approve");
    assert.equal(rows[1]!.issues[0]!.description, "nit");
    for (const row of rows) {
      assert.equal(row.source, "reported");
      assert.deepEqual(row.files, []);
      assert.deepEqual(row.checks, []);
      assert.equal(row.project, null);
      assert.equal(row.task, null);
    }
    assert.equal(store.count(), 2);
    store.close();
  } finally {
    cleanup();
  }
});

test("migration adds columns and the task index without recreating the table", () => {
  const { file, cleanup } = tempDb();
  try {
    writeLegacyV2(file);
    new Store({ path: file }).close();
    const db = new DatabaseSync(file);
    const columns = (
      db.prepare("PRAGMA table_info(events)").all() as { name: string }[]
    ).map((column) => column.name);
    for (const name of ["project", "task", "source", "files", "checks"])
      assert.ok(columns.includes(name), `${name} column was added`);
    const indexes = (
      db.prepare("PRAGMA index_list(events)").all() as { name: string }[]
    ).map((index) => index.name);
    assert.ok(indexes.includes("events_task_idx"));
    // The original ids survive: the table was altered, not rebuilt.
    const ids = (
      db.prepare("SELECT id FROM events ORDER BY id").all() as { id: number }[]
    ).map((row) => row.id);
    assert.deepEqual(ids, [1, 2]);
    db.close();
  } finally {
    cleanup();
  }
});

test("a migrated database accepts new events and survives a reopen", () => {
  const { file, cleanup } = tempDb();
  try {
    writeLegacyV2(file);
    const first = new Store({ path: file });
    const appended = first.append(
      event({
        actor: "new-agent",
        project: "ousel",
        task: "t1",
        source: "captured",
        files: [{ path: "src/a.ts", change: "added" }],
        checks: [{ name: "npm test", result: "pass", evidence: "captured" }],
      }),
    );
    assert.equal(appended.id, 3);
    assert.equal(appended.source, "captured");
    first.close();

    // Reopening runs the migration again: it must be a no-op, not an error.
    const second = new Store({ path: file });
    const rows = second.list();
    assert.equal(rows.length, 3);
    const latest = rows[2]!;
    assert.equal(latest.project, "ousel");
    assert.equal(latest.task, "t1");
    assert.equal(latest.source, "captured");
    assert.deepEqual(latest.files, [{ path: "src/a.ts", change: "added" }]);
    assert.equal(latest.checks[0]!.evidence, "captured");
    assert.equal(rows[0]!.source, "reported", "old rows keep their default");
    second.close();
  } finally {
    cleanup();
  }
});

test("a table that predates v2 gets a clear error, not a bare SQL one", () => {
  const { file, cleanup } = tempDb();
  try {
    const db = new DatabaseSync(file);
    db.exec(
      "CREATE TABLE events (id INTEGER PRIMARY KEY, kind TEXT, body TEXT)",
    );
    db.close();
    const before = readFileSync(file);
    assert.throws(
      () => new Store({ path: file }),
      /predates the v2 schema.*back it up.*new directory/s,
    );
    assert.deepEqual(
      readFileSync(file),
      before,
      "refusing an incompatible events table must not modify it",
    );
  } finally {
    cleanup();
  }
});

test("a database with other tables but no events table is refused", () => {
  const { file, cleanup } = tempDb();
  try {
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE runs (id INTEGER PRIMARY KEY, name TEXT)");
    db.exec("INSERT INTO runs (name) VALUES ('old run')");
    db.close();
    const before = readFileSync(file);
    assert.throws(
      () => new Store({ path: file }),
      /has tables \(runs\) but no events table.*not an Ousel\/AgentOps v2 database/s,
    );
    assert.deepEqual(
      readFileSync(file),
      before,
      "refusing a foreign database must not modify it",
    );
    const check = new DatabaseSync(file, { readOnly: true });
    assert.equal(
      (check.prepare("SELECT name FROM runs").get() as { name: string }).name,
      "old run",
      "the refused file was not altered",
    );
    check.close();
  } finally {
    cleanup();
  }
});

test("unreadable files and checks columns fall back to empty arrays", () => {
  const store = new Store();
  store.append(event({ actor: "a" }));
  store.db.exec(`UPDATE events SET files = 'not json', checks = '{"x":1}'`);
  const [row] = store.list();
  assert.deepEqual(row!.files, []);
  assert.deepEqual(row!.checks, []);
  store.close();
});

test("list filters by project and task, and keeps cursor and limit semantics", () => {
  const store = new Store();
  store.append(event({ actor: "a", project: "p1", task: "t1" }));
  store.append(event({ actor: "b", project: "p1", task: "t2" }));
  store.append(event({ actor: "c", project: "p2", task: "t1" }));
  store.append(event({ actor: "d", project: "p1", task: "t1" }));
  store.append(event({ actor: "e" }));

  const p1 = store.list({ project: "p1" });
  assert.deepEqual(
    p1.map((e) => e.actor),
    ["a", "b", "d"],
  );
  const both = store.list({ project: "p1", task: "t1" });
  assert.deepEqual(
    both.map((e) => e.actor),
    ["a", "d"],
  );
  assert.deepEqual(
    store.list({ task: "t1" }).map((e) => e.actor),
    ["a", "c", "d"],
  );
  // Newest window, oldest first, exclusive cursor.
  assert.deepEqual(
    store.list({ project: "p1", limit: 2 }).map((e) => e.actor),
    ["b", "d"],
  );
  assert.deepEqual(
    store.list({ project: "p1", afterId: 2 }).map((e) => e.actor),
    ["d"],
  );
  assert.equal(store.list({ project: "nope" }).length, 0);
  assert.equal(store.list().length, 5);
  store.close();
});
