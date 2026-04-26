import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { notifySlack, notifySlackOnScanComplete, __resetAppBaseUrlWarn } from "./slack-notifier.js";
import type { RcaReport } from "../types/rca-types.js";

// The "warn once" flag is module-level state — reset between tests so the
// missing-appBaseUrl branch can be exercised independently of execution
// order. Without this, only the first test that hits the missing-config
// path would observe the warn; later tests would see no log because the
// flag stayed flipped.
beforeEach(() => { __resetAppBaseUrlWarn(); });

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

  it("includes a View Investigation button with the canonical stack-scoped URL", async () => {
    // Regression: previously emitted `${grafanaUrl}/#/investigations/:id`
    // which used hash routing on a pushState SPA — the hash got ignored,
    // landing the user on the Grafana homepage. Now uses the SPA's
    // /stacks/:stackId/investigations/:id form.
    await notifySlack(
      { slackWebhookUrl: "https://hooks.slack.com/test", appBaseUrl: "https://dops.example.com", stackId: "prod" },
      "inv_abc",
      "payments-api",
      makeReport(),
    );

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    const actionsBlock = body.blocks.find((b: any) => b.type === "actions");
    expect(actionsBlock).toBeDefined();
    expect(actionsBlock.elements[0].url).toBe("https://dops.example.com/stacks/prod/investigations/inv_abc");
  });

  it("falls back to the legacy /investigations/:id form when stackId is unknown", async () => {
    // Test-notification path doesn't have a real stackId. Locate-and-redirect
    // on the SPA side handles the legacy form, so the link still works.
    await notifySlack(
      { slackWebhookUrl: "https://hooks.slack.com/test", appBaseUrl: "https://dops.example.com" },
      "inv_abc",
      "payments-api",
      makeReport(),
    );

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    const actionsBlock = body.blocks.find((b: any) => b.type === "actions");
    expect(actionsBlock.elements[0].url).toBe("https://dops.example.com/investigations/inv_abc");
  });

  it("strips a trailing slash on appBaseUrl so the URL doesn't double-slash", async () => {
    await notifySlack(
      { slackWebhookUrl: "https://hooks.slack.com/test", appBaseUrl: "https://dops.example.com/", stackId: "prod" },
      "inv_abc",
      "payments-api",
      makeReport(),
    );

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    const actionsBlock = body.blocks.find((b: any) => b.type === "actions");
    expect(actionsBlock.elements[0].url).toBe("https://dops.example.com/stacks/prod/investigations/inv_abc");
  });

  it("encodes URL segments so the link survives a future schema broadening", async () => {
    // ULIDs are alphanumeric so this isn't a hot path today; defensive
    // against any future widening of the stack-id charset (slugs, etc.).
    await notifySlack(
      { slackWebhookUrl: "https://hooks.slack.com/test", appBaseUrl: "https://dops.example.com", stackId: "stack/with slash" },
      "inv with space",
      "payments-api",
      makeReport(),
    );

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    const actionsBlock = body.blocks.find((b: any) => b.type === "actions");
    expect(actionsBlock.elements[0].url).toBe(
      "https://dops.example.com/stacks/stack%2Fwith%20slash/investigations/inv%20with%20space",
    );
  });

  it("omits actions block when appBaseUrl is not provided", async () => {
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

describe("notifySlackOnScanComplete", () => {
  const origFetch = global.fetch;
  afterEach(() => { global.fetch = origFetch; });

  it("posts a summary block with run deep-link and flagged services", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;
    await notifySlackOnScanComplete({
      slackWebhookUrl: "https://hooks.slack.com/test",
      appBaseUrl: "https://dops.example",
    }, {
      runId: "r1", stackId: "s1", trigger: "manual",
      startedAt: Date.now(), durationMs: 2300,
      servicesProbed: 117, hitsDispatched: 3,
      dispatchedServices: ["payments-api", "search-svc", "auth-gateway"],
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    // Assert URL
    expect(fetchMock.mock.calls[0]![0]).toBe("https://hooks.slack.com/test");
    // Assert body contents
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).toContain("/scan/runs/r1");
    expect(bodyStr).toContain("dops.example");
    expect(bodyStr).toContain("payments-api");
    expect(bodyStr).toContain("search-svc");
    expect(bodyStr).toContain("auth-gateway");
    expect(bodyStr).toContain("117");
  });

  it("uses 'clean' phrasing when no hits dispatched", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;
    await notifySlackOnScanComplete(
      { slackWebhookUrl: "https://hooks.slack.com/test", appBaseUrl: "https://x" },
      { runId: "r1", stackId: "s1", trigger: "cron", startedAt: 0, durationMs: 0, servicesProbed: 50, hitsDispatched: 0, dispatchedServices: [] },
    );
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).toContain("clean");
    // No "Flagged" section when dispatchedServices is empty
    expect(bodyStr).not.toContain("Flagged");
  });

  it("swallows fetch errors (fire-and-forget)", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network")) as unknown as typeof fetch;
    await expect(notifySlackOnScanComplete(
      { slackWebhookUrl: "https://hooks.slack.com/test", appBaseUrl: "https://x" },
      { runId: "r1", stackId: "s1", trigger: "cron", startedAt: 0, durationMs: 0, servicesProbed: 0, hitsDispatched: 0, dispatchedServices: [] },
    )).resolves.toBeUndefined();
  });

  it("uses singular 'service' when hitsDispatched === 1", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;
    await notifySlackOnScanComplete(
      { slackWebhookUrl: "https://hooks.slack.com/test", appBaseUrl: "https://x" },
      { runId: "r1", stackId: "s1", trigger: "manual", startedAt: 0, durationMs: 0, servicesProbed: 10, hitsDispatched: 1, dispatchedServices: ["only-one"] },
    );
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(JSON.stringify(body)).toContain("1 service ");
    expect(JSON.stringify(body)).not.toContain("1 services");
  });

  it("omits the 'View run' hyperlink when appBaseUrl is missing — keeps the metrics tail", async () => {
    // Regression: previously every caller defaulted to "http://localhost:3000"
    // when notifications.email.appBaseUrl was unset, so the "View run"
    // link in production Slack posts was a localhost URL the operator
    // couldn't actually click. Now the link is omitted and the metrics
    // tail (probed count + duration) renders standalone.
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;
    await notifySlackOnScanComplete(
      { slackWebhookUrl: "https://hooks.slack.com/test" },
      { runId: "r1", stackId: "s1", trigger: "manual", startedAt: 0, durationMs: 1234, servicesProbed: 50, hitsDispatched: 0, dispatchedServices: [] },
    );
    const bodyStr = JSON.stringify(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string));
    expect(bodyStr).not.toContain("View run");
    expect(bodyStr).not.toContain("localhost");
    expect(bodyStr).not.toContain("scan/runs/r1");
    // metrics still rendered
    expect(bodyStr).toContain("50 probed");
    expect(bodyStr).toContain("1234ms");
  });

  it("strips a trailing slash on appBaseUrl in the run link", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;
    await notifySlackOnScanComplete(
      { slackWebhookUrl: "https://hooks.slack.com/test", appBaseUrl: "https://dops.example.com/" },
      { runId: "r1", stackId: "s1", trigger: "manual", startedAt: 0, durationMs: 0, servicesProbed: 10, hitsDispatched: 0, dispatchedServices: [] },
    );
    const bodyStr = JSON.stringify(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string));
    expect(bodyStr).toContain("https://dops.example.com/scan/runs/r1");
    expect(bodyStr).not.toContain("example.com//");
  });

  it("encodes runId so a future schema broadening doesn't corrupt the link", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;
    await notifySlackOnScanComplete(
      { slackWebhookUrl: "https://hooks.slack.com/test", appBaseUrl: "https://x" },
      { runId: "r 1", stackId: "s1", trigger: "manual", startedAt: 0, durationMs: 0, servicesProbed: 10, hitsDispatched: 0, dispatchedServices: [] },
    );
    const bodyStr = JSON.stringify(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string));
    expect(bodyStr).toContain("/scan/runs/r%201");
  });
});
