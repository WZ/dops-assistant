import { describe, it, expect, vi, beforeEach } from "vitest";
import { SlackBot } from "./slack.js";
import type { AgentCore } from "../agent/core.js";
import type { IntentClassifier } from "../agent/intent.js";
import type { InvestigationAgent } from "../agent/investigation.js";
import type { RcaReport } from "../agent/rca-types.js";
import type { ConversationMemory } from "../memory/conversation.js";
import { registry } from "../observability/metrics.js";

// Mock @slack/bolt — use vi.hoisted so variables are available inside the hoisted vi.mock factory
const { mockSay, mockMessage, mockEvent, mockStart, mockStop, MockApp } = vi.hoisted(() => {
  const mockSay = vi.fn();
  const mockMessage = vi.fn();
  const mockEvent = vi.fn();
  const mockStart = vi.fn().mockResolvedValue(undefined);
  const mockStop = vi.fn().mockResolvedValue(undefined);
  const MockApp = vi.fn().mockImplementation(function () {
    return { message: mockMessage, event: mockEvent, start: mockStart, stop: mockStop };
  });
  return { mockSay, mockMessage, mockEvent, mockStart, mockStop, MockApp };
});

vi.mock("@slack/bolt", () => ({
  default: { App: MockApp },
}));

const mockAgent = {
  run: vi.fn().mockResolvedValue({ response: "Here is the data.", updatedHistory: [] }),
} as unknown as AgentCore;

const mockMemory = {
  get: vi.fn().mockReturnValue([]),
  append: vi.fn(),
} as unknown as ConversationMemory;

describe("SlackBot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-apply default return values after clearAllMocks
    (mockAgent.run as ReturnType<typeof vi.fn>).mockResolvedValue({ response: "Here is the data.", updatedHistory: [] });
    (mockMemory.get as ReturnType<typeof vi.fn>).mockReturnValue([]);
    mockSay.mockResolvedValue(undefined);
  });

  it("registers message and app_mention handlers on start", async () => {
    const bot = new SlackBot(
      { botToken: "xoxb-test", appToken: "xapp-test" },
      mockAgent,
      mockMemory
    );
    await bot.start();
    expect(mockStart).toHaveBeenCalled();
    expect(mockMessage).toHaveBeenCalledWith(expect.any(Function));
    expect(mockEvent).toHaveBeenCalledWith("app_mention", expect.any(Function));
  });

  it("loads history and calls agent with user message", async () => {
    const existingHistory = [{ role: "user" as const, content: "Previous message." }];
    (mockMemory.get as ReturnType<typeof vi.fn>).mockReturnValue(existingHistory);

    const bot = new SlackBot(
      { botToken: "xoxb-test", appToken: "xapp-test" },
      mockAgent,
      mockMemory
    );

    await bot.handleMessage({ text: "How is the system?", threadTs: "123.456", userId: "U123" }, mockSay);

    expect(mockAgent.run).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "conversational",
        message: "How is the system?",
        history: existingHistory,
      })
    );
  });

  it("appends user message and response to memory", async () => {
    const bot = new SlackBot(
      { botToken: "xoxb-test", appToken: "xapp-test" },
      mockAgent,
      mockMemory
    );

    await bot.handleMessage({ text: "Hello.", threadTs: "123.456", userId: "U123" }, mockSay);

    expect(mockMemory.append).toHaveBeenCalledWith(
      "123.456",
      expect.objectContaining({ role: "user", content: "Hello." })
    );
    expect(mockMemory.append).toHaveBeenCalledWith(
      "123.456",
      expect.objectContaining({ role: "assistant", content: "Here is the data." })
    );
  });

  it("posts agent response to the thread", async () => {
    const bot = new SlackBot(
      { botToken: "xoxb-test", appToken: "xapp-test" },
      mockAgent,
      mockMemory
    );

    await bot.handleMessage({ text: "Hello.", threadTs: "123.456", userId: "U123" }, mockSay);

    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Here is the data.",
        thread_ts: "123.456",
      })
    );
  });

  it("posts error message to thread when agent.run throws", async () => {
    (mockAgent.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("LLM unavailable"));

    const bot = new SlackBot(
      { botToken: "xoxb-test", appToken: "xapp-test" },
      mockAgent,
      mockMemory
    );

    await expect(
      bot.handleMessage({ text: "Hello.", threadTs: "123.456", userId: "U123" }, mockSay)
    ).rejects.toThrow("LLM unavailable");

    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Sorry, something went wrong. Please try again.",
        thread_ts: "123.456",
      })
    );
  });

  it("increments slackMessagesTotal on success", async () => {
    registry.resetMetrics();
    const bot = new SlackBot(
      { botToken: "xoxb-test", appToken: "xapp-test" },
      mockAgent,
      mockMemory
    );
    await bot.handleMessage({ text: "hello", threadTs: "ts1", userId: "U1" }, mockSay);
    const metrics = await registry.getMetricsAsJSON();
    const counter = metrics.find((m) => m.name === "slack_messages_total");
    const values = counter?.values as Array<{ labels: { status: string }; value: number }>;
    expect(values?.find((v) => v.labels.status === "success")?.value).toBe(1);
  });

  it("increments slackMessagesTotal on error", async () => {
    registry.resetMetrics();
    const bot = new SlackBot(
      { botToken: "xoxb-test", appToken: "xapp-test" },
      mockAgent,
      mockMemory
    );
    (mockAgent.run as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
    await expect(
      bot.handleMessage({ text: "fail", threadTs: "ts2", userId: "U2" }, mockSay),
    ).rejects.toThrow("boom");
    const metrics = await registry.getMetricsAsJSON();
    const counter = metrics.find((m) => m.name === "slack_messages_total");
    const values = counter?.values as Array<{ labels: { status: string }; value: number }>;
    expect(values?.find((v) => v.labels.status === "error")?.value).toBe(1);
  });
});

