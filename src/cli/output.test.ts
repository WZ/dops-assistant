import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildOutput, writeOutput, type ToolCallRecord } from "./output.js";

describe("buildOutput", () => {
  it("builds a success envelope with all fields", () => {
    const result = buildOutput({
      command: "investigate",
      status: "success",
      durationMs: 1234,
      tokens: { input: 100, output: 50, total: 150 },
      toolCalls: [],
      result: { severity: "high" },
      extra: { service: "api-gateway", history: false },
    });

    expect(result).toEqual({
      command: "investigate",
      service: "api-gateway",
      history: false,
      status: "success",
      durationMs: 1234,
      tokens: { input: 100, output: 50, total: 150 },
      toolCalls: [],
      result: { severity: "high" },
      error: null,
    });
  });

  it("builds an error envelope with null result", () => {
    const result = buildOutput({
      command: "chat",
      status: "error",
      durationMs: 500,
      tokens: null,
      toolCalls: [],
      result: null,
      error: "LLM timeout",
      extra: { message: "hello" },
    });

    expect(result).toEqual({
      command: "chat",
      message: "hello",
      status: "error",
      durationMs: 500,
      tokens: null,
      toolCalls: [],
      result: null,
      error: "LLM timeout",
    });
  });
});

describe("writeOutput", () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((_data, cb?: any) => {
      if (typeof cb === "function") cb();
      return true;
    });
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
  });

  it("writes JSON to stdout and exits with code", async () => {
    const data = { command: "mcp-check", status: "success" };
    await writeOutput(data, 0);
    const written = writeSpy.mock.calls[0]?.[0] as string;
    expect(JSON.parse(written)).toEqual(data);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("exits with code 1 on error", async () => {
    const data = { command: "chat", status: "error", error: "timeout" };
    await writeOutput(data, 1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
