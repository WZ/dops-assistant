import { describe, it, expect } from "vitest";
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

  it("falls back to dashboard for unknown paths", () => {
    expect(parseUrl("/unknown/path")).toEqual({ type: "dashboard" });
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
    ];
    for (const view of views) {
      expect(parseUrl(viewToUrl(view))).toEqual(view);
    }
  });
});