describe("SlackBot – investigation routing", () => {
  const mockRcaReport: RcaReport = {
    service: "payments-api",
    severity: "high",
    summary: "High error rate",
    rootCause: "DB pool exhausted",
    evidence: { metrics: ["18%"], logs: [], infra: [] },
    recommendedActions: ["Scale DB"],
    confidence: "high",
    investigatedAt: new Date().toISOString(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (mockAgent.run as ReturnType<typeof vi.fn>).mockResolvedValue({ response: "Here is the data.", updatedHistory: [] });
    (mockMemory.get as ReturnType<typeof vi.fn>).mockReturnValue([]);
    mockSay.mockResolvedValue(undefined);
  });

  it("routes investigation intent to InvestigationAgent", async () => {
    const mockClassifier = {
      classify: vi.fn().mockResolvedValue({ intent: "investigation", service: "payments-api" }),
    } as unknown as IntentClassifier;
    const mockInvestigationAgent = {
      investigate: vi.fn().mockResolvedValue(mockRcaReport),
    } as unknown as InvestigationAgent;

    const bot = new SlackBot(
      { botToken: "xoxb-test", appToken: "xapp-test" },
      mockAgent,
      mockMemory,
      [{ name: "payments-api", metrics: [], logLabels: {} }],
      mockClassifier,
      mockInvestigationAgent,
    );

    await bot.handleMessage({ text: "investigate payments-api", threadTs: "ts1", userId: "U1" }, mockSay);

    expect(mockInvestigationAgent.investigate).toHaveBeenCalled();
    expect(mockAgent.run).not.toHaveBeenCalled();
    expect(mockSay).toHaveBeenCalledWith(expect.objectContaining({ blocks: expect.any(Array) }));
  });

  it("falls back to conversational mode for question intent", async () => {
    const mockClassifier = {
      classify: vi.fn().mockResolvedValue({ intent: "question" }),
    } as unknown as IntentClassifier;

    const bot = new SlackBot(
      { botToken: "xoxb-test", appToken: "xapp-test" },
      mockAgent,
      mockMemory,
      [],
      mockClassifier,
    );

    await bot.handleMessage({ text: "what is the error rate?", threadTs: "ts1", userId: "U1" }, mockSay);

    expect(mockAgent.run).toHaveBeenCalled();
  });

  it("falls back to conversational mode when no classifier provided", async () => {
    const bot = new SlackBot(
      { botToken: "xoxb-test", appToken: "xapp-test" },
      mockAgent,
      mockMemory,
    );

    await bot.handleMessage({ text: "hello", threadTs: "ts1", userId: "U1" }, mockSay);

    expect(mockAgent.run).toHaveBeenCalled();
  });
});
