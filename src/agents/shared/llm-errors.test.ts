import { APICallError } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { LlmUnavailableError, isLlmUnavailable } from "./llm-errors.js";

const apiError = (statusCode: number, message = "boom") =>
  new APICallError({
    message,
    url: "https://example.com/llm",
    requestBodyValues: {},
    statusCode,
  });

describe("isLlmUnavailable", () => {
  it.each([
    "ECONNREFUSED 127.0.0.1:8080",
    "fetch failed",
    "ETIMEDOUT",
    "ENOTFOUND example.com",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "ECONNRESET",
    "EAI_AGAIN",
    "Cannot connect to API",
    "connect ECONNREFUSED",
  ])("classifies connection-level %s as transient", (msg) => {
    expect(isLlmUnavailable(new Error(msg))).toBe(true);
  });

  it.each([408, 409, 429, 500, 502, 503, 504])(
    "classifies APICallError with status %i as transient",
    (statusCode) => {
      expect(isLlmUnavailable(apiError(statusCode))).toBe(true);
    },
  );

  it.each([400, 401, 403, 404, 422])(
    "classifies APICallError with status %i as non-transient",
    (statusCode) => {
      expect(isLlmUnavailable(apiError(statusCode))).toBe(false);
    },
  );

  it.each([
    "Unexpected token } in JSON at position 42",
    "schema validation failed",
    "401 Unauthorized",
    "invalid api key",
    "context length exceeded",
    // Tool-like errors that previously false-positive matched the broader regex.
    // These could come from Prometheus, Loki, or MCP — never retry the LLM for them.
    "loki query timed out",
    "Prometheus returned 503",
    "rate limit on Grafana API",
  ])("classifies %s as non-transient", (msg) => {
    expect(isLlmUnavailable(new Error(msg))).toBe(false);
  });

  it("walks the cause chain", () => {
    const cause = new Error("ECONNREFUSED");
    const wrapped = new Error("Mastra: agent generation failed", { cause });
    expect(isLlmUnavailable(wrapped)).toBe(true);
  });

  it("walks deeper cause chains (up to 5 levels)", () => {
    const innermost = new Error("ECONNREFUSED");
    const layer1 = new Error("layer1", { cause: innermost });
    const layer2 = new Error("layer2", { cause: layer1 });
    const layer3 = new Error("layer3", { cause: layer2 });
    expect(isLlmUnavailable(layer3)).toBe(true);
  });

  it("recognises APICallError nested under a wrapper", () => {
    const inner = apiError(503);
    const wrapper = new Error("Mastra step failed", { cause: inner });
    expect(isLlmUnavailable(wrapper)).toBe(true);
  });

  it("handles non-Error input", () => {
    expect(isLlmUnavailable("ECONNREFUSED")).toBe(true);
    expect(isLlmUnavailable("bad json")).toBe(false);
    expect(isLlmUnavailable(null)).toBe(false);
    expect(isLlmUnavailable(undefined)).toBe(false);
  });
});

describe("LlmUnavailableError", () => {
  it("preserves cause and has stable name", () => {
    const cause = new Error("ECONNREFUSED");
    const err = new LlmUnavailableError(cause);
    expect(err.name).toBe("LlmUnavailableError");
    expect(err.cause).toBe(cause);
    expect(err.message).toContain("LLM unavailable");
  });
});
