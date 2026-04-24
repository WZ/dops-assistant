// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { InvestigationRow } from "./InvestigationRow";
import type { InvestigationSummary } from "@/lib/dashboard-utils";

/**
 * Pin down the thick-left-border color mapping. Earlier it was status-coded
 * (complete → green) which made a critical incident look fine as soon as the
 * workflow finished. This test locks the stripe to SEVERITY so a regression
 * to the old behavior fails the suite loudly.
 */
function make(sev: InvestigationSummary["severity"], status: string): InvestigationSummary {
  return {
    id: "inv_test",
    service: "payments-api",
    query: "Proactive scan detected anomaly on payments-api.",
    severity: sev,
    status,
    report: null,
    created_at: new Date().toISOString(),
    completed_at: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_duration_ms: 0,
    confidence_score: null,
  };
}

function borderClass(el: HTMLElement): string {
  const anchor = el.querySelector("a");
  if (!anchor) throw new Error("InvestigationRow did not render an anchor");
  // Skip `border-l-[3px]` — that's the stripe WIDTH; we want the COLOR class
  // which never has bracket-literal arbitrary values.
  const match = anchor.className
    .split(/\s+/)
    .find((c) => c.startsWith("border-l-") && !c.startsWith("border-l-["));
  if (!match) throw new Error(`no border-l-* color class on row: ${anchor.className}`);
  return match;
}

describe("InvestigationRow — left border encodes severity, not status", () => {
  it.each([
    ["critical", "border-l-destructive"],
    ["high", "border-l-accent"],
    ["medium", "border-l-warning"],
    ["low", "border-l-info"],
  ] as const)("severity=%s → stripe=%s", (sev, expected) => {
    // Status is 'complete' in every case — the regression we're guarding
    // against is "green stripe just because it's complete", regardless of
    // how bad the incident was.
    const { container } = render(
      <InvestigationRow investigation={make(sev, "complete")} onClick={() => {}} />,
    );
    expect(borderClass(container)).toBe(expected);
  });

  it("severity=null → neutral stripe (no severity yet, e.g. still running)", () => {
    const { container } = render(
      <InvestigationRow investigation={make(null, "running")} onClick={() => {}} />,
    );
    expect(borderClass(container)).toBe("border-l-border");
  });

  it("status does NOT change the stripe — high-severity complete row stays accent, not success", () => {
    const { container } = render(
      <InvestigationRow investigation={make("high", "complete")} onClick={() => {}} />,
    );
    expect(borderClass(container)).toBe("border-l-accent");
    // And critical-failed keeps destructive rather than switching for failure.
    const { container: c2 } = render(
      <InvestigationRow investigation={make("critical", "failed")} onClick={() => {}} />,
    );
    expect(borderClass(c2)).toBe("border-l-destructive");
  });
});
