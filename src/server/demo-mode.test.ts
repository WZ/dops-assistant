import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDemoModeMiddleware, isDemoMode } from "./demo-mode.js";
import type { Request, Response, NextFunction } from "express";

function mockReq(method: string, path: string): Request {
  return { method, path } as Request;
}
function mockRes() {
  let statusCode = 200;
  let body: unknown = undefined;
  const res = {
    status(code: number) { statusCode = code; return this; },
    json(b: unknown) { body = b; return this; },
    get statusCode() { return statusCode; },
    get body() { return body; },
  } as unknown as Response & { statusCode: number; body: unknown };
  return res;
}

describe("demo-mode", () => {
  let originalDemoMode: string | undefined;

  beforeEach(() => {
    originalDemoMode = process.env["DEMO_MODE"];
    delete process.env["DEMO_MODE"];
  });
  afterEach(() => {
    if (originalDemoMode === undefined) delete process.env["DEMO_MODE"];
    else process.env["DEMO_MODE"] = originalDemoMode;
  });

  describe("isDemoMode", () => {
    it("returns false when DEMO_MODE is unset", () => {
      expect(isDemoMode()).toBe(false);
    });
    it("returns true for 'true'", () => {
      process.env["DEMO_MODE"] = "true";
      expect(isDemoMode()).toBe(true);
    });
    it("returns true for '1'", () => {
      process.env["DEMO_MODE"] = "1";
      expect(isDemoMode()).toBe(true);
    });
    it("returns false for anything else", () => {
      process.env["DEMO_MODE"] = "yes";
      expect(isDemoMode()).toBe(false);
      process.env["DEMO_MODE"] = "TRUE";
      expect(isDemoMode()).toBe(false);
    });
  });

  describe("createDemoModeMiddleware (inactive)", () => {
    it("is a pass-through when DEMO_MODE is unset", () => {
      const mw = createDemoModeMiddleware();
      const req = mockReq("POST", "/providers");
      const res = mockRes();
      let called = false;
      const next: NextFunction = () => { called = true; };
      mw(req, res, next);
      expect(called).toBe(true);
      expect((res as unknown as { statusCode: number }).statusCode).toBe(200);
    });
  });

  describe("createDemoModeMiddleware (active)", () => {
    beforeEach(() => { process.env["DEMO_MODE"] = "true"; });

    it("lets every GET through", () => {
      const mw = createDemoModeMiddleware();
      for (const path of ["/investigations", "/services", "/scan/runs", "/providers"]) {
        const req = mockReq("GET", path);
        const res = mockRes();
        let called = false;
        mw(req, res, () => { called = true; });
        expect(called, `GET ${path} should pass through`).toBe(true);
      }
    });

    it("rejects every POST that isn't on the allowlist with 403", () => {
      const mw = createDemoModeMiddleware();
      for (const path of ["/providers", "/investigations", "/scan/trigger", "/notifications/email/send", "/services/foo/metadata"]) {
        const req = mockReq("POST", path);
        const res = mockRes();
        let called = false;
        mw(req, res, () => { called = true; });
        expect(called, `POST ${path} should NOT call next`).toBe(false);
        expect((res as unknown as { statusCode: number }).statusCode, `POST ${path} should be 403`).toBe(403);
        const body = (res as unknown as { body: { demoMode: boolean; error: string } }).body;
        expect(body.demoMode).toBe(true);
        expect(body.error).toMatch(/demo mode/i);
      }
    });

    it("rejects PUT, PATCH, and DELETE too", () => {
      const mw = createDemoModeMiddleware();
      for (const method of ["PUT", "PATCH", "DELETE"]) {
        const req = mockReq(method, "/providers/x");
        const res = mockRes();
        let called = false;
        mw(req, res, () => { called = true; });
        expect(called, `${method} should NOT call next`).toBe(false);
        expect((res as unknown as { statusCode: number }).statusCode).toBe(403);
      }
    });

    it("whitelists POST /health", () => {
      const mw = createDemoModeMiddleware();
      const req = mockReq("POST", "/health");
      const res = mockRes();
      let called = false;
      mw(req, res, () => { called = true; });
      expect(called).toBe(true);
    });

    it("whitelists POST /investigations/:id/feedback", () => {
      const mw = createDemoModeMiddleware();
      const req = mockReq("POST", "/investigations/inv_abc123/feedback");
      const res = mockRes();
      let called = false;
      mw(req, res, () => { called = true; });
      expect(called).toBe(true);
    });

    it("does NOT whitelist other feedback-adjacent paths", () => {
      const mw = createDemoModeMiddleware();
      // /feedback with no investigation id under it
      const req = mockReq("POST", "/feedback");
      const res = mockRes();
      let called = false;
      mw(req, res, () => { called = true; });
      expect(called).toBe(false);
      expect((res as unknown as { statusCode: number }).statusCode).toBe(403);
    });
  });
});
