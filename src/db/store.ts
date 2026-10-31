/**
 * The store: one append-only table of events.
 *
 * There is no run, stage, attempt or approval table any more, because this
 * service no longer runs anything — it receives what agents report. Everything
 * the field draws (actors, sessions, handoffs, verdicts) is derived from this
 * stream, so the only durable thing is the stream itself.
 *
 * `:memory:` is the default so tests and a throwaway server cost nothing; the
 * binary passes a real path under the data directory.
 */
import { DatabaseSync } from "node:sqlite";
import type { EventRecord, IngestedEvent } from "../core/events.js";

export interface StoreOptions {
  /** SQLite file, or `:memory:` (the default). */
  path?: string;
}

export interface EventQuery {
  /** Exclusive cursor: only events with a higher id are returned. */
  afterId?: number;
  session?: string | null;
  project?: string | null;
  task?: string | null;
  limit?: number;
}

/**
 * Columns added after the first v2 schema. An existing database is upgraded in
 * place by adding whichever of these it lacks; the table is never recreated.
 */
const ADDED_COLUMNS: readonly { name: string; definition: string }[] = [
  { name: "project", definition: "TEXT" },
  { name: "task", definition: "TEXT" },
  { name: "source", definition: "TEXT NOT NULL DEFAULT 'reported'" },
  { name: "files", definition: "TEXT NOT NULL DEFAULT '[]'" },
  { name: "checks", definition: "TEXT NOT NULL DEFAULT '[]'" },
];

/** Columns every v2 database has. Without them the table is not migratable. */
const V2_COLUMNS = [
  "id",
  "created_at",
  "actor",
  "action",
  "session",
  "provider",
  "target",
  "parent",
  "summary",
  "status",
  "verdict",
  "issues",
  "detail",
] as const;

/** Hard ceiling on one query, so a client cannot ask for the whole history. */
const MAX_LIMIT = 1000;

interface Row {
  id: number;
  created_at: string;
  actor: string;
  action: string;
  session: string | null;
  provider: string | null;
  target: string | null;
  parent: string | null;
  summary: string | null;
  status: string | null;
  verdict: string | null;
  issues: string;
  project: string | null;
  task: string | null;
  source: string | null;
  files: string | null;
  checks: string | null;
  detail: string;
}

function toRecord(row: Row): EventRecord {
  return {
    id: row.id,
    createdAt: row.created_at,
    actor: row.actor,
    action: row.action,
    session: row.session,
    provider: row.provider,
    target: row.target,
    parent: row.parent,
    summary: row.summary,
    status: row.status as EventRecord["status"],
    verdict: row.verdict,
    // Stored as JSON text: parsed back defensively so one unreadable row
    // cannot take down a whole query.
    issues: parseJson(row.issues, []) as EventRecord["issues"],
    source: toSource(row.source),
    project: row.project ?? null,
    task: row.task ?? null,
    files: parseArray(row.files) as EventRecord["files"],
    checks: parseArray(row.checks) as EventRecord["checks"],
    detail: parseJson(row.detail, {}) as Record<string, unknown>,
  };
}

function parseJson(text: string, fallback: unknown): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function parseArray(text: string | null): unknown[] {
  if (text === null || text === undefined) return [];
  const parsed = parseJson(text, []);
  return Array.isArray(parsed) ? parsed : [];
}

/** Anything unrecognised reads as "reported", the pre-v3 meaning of every row. */
function toSource(value: string | null): EventRecord["source"] {
  return value === "captured" || value === "synthetic" ? value : "reported";
}

export class Store {
  readonly db: DatabaseSync;

