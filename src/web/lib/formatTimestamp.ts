/**
 * Unified timestamp formatter for the web UI.
 *
 * The investigation detail page historically rendered 4+ different formats
 * ("2026-04-17T00:00:00Z", "2:33 AM", "Apr 16", etc.) on the same screen.
 * Funneling every timestamp through one helper keeps the visual language
 * consistent and makes it trivial to swap styles later (e.g. flip every
 * "created_at" to relative time without touching call sites).
 *
 * Styles:
 *   - relative → "just now", "2m ago", "3h ago", "5d ago", "never"
 *   - local    → "Apr 17, 2:33 PM" (user locale, 12-hour)
 *   - utc      → "2026-04-17T00:00:00Z" (ISO pass-through, seconds-precision)
 */
export type TimestampStyle = "relative" | "local" | "utc";

/** For tests: allow injecting a fixed "now" so the clock can be frozen. */
export interface FormatOptions {
  now?: number;
}

export function formatTimestamp(
  iso: string | null | undefined,
  style: TimestampStyle,
  opts: FormatOptions = {},
): string {
  if (!iso) return style === "relative" ? "never" : "";

  const d = new Date(iso);
  if (isNaN(d.getTime())) return style === "relative" ? "never" : "";

  switch (style) {
    case "relative":
      return formatRelative(d.getTime(), opts.now ?? Date.now());
    case "local":
      return formatLocal(d);
    case "utc":
      return formatUtc(d);
  }
}

function formatRelative(ts: number, now: number): string {
  const diffMs = now - ts;
  // Future timestamps are rare but shouldn't crash; clamp to "just now"
  if (diffMs < 0) return "just now";
  const mins = Math.floor(diffMs / 60_000);
  // Under a minute collapses to "just now" — consistent with the legacy
  // `timeAgo` helper so existing UI copy doesn't visibly shift.
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatLocal(d: Date): string {
  // e.g. "Apr 17, 2:33 PM" — user locale, 12-hour. We intentionally skip the
  // year to keep the label compact; callers that need the year can pair this
  // with the `utc` style in a tooltip.
  const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${date}, ${time}`;
}

function formatUtc(d: Date): string {
  // Seconds-precision ISO 8601 — strips the ".000" millis so the label
  // matches the "2026-04-17T00:00:00Z" shape operators are used to seeing
  // in Prometheus / Grafana URL params.
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}
