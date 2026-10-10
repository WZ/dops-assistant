// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { DiscoveryProgress } from "./DiscoveryProgress";

const call = { timestamp: "1:00:00 AM", tool: "query_prometheus", status: "success" as const };

describe("DiscoveryProgress wait counters", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("counts up while waiting for the model's first response", () => {
    render(<DiscoveryProgress phase="discovery" phaseStatus="running" toolCalls={[]} onBack={() => {}} />);
    act(() => { vi.advanceTimersByTime(12_000); });
    expect(screen.getByText(/Waiting for the model's first response\.\.\. 12s/)).toBeInTheDocument();
  });

  it("shows how long the model has been thinking since the last tool call", () => {
    render(<DiscoveryProgress phase="discovery" phaseStatus="running" toolCalls={[call]} onBack={() => {}} />);
    act(() => { vi.advanceTimersByTime(75_000); });
    expect(screen.getByText(/LLM is analyzing results and generating service list\.\.\. 1m 15s/)).toBeInTheDocument();
  });
});
