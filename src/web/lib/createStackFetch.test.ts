import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * APP_BASE_PATH is evaluated at module import time, so to exercise both
 * the "/" (no sub-path) and "/dops/" (sub-path) cases we stub
 * import.meta.env.BASE_URL, reset the module cache, and dynamically re-import
 * the helper inside each test.
 */

describe("createStackFetch helpers", () => {
  const originalFetch = globalThis.fetch;
  // vitest's default node env doesn't provide a `window` global. The source
  // guards with `typeof window !== "undefined"`, so installing a stub here
  // lets us exercise both "window absent" and "window.__APP_BASE__ set" paths.
  const originalWindow = (globalThis as { window?: unknown }).window;

  beforeEach(() => {
    vi.resetModules();
    (globalThis as { window?: unknown }).window = {};
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    globalThis.fetch = originalFetch;
    (globalThis as { window?: unknown }).window = originalWindow;
  });

  describe("APP_BASE_PATH", () => {
    it("falls back to '/' when BASE_URL is undefined/empty", async () => {
      vi.stubEnv("BASE_URL", "");
      const { APP_BASE_PATH } = await import("./createStackFetch");
      expect(APP_BASE_PATH).toBe("/");
    });

    it("reflects Vite's configured BASE_URL when set", async () => {
      vi.stubEnv("BASE_URL", "/dops/");
      const { APP_BASE_PATH } = await import("./createStackFetch");
      expect(APP_BASE_PATH).toBe("/dops/");
    });

    it("prefers window.__APP_BASE__ (runtime) over import.meta.env.BASE_URL (build-time)", async () => {
      vi.stubEnv("BASE_URL", "/");
      (globalThis.window as { __APP_BASE__?: string }).__APP_BASE__ = "/dops/";
      const { APP_BASE_PATH } = await import("./createStackFetch");
      expect(APP_BASE_PATH).toBe("/dops/");
    });

    it("normalizes window.__APP_BASE__ that lacks a trailing slash", async () => {
      vi.stubEnv("BASE_URL", "/");
      (globalThis.window as { __APP_BASE__?: string }).__APP_BASE__ = "/dops";
      const { APP_BASE_PATH } = await import("./createStackFetch");
      expect(APP_BASE_PATH).toBe("/dops/");
    });

    it("normalizes a base without leading slash", async () => {
      vi.stubEnv("BASE_URL", "/");
      (globalThis.window as { __APP_BASE__?: string }).__APP_BASE__ = "dops/";
      const { APP_BASE_PATH } = await import("./createStackFetch");
      expect(APP_BASE_PATH).toBe("/dops/");
    });
  });

  describe("withBase", () => {
    it("returns the url unchanged when base is '/'", async () => {
      vi.stubEnv("BASE_URL", "/");
      const { withBase } = await import("./createStackFetch");
      expect(withBase("/api/health")).toBe("/api/health");
      expect(withBase("/api/stacks")).toBe("/api/stacks");
    });

    it("prepends the base path when the app is served from a sub-path", async () => {
      vi.stubEnv("BASE_URL", "/dops/");
      const { withBase } = await import("./createStackFetch");
      expect(withBase("/api/health")).toBe("/dops/api/health");
      expect(withBase("/api/stacks")).toBe("/dops/api/stacks");
    });

    it("does not double the slash when the input url lacks a leading slash", async () => {
      vi.stubEnv("BASE_URL", "/dops/");
      const { withBase } = await import("./createStackFetch");
      expect(withBase("api/health")).toBe("/dops/api/health");
    });
  });

  describe("createStackFetch", () => {
    it("sends X-Stack-Id header and fetches the base-prefixed URL", async () => {
      vi.stubEnv("BASE_URL", "/dops/");
      const { createStackFetch } = await import("./createStackFetch");

      const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const stackFetch = createStackFetch("stack-123");
      await stackFetch("/api/health");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("/dops/api/health");
      const headers = new Headers((init as RequestInit).headers);
      expect(headers.get("X-Stack-Id")).toBe("stack-123");
    });

    it("uses the plain URL when base is '/'", async () => {
      vi.stubEnv("BASE_URL", "/");
      const { createStackFetch } = await import("./createStackFetch");

      const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const stackFetch = createStackFetch("stack-abc");
      await stackFetch("/api/stacks");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]![0]).toBe("/api/stacks");
    });
  });
});
