// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { DiscoveryReview } from "./DiscoveryReview";
import { StackProvider } from "../contexts/StackContext";
import type { ValidatedServiceConfig } from "../../types/discovery-types";

function Wrapper({ children }: { children: ReactNode }) {
  return <StackProvider activeStackId="test-stack">{children}</StackProvider>;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function service(name: string): ValidatedServiceConfig {
  return {
    name,
    metrics: [],
    logLabels: {},
    probeRules: [],
    confidence: "verified",
    validationNotes: "metrics ok",
  };
}

describe("DiscoveryReview", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    cleanup();
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("lists the names of new and removed services in the review diff", async () => {
    globalThis.fetch = vi.fn((url: string | URL) => {
      if (String(url).endsWith("/api/services")) {
        return Promise.resolve(jsonResponse([
          { name: "existing-api", metrics: [], logLabels: {}, probeRules: [] },
          { name: "legacy-worker", metrics: [], logLabels: {}, probeRules: [] },
        ]));
      }
      return Promise.resolve(jsonResponse([]));
    }) as unknown as typeof fetch;

    render(
      <DiscoveryReview
        services={[service("existing-api"), service("new-api"), service("new-worker")]}
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onRerun={vi.fn()}
        onBack={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    const newServices = await screen.findByLabelText("New services");
    expect(within(newServices).getByText("new-api")).toBeTruthy();
    expect(within(newServices).getByText("new-worker")).toBeTruthy();

    const removedServices = await screen.findByLabelText("Removed services");
    expect(within(removedServices).getByText("legacy-worker")).toBeTruthy();
  });
});
