/**
 * Constellation view model: folds the event stream into stars, edges and cards.
 *
 * Pure — no React, no DOM, no network — so the whole picture is asserted in
 * `tests/constellation.test.ts`. The canvas only projects what this returns.
 *
 * Nothing is invented. A star exists because an actor reported something; an
 * edge exists because an event named a `parent` or a `target`, or because two
 * actors acted in sequence inside one session — and that third kind is labelled
 * `sequence` so the drawing can say it is weaker evidence than the other two.
 */
import {
  verdictTone,
  type EventIssue,
  type EventRecord,
  type EventSource,
  type EventStatus,
} from "../core/events.js";

/** How long an event keeps its actor lit. */
export const ACTIVITY_WINDOW_MS = 25_000;
/** How long a handoff keeps its edge drawn. */
export const EDGE_WINDOW_MS = 30_000;
/** How long a verdict flares on the canvas. */
export const FLARE_WINDOW_MS = 2_600;
/** How long an actor stays on the field after its last event. */
export const STAR_RETENTION_MS = 30 * 60_000;
/** How many cards the column keeps. */
export const CARD_LIMIT = 14;

const GOLDEN_ANGLE = 2.399963229728653;
/** Fraction of the half-axis the field fills. Dense by design. */
const FIELD_RADIUS = 0.78;
/** Minimum separation, in unit coordinates, enforced by the relaxation pass. */
const MIN_SEPARATION = 0.16;

export interface Star {
  actor: string;
  provider: string | null;
  session: string | null;
  /** Unit coordinates in [0,1]; the canvas scales them. */
  x: number;
  y: number;
  /** 0 when idle, 1 the instant something happens. */
  activity: number;
  /** True while the actor's latest event says it is still running. */
  live: boolean;
  /** The actor's most recent status, for the tone of its halo. */
  status: EventStatus | null;
  /** What it last did, shown under the name when it is active. */
  lastAction: string;
  lastSummary: string | null;
  events: number;
}

export type EdgeKind = "spawn" | "handoff" | "sequence";

export interface Edge {
  from: string;
  to: string;
  kind: EdgeKind;
  /** 0..1 by recency. */
  weight: number;
  session: string | null;
}

export interface Flare {
  actor: string;
  tone: "success" | "warn" | "danger" | "neutral";
  /** 0 at the moment of the event, 1 when faded. */
  progress: number;
}

export interface Card {
  id: number;
  actor: string;
  provider: string | null;
  session: string | null;
  action: string;
  summary: string | null;
  verdict: string | null;
  status: EventStatus | null;
  tone: "success" | "warn" | "danger" | "neutral";
  issues: EventIssue[];
  detail: Record<string, unknown>;
  /** How the event was learned, so a card never reads as more than it is. */
  source: EventSource;
  /** Carried so a reply lands in the same task as the card it answers. */
  project: string | null;
  task: string | null;
  /**
   * True while this is the newest unresolved blocker or failure for its
   * session, by explicit events only. It is never derived from silence.
   */
  awaitingYou: boolean;
  createdAt: string;
}

export interface SessionSummary {
  session: string;
  actors: number;
  events: number;
  providers: string[];
  /** True when anything in the session is still running. */
  live: boolean;
  lastAt: string;
}

export interface ConstellationState {
  stars: Star[];
  edges: Edge[];
  flares: Flare[];
  cards: Card[];
  sessions: SessionSummary[];
  liveActors: number;
}

export interface ConstellationInput {
  events: readonly EventRecord[];
  now: number;
  /** When set, only this session's events are folded. */
  session?: string | null;
}

function decay(ageMs: number, windowMs: number): number {
  if (!Number.isFinite(ageMs) || ageMs < 0) return 0;
  if (ageMs >= windowMs) return 0;
  return 1 - ageMs / windowMs;
}

