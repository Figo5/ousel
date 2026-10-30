/**
 * The task view's panels: summary strip, participants, attention, timeline.
 *
 * Presentation only. Every decision about what is true lives in `taskview.ts`;
 * these components print it, and print where it came from.
 */
import { memo } from "react";
import {
  verdictTone,
  type EventRecord,
  type EventStatus,
} from "../../core/events.js";
import {
  QUIET_LABEL,
  formatDuration,
  relativeTime,
  shortSession,
  type AttentionItem,
  type AttentionTone,
  type ParticipantView,
  type TaskView,
} from "../taskview.js";
import { Disclosure, Pill, SourceBadge, type Tone } from "./Bits.js";

/** How many timeline entries are rendered; older ones stay in the data. */
export const TIMELINE_LIMIT = 300;

function statusTone(status: EventStatus): Tone {
  switch (status) {
    case "ok":
      return "success";
    case "error":
      return "danger";
    case "blocked":
      return "warn";
    case "running":
      return "info";
  }
}

function toneOf(value: string | null, status: EventStatus | null = null): Tone {
  return verdictTone(value, status);
}

const ATTENTION_PILL: Record<AttentionTone, { tone: Tone; label: string }> = {
  high: { tone: "danger", label: "High" },
  medium: { tone: "warn", label: "Medium" },
  low: { tone: "info", label: "Low" },
};

const CHANGE_GLYPH: Record<string, string> = {
  added: "+",
  created: "+",
  modified: "~",
  changed: "~",
  deleted: "−",
  removed: "−",
};

function SessionTag({ session }: { session: string }) {
  return (
    <span className="tag tag--session" title={`session ${session}`}>
      session {shortSession(session)}
    </span>
  );
}

export function SummaryStrip({ view, now }: { view: TaskView; now: number }) {
  const latest = view.lastReported;
  const decision = view.reviewerDecisions[view.reviewerDecisions.length - 1];
  const quiet = view.participants.filter((p) => p.inferredQuiet).length;
  return (
    <section className="strip" aria-label="Task summary">
      <div className="tile">
        <span className="tile__label">Last reported</span>
        {latest ? (
          <>
            <span className="tile__value">
              {relativeTime(latest.createdAt, now)}
            </span>
            <span className="tile__note wrap-anywhere">
              {latest.actor} · {latest.action}
            </span>
            <SourceBadge source={latest.source} />
          </>
        ) : (
          <span className="tile__value faint">nothing yet</span>
        )}
      </div>
      <div className="tile">
        <span className="tile__label">Participants</span>
        <span className="tile__value">{view.participants.length}</span>
        <span className="tile__note">
          {quiet > 0
            ? `${quiet} quiet (inferred from inactivity)`
            : "by actor and session"}
        </span>
      </div>
      <div className="tile">
        <span className="tile__label">Checks</span>
        <span className="tile__value">
          {view.capturedChecks} captured · {view.reportedChecks} reported
        </span>
        <span className="tile__note">
          {view.syntheticChecks > 0
            ? `${view.syntheticChecks} synthetic (not evidence)`
            : view.capturedChecks === 0
              ? "no captured validation"
              : "captured = observed by an integration"}
        </span>
      </div>
      <div className="tile">
        <span className="tile__label">Review</span>
        {decision ? (
          <>
            <span className="tile__value wrap-anywhere">
              {decision.verdict}
            </span>
            <span className="tile__note">
              {decision.actor} · {relativeTime(decision.at, now)}
            </span>
          </>
        ) : (
          <span className="tile__value faint">no decision</span>
        )}
      </div>
      <div className="tile">
        <span className="tile__label">Changes</span>
        <span className="tile__value">
          {new Set(view.files.map((file) => file.path)).size} files
        </span>
        <span className="tile__note">
          {view.handoffs.length} handoff{view.handoffs.length === 1 ? "" : "s"}
        </span>
      </div>
    </section>
  );
}

