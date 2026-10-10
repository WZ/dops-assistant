// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { InvestigationPane } from "./InvestigationPane";
import { StackProvider } from "../contexts/StackContext";
import { OrchestratorRunProvider } from "../contexts/OrchestratorRunContext";

const ID = "inv_failed";

function mockFetch() {
  return vi.fn((url: string | URL) => {
    const u = String(url);
    if (u.includes(`/api/investigations/${ID}`) && !u.includes("/locate")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          investigation: { id: ID, service: "api", query: "investigate api", status: "failed", report: null },
          phases: [],
          events: [],
        }),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
  });
}

describe("InvestigationPane — a run that stopped without a report", () => {
  beforeEach(() => {
    cleanup();
    globalThis.fetch = mockFetch() as unknown as typeof fetch;
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => vi.restoreAllMocks());

  it("says the run stopped (not 'in progress') and does not blame the LLM", async () => {
    render(
      <StackProvider activeStackId="test-stack">
        <OrchestratorRunProvider wsMessages={[]} wsSend={vi.fn()} connectionStatus="connected">
          <InvestigationPane investigationId={ID} wsMessages={[]} onBack={vi.fn()} />
        </OrchestratorRunProvider>
      </StackProvider>,
    );
    expect(await screen.findByText("Investigation could not run")).toBeTruthy();
    expect(screen.getByText(/Investigation stopped/i)).toBeTruthy();
    expect(screen.queryByText(/Investigation in progress/i)).toBeNull();
    expect(screen.queryByText(/LLM API was unreachable/i)).toBeNull();
    expect(screen.getByText(/server may have restarted/i)).toBeTruthy();
  });
});
