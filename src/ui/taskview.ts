/**
 * Task view model: folds the event stream into one task's story.
 *
 * Pure — no React, no DOM, no network — so everything the task view claims is
 * asserted in `tests/taskview.test.ts`.
 *
 * Only explicit fields are used. A participant is who reported; a handoff is an
 * event that named a `target`; a reviewer decision is an event that carried a
 * `verdict`; a check is something in `checks`. Nothing is guessed, and there is
 * exactly one derived state: a participant whose last event said `running` and
 * who has since gone silent is *quiet*. That is labelled as inferred and is
 * never presented as blocked — silence means stale, not stuck.
 */
import type {
  CheckEvidence,
  EventRecord,
  EventSource,
  EventStatus,
  EventIssue,
} from "../core/events.js";

/** Identity given to events that carry no `project` or `task`. */
export const UNASSIGNED = "unassigned";
/** How long a "running" participant may be silent before it is called quiet. */
export const QUIET_AFTER_MS = 10 * 60_000;
export const QUIET_LABEL = "quiet — status unknown (inferred from inactivity)";

export type AttentionSource = EventSource | "inferred";
export type AttentionTone = "high" | "medium" | "low";

export interface TaskRef {
  project: string;
  task: string;
  events: number;
  lastId: number;
  lastAt: string;
}

export interface ParticipantView {
  actor: string;
  /** Session ids this actor reported under; actor and session stay distinct. */
  sessions: string[];
  lastAt: string;
  /** The status on the actor's last event; null when that event named none. */
  lastStatus: EventStatus | null;
  sourceKinds: EventSource[];
  lastSummary: string | null;
  /** Last event said `running` and is older than {@link QUIET_AFTER_MS}. */
  quiet: boolean;
  /** Same fact, named for what it is: derived by the viewer, not reported. */
  inferredQuiet: boolean;
}

export interface HandoffView {
  from: string;
  to: string;
  at: string;
  source: EventSource;
}

export interface ReviewerDecision {
  actor: string;
  verdict: string;
  summary: string | null;
  issues: EventIssue[];
  at: string;
  source: EventSource;
}

export interface CheckView {
  name: string;
  result: string;
  evidence: CheckEvidence;
  command: string | null;
  durationMs: number | null;
  actor: string;
  at: string;
  /** The source of the event that carried this check. */
  source: EventSource;
}

export interface FileView {
  path: string;
  change: string | null;
  actor: string;
  at: string;
}

export interface TaskView {
  /** Chronological. */
  events: EventRecord[];
  participants: ParticipantView[];
  handoffs: HandoffView[];
  reviewerDecisions: ReviewerDecision[];
  checks: CheckView[];
  files: FileView[];
  lastReported: EventRecord | null;
  capturedChecks: number;
  reportedChecks: number;
  /** Checks from synthetic demo events, never counted as real evidence. */
  syntheticChecks: number;
  activityCount: number;
}

export interface AttentionItem {
  id: string;
  tone: AttentionTone;
  title: string;
  detail: string;
  /**
   * `captured`/`reported`/`synthetic` mean an explicit event says so, as
   * recorded. `inferred` means the viewer derived it from an absence.
   */
  source: AttentionSource;
  actor: string | null;
  at: string;
}

export function projectOf(event: EventRecord): string {
  return event.project ?? UNASSIGNED;
}

export function taskOf(event: EventRecord): string {
  return event.task ?? UNASSIGNED;
}

export function taskKey(project: string, task: string): string {
  return JSON.stringify([project, task]);
}