function ParticipantRow({
  participant,
  now,
}: {
  participant: ParticipantView;
  now: number;
}) {
  return (
    <li className="who">
      <div className="who__head">
        <span className="who__actor">{participant.actor}</span>
        {participant.lastStatus ? (
          <Pill tone={statusTone(participant.lastStatus)}>
            {participant.lastStatus}
          </Pill>
        ) : (
          <span className="faint small">no status</span>
        )}
        {participant.inferredQuiet ? (
          <span
            className="quiet"
            title="Derived by Ousel: the last event said running and nothing has been reported for over 10 minutes. This is not a blocker."
          >
            ~ {QUIET_LABEL}
          </span>
        ) : null}
        <span className="faint small who__time">
          {relativeTime(participant.lastAt, now)}
        </span>
      </div>
      <div className="row who__meta">
        {participant.sourceKinds.map((kind) => (
          <SourceBadge key={kind} source={kind} />
        ))}
        {participant.sessions.map((session) => (
          <SessionTag key={session} session={session} />
        ))}
      </div>
      {participant.lastSummary ? (
        <p className="small faint wrap-anywhere">{participant.lastSummary}</p>
      ) : null}
    </li>
  );
}

export function Participants({
  participants,
  now,
}: {
  participants: ParticipantView[];
  now: number;
}) {
  return (
    <section className="panel" aria-labelledby="who-h">
      <h2 id="who-h">Who is working on this</h2>
      {participants.length === 0 ? (
        <p className="faint small">No one has reported on this task.</p>
      ) : (
        <ul className="who-list">
          {participants.map((participant) => (
            <ParticipantRow
              key={participant.actor}
              participant={participant}
              now={now}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export function Evidence({ view, now }: { view: TaskView; now: number }) {
  const checks = [...view.checks].reverse();
  return (
    <section className="panel" aria-labelledby="evidence-h">
      <h2 id="evidence-h">Validation evidence</h2>
      <p className="faint small">
        {view.capturedChecks} captured · {view.reportedChecks} reported
        {view.syntheticChecks > 0
          ? ` · ${view.syntheticChecks} synthetic (not evidence)`
          : ""}
      </p>
      {checks.length === 0 ? (
        <p className="faint small">
          No checks recorded. That is an absence of evidence, not a pass.
        </p>
      ) : (
        <ul className="checks">
          {checks.slice(0, 12).map((check, index) => (
            <li key={`${check.at}-${check.name}-${index}`} className="check">
              <span className="check__name wrap-anywhere">{check.name}</span>
              <Pill tone={toneOf(check.result)}>{check.result}</Pill>
              <SourceBadge
                source={check.source}
                label={`evidence: ${check.evidence}`}
              />
              <span className="faint small">
                {check.actor} · {relativeTime(check.at, now)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function AttentionList({
  items,
  now,
}: {
  items: AttentionItem[];
  now: number;
}) {
  return (
    <section className="panel" aria-labelledby="attn-h">
      <h2 id="attn-h">Needs attention</h2>
      {items.length === 0 ? (
        <p className="calm">
          <span aria-hidden="true">✓</span> Nothing needs attention. That covers
          only what has been reported; silence is not a sign of progress.
        </p>
      ) : (
        <ul className="attn-list">
          {items.map((item) => {
            const pill = ATTENTION_PILL[item.tone];
            return (
              <li key={item.id} className={`attn attn--${item.tone}`}>
                <div className="attn__head">
                  <Pill tone={pill.tone}>{pill.label}</Pill>
                  <span className="attn__title wrap-anywhere">
                    {item.title}
                  </span>
                </div>
                <p className="small faint wrap-anywhere">{item.detail}</p>
                <div className="row attn__meta">
                  <SourceBadge source={item.source} />
                  <span className="faint small">
                    {relativeTime(item.at, now)}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const TimelineEntry = memo(function TimelineEntry({
  event,
  now,
}: {
  event: EventRecord;
  now: number;
}) {
  const verdictPillTone = event.verdict
    ? toneOf(event.verdict, event.status)
    : "neutral";
  return (
    <li className={`entry entry--${event.source}`}>
      <div className="entry__head">
        <SourceBadge source={event.source} />
        <span className="entry__actor">{event.actor}</span>
        {event.session ? <SessionTag session={event.session} /> : null}
        <span className="faint small">{event.action}</span>
        {event.provider ? (
          <span className="faint small">· {event.provider}</span>
        ) : null}
        <span className="faint small entry__time" title={event.createdAt}>
          {relativeTime(event.createdAt, now)}
        </span>
      </div>

      {event.status || event.verdict ? (
        <div className="row">
          {event.status ? (
            <Pill tone={statusTone(event.status)}>{event.status}</Pill>
          ) : null}
          {event.verdict ? (
            <Pill tone={verdictPillTone}>verdict: {event.verdict}</Pill>
          ) : null}
        </div>
      ) : null}

      {event.summary ? <p className="entry__summary">{event.summary}</p> : null}

      {event.target || event.parent ? (
        <p className="small faint wrap-anywhere">
          {event.target ? (
            <span className="link">
              <span aria-hidden="true">{event.actor} →</span>
              <span className="sr-only">hands off to</span> {event.target}
            </span>
          ) : null}
          {event.target && event.parent ? " · " : ""}
          {event.parent ? (
            <span className="link">
              <span aria-hidden="true">↳</span> spawned by {event.parent}
            </span>
          ) : null}
        </p>
      ) : null}

      {event.files.length > 0 ? (
        <ul className="chips" aria-label="Files">
          {event.files.map((file, index) => (
            <li
              key={`${file.path}-${index}`}
              className="file-chip"
              title={file.change ?? "change not stated"}
            >
              <span aria-hidden="true">
                {Object.hasOwn(CHANGE_GLYPH, (file.change ?? "").toLowerCase())
                  ? CHANGE_GLYPH[(file.change ?? "").toLowerCase()]
                  : "·"}
              </span>{" "}
              {file.path}
              {file.change ? (
                <span className="faint"> ({file.change})</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {event.checks.length > 0 ? (
        <ul className="checks" aria-label="Checks">
          {event.checks.map((check, index) => (
            <li key={`${check.name}-${index}`} className="check">
              <span className="check__name wrap-anywhere">{check.name}</span>
              <Pill tone={toneOf(check.result)}>{check.result}</Pill>
              <SourceBadge
                source={check.evidence}
                label={`evidence: ${check.evidence}`}
              />
              {check.durationMs !== null ? (
                <span className="faint small">
                  {formatDuration(check.durationMs)}
                </span>
              ) : null}
              {check.command ? (
                <code className="check__cmd wrap-anywhere">
                  {check.command}
                </code>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {event.issues.length > 0 ? (
        <Disclosure summary={`Findings (${event.issues.length})`}>
          <ul className="findings">
            {event.issues.map((issue, index) => (
              <li key={`${event.id}-${index}`} className="small wrap-anywhere">
                {issue.severity ? <b>{issue.severity}</b> : null}
                {issue.path
                  ? ` · ${issue.path}${issue.line ? `:${issue.line}` : ""}`
                  : ""}
                {issue.severity || issue.path ? " — " : ""}
                {issue.description}
              </li>
            ))}
          </ul>
        </Disclosure>
      ) : null}

      {Object.keys(event.detail).length > 0 ? (
        <Disclosure summary="Detail">
          <pre className="detail">{JSON.stringify(event.detail, null, 2)}</pre>
        </Disclosure>
      ) : null}
    </li>
  );
});

export function Timeline({
  events,
  now,
}: {
  events: readonly EventRecord[];
  now: number;
}) {
  const shown =
    events.length > TIMELINE_LIMIT
      ? events.slice(events.length - TIMELINE_LIMIT)
      : events;
  return (
    <section className="panel" aria-labelledby="timeline-h">
      <h2 id="timeline-h">Timeline</h2>
      {events.length > TIMELINE_LIMIT ? (
        <p className="faint small">
          Showing last {TIMELINE_LIMIT} of {events.length} events on this task.
        </p>
      ) : null}
      {shown.length === 0 ? (
        <p className="faint small">No events on this task yet.</p>
      ) : (
        <ol className="timeline">
          {shown.map((event) => (
            <TimelineEntry key={event.id} event={event} now={now} />
          ))}
        </ol>
      )}
    </section>
  );
}
