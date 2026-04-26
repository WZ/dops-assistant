import { describe, expect, it } from "vitest";
import { LlmUnavailableError, isLlmUnavailable } from "./llm-errors.js";

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
    "request timed out after 30s",
    "Cannot connect to API",
    "connect ECONNREFUSED",
    "Bad Gateway",
    "Service Unavailable",
    "rate limit reached",
    "HTTP 429 Too Many Requests",
    "HTTP 502",
    "HTTP 503",
    "HTTP 504",
  ])("classifies %s as transient", (msg) => {
    expect(isLlmUnavailable(new Error(msg))).toBe(true);
  });

  it.each([
    "Unexpected token } in JSON at position 42",
    "schema validation failed",
    "401 Unauthorized",
    "invalid api key",
    "context length exceeded",
  ])("classifies %s as non-transient", (msg) => {
    expect(isLlmUnavailable(new Error(msg))).toBe(false);
  });

  it("checks the cause chain too", () => {
    const cause = new Error("ECONNREFUSED");
    const wrapped = new Error("Mastra: agent generation failed", { cause });
    expect(isLlmUnavailable(wrapped)).toBe(true);
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