function timeOf(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Every task seen in the stream, most recently active first. */
export function listTasks(events: readonly EventRecord[]): TaskRef[] {
  const tasks = new Map<string, TaskRef>();
  for (const event of events) {
    const project = projectOf(event);
    const task = taskOf(event);
    const key = taskKey(project, task);
    const existing = tasks.get(key);
    if (!existing) {
      tasks.set(key, {
        project,
        task,
        events: 1,
        lastId: event.id,
        lastAt: event.createdAt,
      });
      continue;
    }
    existing.events += 1;
    if (event.id > existing.lastId) {
      existing.lastId = event.id;
      existing.lastAt = event.createdAt;
    }
  }
  return [...tasks.values()].sort((a, b) => b.lastId - a.lastId);
}

/**
 * The saved selection if it still exists, otherwise the most recently active
 * task, otherwise null for an empty stream.
 */
export function pickTask(
  tasks: readonly TaskRef[],
  saved: { project: string; task: string } | null,
): { project: string; task: string } | null {
  if (
    saved &&
    tasks.some(
      (ref) => ref.project === saved.project && ref.task === saved.task,
    )
  )
    return saved;
  const first = tasks[0];
  return first ? { project: first.project, task: first.task } : null;
}

const SOURCE_ORDER: readonly EventSource[] = [
  "captured",
  "reported",
  "synthetic",
];

export function foldTaskView(
  allEvents: readonly EventRecord[],
  project: string,
  task: string,
  now: number,
): TaskView {
  const events = allEvents
    .filter((event) => projectOf(event) === project && taskOf(event) === task)
    .sort((a, b) => a.id - b.id);

  const byActor = new Map<
    string,
    {
      sessions: Set<string>;
      sources: Set<EventSource>;
      last: EventRecord;
      lastSummary: string | null;
    }
  >();
  const handoffs: HandoffView[] = [];
  const reviewerDecisions: ReviewerDecision[] = [];
  const checks: CheckView[] = [];
  const files: FileView[] = [];

  for (const event of events) {
    // The integration's own connection receipt is part of the timeline, but
    // "ousel" is not an agent working on the task. Do not count it as one.
    const systemReceipt =
      event.actor === "ousel" && event.action === "integration_connected";
    if (!systemReceipt) {
      const entry = byActor.get(event.actor) ?? {
        sessions: new Set<string>(),
        sources: new Set<EventSource>(),
        last: event,
        lastSummary: null,
      };
      if (event.session) entry.sessions.add(event.session);
      entry.sources.add(event.source);
      entry.last = event;
      if (event.summary) entry.lastSummary = event.summary;
      byActor.set(event.actor, entry);
    }

    if (event.target)
      handoffs.push({
        from: event.actor,
        to: event.target,
        at: event.createdAt,
        source: event.source,
      });
    if (event.verdict)
      reviewerDecisions.push({
        actor: event.actor,
        verdict: event.verdict,
        summary: event.summary,
        issues: event.issues,
        at: event.createdAt,
        source: event.source,
      });
    for (const check of event.checks)
      checks.push({
        name: check.name,
        result: check.result,
        evidence: check.evidence,
        command: check.command,
        durationMs: check.durationMs,
        actor: event.actor,
        at: event.createdAt,
        source: event.source,
      });
    for (const file of event.files)
      files.push({
        path: file.path,
        change: file.change,
        actor: event.actor,
        at: event.createdAt,
      });
  }

  const participants: ParticipantView[] = [...byActor.entries()]
    .map(([actor, entry]) => {
      const quiet =
        entry.last.status === "running" &&
        now - timeOf(entry.last.createdAt) > QUIET_AFTER_MS;
      return {
        actor,
        sessions: [...entry.sessions].sort(),
        lastAt: entry.last.createdAt,
        lastStatus: entry.last.status,
        sourceKinds: SOURCE_ORDER.filter((kind) => entry.sources.has(kind)),
        lastSummary: entry.lastSummary,
        quiet,
        inferredQuiet: quiet,
      };
    })
    .sort(
      (a, b) =>
        timeOf(b.lastAt) - timeOf(a.lastAt) || a.actor.localeCompare(b.actor),
    );

  const realChecks = checks.filter((check) => check.source !== "synthetic");
  const capturedChecks = realChecks.filter(
    (check) => check.evidence === "captured",
  ).length;

  return {
    events,
    participants,
    handoffs,
    reviewerDecisions,
    checks,
    files,
    lastReported: events[events.length - 1] ?? null,
    capturedChecks,
    reportedChecks: realChecks.length - capturedChecks,
    syntheticChecks: checks.length - realChecks.length,
    activityCount: events.length,
  };
}

/** Verdicts that ask for more work or reject it. */
const NEGATIVE_VERDICT =
  /(needs[-_\s]?fix|request(?:ed)?[-_\s]?changes|changes[-_\s]?requested|(?<!\bno[-_\s])\bchanges\b|reject|fail|\bdeny\b|denied)/i;
/** Verdicts that read as approval. Checked after the negative family. */
const APPROVAL_VERDICT =
  /\b(approve|approved|accept|accepted|pass|passed|lgtm|ok|success)\b/i;

export function isNegativeVerdict(verdict: string): boolean {
  return NEGATIVE_VERDICT.test(verdict);
}

export function isApprovalVerdict(verdict: string): boolean {
  return !isNegativeVerdict(verdict) && APPROVAL_VERDICT.test(verdict);
}

const TONE_RANK: Record<AttentionTone, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/**
 * What needs a human's eye, most urgent first.
 *
 * Every item says where it came from. Items that quote an explicit event carry
 * that event's source; items that rest on an absence — no reviewer, a silent
 * participant — are `inferred`. Silence is never turned into `blocked`.
 */
export function attentionItems(view: TaskView, now: number): AttentionItem[] {
  const items = new Map<string, AttentionItem>();
  const add = (item: AttentionItem) => {
    if (!items.has(item.id)) items.set(item.id, item);
  };
  const where = (event: EventRecord) =>
    event.session ? ` (session ${event.session})` : "";

  // Rules a and b work per actor+session: one participant's progress must not
  // clear another's blocker.
  const latestStatus = new Map<string, EventRecord>();
  const latestError = new Map<string, EventRecord>();
  const latestOk = new Map<string, EventRecord>();
  for (const event of view.events) {
    const key = `${event.actor}\u0000${event.session ?? ""}`;
    if (event.status) latestStatus.set(key, event);
    if (event.status === "error") latestError.set(key, event);
    if (event.status === "ok") latestOk.set(key, event);
  }

  for (const [key, event] of latestStatus)
    if (event.status === "blocked")
      add({
        id: `blocked:${key}`,
        tone: "high",
        title: `${event.actor} reported blocked`,
        detail: `${event.summary ?? "No summary was given."}${where(event)}`,
        source: event.source,
        actor: event.actor,
        at: event.createdAt,
      });

  for (const [key, event] of latestError) {
    const ok = latestOk.get(key);
    if (ok && ok.id > event.id) continue;
    add({
      id: `error:${key}`,
      tone: "high",
      title: `${event.actor} reported an error`,
      detail: `${event.summary ?? "No summary was given."}${where(event)} No later ok from this actor and session.`,
      source: event.source,
      actor: event.actor,
      at: event.createdAt,
    });
  }

  // Rules c and d look at each reviewer's most recent verdict.
  const latestVerdict = new Map<string, EventRecord>();
  for (const event of view.events)
    if (event.verdict) latestVerdict.set(event.actor, event);
  const approvals = view.events.filter(
    (event) => event.verdict !== null && isApprovalVerdict(event.verdict),
  );
  let newestApproval: EventRecord | null = null;
  for (const event of latestVerdict.values()) {
    const verdict = event.verdict ?? "";
    if (isNegativeVerdict(verdict)) {
      // A later approval from anyone means the request may have been answered,
      // but it does not prove the fix addressed this finding. Keep it visible,
      // lower it, and say exactly what the later evidence is.
      const later = approvals.find((approval) => approval.id > event.id);
      add({
        id: `verdict:${event.actor}`,
        tone: later ? "medium" : "high",
        title: later
          ? `${event.actor} requested changes; ${later.actor} later approved`
          : `${event.actor} reviewed: ${verdict}`,
        detail:
          (event.summary ??
            (event.issues.length > 0
              ? `${event.issues.length} finding${event.issues.length === 1 ? "" : "s"} reported.`
              : "No summary was given.")) +
          (later
            ? ` A later approval by ${later.actor} exists; confirm the finding was actually addressed.`
            : ""),
        source: event.source,
        actor: event.actor,
        at: event.createdAt,
      });
    } else if (
      isApprovalVerdict(verdict) &&
      (!newestApproval || event.id > newestApproval.id)
    )
      newestApproval = event;
  }
  if (newestApproval && view.capturedChecks === 0)
    add({
      id: "approval-without-captured-checks",
      tone: "medium",
      title: "Review approved without captured validation",
      detail:
        `${newestApproval.actor} said “${newestApproval.verdict}”. A verdict is a decision, not test evidence: ` +
        (view.reportedChecks > 0
          ? `${view.reportedChecks} check${view.reportedChecks === 1 ? " is" : "s are"} reported but none were captured.`
          : "no check was recorded for this task."),
      source: newestApproval.source,
      actor: newestApproval.actor,
      at: newestApproval.createdAt,
    });

  // Rule e: the newest handoff to each target that has not acted since.
  const unanswered = new Map<string, EventRecord>();
  for (const event of view.events) {
    // Acting at all clears every earlier handoff to this actor...
    unanswered.delete(event.actor);
    // ...and then this event may hand work on to someone else.
    if (event.target && event.target !== event.actor)
      unanswered.set(event.target, event);
  }
  for (const [target, event] of unanswered)
    add({
      id: `handoff:${target}`,
      tone: "medium",
      title: `Handoff awaiting ${target}`,
      detail: `${event.actor} handed work to ${target}${where(event)}; ${target} has reported nothing since.`,
      source: event.source,
      actor: target,
      at: event.createdAt,
    });

  // Rule f: work finished, but nobody has reviewed it.
  const finished = view.events.some(
    (event) => event.status === "ok" || /^completed?$/i.test(event.action),
  );
  if (finished && view.reviewerDecisions.length === 0 && view.lastReported)
    add({
      id: "no-reviewer-decision",
      tone: "low",
      title: "No reviewer decision yet",
      detail:
        "Something on this task reported ok or completed, and no event carries a verdict.",
      source: "inferred",
      actor: null,
      at: view.lastReported.createdAt,
    });

  // Rule g: the only inferred participant state.
  for (const participant of view.participants)
    if (participant.inferredQuiet)
      add({
        id: `quiet:${participant.actor}`,
        tone: "low",
        title: `${participant.actor} is ${QUIET_LABEL}`,
        detail: `Last said running at ${participant.lastAt}. Silence is not a blocker; ask the agent if it matters.`,
        source: "inferred",
        actor: participant.actor,
        at: participant.lastAt,
      });

  return [...items.values()].sort(
    (a, b) =>
      TONE_RANK[a.tone] - TONE_RANK[b.tone] ||
      timeOf(b.at) - timeOf(a.at) ||
      a.id.localeCompare(b.id),
  );
}

/** "12s ago", "4m ago", "3h ago", then a date. Never negative. */
export function relativeTime(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return new Date(at).toLocaleDateString();
}

export function sourceLabel(source: AttentionSource): string {
  switch (source) {
    case "captured":
      return "captured";
    case "reported":
      return "reported";
    case "synthetic":
      return "synthetic";
    case "inferred":
      return "inferred";
  }
}

/** What each source does and does not prove, for a tooltip. */
export function sourceHint(source: AttentionSource): string {
  switch (source) {
    case "captured":
      return "Observed by an integration, not claimed by a model.";
    case "reported":
      return "Posted by an agent or a person. A claim, not an observation.";
    case "synthetic":
      return "Demo or fixture data. Not real activity.";
    case "inferred":
      return "Derived by Ousel from absence or inactivity. Nothing reported this.";
  }
}

/** A session id short enough for a row; the full id stays in the tooltip. */
export function shortSession(session: string, max = 12): string {
  return session.length <= max ? session : `${session.slice(0, max - 1)}…`;
}

export function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return "";
  if (durationMs < 1000) return `${durationMs}ms`;
  const seconds = durationMs / 1000;
  return seconds < 60
    ? `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
    : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}
