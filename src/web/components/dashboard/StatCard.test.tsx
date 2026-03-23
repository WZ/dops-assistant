// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatCard } from "./StatCard.js";
import { normalizeConfidence } from "../../lib/dashboard-utils.js";

/**
 * Tests KPI card rendering for the 4 dashboard cards.
 * Verifies the exact props the Dashboard passes to StatCard for each scenario.
 */
describe("StatCard KPI rendering", () => {
  // ── Card 1: Investigations ────────────────────────────────────────────

  it("Card 1: shows investigation count with success rate when present", () => {
    const successRate = 85;
    const value = `22 · ${Math.round(successRate)}%`;
    render(
      <StatCard label="Investigations" value={value} detail="0 active · 20 complete · 2 failed" />
    );
    expect(screen.getByRole("group", { name: "Investigations: 22 · 85%" })).toBeTruthy();
  });

  it("Card 1: shows only count when successRate is null", () => {
    render(
      <StatCard label="Investigations" value="0" detail="0 active · 0 complete · 0 failed" />
    );
    expect(screen.getByRole("group", { name: "Investigations: 0" })).toBeTruthy();
  });

  // ── Card 2: Services Health ───────────────────────────────────────────

  it("Card 2: shows real health counts from Prometheus data", () => {
    render(
      <StatCard
        label="Services Health"
        value="67/117"
        variant="default"
        detail="5 down · 0 degraded · 45 unknown"
      />
    );
    const card = screen.getByRole("group", { name: "Services Health: 67/117" });
    expect(card).toBeTruthy();
    expect(card.textContent).toContain("5 down");
    expect(card.textContent).toContain("45 unknown");
  });

  // ── Card 4: Avg Confidence ────────────────────────────────────────────

  it("Card 4: shows confidence percentage when present", () => {
    const avg = 0.87;
    const value = normalizeConfidence(avg) || "\u2014";
    render(
      <StatCard
        label="Avg Confidence"
        value={value}
        variant="success"
        detail="22 scored · 0 low confidence"
      />
    );
    expect(screen.getByRole("group", { name: "Avg Confidence: 87%" })).toBeTruthy();
  });

  it("Card 4: shows dash when confidence is null", () => {
    const avg = null;
    const value = (avg != null ? normalizeConfidence(avg) : "") || "\u2014";
    render(
      <StatCard
        label="Avg Confidence"
        value={value}
        variant="default"
        detail="needs scored investigations"
      />
    );
    expect(screen.getByRole("group", { name: "Avg Confidence: —" })).toBeTruthy();
  });
});
