import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseUrl, viewToUrl } from "./useRoute";

describe("parseUrl", () => {
  it("parses / as dashboard", () => {
    expect(parseUrl("/")).toEqual({ type: "dashboard" });
  });

  it("parses empty string as dashboard", () => {
    expect(parseUrl("")).toEqual({ type: "dashboard" });
  });

  it("parses /stacks/:stackId/investigations/:id (canonical, stack-scoped)", () => {
    expect(parseUrl("/stacks/prod/investigations/inv_01KNR")).toEqual({
      type: "investigation",
      id: "inv_01KNR",
      stackId: "prod",
    });
  });

  it("encodes and decodes special characters in stackId / investigation id (defensive against schema broadening)", () => {
    // ULIDs are alphanumeric so this isn't a hot path today, but the URL
    // contract should survive a future change to slugs / mixed-case / etc.
    // Round-trip a value that needs percent-encoding through the serializer
    // and parser: viewToUrl encodes, parseUrl decodes, equality holds.
    const view = { type: "investigation" as const, id: "inv with space", stackId: "stack/slug" };
    const url = viewToUrl(view);
    expect(url).toBe("/stacks/stack%2Fslug/investigations/inv%20with%20space");
    expect(parseUrl(url)).toEqual(view);
  });

  it("parses legacy /investigations/:id with stackId='' sentinel for locate-and-redirect", () => {
    // Pre-stack-scoped bookmarks (Slack links, email notifications, etc.)
    // need to keep resolving. The empty stackId is the locate-pending
    // sentinel — App.tsx hits /api/investigations/:id/locate, switches to
    // the owning stack, and replaceState's to the canonical URL.
    expect(parseUrl("/investigations/inv_01KNR")).toEqual({
      type: "investigation",
      id: "inv_01KNR",
      stackId: "",
    });
  });

  it("parses /patterns/:id", () => {
    expect(parseUrl("/patterns/pat_01KNR")).toEqual({ type: "pattern", id: "pat_01KNR" });
  });

  it("parses /activity as the activity page on the investigations tab", () => {
    expect(parseUrl("/activity")).toEqual({ type: "activity", tab: "investigations", query: {} });
  });

  it("parses /activity/investigations as the investigations tab", () => {
    expect(parseUrl("/activity/investigations")).toEqual({ type: "activity", tab: "investigations", query: {} });
  });

  it("parses /activity/scans, /activity/events, /activity/patterns into their tabs", () => {
    expect(parseUrl("/activity/scans")).toEqual({ type: "activity", tab: "scans", query: {} });
    expect(parseUrl("/activity/events")).toEqual({ type: "activity", tab: "events", query: {} });
    expect(parseUrl("/activity/patterns")).toEqual({ type: "activity", tab: "patterns", query: {} });
  });

  it("returns notfound for unknown activity tabs", () => {
    expect(parseUrl("/activity/bogus")).toEqual({ type: "notfound", path: "/activity/bogus" });
  });

  it("parses /activity/investigations with search params into the query object", () => {
    const view = parseUrl("/activity/investigations", "?severity=critical,high&status=running&offset=25");
    expect(view).toEqual({
      type: "activity",
      tab: "investigations",
      query: { severity: ["critical", "high"], status: ["running"], offset: 25 },
    });
  });

  it("activity investigations tab ignores unknown search keys and invalid values", () => {
    const view = parseUrl("/activity/investigations", "?severity=bogus&unknown=x");
    expect(view).toEqual({ type: "activity", tab: "investigations", query: {} });
  });

  it("/activity/scans parses its own ScanRunsQuery shape (status/trigger/outcome/range/offset)", () => {
    const view = parseUrl("/activity/scans", "?status=failed,complete&trigger=cron&outcome=dispatched&range=24h&offset=25");
    expect(view).toEqual({
      type: "activity",
      tab: "scans",
      query: {
        status: ["failed", "complete"],
        trigger: ["cron"],
        outcome: ["dispatched"],
        range: "24h",
        offset: 25,
      },
    });
  });

  it("/activity/scans drops keys that aren't part of ScanRunsQuery", () => {
    // `severity` is an InvestigationsQuery key — the scans parser doesn't
    // recognize it, so it gets dropped. `offset` is shared.
    expect(parseUrl("/activity/scans", "?severity=high&offset=10"))
      .toEqual({ type: "activity", tab: "scans", query: { offset: 10 } });
  });

  it("/activity/patterns parses its own PatternsQuery shape (service/severity/range/q/sort/offset)", () => {
    const view = parseUrl("/activity/patterns", "?service=payments-api&severity=critical,high&range=7d&q=oom&sort=severity&offset=25");
    expect(view).toEqual({
      type: "activity",
      tab: "patterns",
      query: {
        service: "payments-api",
        severity: ["critical", "high"],
        range: "7d",
        q: "oom",
        sort: "severity",
        offset: 25,
      },
    });
  });

  it("/activity/patterns drops keys that aren't part of PatternsQuery", () => {
    expect(parseUrl("/activity/patterns", "?status=failed&service=foo"))
      .toEqual({ type: "activity", tab: "patterns", query: { service: "foo" } });
  });

  it("/activity/events parses its own EventsQuery shape", () => {
    const view = parseUrl("/activity/events", "?kind=investigation_started&severity=error,warn&service=payments-api&range=1h");
    expect(view).toEqual({
      type: "activity",
      tab: "events",
      query: {
        kind: ["investigation_started"],
        severity: ["error", "warn"],
        service: "payments-api",
        range: "1h",
      },
    });
  });

  it("/activity/events drops keys that aren't part of EventsQuery", () => {
    expect(parseUrl("/activity/events", "?status=failed&service=foo"))
      .toEqual({ type: "activity", tab: "events", query: { service: "foo" } });
  });

  it("legacy /investigations (no id) parses to the activity investigations tab — backwards compat", () => {
    // Old bookmarks land on the activity page; the mount-time redirect in
    // useRoute rewrites the URL to /activity/investigations so the user sees
    // the canonical path on first load.
    expect(parseUrl("/investigations")).toEqual({ type: "activity", tab: "investigations", query: {} });
  });

  it("legacy /investigations preserves search params on redirect", () => {
    const view = parseUrl("/investigations", "?severity=critical,high&status=running&offset=25");
    expect(view).toEqual({
      type: "activity",
      tab: "investigations",
      query: { severity: ["critical", "high"], status: ["running"], offset: 25 },
    });
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

  it("parses /settings/discovery as the discovery tab", () => {
    expect(parseUrl("/settings/discovery")).toEqual({ type: "settings", initialTab: "discovery" });
  });

  it("parses /settings/webhooks as the alert webhooks tab", () => {
    expect(parseUrl("/settings/webhooks")).toEqual({ type: "settings", initialTab: "webhooks" });
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

  it("maps investigation with stackId to /stacks/:stackId/investigations/:id", () => {
    expect(viewToUrl({ type: "investigation", id: "inv_abc", stackId: "prod" })).toBe(
      "/stacks/prod/investigations/inv_abc",
    );
  });

  it("maps investigation with empty stackId to legacy /investigations/:id", () => {
    // The serialize side honors the locate-pending sentinel: while the
    // owning stack is unknown, emit the legacy URL so a navigate({...},
    // { replace: true }) at locate-pending doesn't lock the URL into
    // /stacks//investigations/inv_abc (broken).
    expect(viewToUrl({ type: "investigation", id: "inv_abc", stackId: "" })).toBe(
      "/investigations/inv_abc",
    );
  });

  it("maps pattern to /patterns/:id", () => {
    expect(viewToUrl({ type: "pattern", id: "pat_abc" })).toBe("/patterns/pat_abc");
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

  it("maps activity investigations tab with empty query to /activity/investigations (no ?)", () => {
    expect(viewToUrl({ type: "activity", tab: "investigations", query: {} })).toBe("/activity/investigations");
  });

  it("maps activity investigations tab with filters to /activity/investigations?...", () => {
    expect(
      viewToUrl({
        type: "activity",
        tab: "investigations",
        query: { severity: ["critical"], status: ["complete", "failed"], offset: 25 },
      }),
    ).toBe("/activity/investigations?severity=critical&status=complete%2Cfailed&offset=25");
  });

  it("maps non-investigations tabs to /activity/<tab> with no search string", () => {
    expect(viewToUrl({ type: "activity", tab: "scans", query: {} })).toBe("/activity/scans");
    expect(viewToUrl({ type: "activity", tab: "events", query: {} })).toBe("/activity/events");
    expect(viewToUrl({ type: "activity", tab: "patterns", query: {} })).toBe("/activity/patterns");
  });

  it("scans tab serializes its ScanRunsQuery shape", () => {
    expect(
      viewToUrl({
        type: "activity",
        tab: "scans",
        query: { status: ["failed"], trigger: ["cron"], range: "24h", offset: 25 },
      }),
    ).toBe("/activity/scans?status=failed&trigger=cron&range=24h&offset=25");
  });

  it("patterns tab serializes its PatternsQuery shape", () => {
    expect(
      viewToUrl({
        type: "activity",
        tab: "patterns",
        query: { service: "payments-api", severity: ["critical"], range: "7d", q: "oom", sort: "severity" },
      }),
    ).toBe("/activity/patterns?service=payments-api&severity=critical&range=7d&q=oom&sort=severity");
  });

  it("events tab serializes its EventsQuery shape", () => {
    expect(
      viewToUrl({
        type: "activity",
        tab: "events",
        query: { severity: ["error"], kind: ["investigation_started"], range: "1h" },
      }),
    ).toBe("/activity/events?kind=investigation_started&severity=error&range=1h");
  });
});

describe("roundtrip", () => {
  it("parseUrl(viewToUrl(view)) === view for all types", () => {
    const views = [
      { type: "dashboard" as const },
      { type: "investigation" as const, id: "inv_123", stackId: "prod" },
      { type: "pattern" as const, id: "pat_123" },
      { type: "activity" as const, tab: "investigations" as const, query: {} },
      { type: "activity" as const, tab: "scans" as const, query: {} },
      { type: "activity" as const, tab: "events" as const, query: {} },
      { type: "activity" as const, tab: "patterns" as const, query: {} },
      { type: "services" as const },
      { type: "services" as const, initialService: "my-svc" },
      { type: "settings" as const },
      { type: "settings" as const, initialTab: "providers" as const },
      { type: "settings" as const, initialTab: "webhooks" as const },
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
    // viewToUrl returns `/activity/investigations?...` — parseUrl needs the
    // search half separately. Mirrors how useRoute feeds
    // window.location.pathname + window.location.search at runtime.
    const view = {
      type: "activity" as const,
      tab: "investigations" as const,
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
    expect(mod.parseUrl("/dops/stacks/prod/investigations/inv_123")).toEqual({
      type: "investigation",
      id: "inv_123",
      stackId: "prod",
    });
    // Legacy URL still resolves under sub-path deploy (existing bookmarks).
    expect(mod.parseUrl("/dops/investigations/inv_123")).toEqual({
      type: "investigation",
      id: "inv_123",
      stackId: "",
    });
    expect(mod.parseUrl("/dops/patterns/pat_123")).toEqual({ type: "pattern", id: "pat_123" });
    expect(mod.parseUrl("/dops/services/api")).toEqual({ type: "services", initialService: "api" });
    expect(mod.parseUrl("/dops/settings/providers")).toEqual({ type: "settings", initialTab: "providers" });
    expect(mod.parseUrl("/dops/settings/webhooks")).toEqual({ type: "settings", initialTab: "webhooks" });
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
    expect(mod.viewToUrl({ type: "investigation", id: "inv_1", stackId: "prod" })).toBe(
      "/dops/stacks/prod/investigations/inv_1",
    );
    expect(mod.viewToUrl({ type: "pattern", id: "pat_1" })).toBe("/dops/patterns/pat_1");
    expect(mod.viewToUrl({ type: "services" })).toBe("/dops/services");
    expect(mod.viewToUrl({ type: "services", initialService: "api" })).toBe("/dops/services/api");
    expect(mod.viewToUrl({ type: "settings", initialTab: "webhooks" })).toBe("/dops/settings/webhooks");
  });

  it("parseUrl(viewToUrl(view)) roundtrip holds under sub-path", async () => {
    vi.stubEnv("BASE_URL", "/dops/");
    const mod = await import("./useRoute");

    const views = [
      { type: "dashboard" as const },
      { type: "investigation" as const, id: "inv_123", stackId: "prod" },
      { type: "pattern" as const, id: "pat_123" },
      { type: "services" as const, initialService: "api" },
      { type: "settings" as const, initialTab: "providers" as const },
      { type: "settings" as const, initialTab: "webhooks" as const },
    ];
    for (const view of views) {
      expect(mod.parseUrl(mod.viewToUrl(view))).toEqual(view);
    }
  });
});
