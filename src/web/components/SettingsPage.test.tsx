// src/web/components/SettingsPage.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SettingsPage } from "./SettingsPage";

vi.mock("./ProvidersPage", () => ({
  ProvidersPage: ({ onRunDiscovery }: { onRunDiscovery: () => void }) => (
    <div data-testid="providers-page">Providers</div>
  ),
}));
vi.mock("./SkillsPage", () => ({
  SkillsPage: () => <div data-testid="skills-page">Skills</div>,
}));

describe("SettingsPage", () => {
  it("shows Providers tab by default", () => {
    render(<SettingsPage onRunDiscovery={() => {}} />);
    expect(screen.getByTestId("providers-page")).toBeDefined();
  });

  it("switches to Skills tab when clicked", () => {
    render(<SettingsPage onRunDiscovery={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: /Skills/ }));
    expect(screen.getByTestId("skills-page")).toBeDefined();
  });

  it("switches back to Providers tab", () => {
    render(<SettingsPage onRunDiscovery={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: /Skills/ }));
    fireEvent.click(screen.getByRole("tab", { name: /Providers/ }));
    expect(screen.getByTestId("providers-page")).toBeDefined();
  });
});
