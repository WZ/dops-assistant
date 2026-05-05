import { describe, it, expect, vi } from "vitest";
import { notifyEmail } from "./email-notifier.js";
import type { EmailNotifierDeps } from "./email-notifier.js";
import type { RcaReport } from "../types/rca-types.js";

function fakeReport(severity: RcaReport["severity"] = "high"): RcaReport {
  return {
    service: "svc",
    severity,
    summary: "x",
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
}

describe("notifyEmail — per-stack kill switch via deps closure", () => {
  it("does not send when isGloballyEnabled returns false", async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    const deps: EmailNotifierDeps = {
      isGloballyEnabled: () => false,
      listEnabledRecipients: () => [
        { id: 1, address: "g@x.com", minSeverity: "high", allowedSources: ["scan"], enabled: true, stackId: null, scope: "global" } as any,
      ],
      transport: { sendMail } as any,
      config: { from: "f@x.com", appBaseUrl: "https://app", retry: { attempts: 1, backoffMs: [] } },
    };
    await notifyEmail(deps, "inv-1", fakeReport(), "scan");
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("sends to globals + own pinned (deps decides recipient list)", async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    const deps: EmailNotifierDeps = {
      isGloballyEnabled: () => true,
      listEnabledRecipients: () => [
        { id: 1, address: "g@x.com", minSeverity: "high", allowedSources: ["scan"], enabled: true, stackId: null, scope: "global" } as any,
        { id: 2, address: "p@x.com", minSeverity: "high", allowedSources: ["scan"], enabled: true, stackId: "stk-prod", scope: "stack" } as any,
      ],
      transport: { sendMail } as any,
      config: { from: "f@x.com", appBaseUrl: "https://app", retry: { attempts: 1, backoffMs: [] } },
    };
    await notifyEmail(deps, "inv-1", fakeReport(), "scan");
    const tos = sendMail.mock.calls.map((c) => c[0].to).sort();
    expect(tos).toEqual(["g@x.com", "p@x.com"]);
  });
});
