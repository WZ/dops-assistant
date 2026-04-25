// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { DemoBanner, isDemoActive } from "./DemoBanner";

declare global {
  interface Window {
    __DEMO_MODE__?: boolean;
  }
}

afterEach(() => {
  cleanup();
  delete window.__DEMO_MODE__;
});

describe("DemoBanner", () => {
  it("renders nothing when window.__DEMO_MODE__ is unset", () => {
    const { container } = render(<DemoBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when window.__DEMO_MODE__ is false", () => {
    window.__DEMO_MODE__ = false;
    const { container } = render(<DemoBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the banner when window.__DEMO_MODE__ is true", () => {
    window.__DEMO_MODE__ = true;
    render(<DemoBanner />);
    expect(screen.getByRole("region", { name: /demo mode/i })).toBeDefined();
    expect(screen.getByText(/read-only showcase/i)).toBeDefined();
  });

  it("renders the repo link with the override URL", () => {
    window.__DEMO_MODE__ = true;
    render(<DemoBanner repoUrl="https://example.test/repo" />);
    const link = screen.getByRole("link", { name: /run it yourself/i }) as HTMLAnchorElement;
    expect(link.href).toBe("https://example.test/repo");
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noopener");
  });

  it("isDemoActive reflects the flag", () => {
    expect(isDemoActive()).toBe(false);
    window.__DEMO_MODE__ = true;
    expect(isDemoActive()).toBe(true);
  });
});
