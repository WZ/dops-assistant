// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { shouldResetOnStackSwitch, autoRouteTargetForSetupStage } from "./App";

describe("shouldResetOnStackSwitch", () => {
  it("resets when viewing stack-specific panes", () => {
    // A service open from stack A would render stale data under stack B,
    // so we need to unmount it and fall back to the dashboard.
    expect(shouldResetOnStackSwitch("services")).toBe(true);
    expect(shouldResetOnStackSwitch("investigation")).toBe(true);
  });

  it("does NOT reset when on stack-neutral panes", () => {
    // Regression guard for QA #19 — a sidebar click to Settings raced with
    // a stack switch and the switch's blanket reset clobbered the click
    // target, causing a visible "double redirect" flash (/ → /settings).
    // Settings/dashboard/notfound don't depend on stack data, so the
    // reset is pure noise here.
    expect(shouldResetOnStackSwitch("settings")).toBe(false);
    expect(shouldResetOnStackSwitch("dashboard")).toBe(false);
    expect(shouldResetOnStackSwitch("notfound")).toBe(false);
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