function timeOf(event: EventRecord): number {
  const parsed = Date.parse(event.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Stable 32-bit hash, so an actor keeps its place and colour across reloads. */
export function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

/**
 * Positions for a set of actors.
 *
 * Each actor starts at a position derived from its own name, so it lands in the
 * same region every time rather than being dealt a slot by arrival order. A
 * bounded relaxation pass then pushes apart any pair that would overlap, which
 * is what keeps a field of five agents from stacking two of them on one point.
 * The pass is deterministic: same names in, same layout out.
 */
export function starLayout(
  actors: readonly string[],
): Map<string, { x: number; y: number }> {
  const names = [...actors].sort();
  const points = names.map((name) => {
    const seed = hash(name);
    const angle = ((seed % 10000) / 10000) * Math.PI * 2;
    // sqrt keeps the distribution even by area instead of crowding the centre.
    const radius = Math.sqrt(((seed >>> 13) % 10000) / 10000) * FIELD_RADIUS;
    return {
      name,
      x: 0.5 + (radius * Math.cos(angle)) / 2,
      y: 0.5 + (radius * Math.sin(angle)) / 2,
    };
  });

  for (let pass = 0; pass < 24; pass += 1) {
    let moved = false;
    for (let a = 0; a < points.length; a += 1)
      for (let b = a + 1; b < points.length; b += 1) {
        const first = points[a]!;
        const second = points[b]!;
        const dx = second.x - first.x;
        const dy = second.y - first.y;
        const distance = Math.hypot(dx, dy);
        if (distance >= MIN_SEPARATION) continue;
        moved = true;
        // Two actors on the exact same point need a deterministic nudge, or
        // the normalized direction would be NaN and they would never separate.
        const nx = distance < 1e-6 ? Math.cos(hash(first.name)) : dx / distance;
        const ny = distance < 1e-6 ? Math.sin(hash(first.name)) : dy / distance;
        const push = (MIN_SEPARATION - distance) / 2;
        first.x -= nx * push;
        first.y -= ny * push;
        second.x += nx * push;
        second.y += ny * push;
      }
    if (!moved) break;
  }

  // Fit what is actually on screen to the field. Without this a small fleet —
  // or a session filter that leaves two actors — sits wherever its names
  // happened to hash, in a corner of an otherwise empty box.
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanY = Math.max(...ys) - Math.min(...ys);
  // One axis is scaled by the same factor as the other, so the arrangement is
  // never stretched out of shape.
  const scale =
    spanX < 1e-6 && spanY < 1e-6
      ? 1
      : Math.min(
          FIELD_RADIUS / Math.max(spanX / 2, 1e-6),
          FIELD_RADIUS / Math.max(spanY / 2, 1e-6),
          // Never magnify past the natural spread: three actors should not be
          // flung to the corners just because there is room.
          1.6,
        );
  const centreX = (Math.max(...xs) + Math.min(...xs)) / 2;
  const centreY = (Math.max(...ys) + Math.min(...ys)) / 2;

  const layout = new Map<string, { x: number; y: number }>();
  for (const point of points)
    layout.set(point.name, {
      // Clamped inside the box so a pushed star cannot leave the field.
      x: Math.min(0.92, Math.max(0.08, 0.5 + (point.x - centreX) * scale)),
      y: Math.min(0.88, Math.max(0.12, 0.5 + (point.y - centreY) * scale)),
    });
  return layout;
}

/** Spreads a single actor dead centre rather than off on a radius. */
function singleton(actor: string): Map<string, { x: number; y: number }> {
  return new Map([[actor, { x: 0.5, y: 0.5 }]]);
}

interface ActorState {
  actor: string;
  provider: string | null;
  session: string | null;
  lastAt: number;
  lastAction: string;
  lastSummary: string | null;
  status: EventStatus | null;
  events: number;
}

export function foldConstellation(
  input: ConstellationInput,
): ConstellationState {
  const { now } = input;
  const events = input.session
    ? input.events.filter((event) => event.session === input.session)
    : input.events;

  const actors = new Map<string, ActorState>();
  const edgeMap = new Map<string, Edge>();
  const flares: Flare[] = [];
  const cards: Card[] = [];
  const sessions = new Map<
    string,
    {
      actors: Set<string>;
      events: number;
      providers: Set<string>;
      live: boolean;
      lastAt: string;
    }
  >();
  /** session → the last actor seen acting, for the weaker `sequence` edges. */
  const lastInSession = new Map<string, string>();
  /** session → whether a later event resolved its blocker. */
  const resolvedAfter = new Map<string, number>();

  const touchEdge = (
    from: string,
    to: string,
    kind: EdgeKind,
    at: number,
    session: string | null,
  ) => {
    if (from === to) return;
    const weight = decay(now - at, EDGE_WINDOW_MS);
    if (weight <= 0) return;
    const key = `${from}>${to}:${kind}`;
    const existing = edgeMap.get(key);
    if (existing) {
      existing.weight = Math.max(existing.weight, weight);
      return;
    }
    if (kind === "sequence") {
      // A pair that already has a reported relationship does not also get the
      // derived one: two lines for one handoff would double-count the traffic.
      if (
        edgeMap.has(`${from}>${to}:spawn`) ||
        edgeMap.has(`${from}>${to}:handoff`)
      )
        return;
    } else {
      // The reported edge supersedes anything ordering had inferred.
      edgeMap.delete(`${from}>${to}:sequence`);
    }
    edgeMap.set(key, { from, to, kind, weight, session });
  };

  // A running actor stays on the field however long it runs; everything else
  // ages out of the retention window. Without this, a long-running agent that
  // has not posted recently vanishes from the field entirely.
  const latestStatus = new Map<string, string | null>();
  for (const event of events)
    latestStatus.set(event.actor, event.status ?? null);

  for (const event of events) {
    const at = timeOf(event);
    if (
      now - at > STAR_RETENTION_MS &&
      latestStatus.get(event.actor) !== "running"
    )
      continue;

    const existing = actors.get(event.actor);
    const state: ActorState = existing ?? {
      actor: event.actor,
      provider: event.provider,
      session: event.session,
      lastAt: at,
      lastAction: event.action,
      lastSummary: event.summary,
      status: event.status,
      events: 0,
    };
    state.events += 1;
    // Later events win: an actor's provider or session can be filled in by a
    // richer event after a minimal first one.
    if (at >= state.lastAt) {
      state.lastAt = at;
      state.lastAction = event.action;
      state.lastSummary = event.summary ?? state.lastSummary;
      state.status = event.status ?? state.status;
      state.provider = event.provider ?? state.provider;
      state.session = event.session ?? state.session;
    }
    actors.set(event.actor, state);

    if (event.parent)
      touchEdge(event.parent, event.actor, "spawn", at, event.session);
    if (event.target)
      touchEdge(event.actor, event.target, "handoff", at, event.session);

    if (event.session) {
      const summary = sessions.get(event.session) ?? {
        actors: new Set<string>(),
        events: 0,
        providers: new Set<string>(),
        live: false,
        lastAt: event.createdAt,
      };
      summary.actors.add(event.actor);
      summary.events += 1;
      if (event.provider) summary.providers.add(event.provider);
      if (event.createdAt > summary.lastAt) summary.lastAt = event.createdAt;
      sessions.set(event.session, summary);

      const previous = lastInSession.get(event.session);
      // Only when the sender named neither relationship: a reported edge is
      // always preferred over one derived from ordering.
      if (previous && !event.parent && !event.target)
        touchEdge(previous, event.actor, "sequence", at, event.session);
      lastInSession.set(event.session, event.actor);

      if (event.status && event.status !== "blocked")
        resolvedAfter.set(event.session, event.id);
    }

    const tone = verdictTone(event.verdict, event.status);
    const notable =
      event.verdict !== null ||
      event.status === "blocked" ||
      event.status === "error";
    if (notable) {
      cards.push({
        id: event.id,
        actor: event.actor,
        provider: event.provider,
        session: event.session,
        action: event.action,
        summary: event.summary,
        verdict: event.verdict,
        status: event.status,
        tone,
        issues: event.issues,
        detail: event.detail,
        source: event.source,
        project: event.project,
        task: event.task,
        awaitingYou: false,
        createdAt: event.createdAt,
      });
      const progress = 1 - decay(now - at, FLARE_WINDOW_MS);
      if (progress < 1) flares.push({ actor: event.actor, tone, progress });
    }
  }

  const names = [...actors.keys()];
  const layout = names.length === 1 ? singleton(names[0]!) : starLayout(names);

  const stars: Star[] = names.sort().map((name) => {
    const state = actors.get(name)!;
    const position = layout.get(name) ?? { x: 0.5, y: 0.5 };
    const live = state.status === "running";
    return {
      actor: name,
      provider: state.provider,
      session: state.session,
      x: position.x,
      y: position.y,
      // A running actor stays fully lit however long it takes; everything
      // else fades on recency.
      activity: live ? 1 : decay(now - state.lastAt, ACTIVITY_WINDOW_MS),
      live,
      status: state.status,
      lastAction: state.lastAction,
      lastSummary: state.lastSummary,
      events: state.events,
    };
  });

  const resolvedCards = cards
    .map((card) => {
      const blocking = card.status === "blocked" || card.tone === "danger";
      const resolution = card.session
        ? resolvedAfter.get(card.session)
        : undefined;
      return {
        ...card,
        // Still waiting only when nothing in that session moved on afterwards,
        // and only for the newest such card per session.
        awaitingYou:
          blocking &&
          (resolution === undefined || resolution <= card.id) &&
          cards.every(
            (other) =>
              other.session !== card.session ||
              other.id <= card.id ||
              !(other.status === "blocked" || other.tone === "danger"),
          ),
      };
    })
    .sort((a, b) => b.id - a.id)
    .slice(0, CARD_LIMIT);

  const sessionList: SessionSummary[] = [...sessions.entries()]
    .map(([session, summary]) => ({
      session,
      actors: summary.actors.size,
      events: summary.events,
      providers: [...summary.providers].sort(),
      live: stars.some((star) => star.session === session && star.live),
      lastAt: summary.lastAt,
    }))
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt));

  return {
    stars,
    edges: [...edgeMap.values()],
    flares,
    cards: resolvedCards,
    sessions: sessionList,
    liveActors: stars.filter((star) => star.live).length,
  };
}
