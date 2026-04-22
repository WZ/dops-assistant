import { describe, it, expect, vi } from "vitest";
import { notifyEmail, isRetryableSmtpError, type EmailNotifierDeps } from "./email-notifier.js";
import type { RcaReport } from "../types/rca-types.js";
import type { EmailRecipient } from "../types/notifications.js";

const baseReport: RcaReport = {
  service: "svc",
  severity: "high",
  summary: "s",
  impact: { duration: "1m", description: "d" },
  trigger: "t",
  rootCause: "r",
  contributingFactors: [],
  timeline: [],
  evidence: { metrics: [], logs: [], infra: [] },
  dashboardLinks: [],
  recommendedActions: [],
  confidence: "high",
  confidenceScore: 80,
  investigatedAt: "2026-04-22T14:00:00Z",
};

const baseRecipient: EmailRecipient = {
  id: 1, address: "a@x.com", minSeverity: "low",
  allowedSources: ["webhook", "scan", "poller", "manual"],
  enabled: true, createdAt: "", updatedAt: "",
};

function makeDeps(overrides: Partial<EmailNotifierDeps> = {}): {
  deps: EmailNotifierDeps;
  sendMail: ReturnType<typeof vi.fn>;
} {
  const sendMail = vi.fn().mockResolvedValue({ messageId: "<x>" });
  const deps: EmailNotifierDeps = {
    isGloballyEnabled: () => true,
    listEnabledRecipients: () => [baseRecipient],
    transport: { sendMail } as unknown as EmailNotifierDeps["transport"],
    config: {
      from: "dops@x.com",
      appBaseUrl: "https://x/",
      retry: { attempts: 4, backoffMs: [1, 1, 1] },
    },
    ...overrides,
  };
  return { deps, sendMail };
}

describe("isRetryableSmtpError", () => {
  it("retries on network error codes", () => {
    for (const code of ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ESOCKET"]) {
      expect(isRetryableSmtpError({ code })).toBe(true);
    }
  });
  it("retries on 4xx responseCode", () => {
    expect(isRetryableSmtpError({ responseCode: 421 })).toBe(true);
    expect(isRetryableSmtpError({ responseCode: 450 })).toBe(true);
  });
  it("does not retry on 5xx responseCode", () => {
    expect(isRetryableSmtpError({ responseCode: 550 })).toBe(false);
  });
  it("does not retry on auth failure (535)", () => {
    expect(isRetryableSmtpError({ responseCode: 535 })).toBe(false);
  });
  it("does not retry on EENVELOPE", () => {
    expect(isRetryableSmtpError({ code: "EENVELOPE" })).toBe(false);
  });
  it("does not retry unknown errors", () => {
    expect(isRetryableSmtpError({})).toBe(false);
    expect(isRetryableSmtpError(new Error("weird"))).toBe(false);
  });
});

describe("notifyEmail — short-circuits", () => {
  it("does nothing when globally disabled", async () => {
    const { deps, sendMail } = makeDeps({ isGloballyEnabled: () => false });
    await notifyEmail(deps, "inv_1", baseReport, "scan");
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("does nothing when no recipients match the severity", async () => {
    const { deps, sendMail } = makeDeps({
      listEnabledRecipients: () => [{ ...baseRecipient, minSeverity: "critical" }],
    });
    await notifyEmail(deps, "inv_1", baseReport, "scan");
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("does nothing when no recipients allow the source", async () => {
    const { deps, sendMail } = makeDeps({
      listEnabledRecipients: () => [{ ...baseRecipient, allowedSources: ["webhook"] }],
    });
    await notifyEmail(deps, "inv_1", baseReport, "scan");
    expect(sendMail).not.toHaveBeenCalled();
  });
});

describe("notifyEmail — matching", () => {
  it("sends to every matching recipient once on success", async () => {
    const r1 = { ...baseRecipient, id: 1, address: "a@x" };
    const r2 = { ...baseRecipient, id: 2, address: "b@x" };
    const { deps, sendMail } = makeDeps({ listEnabledRecipients: () => [r1, r2] });
    await notifyEmail(deps, "inv_1", baseReport, "scan");
    expect(sendMail).toHaveBeenCalledTimes(2);
    const recipients = sendMail.mock.calls.map((c) => (c[0] as { to: string }).to);
    expect(recipients.sort()).toEqual(["a@x", "b@x"]);
  });

  it("envelope contains from, to, subject, html, and text", async () => {
    const { deps, sendMail } = makeDeps();
    await notifyEmail(deps, "inv_1", baseReport, "scan");
    expect(sendMail).toHaveBeenCalledTimes(1);
    const env = sendMail.mock.calls[0]![0] as Record<string, unknown>;
    expect(env["from"]).toBe("dops@x.com");
    expect(env["to"]).toBe("a@x.com");
    expect(String(env["subject"])).toContain("svc");
    expect(String(env["html"])).toContain("<");
    expect(String(env["text"])).toContain("SUMMARY");
  });
});

describe("notifyEmail — retry behaviour", () => {
  it("retries a retryable error and succeeds on second attempt", async () => {
    const sendMail = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("temp"), { code: "ETIMEDOUT" }))
      .mockResolvedValue({ messageId: "<ok>" });
    const { deps } = makeDeps({ transport: { sendMail } as unknown as EmailNotifierDeps["transport"] });
    await notifyEmail(deps, "inv_1", baseReport, "scan");
    expect(sendMail).toHaveBeenCalledTimes(2);
  });

  it("gives up after attempts and does not throw", async () => {
    const sendMail = vi.fn().mockRejectedValue(Object.assign(new Error("temp"), { code: "ETIMEDOUT" }));
    const { deps } = makeDeps({ transport: { sendMail } as unknown as EmailNotifierDeps["transport"] });
    await expect(notifyEmail(deps, "inv_1", baseReport, "scan")).resolves.toBeUndefined();
    expect(sendMail).toHaveBeenCalledTimes(4);
  });

  it("fails fast on non-retryable errors (single attempt)", async () => {
    const sendMail = vi.fn().mockRejectedValue(Object.assign(new Error("bad creds"), { responseCode: 535 }));
    const { deps } = makeDeps({ transport: { sendMail } as unknown as EmailNotifierDeps["transport"] });
    await notifyEmail(deps, "inv_1", baseReport, "scan");
    expect(sendMail).toHaveBeenCalledTimes(1);
  });
});

describe("notifyEmail — isolation between recipients", () => {
  it("one recipient's failure does not prevent others from being sent", async () => {
    const sendMail = vi.fn().mockImplementation((env: { to: string }) => {
      if (env.to === "bad@x") return Promise.reject(Object.assign(new Error("nope"), { responseCode: 550 }));
      return Promise.resolve({ messageId: "<ok>" });
    });
    const { deps } = makeDeps({
      listEnabledRecipients: () => [
        { ...baseRecipient, id: 1, address: "good1@x" },
        { ...baseRecipient, id: 2, address: "bad@x" },
        { ...baseRecipient, id: 3, address: "good2@x" },
      ],
      transport: { sendMail } as unknown as EmailNotifierDeps["transport"],
    });
    await notifyEmail(deps, "inv_1", baseReport, "scan");
    const tos = sendMail.mock.calls.map((c) => (c[0] as { to: string }).to);
    expect(tos).toContain("good1@x");
    expect(tos).toContain("good2@x");
    expect(tos).toContain("bad@x");
  });
});
