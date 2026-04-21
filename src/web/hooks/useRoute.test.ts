import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseUrl, viewToUrl } from "./useRoute";

describe("parseUrl", () => {
  it("parses / as dashboard", () => {
    expect(parseUrl("/")).toEqual({ type: "dashboard" });
  });

  it("parses empty string as dashboard", () => {
    expect(parseUrl("")).toEqual({ type: "dashboard" });
  });

  it("parses /investigations/:id", () => {
    expect(parseUrl("/investigations/inv_01KNR")).toEqual({ type: "investigation", id: "inv_01KNR" });
  });

  it("parses /services", () => {
    expect(parseUrl("/services")).toEqual({ type: "services", initialService: undefined });
  });

  it("parses /services/:name", () => {
    expect(parseUrl("/services/ingestion-server")).toEqual({ type: "services", initialService: "ingestion-server" });
  });

  it("parses /settings", () => {
    expect(parseUrl("/settings")).toEqual({ type: "settings", initialTab: undefined });
  });

  it("parses /settings/:tab", () => {
    expect(parseUrl("/settings/providers")).toEqual({ type: "settings", initialTab: "providers" });
  });

  it("parses /settings/scan as the scan tab", () => {
    expect(parseUrl("/settings/scan")).toEqual({ type: "settings", initialTab: "scan" });
  });

  it("parses /settings/notifications as the notifications tab", () => {
    expect(parseUrl("/settings/notifications")).toEqual({ type: "settings", initialTab: "notifications" });
  });

  it("returns notfound for unknown paths", () => {
    // Previously silently rendered the dashboard, which hid dead links and
    // routing bugs. Unknown paths now surface as an explicit 404 view.
    expect(parseUrl("/unknown/path")).toEqual({ type: "notfound", path: "/unknown/path" });
  });

  it("returns notfound for unknown settings tabs", () => {
    // /settings/foo used to render an empty settings shell. Now it 404s.
    expect(parseUrl("/settings/foo")).toEqual({ type: "notfound", path: "/settings/foo" });
  });

  it("parses /dashboard explicitly as dashboard", () => {
    expect(parseUrl("/dashboard")).toEqual({ type: "dashboard" });
  });

  it("strips trailing slashes", () => {
    expect(parseUrl("/services/")).toEqual({ type: "services", initialService: undefined });
  });
});

describe("viewToUrl", () => {
  it("maps dashboard to /", () => {
    expect(viewToUrl({ type: "dashboard" })).toBe("/");
  });

  it("maps investigation to /investigations/:id", () => {
    expect(viewToUrl({ type: "investigation", id: "inv_abc" })).toBe("/investigations/inv_abc");
  });

  it("maps services to /services", () => {
    expect(viewToUrl({ type: "services" })).toBe("/services");
  });

  it("maps services with name to /services/:name", () => {
    expect(viewToUrl({ type: "services", initialService: "api" })).toBe("/services/api");
  });

  it("maps settings to /settings", () => {
    expect(viewToUrl({ type: "settings" })).toBe("/settings");
  });

  it("maps settings with tab to /settings/:tab", () => {
    expect(viewToUrl({ type: "settings", initialTab: "skills" })).toBe("/settings/skills");
  });
});

describe("roundtrip", () => {
  it("parseUrl(viewToUrl(view)) === view for all types", () => {
    const views = [
      { type: "dashboard" as const },
      { type: "investigation" as const, id: "inv_123" },
      { type: "services" as const },
      { type: "services" as const, initialService: "my-svc" },
      { type: "settings" as const },
      { type: "settings" as const, initialTab: "providers" as const },
      // notfound preserves the user-typed path verbatim so reload stays on
      // the 404 page instead of bouncing back to the dashboard.
      { type: "notfound" as const, path: "/bogus/path" },
    ];
    for (const view of views) {
      expect(parseUrl(viewToUrl(view))).toEqual(view);
    }
  });
});

/**
 * Sub-path deploys (e.g. served at https://host/dops/) require parseUrl to
 * strip the base prefix before matching, and viewToUrl to prepend it. These
 * tests re-import the module under a stubbed BASE_URL to exercise that path.
 */
describe("useRoute — sub-path deploy (BASE_URL='/dops/')", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parseUrl strips the base prefix before matching", async () => {
    vi.stubEnv("BASE_URL", "/dops/");
    const mod = await import("./useRoute");

    expect(mod.parseUrl("/dops/")).toEqual({ type: "dashboard" });
    expect(mod.parseUrl("/dops/investigations/inv_123")).toEqual({ type: "investigation", id: "inv_123" });
    expect(mod.parseUrl("/dops/services/api")).toEqual({ type: "services", initialService: "api" });
    expect(mod.parseUrl("/dops/settings/providers")).toEqual({ type: "settings", initialTab: "providers" });
  });

  it("parseUrl returns notfound for paths that don't start with the base", async () => {
    // Paths that bypass the configured sub-path can't be resolved to any
    // known view. Previously they rendered the dashboard silently; now they
    // surface as an explicit 404 so misconfigured links are visible.
    vi.stubEnv("BASE_URL", "/dops/");
    const mod = await import("./useRoute");

    expect(mod.parseUrl("/other/route")).toEqual({ type: "notfound", path: "/other/route" });
  });

  it("viewToUrl prepends the base path", async () => {
    vi.stubEnv("BASE_URL", "/dops/");
    const mod = await import("./useRoute");

    expect(mod.viewToUrl({ type: "dashboard" })).toBe("/dops/");
    expect(mod.viewToUrl({ type: "investigation", id: "inv_1" })).toBe("/dops/investigations/inv_1");
    expect(mod.viewToUrl({ type: "services" })).toBe("/dops/services");
    expect(mod.viewToUrl({ type: "services", initialService: "api" })).toBe("/dops/services/api");
    expect(mod.viewToUrl({ type: "settings", initialTab: "skills" })).toBe("/dops/settings/skills");
  });

  it("parseUrl(viewToUrl(view)) roundtrip holds under sub-path", async () => {
    vi.stubEnv("BASE_URL", "/dops/");
    const mod = await import("./useRoute");

    const views = [
      { type: "dashboard" as const },
      { type: "investigation" as const, id: "inv_123" },
      { type: "services" as const, initialService: "api" },
      { type: "settings" as const, initialTab: "providers" as const },
    ];
    for (const view of views) {
      expect(mod.parseUrl(mod.viewToUrl(view))).toEqual(view);
    }
  });
});
