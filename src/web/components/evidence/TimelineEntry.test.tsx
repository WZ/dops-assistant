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

  it("shows time range for log entries in local timezone with tz suffix", () => {
    render(<TimelineEntry entry={logEntry} />);
    // The concrete HH:MM values depend on the viewer's timezone, so assert the
    // structural shape: "HH:MM:SS – HH:MM:SS TZ" with an en-dash separator and
    // a non-empty timezone abbreviation (short name or GMT offset fallback).
    const timeNode = screen.getByText(
      /^\d{2}:\d{2}:\d{2}\s*–\s*\d{2}:\d{2}:\d{2}\s+\S+/,
    );
    expect(timeNode).toBeDefined();
    // Tooltip carries the raw ISO timestamps so the user can always see source.
    expect(timeNode.getAttribute("title")).toContain("2026-03-25T14:31:00Z");
    expect(timeNode.getAttribute("title")).toContain("2026-03-25T14:45:00Z");
  });

  it("renders '--:--:--' skeleton when no timestamp is available", () => {
    const untimed: TimelineEntryData = { ...logEntry, timestamp: "", timestampEnd: undefined };
    render(<TimelineEntry entry={untimed} />);
    expect(screen.getByText(/^--:--:--$/)).toBeDefined();
  });

  it("prefixes approximate timestamps with '~' and explains in the tooltip", () => {
    const approx: TimelineEntryData = {
      ...logEntry,
      timestamp: "2026-03-25T14:31:00Z",
      timestampEnd: undefined,
      isApproximate: true,
    };
    render(<TimelineEntry entry={approx} />);
    const timeNode = screen.getByText(/^~\d{2}:\d{2}:\d{2}\s+\S+/);
    expect(timeNode).toBeDefined();
    expect(timeNode.getAttribute("title")).toMatch(/[Aa]pproximate/);
  });

  it("does not show expand trigger when no expandedContent", () => {
    const minimal: TimelineEntryData = { ...logEntry, expandedContent: undefined };
    render(<TimelineEntry entry={minimal} />);
    expect(screen.queryByRole("button", { name: /expand/i })).toBeNull();
  });
});
