// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { shouldResetOnStackSwitch, autoRouteTargetForSetupStage } from "./App";

describe("shouldResetOnStackSwitch", () => {
  it("resets when viewing stack-specific panes", () => {
    expect(shouldResetOnStackSwitch({ type: "services" })).toBe(true);
    expect(shouldResetOnStackSwitch({ type: "investigation", id: "x", stackId: "s" })).toBe(true);
    expect(shouldResetOnStackSwitch({ type: "pattern", id: "p" })).toBe(true);
    expect(shouldResetOnStackSwitch({ type: "scanrun", runId: "r" })).toBe(true);
    expect(shouldResetOnStackSwitch({ type: "activity", tab: "investigations", query: {} })).toBe(true);
  });

  it("resets from any Settings tab so the switch is visible", () => {
    // Without this redirect, switching stacks while on /settings/providers
    // (or any other stack-scoped tab) silently re-keys the provider list
    // and the user has no visual confirmation that the switch actually
    // landed.
    expect(shouldResetOnStackSwitch({ type: "settings" })).toBe(true);
    expect(shouldResetOnStackSwitch({ type: "settings", initialTab: "providers" })).toBe(true);
    expect(shouldResetOnStackSwitch({ type: "settings", initialTab: "webhooks" })).toBe(true);
    expect(shouldResetOnStackSwitch({ type: "settings", initialTab: "discovery" })).toBe(true);
  });

  it("does NOT reset from Settings → Stacks (managing all stacks)", () => {
    // The Stacks tab IS the stack-management surface; bouncing the user
    // to the dashboard mid-management would yank them out of the task
    // they just used to trigger the switch.
    expect(shouldResetOnStackSwitch({ type: "settings", initialTab: "stacks" })).toBe(false);
  });

  it("does NOT reset on dashboard or notfound", () => {
    // Dashboard is already the redirect target — no-op.
    // NotFound shows the 404 for the URL the user typed; bouncing to the
    // dashboard would mask the typo'd URL.
    expect(shouldResetOnStackSwitch({ type: "dashboard" })).toBe(false);
    expect(shouldResetOnStackSwitch({ type: "notfound", path: "/bogus" })).toBe(false);
  });
});

describe("autoRouteTargetForSetupStage", () => {
  const base = {
    setupStage: "needs-provider" as const,
    setupDismissed: false,
    setupLoading: false,
    paneType: "dashboard" as const,
    lastRoutedStage: null,
  };

  it("redirects to settings when on dashboard with no provider", () => {
    expect(autoRouteTargetForSetupStage(base)).toBe("settings");
  });

  it("redirects to services when discovery is the next step", () => {
    expect(autoRouteTargetForSetupStage({ ...base, setupStage: "needs-discovery" })).toBe("services");
  });

  it("does NOT redirect when the user is on a deep route (bookmark / shared link)", () => {
    // ISSUE-001: previously the redirect fired regardless of where the
    // user landed, breaking bookmarks like /investigations?severity=high
    // and shared deep links like /investigations/inv_xyz. Deep routes now
    // stay put so the URL the user typed renders.
    expect(autoRouteTargetForSetupStage({ ...base, paneType: "investigations" })).toBeNull();
    expect(autoRouteTargetForSetupStage({ ...base, paneType: "investigation" })).toBeNull();
    expect(autoRouteTargetForSetupStage({ ...base, paneType: "services" })).toBeNull();
    expect(autoRouteTargetForSetupStage({ ...base, paneType: "scanrun" })).toBeNull();
    expect(autoRouteTargetForSetupStage({ ...base, paneType: "settings" })).toBeNull();
  });

  it("does NOT redirect on the notfound page (typo'd URLs render the 404)", () => {
    // ISSUE-002: bogus routes used to silently redirect to /settings;
    // the NotFound view now actually gets to render.
    expect(autoRouteTargetForSetupStage({ ...base, paneType: "notfound" })).toBeNull();
  });

  it("does NOT redirect when setup is complete", () => {
    expect(autoRouteTargetForSetupStage({ ...base, setupStage: "complete" })).toBeNull();
  });

  it("does NOT redirect when the user dismissed the stepper", () => {
    expect(autoRouteTargetForSetupStage({ ...base, setupDismissed: true })).toBeNull();
  });

  it("does NOT redirect while setup state is still loading", () => {
    expect(autoRouteTargetForSetupStage({ ...base, setupLoading: true })).toBeNull();
  });

  it("does NOT redirect twice for the same stage (avoid loop after manual nav)", () => {
    expect(autoRouteTargetForSetupStage({ ...base, lastRoutedStage: "needs-provider" })).toBeNull();
  });

  it("returns null for unknown stage strings", () => {
    expect(autoRouteTargetForSetupStage({ ...base, setupStage: "some-future-stage" })).toBeNull();
  });
});
