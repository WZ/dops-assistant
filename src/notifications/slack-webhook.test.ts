import { describe, it, expect, vi, beforeEach } from "vitest";
import { sendAnomalyAlert } from "./slack-webhook.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sendAnomalyAlert", () => {
  it("POSTs a JSON payload to the webhook URL", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await sendAnomalyAlert("https://hooks.slack.com/test", {
      service: "payments-api",
      severity: "high",
      summary: "P99 latency spike detected",
      metrics: ["p99: 4.2s"],
      dashboardUrl: "https://grafana.example.com/d/123",
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://hooks.slack.com/test",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
    );

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.blocks).toBeDefined();
  });

  it("includes service name, severity, and summary in payload", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await sendAnomalyAlert("https://hooks.slack.com/test", {
      service: "checkout-service",
      severity: "medium",
      summary: "Error rate elevated",
    });

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    const blockText = JSON.stringify(body);
    expect(blockText).toContain("checkout-service");
    expect(blockText).toContain("medium");
    expect(blockText).toContain("Error rate elevated");
  });

  it("throws on non-2xx response", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 400, statusText: "Bad Request" });

    await expect(
      sendAnomalyAlert("https://hooks.slack.com/test", {
        service: "payments-api",
        severity: "low",
        summary: "Minor issue",
      })
    ).rejects.toThrow("Slack webhook failed: 400 Bad Request");
  });
});
