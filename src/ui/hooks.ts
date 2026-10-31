/**
 * React data hooks. Everything comes from the local API through `./api.js`;
 * there is no sample-data path anywhere in this module.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { EventRecord } from "../core/events.js";
import {
  describeError,
  mergeEvents,
  parseSseEventFrame,
  type Bootstrap,
  type Client,
} from "./api.js";

export interface AsyncResource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

export function useBootstrap(
  client: Client,
): AsyncResource<Bootstrap> & { reload: () => Promise<void> } {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      setData(await client.bootstrap());
      setError(null);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, error, loading, reload };
}

export interface SseState {
  status: "idle" | "connecting" | "live" | "reconnecting" | "unsupported";
  events: EventRecord[];
}

/**
 * Subscribes to `GET /api/events`.
 *
 * `session: null` streams everything. Events are merged by id, so a reconnect
 * that replays history cannot double-count. `seed` is the bootstrap window, so
 * the field is populated before the first live event arrives.
 */
export function useEventStream(options: {
  client: Client;
  session: string | null;
  enabled: boolean;
  seed?: readonly EventRecord[];
}): SseState {
  const { client, session, enabled, seed } = options;
  const [status, setStatus] = useState<SseState["status"]>("idle");
  const [events, setEvents] = useState<EventRecord[]>([]);

  useEffect(() => {
    if (seed && seed.length > 0)
      setEvents((current) => mergeEvents(current, seed));
  }, [seed]);

  useEffect(() => {
    if (!enabled) {
      setStatus("idle");
      return;
    }
    if (typeof EventSource === "undefined") {
      setStatus("unsupported");
      return;
    }
    setStatus("connecting");
    // Resume from 0: the server replays from the cursor and mergeEvents
    // deduplicates, so a reconnect costs a window, never a gap.
    const source = new EventSource(client.eventsUrl(session, 0));
    source.onopen = () => setStatus("live");
    source.onerror = () =>
      setStatus((current) => (current === "idle" ? "idle" : "reconnecting"));
    // A replay can deliver thousands of frames in a burst. Merge them in one
    // pass instead of rebuilding and sorting the whole list per frame.
    const buffer: EventRecord[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      if (buffer.length === 0) return;
      const batch = buffer.splice(0);
      setEvents((current) => mergeEvents(current, batch));
    };
    const receive = (message: MessageEvent) => {
      const parsed = parseSseEventFrame(
        typeof message.data === "string" ? `data: ${message.data}` : "",
      );
      if (!parsed) return;
      buffer.push(parsed);
      if (timer === null) timer = setTimeout(flush, 120);
    };
    source.addEventListener("event", receive);
    return () => {
      source.removeEventListener("event", receive);
      source.close();
      if (timer !== null) clearTimeout(timer);
      buffer.length = 0;
      setStatus("idle");
    };
  }, [client, session, enabled]);

  return { status, events };
}

export interface ActionState {
  pending: boolean;
  error: string | null;
  notice: string | null;
  clear: () => void;
}

/** Wraps a write so components get pending/error/notice without try/catch noise. */
export function useAction(
  client: Client,
  successNotice?: string,
): ActionState & {
  run: <T>(operation: (client: Client) => Promise<T>) => Promise<T | null>;
} {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = useCallback(
    async <T>(operation: (c: Client) => Promise<T>): Promise<T | null> => {
      setPending(true);
      setError(null);
      try {
        const result = await operation(client);
        if (successNotice) setNotice(successNotice);
        return result;
      } catch (caught) {
        setNotice(null);
        setError(describeError(caught));
        return null;
      } finally {
        setPending(false);
      }
    },
    [client, successNotice],
  );

  const clear = useCallback(() => {
    setError(null);
    setNotice(null);
  }, []);

  return { pending, error, notice, clear, run };
}

/** Trailing-edge debounce for refresh bursts (SSE streams arrive in floods). */
export function useDebouncedCallback(
  callback: () => void,
  delayMs: number,
): () => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(callback);
  latest.current = callback;
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      latest.current();
    }, delayMs);
  }, [delayMs]);
}
