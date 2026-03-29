import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { notifySlack } from "./slack-notifier.js";
import type { RcaReport } from "../types/rca-types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeReport(overrides: Partial<RcaReport> = {}): RcaReport {
  return {
    service: "payments-api",
    severity: "high",
    summary: "High error rate on payment endpoint",
    impact: { duration: "15 minutes", description: "50% of payments failing" },
    trigger: "Error rate > 5%",
    rootCause: "Database connection pool exhaustion",
    contributingFactors: ["High traffic", "Leaked connections"],
    timeline: [{ time: "12:00", event: "Error rate spike" }],
    evidence: { metrics: ["error_rate"], logs: ["connection timeout"], infra: [] },
    dashboardLinks: [],
    recommendedActions: ["Increase pool size"],
    confidence: "high",
    confidenceScore: 0.85,
    investigatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("notifySlack", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve("ok") });
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a POST request to the webhook URL with correct payload", async () => {
    await notifySlack(
      { slackWebhookUrl: "https://hooks.slack.com/test" },
      "inv_123",
      "payments-api",
      makeReport(),
    );

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://hooks.slack.com/test");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(opts.body);
    expect(body.blocks).toBeDefined();
    expect(body.blocks.length).toBeGreaterThan(0);

    // Header block should include service name
    const header = body.blocks.find((b: any) => b.type === "header");
    expect(header.text.text).toContain("payments-api");
  });

  it("includes severity and confidence in fields block", async () => {
    await notifySlack(
      { slackWebhookUrl: "https://hooks.slack.com/test" },
      "inv_123",
      "payments-api",
      makeReport({ severity: "critical", confidenceScore: 0.92 }),
    );

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    const fieldsBlock = body.blocks.find((b: any) => b.fields);
    expect(fieldsBlock).toBeDefined();

    const severityField = fieldsBlock.fields.find((f: any) => f.text.includes("Severity"));
    expect(severityField.text).toContain("critical");

    const confidenceField = fieldsBlock.fields.find((f: any) => f.text.includes("Confidence"));
    expect(confidenceField.text).toContain("92%");
  });

  it("includes a View Investigation button when grafanaUrl is provided", async () => {
    await notifySlack(
      { slackWebhookUrl: "https://hooks.slack.com/test", grafanaUrl: "https://grafana.example.com" },
      "inv_abc",
      "payments-api",
      makeReport(),
    );

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    const actionsBlock = body.blocks.find((b: any) => b.type === "actions");
    expect(actionsBlock).toBeDefined();
    expect(actionsBlock.elements[0].url).toBe("https://grafana.example.com/#/investigations/inv_abc");
  });

  it("omits actions block when grafanaUrl is not provided", async () => {
    await notifySlack(
      { slackWebhookUrl: "https://hooks.slack.com/test" },
      "inv_abc",
      "payments-api",
      makeReport(),
    );

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    const actionsBlock = body.blocks.find((b: any) => b.type === "actions");
    expect(actionsBlock).toBeUndefined();
  });

  it("does not throw when fetch fails", async () => {
    fetchSpy.mockRejectedValue(new Error("Network error"));

    // Should not throw
    await expect(
      notifySlack(
        { slackWebhookUrl: "https://hooks.slack.com/test" },
        "inv_123",
        "payments-api",
        makeReport(),
      ),
    ).resolves.toBeUndefined();
  });

  it("handles non-OK responses gracefully", async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 400, text: () => Promise.resolve("bad request") });

    // Should not throw
    await expect(
      notifySlack(
        { slackWebhookUrl: "https://hooks.slack.com/test" },
        "inv_123",
        "payments-api",
        makeReport(),
      ),
    ).resolves.toBeUndefined();
  });
});
