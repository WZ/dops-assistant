// @vitest-environment jsdom
// src/web/components/dashboard/EventStream.test.tsx
import "@testing-library/jest-dom/vitest";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { EventStream } from "./EventStream.js";
import type { RecentEvent } from "../../../types/events.js";

const events: RecentEvent[] = [
  { id: "1", ts: Date.now() - 1000, kind: "alert_received", severity: "warn", summary: "alert · HighCPU · payments-api", service: "payments-api" },
  { id: "2", ts: Date.now() - 60_000, kind: "investigation_completed", severity: "success", summary: "investigation complete · payments-api · confidence 82%", service: "payments-api" },
];

describe("EventStream", () => {
  it("renders events newest first with human timestamps", () => {
    render(<EventStream events={events} loading={false} error={null} truncated={false} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("alert");
    expect(items[1]).toHaveTextContent("investigation complete");
  });

  it("shows empty state when no events", () => {
    render(<EventStream events={[]} loading={false} error={null} truncated={false} />);
    expect(screen.getByText(/No recent events/i)).toBeInTheDocument();
  });

  it("shows error message when error is present", () => {
    render(<EventStream events={[]} loading={false} error="network" truncated={false} />);
    expect(screen.getByText(/network/)).toBeInTheDocument();
  });
});
