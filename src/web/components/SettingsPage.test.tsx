// src/web/components/SettingsPage.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SettingsPage } from "./SettingsPage";
import type { StackSummary } from "../../types/stack-types.js";

vi.mock("./ProvidersPage", () => ({
  ProvidersPage: ({ onRunDiscovery }: { onRunDiscovery: () => void }) => (
    <div data-testid="providers-page">Providers</div>
  ),
}));
vi.mock("./SkillsPage", () => ({
  SkillsPage: () => <div data-testid="skills-page">Skills</div>,
}));

const stacks: StackSummary[] = [{ id: "alpha", name: "alpha", slug: "alpha" } as StackSummary];

function renderPage() {
  return render(
    <SettingsPage
      onRunDiscovery={() => {}}
      stacks={stacks}
      activeStackId="alpha"
      onSwitchStack={() => {}}
      onRefetchStacks={async () => {}}
    />,
  );
}

describe("SettingsPage", () => {
  it("shows Providers tab by default", () => {
    renderPage();
    expect(screen.getByTestId("providers-page")).toBeDefined();
  });

  it("switches to Skills tab when clicked", () => {
    renderPage();
    fireEvent.click(screen.getByRole("tab", { name: /Skills/ }));
    expect(screen.getByTestId("skills-page")).toBeDefined();
  });

  it("switches back to Providers tab", () => {
    renderPage();
    fireEvent.click(screen.getByRole("tab", { name: /Skills/ }));
    fireEvent.click(screen.getByRole("tab", { name: /Providers/ }));
    expect(screen.getByTestId("providers-page")).toBeDefined();
  });
});
