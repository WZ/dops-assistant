import { describe, it, expect, vi, beforeEach } from "vitest";
import { Scheduler, parseDurationToCron } from "./scheduler.js";
import type { AgentCore } from "../agent/core.js";
import type { sendAnomalyAlert } from "../notifications/slack-webhook.js";

// Mock node-cron to avoid real timer loops in tests
let capturedCallback: (() => void) | null = null;
const mockTask = {
  stop: vi.fn(),
};

vi.mock("node-cron", () => ({
  default: {
    schedule: vi.fn().mockImplementation((_expr: string, callback: () => void) => {
      capturedCallback = callback;
      return mockTask;
    }),
  },
}));

describe("parseDurationToCron", () => {
  it("converts 5m to cron expression", () => {
    expect(parseDurationToCron("5m")).toBe("*/5 * * * *");
  });

  it("converts 10m to cron expression", () => {
    expect(parseDurationToCron("10m")).toBe("*/10 * * * *");
  });

  it("converts 1h to cron expression", () => {
    expect(parseDurationToCron("1h")).toBe("0 */1 * * *");
  });

  it("throws on invalid format", () => {
    expect(() => parseDurationToCron("invalid")).toThrow("Unsupported interval format");
  });
});

describe("Scheduler", () => {
  const mockRun = vi.fn();
  const mockAgent = { run: mockRun } as unknown as AgentCore;
  const mockNotify = vi.fn() as unknown as typeof sendAnomalyAlert;

  const services = [
    { name: "payments-api", metrics: [], logLabels: {} },
    { name: "checkout-service", metrics: [], logLabels: {} },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    capturedCallback = null;
  });

  it("calls agent for each service on tick", async () => {
    mockRun.mockResolvedValue({ response: "All healthy.", updatedHistory: [] });

    const scheduler = new Scheduler(
      { interval: "1m", services: ["payments-api", "checkout-service"], maxConcurrency: 5 },
      services,
      mockAgent,
      mockNotify
    );
    scheduler.start();

    // Simulate a cron tick
    await capturedCallback!();

    expect(mockRun).toHaveBeenCalledTimes(2);
    expect(mockRun).toHaveBeenCalledWith(expect.objectContaining({ mode: "proactive" }));
  });

  it("calls notifier when agent response signals anomaly", async () => {
    mockRun.mockResolvedValue({
      response: "High latency detected on payments-api: P99 is 4.2s",
      updatedHistory: [],
    });

    const scheduler = new Scheduler(
      { interval: "1m", services: ["payments-api"], maxConcurrency: 5 },
      services,
      mockAgent,
      mockNotify
    );
    scheduler.start();

    await capturedCallback!();

    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ service: "payments-api" })
    );
  });

  it("does not call notifier when agent says healthy", async () => {
    mockRun.mockResolvedValue({ response: "Everything looks healthy.", updatedHistory: [] });

    const scheduler = new Scheduler(
      { interval: "1m", services: ["payments-api"], maxConcurrency: 5 },
      services,
      mockAgent,
      mockNotify
    );
    scheduler.start();

    await capturedCallback!();

    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("stop() calls task.stop()", () => {
    mockRun.mockResolvedValue({ response: "healthy", updatedHistory: [] });

    const scheduler = new Scheduler(
      { interval: "1m", services: ["payments-api"], maxConcurrency: 5 },
      services,
      mockAgent,
      mockNotify
    );
    scheduler.start();
    scheduler.stop();

    expect(mockTask.stop).toHaveBeenCalled();
  });
});
