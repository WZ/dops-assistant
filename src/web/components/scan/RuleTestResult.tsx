// src/web/components/scan/RuleTestResult.tsx
import type { RuleTestResponse, RuleTestError } from "./types";

/**
 * Inline renderer for POST /api/scan/rules/test responses. Shows the actual
 * value Prometheus returned, whether it trips the threshold right now, and
 * the substituted query (so operators see what the probe actually ran).
 *
 * Three states: success + trip, success + no trip, error. Consistent with
 * the test-notification result pattern in NotificationsTab.
 */
interface Props {
  result: RuleTestResponse | RuleTestError | null;
}

function isError(r: RuleTestResponse | RuleTestError): r is RuleTestError {
  return "error" in r && typeof (r as { error: unknown }).error === "string";
}

export function RuleTestResult({ result }: Props) {
  if (!result) return null;

  if (isError(result)) {
    return (
      <div className="text-[11px] font-mono px-3 py-2 rounded-md bg-destructive/10 text-destructive space-y-1">
        <div>{result.error}</div>
        {result.query && <div className="text-destructive/70">Query: <code>{result.query}</code></div>}
        {result.testedService && <div className="text-destructive/70">Tested against: {result.testedService}</div>}
      </div>
    );
  }

  const ok = result.wouldTrip;
  const tone = ok
    ? "bg-warning/10 text-warning"
    : "bg-secondary/40 text-muted-foreground";

  const valueLabel = result.value === null
    ? "no value returned"
    : `value ${result.value}`;
  const verdict = ok
    ? `\u2713 would trip now \u2014 ${valueLabel}`
    : result.rawResultCount === 0
      ? "\u2717 no series returned (threshold cannot be evaluated)"
      : `\u2717 does not trip \u2014 ${valueLabel}`;

  return (
    <div className={`text-[11px] font-mono px-3 py-2 rounded-md space-y-1 ${tone}`}>
      <div className="font-semibold">{verdict}</div>
      <div className="opacity-70 break-all">Query: <code>{result.query}</code></div>
      <div className="opacity-60">
        Tested against <span className="font-semibold">{result.testedService}</span>
        {" \u00b7 "}
        {result.rawResultCount} series
        {" \u00b7 "}
        {result.durationMs}ms
      </div>
    </div>
  );
}
