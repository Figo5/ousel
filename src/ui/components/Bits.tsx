/**
 * Shared presentational primitives.
 *
 * Intentionally dumb: no data fetching, no rules beyond presentation.
 */
import type { ReactNode } from "react";
import { sourceHint, sourceLabel, type AttentionSource } from "../taskview.js";

/** The status vocabulary the stylesheet knows how to colour. */
export type Tone =
  | "neutral"
  | "active"
  | "success"
  | "warn"
  | "danger"
  | "info"
  | "muted";

export function classNames(
  ...values: (string | false | null | undefined)[]
): string {
  return values.filter(Boolean).join(" ");
}

export function Pill({
  tone = "neutral",
  children,
  dot = true,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  dot?: boolean;
  title?: string;
}) {
  return (
    <span
      className={classNames("pill", `pill--${tone}`, dot && "pill--dot")}
      title={title}
    >
      {children}
    </span>
  );
}

const SOURCE_GLYPH = {
  captured: "◆",
  reported: "◇",
  synthetic: "▨",
  inferred: "~",
} as const;

/**
 * Where a fact came from. The glyph and the border pattern (solid, thin,
 * dashed, dotted) both differ per source, so it never depends on hue.
 */
export function SourceBadge({
  source,
  label,
}: {
  source: AttentionSource;
  /** Overrides the word, e.g. "evidence: captured". */
  label?: string;
}) {
  return (
    <span
      className={classNames("src", `src--${source}`)}
      title={sourceHint(source)}
    >
      <span aria-hidden="true">{SOURCE_GLYPH[source]}</span>{" "}
      {label ?? sourceLabel(source)}
    </span>
  );
}

/**
 * A status is an icon plus a word, in the system sans at metadata scale.
 *
 * Both parts come from the payload: the glyph encodes the tone, the word is
 * the persisted state, and the raw enum stays reachable as the `title` so the
 * display copy never replaces the recorded value.
 */
export function Disclosure({
  summary,
  children,
  className,
  open = false,
  onToggle,
}: {
  summary: ReactNode;
  children: ReactNode;
  className?: string;
  open?: boolean;
  /** Lets a parent drive the disclosure (used when a stage click must open it). */
  onToggle?: (open: boolean) => void;
}) {
  return (
    <details
      className={classNames("disclosure", className)}
      open={open}
      onToggle={
        onToggle ? (event) => onToggle(event.currentTarget.open) : undefined
      }
    >
      <summary>{summary}</summary>
      <div className="disclosure__body">{children}</div>
    </details>
  );
}

/** A compact state line: icon + word + sentence, instead of a shouted banner. */
export function Button({
  children,
  onClick,
  variant = "default",
  size = "md",
  disabled,
  title,
  type = "button",
  ariaLabel,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "success" | "danger" | "ghost";
  size?: "md" | "sm";
  disabled?: boolean;
  title?: string;
  type?: "button" | "submit";
  ariaLabel?: string;
}) {
  return (
    <button
      type={type}
      className={classNames(
        "btn",
        variant !== "default" && `btn--${variant}`,
        size === "sm" && "btn--sm",
      )}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
    >
      {children}
    </button>
  );
}

export function TextArea({
  value,
  onChange,
  id,
  rows,
  placeholder,
  ariaLabel,
  invalid,
  readOnly,
}: {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  rows?: number;
  placeholder?: string;
  ariaLabel?: string;
  invalid?: boolean;
  /** Truly read-only: the browser refuses edits, not just the handler. */
  readOnly?: boolean;
}) {
  return (
    <textarea
      id={id}
      rows={rows}
      value={value}
      placeholder={placeholder}
      aria-label={ariaLabel}
      aria-invalid={invalid ? "true" : undefined}
      readOnly={readOnly}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export function Notice({
  tone = "info",
  icon,
  children,
  title,
}: {
  tone?: "info" | "warn" | "error" | "success" | "accent";
  icon?: string;
  children: ReactNode;
  title?: string;
}) {
  const glyph =
    icon ??
    (tone === "error"
      ? "!"
      : tone === "success"
        ? "✓"
        : tone === "warn"
          ? "▲"
          : "i");
  const role = tone === "error" ? "alert" : "status";
  return (
    <div
      className={classNames("notice", `notice--${tone}`)}
      role={role}
      title={title}
    >
      <span className="notice__icon" aria-hidden="true">
        {glyph}
      </span>
      <div>{children}</div>
    </div>
  );
}

export function ErrorBox({
  error,
  onRetry,
}: {
  error: string | null | undefined;
  onRetry?: () => void;
}) {
  if (!error) return null;
  return (
    <div className="notice notice--error" role="alert">
      <span className="notice__icon" aria-hidden="true">
        !
      </span>
      <div className="stack--tight">
        <span className="wrap-anywhere">{error}</span>
        {onRetry ? (
          <span>
            <Button size="sm" onClick={onRetry}>
              Retry request
            </Button>
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <p className="loading" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </p>
  );
}
