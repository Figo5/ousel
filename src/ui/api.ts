/**
 * Typed client for the local API. Same-origin only: the server serves this
 * client, and the dev server proxies `/api` and `/ingest` to it.
 */
import type { EventRecord } from "../core/events.js";

export interface Bootstrap {
  token: string;
  version: string;
  events: EventRecord[];
  latestId: number;
  total: number;
}

export interface IngestResult {
  accepted: number;
  rejected: { index: number; errors: string[] }[];
  latestId: number;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export interface ClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface Client {
  readonly baseUrl: string;
  getToken(): string | null;
  bootstrap(): Promise<Bootstrap>;
  /** `session: null` streams every session. */
  eventsUrl(session: string | null, afterId: number): string;
  send(event: Record<string, unknown>): Promise<IngestResult>;
}

export function createClient(options: ClientOptions = {}): Client {
  const baseUrl = options.baseUrl ?? "";
  const doFetch =
    options.fetchImpl ??
    ((...args: Parameters<typeof fetch>) => fetch(...args));
  let token: string | null = null;

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body !== undefined)
      headers.set("Content-Type", "application/json");
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        ...init,
        headers,
        credentials: "same-origin",
      });
    } catch (error) {
      throw new ApiError(0, `Cannot reach the server: ${describeError(error)}`);
    }
    const text = await response.text();
    if (!response.ok) {
      let message = `${response.status} ${response.statusText}`.trim();
      try {
        const parsed = JSON.parse(text) as { error?: unknown };
        if (typeof parsed.error === "string" && parsed.error.trim())
          message = parsed.error;
      } catch {
        if (text.trim()) message = text.trim();
      }
      throw new ApiError(response.status, message);
    }
    if (!text.trim()) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError(response.status, `Malformed JSON from ${path}`);
    }
  }

  return {
    baseUrl,
    getToken: () => token,
    async bootstrap() {
      const payload = await request<Bootstrap>("/api/bootstrap");
      if (payload && typeof payload.token === "string") token = payload.token;
      return payload;
    },
    eventsUrl(session, afterId) {
      const query = new URLSearchParams();
      // Omitted rather than empty: the server reads a missing `session` as
      // "every session", and an empty one as a session nothing belongs to.
      if (session !== null) query.set("session", session);
      query.set("afterId", String(Math.max(0, Math.trunc(afterId))));
      return `${baseUrl}/api/events?${query.toString()}`;
    },
    send(event) {
      return request<IngestResult>("/ingest", {
        method: "POST",
        body: JSON.stringify(event),
      });
    },
  };
}

/** Parses one SSE frame's `data:` line. Returns null for comments/keep-alives. */
export function parseSseEventFrame(frame: string): EventRecord | null {
  const dataLines: string[] = [];
  for (const rawLine of frame.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  try {
    const parsed = JSON.parse(dataLines.join("\n")) as Partial<EventRecord>;
    if (typeof parsed.id !== "number") return null;
    return parsed as EventRecord;
  } catch {
    return null;
  }
}

/** Appends without duplicating ids, so a replay on reconnect cannot double-count. */
export function mergeEvents(
  existing: readonly EventRecord[],
  incoming: readonly EventRecord[],
  cap = 4000,
): EventRecord[] {
  const byId = new Map<number, EventRecord>();
  for (const event of existing) byId.set(event.id, event);
  for (const event of incoming) byId.set(event.id, event);
  const merged = [...byId.values()].sort((a, b) => a.id - b.id);
  if (merged.length <= cap) return merged;
  // Routine tool events may be dropped from the display window, but a status,
  // verdict, handoff, check or file reference can still be the only record of
  // unresolved work. Keep those regardless of age; they are a small fraction
  // of a stream, and losing them would make "needs attention" silently wrong.
  const keep = new Map<number, EventRecord>();
  for (const event of merged)
    if (
      event.status ||
      event.verdict ||
      event.checks.length > 0 ||
      event.files.length > 0 ||
      event.target ||
      event.parent
    )
      keep.set(event.id, event);
  for (const event of merged.slice(merged.length - cap))
    keep.set(event.id, event);
  // A handoff is resolved by any later event from its target, even a routine
  // one. Keep the latest event per actor so retention cannot make an answered
  // handoff look unanswered.
  const latestByActor = new Map<string, EventRecord>();
  for (const event of merged) latestByActor.set(event.actor, event);
  for (const event of latestByActor.values()) keep.set(event.id, event);
  return [...keep.values()].sort((a, b) => a.id - b.id);
}
