// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { shouldResetOnStackSwitch } from "./App";

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
