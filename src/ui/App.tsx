/**
 * The application: one screen, two views.
 *
 * "Task" (the default) answers who is working on a task, what changed, what was
 * checked and what needs attention. "Field" is the constellation with its
 * session strip and activity column. There is no router, because there is
 * nowhere else to go.
 *
 * There is no alert()/confirm()/prompt() anywhere in this UI, and every failure
 * renders in place.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "./api.js";
import { foldConstellation, type Card } from "./constellation.js";
import { useAction, useBootstrap, useEventStream } from "./hooks.js";
import {
  attentionItems,
  foldTaskView,
  listTasks,
  pickTask,
  relativeTime,
  taskKey,
} from "./taskview.js";
import { Field } from "./components/Field.js";
import {
  AttentionList,
  Evidence,
  Participants,
  SummaryStrip,
  Timeline,
} from "./components/TaskPanels.js";
import {
  Button,
  Disclosure,
  ErrorBox,
  Notice,
  Pill,
  SourceBadge,
  TextArea,
} from "./components/Bits.js";

function CardView({
  card,
  now,
  onReply,
}: {
  card: Card;
  now: number;
  onReply: (card: Card, text: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const sent = await onReply(card, text);
    setBusy(false);
    if (sent) {
      setText("");
      setOpen(false);
    } else setError("The reply was not accepted. Nothing was sent.");
  };

  return (
    <li
      className={`card-row card-row--${card.tone}${
        card.awaitingYou ? " card-row--blocking" : ""
      }`}
    >
      <div className="card-row__head">
        <span className="card-row__actor">{card.actor}</span>
        {card.verdict ? (
          <Pill
            tone={
              card.tone === "neutral"
                ? "info"
                : card.tone === "success"
                  ? "success"
                  : card.tone
            }
          >
            {card.verdict}
          </Pill>
        ) : null}
        <SourceBadge source={card.source} />
        {card.status === "blocked" ? (
          <Pill tone="warn">Blocked</Pill>
        ) : card.tone === "danger" ? (
          <Pill tone="danger">Failed</Pill>
        ) : card.awaitingYou ? (
          <Pill tone="warn">Unresolved</Pill>
        ) : null}
        <span className="faint small card-row__time">
          {relativeTime(card.createdAt, now)}
        </span>
      </div>

      {card.summary ? (
        <p className="card-row__summary">{card.summary}</p>
      ) : (
        <p className="card-row__summary faint">
          {card.action} — no summary reported
        </p>
      )}

      <p className="faint small wrap-anywhere">
        {card.action}
        {card.provider ? ` · ${card.provider}` : ""}
        {card.session ? ` · ${card.session}` : ""}
        {card.issues.length > 0
          ? ` · ${card.issues.length} finding${card.issues.length === 1 ? "" : "s"}`
          : ""}
      </p>

      {card.issues.length > 0 ? (
        <Disclosure summary={`Findings (${card.issues.length})`}>
          <ul className="findings">
            {card.issues.map((issue, index) => (
              <li key={`${card.id}-${index}`} className="small wrap-anywhere">
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

      {Object.keys(card.detail).length > 0 ? (
        <Disclosure summary="Detail">
          <pre className="detail">{JSON.stringify(card.detail, null, 2)}</pre>
        </Disclosure>
      ) : null}

      {card.session ? (
        open ? (
          <div className="stack--tight">
            <TextArea
              value={text}
              onChange={setText}
              rows={3}
              ariaLabel={`Reply to ${card.actor}`}
              placeholder="Your agent sees this on the session stream."
            />
            <div className="row">
              <Button
                size="sm"
                variant="primary"
                disabled={busy || text.trim().length === 0}
                onClick={() => void submit()}
              >
                Send reply
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
            {error ? <ErrorBox error={error} /> : null}
          </div>
        ) : (
          <div className="row">
            <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
              Reply
            </Button>
          </div>
        )
      ) : null}
    </li>
  );
}

const SELECTION_KEY = "ousel.task";

function loadSelection(): { project: string; task: string } | null {
  try {
    const raw = window.localStorage.getItem(SELECTION_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { project?: unknown }).project === "string" &&
      typeof (parsed as { task?: unknown }).task === "string"
    )
      return parsed as { project: string; task: string };
  } catch {
    // Storage blocked or corrupt: fall back to the most recent task.
  }
  return null;
}

function saveSelection(selection: { project: string; task: string }) {
  try {
    window.localStorage.setItem(SELECTION_KEY, JSON.stringify(selection));
  } catch {
    // Not persisting is acceptable; the selection still works for this page.
  }
}

function useWide(): boolean {
  const query = "(min-width: 1100px)";
  const [wide, setWide] = useState(
    () =>
      typeof window.matchMedia === "function" &&
      window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const listener = () => setWide(media.matches);
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, []);
  return wide;
}

type ViewName = "task" | "field";

export function App() {
  const client = useMemo(() => createClient({ baseUrl: "" }), []);
  const bootstrap = useBootstrap(client);
  const [view, setView] = useState<ViewName>("task");
  const [session, setSession] = useState<string | null>(null);
  const [actor, setActor] = useState<string | null>(null);
  const [saved, setSaved] = useState(loadSelection);
  const [miniOpen, setMiniOpen] = useState(false);
  const wide = useWide();
  const reply = useAction(client);

  // Subscribe immediately: the live stream must not wait on the (sometimes slow)
  // bootstrap fetch. Bootstrap only supplies the token and the seed window.
  const stream = useEventStream({
    client,
    session: null,
    enabled: true,
    seed: bootstrap.data?.events,
  });

  const tasks = useMemo(() => listTasks(stream.events), [stream.events]);
  const selected = useMemo(() => pickTask(tasks, saved), [tasks, saved]);

  // Folds are memoized on the stream; `now` is refreshed once a minute so
  // relative times and the inferred "quiet" label move without a new event.
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setTick(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const taskView = useMemo(
    () =>
      selected
        ? foldTaskView(stream.events, selected.project, selected.task, tick)
        : null,
    [stream.events, selected, tick],
  );
  const attention = useMemo(
    () => (taskView ? attentionItems(taskView, tick) : []),
    [taskView, tick],
  );

  const state = useMemo(
    () =>
      foldConstellation({ events: stream.events, session, now: Date.now() }),
    [stream.events, session],
  );
  const taskEvents = taskView?.events;

  const onReply = useCallback(
    async (card: Card, text: string) => {
      const result = await reply.run((api) =>
        api.send({
          actor: "operator",
          action: "reply",
          session: card.session,
          target: card.actor,
          summary: text,
          status: "ok",
          ...(card.project ? { project: card.project } : {}),
          ...(card.task ? { task: card.task } : {}),
        }),
      );
      return Boolean(result && result.accepted === 1);
    },
    [reply],
  );

  const visibleCards = actor
    ? state.cards.filter((card) => card.actor === actor)
    : state.cards;
  const blocked = state.cards.filter(
    (card) => card.status === "blocked" && card.awaitingYou,
  ).length;

  // Render the shell immediately, from whatever has arrived: a slow or stalled
  // bootstrap must never wall the whole page behind a spinner. Only a bootstrap
  // that has finished *without* data is a failure worth its own screen.
  if (!bootstrap.data && !bootstrap.loading)
    return (
      <div className="app app--empty">
        <div className="stack" style={{ maxWidth: 560 }}>
          <h1>Cannot reach the server</h1>
          <ErrorBox
            error={bootstrap.error}
            onRetry={() => void bootstrap.reload()}
          />
          <p className="faint small">
            This page talks only to the server that served it. Start it with{" "}
            <code>npm start</code>, then retry.
          </p>
        </div>
      </div>
    );

  const empty = stream.events.length === 0;
  const total = Math.max(bootstrap.data?.total ?? 0, stream.events.length);
  const connection = bootstrap.loading
    ? "connecting"
    : stream.status === "live"
      ? "live"
      : stream.status === "unsupported"
        ? "no EventSource in this browser"
        : stream.status;

  const emptyHelp = (
    <div className="empty">
      <h2>Nothing has reported yet</h2>
      <p className="faint">
        Ousel only shows what agents send it. Send one event to see it here:
      </p>
      <pre className="detail">{`curl -s localhost:4317/ingest \\
  -H 'content-type: application/json' \\
  -d '{"actor":"my-agent","action":"hello","status":"running","project":"demo","task":"first-task"}'`}</pre>
      <p className="faint">To connect Claude Code instead:</p>
      <pre className="detail">npm run connect:claude</pre>
      <p className="faint small">
        See docs/claude-code-integration.md. If you are using a different port,
        replace 4317 above.
      </p>
    </div>
  );

  return (
    <div className="app">
      <header className="bar">
        <span className="brand">OUSEL</span>
        {tasks.length > 0 && selected ? (
          <label className="bar__task">
            <span className="sr-only">Project and task</span>
            <select
              value={taskKey(selected.project, selected.task)}
              onChange={(event) => {
                const next = tasks.find(
                  (ref) =>
                    taskKey(ref.project, ref.task) === event.target.value,
                );
                if (!next) return;
                const choice = { project: next.project, task: next.task };
                setSaved(choice);
                saveSelection(choice);
              }}
            >
              {tasks.map((ref) => (
                <option
                  key={taskKey(ref.project, ref.task)}
                  value={taskKey(ref.project, ref.task)}
                >
                  {ref.project} / {ref.task} ({ref.events})
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <span className="bar__stat">
          {total} event{total === 1 ? "" : "s"}
        </span>
        <span className="bar__spacer" />
        <div className="toggle" role="group" aria-label="View">
          {(["task", "field"] as const).map((name) => (
            <button
              type="button"
              key={name}
              className={`toggle__btn${view === name ? " toggle__btn--on" : ""}`}
              aria-pressed={view === name}
              onClick={() => setView(name)}
            >
              {name === "task" ? "Task" : "Field"}
            </button>
          ))}
        </div>
        <span
          className={`bar__stream bar__stream--${stream.status}`}
          role="status"
        >
          {connection}
        </span>
      </header>

      {stream.status === "reconnecting" ? (
        <div className="banner" role="status">
          Reconnecting — what you see may be out of date until the stream
          resumes.
        </div>
      ) : null}

      {view === "task" ? (
        <main className="task">
          {empty ? (
            emptyHelp
          ) : taskView ? (
            <>
              <div className="task__main">
                <SummaryStrip view={taskView} now={tick} />
                <AttentionList items={attention} now={tick} />
                <Timeline events={taskView.events} now={tick} />
              </div>
              <aside className="task__side" aria-label="Participants and field">
                <Participants participants={taskView.participants} now={tick} />
                <Evidence view={taskView} now={tick} />
                <section className="panel">
                  <div className="column__head">
                    <h2>Constellation</h2>
                    {wide ? null : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setMiniOpen(!miniOpen)}
                      >
                        {miniOpen ? "Hide" : "Show"}
                      </Button>
                    )}
                  </div>
                  {wide || miniOpen ? (
                    <div className="mini">
                      <Field
                        events={taskEvents ?? []}
                        session={null}
                        onSelectActor={() => {}}
                      />
                    </div>
                  ) : null}
                </section>
              </aside>
            </>
          ) : null}
        </main>
      ) : (
        <>
          <div className="bar__sub faint small">
            {state.stars.length} agent{state.stars.length === 1 ? "" : "s"}
            {state.liveActors > 0
              ? ` · ${state.liveActors} reporting running`
              : ""}
            {blocked > 0 ? ` · ${blocked} explicitly blocked` : ""}
          </div>
          {state.sessions.length > 0 ? (
            <div className="sessions" role="group" aria-label="Sessions">
              <button
                type="button"
                className={`chip${session === null ? " chip--on" : ""}`}
                onClick={() => setSession(null)}
              >
                All sessions
              </button>
              {state.sessions.map((item) => (
                <button
                  type="button"
                  key={item.session}
                  className={`chip${session === item.session ? " chip--on" : ""}${
                    item.live ? " chip--live" : ""
                  }`}
                  onClick={() =>
                    setSession(session === item.session ? null : item.session)
                  }
                  title={`${item.actors} agents · ${item.events} events${
                    item.providers.length > 0
                      ? ` · ${item.providers.join(", ")}`
                      : ""
                  }`}
                >
                  {item.session}
                  <span className="chip__count">{item.actors}</span>
                </button>
              ))}
            </div>
          ) : null}

          <main className="stage">
            <div className="field">
              <Field
                events={stream.events}
                session={session}
                onSelectActor={setActor}
              />
              {empty ? <div className="field__empty">{emptyHelp}</div> : null}
            </div>

            <aside className="column" aria-label="Activity">
              <div className="column__head">
                <h2>{actor ? actor : "Activity"}</h2>
                {actor ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setActor(null)}
                  >
                    Clear
                  </Button>
                ) : null}
              </div>
              {reply.notice ? (
                <Notice tone="success">{reply.notice}</Notice>
              ) : null}
              {visibleCards.length === 0 ? (
                <p className="faint small">
                  Verdicts, blockers and errors land here. Anything an agent
                  sends with a <code>verdict</code>, or a <code>status</code> of{" "}
                  <code>blocked</code> or <code>error</code>, shows up with its
                  summary line.
                </p>
              ) : (
                <ul className="card-list">
                  {visibleCards.map((card) => (
                    <CardView
                      key={card.id}
                      card={card}
                      now={tick}
                      onReply={onReply}
                    />
                  ))}
                </ul>
              )}
            </aside>
          </main>
        </>
      )}
    </div>
  );
}
