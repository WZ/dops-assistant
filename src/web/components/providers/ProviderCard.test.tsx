// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { ProviderCard } from "./ProviderCard";
import { StackProvider } from "../../contexts/StackContext";

function Wrapper({ children }: { children: ReactNode }) {
  return <StackProvider activeStackId="test-stack">{children}</StackProvider>;
}

describe("ProviderCard", () => {
  it("renders an Open link when webUrl is provided", () => {
    render(
      <Wrapper>
        <ProviderCard
          name="grafana"
          roles={["metrics"]}
          transport="http"
          url="http://localhost:8080/mcp"
          webUrl="https://grafana.example.com/"
          source="gui"
          status="connected"
          toolCount={3}
          onTest={vi.fn()}
        />
      </Wrapper>,
    );
    const link = screen.getByRole("link", { name: /Open grafana/i });
    expect(link).toBeDefined();
    expect(link.getAttribute("href")).toBe("https://grafana.example.com/");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });

  it("does not render an Open link when webUrl is absent", () => {
    render(
      <Wrapper>
        <ProviderCard
          name="grafana"
          roles={["metrics"]}
          transport="http"
          url="http://localhost:8080/mcp"
          source="gui"
          status="connected"
          toolCount={3}
          onTest={vi.fn()}
        />
      </Wrapper>,
    );
    expect(screen.queryByRole("link", { name: /Open grafana/i })).toBeNull();
  });

  it("does not render Remove button for config (system) providers", () => {
    render(
      <Wrapper>
        <ProviderCard
          name="system-grafana"
          roles={["metrics"]}
          transport="http"
          url="http://localhost:8080/mcp"
          source="config"
          status="connected"
          toolCount={3}
          onTest={vi.fn()}
        />
      </Wrapper>,
    );
    expect(screen.queryByRole("button", { name: /Remove system-grafana/i })).toBeNull();
  });

  it("renders Remove button for GUI providers when onRemove is provided", () => {
    render(
      <Wrapper>
        <ProviderCard
          name="my-provider"
          roles={["metrics"]}
          transport="http"
          url="http://localhost:8080/mcp"
          source="gui"
          status="connected"
          toolCount={3}
          onTest={vi.fn()}
          onRemove={vi.fn()}
        />
      </Wrapper>,
    );
    expect(screen.getByRole("button", { name: "Remove my-provider" })).toBeDefined();
  });
});
