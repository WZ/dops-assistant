// src/cli/cli-integration.test.ts
import { describe, it, expect } from "vitest";
import { parseArgs } from "./parse-args.js";
import { buildOutput } from "./output.js";
import { evaluateAssertions } from "./assertions.js";

describe("CLI integration", () => {
  it("arg parser → investigate → output envelope", () => {
    const parsed = parseArgs(["investigate", "api-gateway", "--verbose", "--timeout", "60000"]);
    expect(parsed.command).toBe("investigate");
    expect(parsed.args).toEqual(["api-gateway"]);
    expect(parsed.flags.verbose).toBe(true);
    expect(parsed.flags.timeout).toBe(60000);
    expect(parsed.flags.history).toBe(false);

    const output = buildOutput({
      command: "investigate",
      status: "success",
      durationMs: 5000,
      tokens: { input: 100, output: 50, total: 150 },
      toolCalls: [{ name: "tool1", argsSummary: "{}", durationMs: 100 }],
      result: { severity: "high" },
      extra: { service: "api-gateway", history: false },
    });

    expect(output.command).toBe("investigate");
    expect(output.service).toBe("api-gateway");
    expect(output.status).toBe("success");
  });

  it("assertion engine works with investigate output shape", () => {
    const output = {
      command: "investigate",
      status: "success",
      result: {
        severity: "high",
        confidenceScore: 0.85,
        evidence: { metrics: ["cpu > 90%"], logs: [], infra: [] },
      },
    };

    const results = evaluateAssertions(output, {
      status: "success",
      "result.severity": { in: ["high", "critical"] },
      "result.confidenceScore": { gte: 0.5 },
      "result.evidence.metrics": { not_empty: true },
    });

    expect(results.every((r) => r.pass)).toBe(true);
  });

  it("e2e defaults: no args → interactive, history off", () => {
    const parsed = parseArgs([]);
    expect(parsed.command).toBe("interactive");
    expect(parsed.flags.history).toBe(false);
  });

  it("unknown command produces exit code 2 shape", () => {
    const parsed = parseArgs(["bogus"]);
    expect(parsed.command).toBe("bogus");

    const output = buildOutput({
      command: parsed.command,
      status: "error",
      durationMs: 0,
      error: `unknown command: ${parsed.command}. Available: investigate, chat, mcp-check, e2e, interactive`,
    });
    expect(output.status).toBe("error");
    expect(output.error).toContain("unknown command: bogus");
  });

  it("missing required args produce exit code 2 shape", () => {
    const parsed = parseArgs(["investigate"]);
    expect(parsed.command).toBe("investigate");
    expect(parsed.args).toEqual([]);

    const output = buildOutput({
      command: "investigate",
      status: "error",
      durationMs: 0,
      error: "usage: dops investigate <service>",
    });
    expect(output.error).toContain("usage:");
  });
});
