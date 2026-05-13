// src/web/components/SettingsPage.test.tsx
// @vitest-environment jsdom
import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import { SettingsPage, type SettingsTab } from "./SettingsPage";
import type { StackSummary } from "../../types/stack-types.js";

vi.mock("./ProvidersPage", () => ({
  ProvidersPage: ({ onRunDiscovery }: { onRunDiscovery: () => void }) => (
    <div data-testid="providers-page">Providers</div>
  ),
}));
vi.mock("./SkillsPage", () => ({
  SkillsPage: () => <div data-testid="skills-page">Skills</div>,
}));
vi.mock("./StacksManagePage", () => ({
  StacksManagePage: () => <div data-testid="stacks-page">Stacks</div>,
}));
vi.mock("./ScanTab", () => ({
  ScanTab: () => <div data-testid="scan-page">Scan</div>,
}));
vi.mock("./NotificationsTab", () => ({
  NotificationsTab: () => <div data-testid="notifications-page">Notifications</div>,
}));

const stacks: StackSummary[] = [{ id: "alpha", name: "alpha", slug: "alpha" } as StackSummary];

// Stateful harness — mirrors how App.tsx hosts SettingsPage. Internal tab
// clicks fire onChangeTab → harness state updates → SettingsPage re-renders
// with the new activeTab. Always-in-sync, no divergence possible.
function Harness({ initial, onChange }: { initial: SettingsTab; onChange?: (tab: SettingsTab) => void }) {
  const [tab, setTab] = useState<SettingsTab>(initial);
  return (
    <SettingsPage
      onRunDiscovery={() => {}}
      activeTab={tab}
      onChangeTab={(t) => {
        setTab(t);
        onChange?.(t);
      }}
      stacks={stacks}
      activeStackId="alpha"
      onSwitchStack={() => {}}
      onRefetchStacks={async () => {}}
    />
  );
}

describe("SettingsPage", () => {
  it("shows the activeTab on mount", () => {
    render(<Harness initial="providers" />);
    expect(screen.getByTestId("providers-page")).toBeDefined();
  });

  it("propagates internal tab clicks through onChangeTab", () => {
    const spy = vi.fn();
    render(<Harness initial="providers" onChange={spy} />);
    fireEvent.click(screen.getByRole("tab", { name: /Skills/ }));
    expect(spy).toHaveBeenCalledWith("skills");
    expect(screen.getByTestId("skills-page")).toBeDefined();
  });

  it("switches between tabs as the harness state updates", () => {
    render(<Harness initial="providers" />);
    fireEvent.click(screen.getByRole("tab", { name: /Skills/ }));
    expect(screen.getByTestId("skills-page")).toBeDefined();
    fireEvent.click(screen.getByRole("tab", { name: /Providers/ }));
    expect(screen.getByTestId("providers-page")).toBeDefined();
  });

  // Regression for the production bug behind both #217 and this PR:
  //
  // 1. Land on /settings/stacks → activeTab="stacks", Stacks visible.
  // 2. User clicks Notifications inside Settings.
  // 3. User clicks "New Stack" in the top-nav StackSwitcher, which targets
  //    initialTab="stacks" — the same value as the URL already had.
  //
  // The earlier uncontrolled-tabs / useState+useEffect version stayed on
  // Notifications because step 2 mutated only the local Tabs state, then
  // step 3 didn't change the initialTab prop so the useEffect skipped the
  // re-sync. The controlled rewrite makes step 2 propagate up through
  // onChangeTab, so step 3 always works.
  it("regression: external nav back to the URL's tab snaps the view back when an internal click moved it away", () => {
    // Parent owns the active tab. We surface it via a ref-style closure so
    // we can re-trigger an external nav targeting the same tab.
    let externalSetTab: (tab: SettingsTab) => void = () => {};
    function ExternalNavHarness() {
      const [tab, setTab] = useState<SettingsTab>("stacks");
      externalSetTab = setTab;
      return (
        <SettingsPage
          onRunDiscovery={() => {}}
          activeTab={tab}
          onChangeTab={setTab}
          stacks={stacks}
          activeStackId="alpha"
          onSwitchStack={() => {}}
          onRefetchStacks={async () => {}}
        />
      );
    }
    render(<ExternalNavHarness />);
    expect(screen.getByTestId("stacks-page")).toBeDefined();

    // (2) Internal click moves the parent state too — there is no longer any
    //     hidden local state to diverge.
    fireEvent.click(screen.getByRole("tab", { name: /Notifications/ }));
    expect(screen.getByTestId("notifications-page")).toBeDefined();

    // (3) External "New Stack" click. App.tsx wires this as
    //     setLeftPane({ type: "settings", initialTab: "stacks" }), which
    //     ends up calling onChangeTab("stacks") on this component. The view
    //     must snap back to Stacks even though the parent state value
    //     ("stacks") matches what (1) set it to.
    act(() => externalSetTab("stacks"));
    expect(screen.getByTestId("stacks-page")).toBeDefined();
  });
});
