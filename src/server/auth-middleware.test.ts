import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { createApiKeyMiddleware } from "./auth-middleware.js";

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    method: "POST",
    path: "/api/stacks",
    headers: {},
    ...overrides,
  } as unknown as Request;
}

function mockRes(): Response & { _status: number; _body: unknown } {
  const res = {
    _status: 0,
    _body: undefined as unknown,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(body: unknown) {
      res._body = body;
      return res;
    },
  } as unknown as Response & { _status: number; _body: unknown };
  return res;
}

describe("createApiKeyMiddleware", () => {
  it("passes through when no API key is configured", () => {
    const mw = createApiKeyMiddleware(undefined);
    const next = vi.fn();
    mw(mockReq(), mockRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it("passes through when API key is empty string", () => {
    const mw = createApiKeyMiddleware("");
    const next = vi.fn();
    mw(mockReq(), mockRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it("allows GET requests even when API key is configured", () => {
    const mw = createApiKeyMiddleware("secret-key");
    const next = vi.fn();
    mw(mockReq({ method: "GET" }), mockRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it("allows POST with valid API key", () => {
    const mw = createApiKeyMiddleware("secret-key");
    const next = vi.fn();
    mw(
      mockReq({ headers: { "x-api-key": "secret-key" } as Record<string, string> }),
      mockRes(),
      next,
    );
    expect(next).toHaveBeenCalled();
  });

  it("rejects POST with invalid API key", () => {
    const mw = createApiKeyMiddleware("secret-key");
    const next = vi.fn();
    const res = mockRes();
    mw(
      mockReq({ headers: { "x-api-key": "wrong-key" } as Record<string, string> }),
      res,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
    expect(res._body).toEqual({
      error: "Forbidden",
      message: "Invalid or missing API key",
    });
  });

  it("rejects POST without API key header when key is configured", () => {
    const mw = createApiKeyMiddleware("secret-key");
    const next = vi.fn();
    const res = mockRes();
    mw(mockReq(), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
  });

  it("rejects PUT without API key header when key is configured", () => {
    const mw = createApiKeyMiddleware("secret-key");
    const next = vi.fn();
    const res = mockRes();
    mw(mockReq({ method: "PUT" }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
  });

  it("rejects DELETE without API key header when key is configured", () => {
    const mw = createApiKeyMiddleware("secret-key");
    const next = vi.fn();
    const res = mockRes();
    mw(mockReq({ method: "DELETE" }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
  });

  it("allows exempt paths even without API key", () => {
    const mw = createApiKeyMiddleware("secret-key", ["/api/webhook/alert"]);
    const next = vi.fn();
    mw(mockReq({ path: "/api/webhook/alert" }), mockRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it("allows exempt path prefixes (e.g., stack-scoped webhook)", () => {
    const mw = createApiKeyMiddleware("secret-key", ["/api/webhook/alert"]);
    const next = vi.fn();
    mw(mockReq({ path: "/api/webhook/alert/eu-west" }), mockRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it("does not exempt non-matching paths", () => {
    const mw = createApiKeyMiddleware("secret-key", ["/api/webhook/alert"]);
    const next = vi.fn();
    const res = mockRes();
    mw(mockReq({ path: "/api/stacks" }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
  });
});