  constructor(options: StoreOptions = {}) {
    this.db = new DatabaseSync(options.path ?? ":memory:");
    try {
      // Inspect before any writable pragma: refusing a foreign database must
      // not switch its journal mode or otherwise modify the file.
      const tables = (
        this.db
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
          )
          .all() as unknown as { name: string }[]
      ).map((table) => table.name);
      // A pre-v2 AgentOps file used different tables. Creating an empty
      // `events` table beside them would start with a blank history and make
      // the old data look gone. Refuse instead of silently ignoring it.
      if (tables.length > 0 && !tables.includes("events"))
        throw new Error(
          `the file has tables (${tables.join(", ")}) but no events table; it is not an Ousel/AgentOps v2 database`,
        );
      // An incompatible existing events table must also be refused before a
      // writable pragma changes the file.
      if (tables.includes("events")) {
        const columns = new Set(
          (
            this.db.prepare(`PRAGMA table_info(events)`).all() as unknown as {
              name: string;
            }[]
          ).map((column) => column.name),
        );
        const missingBase = V2_COLUMNS.filter((name) => !columns.has(name));
        if (missingBase.length > 0)
          throw new Error(
            `the events table predates the v2 schema (missing ${missingBase.join(", ")})`,
          );
      }
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA foreign_keys = ON");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS events (
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
          project TEXT,
          task TEXT,
          source TEXT NOT NULL DEFAULT 'reported',
          files TEXT NOT NULL DEFAULT '[]',
          checks TEXT NOT NULL DEFAULT '[]',
          detail TEXT NOT NULL DEFAULT '{}'
        );
      `);
      this.migrate();
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS events_session_idx ON events (session, id);
        CREATE INDEX IF NOT EXISTS events_actor_idx ON events (actor, id);
        CREATE INDEX IF NOT EXISTS events_task_idx ON events (project, task, id);
      `);
    } catch (cause) {
      try {
        this.db.close();
      } catch {
        // Already closed, or never usable.
      }
      const message = cause instanceof Error ? cause.message : String(cause);
      // Only schema-shape failures get data-movement advice. A busy or
      // read-only database must surface its own error, not tell the user to
      // move a healthy file.
      if (/predates the v2 schema|no events table/.test(message)) {
        const where = options.path ?? ":memory:";
        throw new Error(
          `Could not open ${where}: ${message}. Keep the file, back it up, ` +
            `and point OUSEL_DATA_DIR at it only after checking what wrote it; ` +
            `or use a new directory.`,
        );
      }
      throw cause;
    }
  }

  /**
   * Brings a v2 database up to date in place: inspect the columns, add what is
   * missing, all inside one transaction so a failure leaves the file as it was.
   * Existing rows take the column defaults — `source = 'reported'`, empty
   * `files`/`checks`, null `project`/`task` — which is what they always meant.
   */
  private migrate(): void {
    const columns = new Set(
      (
        this.db.prepare(`PRAGMA table_info(events)`).all() as unknown as {
          name: string;
        }[]
      ).map((column) => column.name),
    );
    const missingBase = V2_COLUMNS.filter((name) => !columns.has(name));
    if (missingBase.length > 0)
      throw new Error(
        `the events table predates the v2 schema (missing ${missingBase.join(", ")})`,
      );
    const missing = ADDED_COLUMNS.filter((column) => !columns.has(column.name));
    if (missing.length === 0) return;
    this.db.exec("BEGIN");
    try {
      for (const column of missing)
        this.db.exec(
          `ALTER TABLE events ADD COLUMN ${column.name} ${column.definition}`,
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  append(event: IngestedEvent): EventRecord {
    const createdAt = new Date().toISOString();
    const statement = this.db.prepare(`
      INSERT INTO events
        (created_at, actor, action, session, provider, target, parent,
         summary, status, verdict, issues, project, task, source, files,
         checks, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `);
    const row = statement.get(
      createdAt,
      event.actor,
      event.action,
      event.session,
      event.provider,
      event.target,
      event.parent,
      event.summary,
      event.status,
      event.verdict,
      JSON.stringify(event.issues),
      event.project,
      event.task,
      event.source,
      JSON.stringify(event.files),
      JSON.stringify(event.checks),
      JSON.stringify(event.detail),
    ) as unknown as Row;
    return toRecord(row);
  }

  list(query: EventQuery = {}): EventRecord[] {
    const limit = Math.min(Math.max(1, query.limit ?? 200), MAX_LIMIT);
    const afterId = Math.max(0, Math.trunc(query.afterId ?? 0));
    // Newest-first with a limit, then reversed: a fresh client gets the most
    // recent window rather than the oldest events in the database.
    const where = ["id > ?"];
    const params: (string | number)[] = [afterId];
    if (query.session) {
      where.push("session = ?");
      params.push(query.session);
    }
    if (query.project) {
      where.push("project = ?");
      params.push(query.project);
    }
    if (query.task) {
      where.push("task = ?");
      params.push(query.task);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM events WHERE ${where.join(" AND ")}
         ORDER BY id DESC LIMIT ?`,
      )
      .all(...params, limit) as unknown as Row[];
    return rows.map(toRecord).reverse();
  }

  /** Events after a cursor in ascending order: what the SSE pump sends. */
  since(afterId: number, limit = 200): EventRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?`)
      .all(
        Math.max(0, Math.trunc(afterId)),
        Math.min(limit, MAX_LIMIT),
      ) as unknown as Row[];
    return rows.map(toRecord);
  }

  latestId(): number {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM events`)
      .get() as unknown as { id: number };
    return row.id;
  }

  count(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM events`)
      .get() as unknown as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}
