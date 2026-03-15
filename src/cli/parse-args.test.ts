import { describe, it, expect } from "vitest";
import { parseArgs } from "./parse-args.js";

describe("parseArgs", () => {
  it("parses investigate command", () => {
    const result = parseArgs(["investigate", "api-gateway"]);
    expect(result).toEqual({
      command: "investigate",
      args: ["api-gateway"],
      flags: { timeout: 120000, verbose: false, config: "config.yaml", history: false },
    });
  });

  it("parses chat command with quoted message", () => {
    const result = parseArgs(["chat", "What alerts fired?"]);
    expect(result).toEqual({
      command: "chat",
      args: ["What alerts fired?"],
      flags: { timeout: 120000, verbose: false, config: "config.yaml", history: false },
    });
  });

  it("parses mcp-check command", () => {
    const result = parseArgs(["mcp-check"]);
    expect(result.command).toBe("mcp-check");
  });

  it("parses e2e command with scenario file", () => {
    const result = parseArgs(["e2e", "scenarios/test.json"]);
    expect(result).toEqual({
      command: "e2e",
      args: ["scenarios/test.json"],
      flags: { timeout: 120000, verbose: false, config: "config.yaml", history: false },
    });
  });

  it("parses interactive command", () => {
    const result = parseArgs(["interactive"]);
    expect(result.command).toBe("interactive");
  });

  it("defaults to interactive when no command given", () => {
    const result = parseArgs([]);
    expect(result.command).toBe("interactive");
  });

  it("parses --verbose flag", () => {
    const result = parseArgs(["investigate", "svc", "--verbose"]);
    expect(result.flags.verbose).toBe(true);
  });

  it("parses --timeout flag", () => {
    const result = parseArgs(["chat", "hi", "--timeout", "30000"]);
    expect(result.flags.timeout).toBe(30000);
  });

  it("parses --config flag", () => {
    const result = parseArgs(["mcp-check", "--config", "/path/to/config.yaml"]);
    expect(result.flags.config).toBe("/path/to/config.yaml");
  });

  it("parses --history flag to enable history", () => {
    const result = parseArgs(["investigate", "svc", "--history"]);
    expect(result.flags.history).toBe(true);
  });

  it("returns unknown command as-is for error handling upstream", () => {
    const result = parseArgs(["bogus"]);
    expect(result.command).toBe("bogus");
  });

  it("uses CONFIG_PATH env var when --config not set", () => {
    const prev = process.env.CONFIG_PATH;
    process.env.CONFIG_PATH = "/env/config.yaml";
    const result = parseArgs(["mcp-check"]);
    expect(result.flags.config).toBe("/env/config.yaml");
    process.env.CONFIG_PATH = prev;
  });
});
