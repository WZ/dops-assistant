import { describe, it, expect, vi } from "vitest";
import { notifyEmailScanRun } from "./email-notifier.js";

const FAKE_SUMMARY = {
  runId: "r1", stackId: "s1", trigger: "manual" as const,
  startedAt: Date.now(), durationMs: 100,
  servicesProbed: 10, hitsDispatched: 2,
  dispatchedServices: ["api", "auth"],
};

function makeDeps(overrides: Partial<{
  enabled: boolean;
  recipients: Array<{ address: string; allowedSources: string[] }>;
  sendMail: ReturnType<typeof vi.fn>;
}> = {}) {
  return {
    isGloballyEnabled: () => overrides.enabled ?? true,
    listEnabledRecipients: () => (overrides.recipients ?? []) as any,
    transport: { sendMail: overrides.sendMail ?? vi.fn().mockResolvedValue({ accepted: ["x"] }) } as any,
    config: { from: "from@x", appBaseUrl: "https://dops.example", retry: { attempts: 1, backoffMs: [] } },
  };
}

describe("notifyEmailScanRun", () => {
  it("sends only to recipients with 'scan-run' in allowedSources", async () => {
    const sendMail = vi.fn().mockResolvedValue({ accepted: ["x"] });
    const deps = makeDeps({
      sendMail,
      recipients: [
        { address: "include@x", allowedSources: ["scan-run"] },
        { address: "also-include@x", allowedSources: ["scan-run", "webhook"] },
        { address: "exclude@x", allowedSources: ["webhook"] },
      ],
    });
    await notifyEmailScanRun(deps, FAKE_SUMMARY);
    expect(sendMail).toHaveBeenCalledTimes(2);
    const toAddresses = sendMail.mock.calls.map(c => c[0].to).sort();
    expect(toAddresses).toEqual(["also-include@x", "include@x"]);
  });

  it("is a no-op when globally disabled", async () => {
    const sendMail = vi.fn();
    const deps = makeDeps({
      enabled: false,
      sendMail,
      recipients: [{ address: "x@x", allowedSources: ["scan-run"] }],
    });
    await notifyEmailScanRun(deps, FAKE_SUMMARY);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("is a no-op when no recipients subscribe to scan-run", async () => {
    const sendMail = vi.fn();
    const deps = makeDeps({
      sendMail,
      recipients: [
        { address: "x@x", allowedSources: ["webhook", "scan"] },
      ],
    });
    await notifyEmailScanRun(deps, FAKE_SUMMARY);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("envelope contains subject + html + text with run link", async () => {
    const sendMail = vi.fn().mockResolvedValue({ accepted: ["x"] });
    const deps = makeDeps({
      sendMail,
      recipients: [{ address: "x@x", allowedSources: ["scan-run"] }],
    });
    await notifyEmailScanRun(deps, FAKE_SUMMARY);
    const envelope = sendMail.mock.calls[0]![0];
    expect(envelope.from).toBe("from@x");
    expect(envelope.to).toBe("x@x");
    expect(envelope.subject).toContain("Scan flagged 2 services");
    expect(envelope.html).toContain("/scan/runs/r1");
    expect(envelope.text).toContain("/scan/runs/r1");
  });

  it("swallows per-recipient send failures via Promise.allSettled", async () => {
    const sendMail = vi.fn()
      .mockResolvedValueOnce({ accepted: ["ok@x"] })
      .mockRejectedValueOnce(new Error("SMTP boom"));
    const deps = makeDeps({
      sendMail,
      recipients: [
        { address: "ok@x", allowedSources: ["scan-run"] },
        { address: "bad@x", allowedSources: ["scan-run"] },
      ],
    });
    await expect(notifyEmailScanRun(deps, FAKE_SUMMARY)).resolves.toBeUndefined();
    expect(sendMail).toHaveBeenCalledTimes(2);
  });
});
