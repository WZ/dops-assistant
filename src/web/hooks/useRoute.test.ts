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

  it("parses /investigations (no id) as the list page with empty query", () => {
    // Must match BEFORE /investigations/:id so the bare path doesn't resolve
    // to an empty id.
    expect(parseUrl("/investigations")).toEqual({ type: "investigations", query: {} });
  });

  it("parses /investigations with search params into the query object", () => {
    const view = parseUrl("/investigations", "?severity=critical,high&status=running&offset=25");
    expect(view).toEqual({
      type: "investigations",
      query: { severity: ["critical", "high"], status: ["running"], offset: 25 },
    });
  });

  it("list page ignores unknown search keys and invalid values", () => {
    // URL state is soft input (bookmarks, pasted links). Drop junk and keep
    // going so the user isn't blocked by a typo.
    const view = parseUrl("/investigations", "?severity=bogus&unknown=x");
    expect(view).toEqual({ type: "investigations", query: {} });
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

  it("parses /scan/runs/:id as scanrun", () => {
    expect(parseUrl("/scan/runs/run_01J")).toEqual({ type: "scanrun", runId: "run_01J" });
  });

  it("decodes percent-encoded scan run ids", () => {
    expect(parseUrl("/scan/runs/run%3A01J")).toEqual({ type: "scanrun", runId: "run:01J" });
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

  it("maps scanrun to /scan/runs/:id", () => {
    expect(viewToUrl({ type: "scanrun", runId: "run_01J" })).toBe("/scan/runs/run_01J");
  });

  it("maps investigations list with empty query to /investigations (no ?)", () => {
    expect(viewToUrl({ type: "investigations", query: {} })).toBe("/investigations");
  });

  it("maps investigations list with filters to /investigations?...", () => {
    expect(
      viewToUrl({
        type: "investigations",
        query: { severity: ["critical"], status: ["complete", "failed"], offset: 25 },
      }),
    ).toBe("/investigations?severity=critical&status=complete%2Cfailed&offset=25");
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
      { type: "scanrun" as const, runId: "run_01J" },
      // notfound preserves the user-typed path verbatim so reload stays on
      // the 404 page instead of bouncing back to the dashboard.
      { type: "notfound" as const, path: "/bogus/path" },
    ];
    for (const view of views) {
      expect(parseUrl(viewToUrl(view))).toEqual(view);
    }
  });

  it("parseUrl(viewToUrl(view)) preserves the investigations query", () => {
    // viewToUrl returns `/investigations?...` — parseUrl needs the search
    // half separately. Mirrors how useRoute feeds window.location.pathname
    // and window.location.search at runtime.
    const view = {
      type: "investigations" as const,
      query: {
        severity: ["critical" as const, "high" as const],
        status: ["running" as const],
        service: "payments-api",
        q: "redis",
        since: "2026-04-01T00:00:00Z",
        sort: "confidence" as const,
        limit: 50,
        offset: 100,
      },
    };
    const url = viewToUrl(view);
    const [pathname, search] = url.split("?");
    expect(parseUrl(pathname!, search ? `?${search}` : "")).toEqual(view);
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
