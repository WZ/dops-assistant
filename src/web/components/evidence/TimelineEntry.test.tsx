// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TimelineEntry, type TimelineEntryData } from "./TimelineEntry";

const logEntry: TimelineEntryData = {
  id: "log-1",
  type: "log",
  timestamp: "2026-03-25T14:31:00Z",
  timestampEnd: "2026-03-25T14:45:00Z",
  entity: "payments-api",
  summary: "connection refused to postgres:5432",
  count: 247,
  expandedContent: "2026-03-25T14:31:12 ERROR connection refused\n2026-03-25T14:31:15 ERROR connection refused",
};

const infraEntry: TimelineEntryData = {
  id: "infra-1",
  type: "infra",
  timestamp: "2026-03-25T14:28:00Z",
  entity: "pod/payments-api-7f8b9",
  summary: "OOMKilled (memory limit 512Mi)",
  severity: "unhealthy",
  expandedContent: "Container exceeded 512Mi memory limit. Killed by OOM killer at 14:28:03.",
};

describe("TimelineEntry", () => {
  it("renders log entry with type badge and entity", () => {
    render(<TimelineEntry entry={logEntry} />);
    expect(screen.getByText("LOG")).toBeDefined();
    expect(screen.getByText("payments-api")).toBeDefined();
    expect(screen.getByText(/connection refused/)).toBeDefined();
    expect(screen.getByText("×247")).toBeDefined();
  });

  it("renders infra entry with INFRA badge", () => {
    render(<TimelineEntry entry={infraEntry} />);
    expect(screen.getByText("INFRA")).toBeDefined();
    expect(screen.getByText(/OOMKilled/)).toBeDefined();
  });

  it("expands on click to show expanded content", () => {
    render(<TimelineEntry entry={logEntry} />);
    expect(screen.queryByText(/2026-03-25T14:31:12/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /expand/i }));
    expect(screen.getByText(/2026-03-25T14:31:12/)).toBeDefined();
  });

  it("collapses on second click", () => {
    render(<TimelineEntry entry={logEntry} />);
    const btn = screen.getByRole("button", { name: /expand/i });
    fireEvent.click(btn);
    expect(screen.getByText(/2026-03-25T14:31:12/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /collapse/i }));
    expect(screen.queryByText(/2026-03-25T14:31:12/)).toBeNull();
  });

  it("shows time range for log entries", () => {
    render(<TimelineEntry entry={logEntry} />);
    expect(screen.getByText(/14:31/)).toBeDefined();
    expect(screen.getByText(/14:45/)).toBeDefined();
  });

  it("does not show expand trigger when no expandedContent", () => {
    const minimal: TimelineEntryData = { ...logEntry, expandedContent: undefined };
    render(<TimelineEntry entry={minimal} />);
    expect(screen.queryByRole("button", { name: /expand/i })).toBeNull();
  });
});
