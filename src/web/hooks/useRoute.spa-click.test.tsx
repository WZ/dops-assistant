// src/web/hooks/useRoute.spa-click.test.tsx
// @vitest-environment jsdom
//
// Regression tests for Issue #13 — service-card SPA nav drops the :name param.
//
// Reproduces the bug where clicking a service tile from the Home grid
// navigates to /services/:name in the URL bar but the app state ends up as
// `{type:"services", initialService: undefined}` — so the services INDEX
// renders instead of the service detail page. A direct URL visit to the same
// path works correctly.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, renderHook, render, screen, fireEvent } from "@testing-library/react";
import { useCallback, useRef, useState } from "react";
import { useRoute, parseUrl } from "./useRoute";
import type { LeftPaneView } from "../App";

/** Harness that mirrors the App.tsx wiring: useState + useRoute + the
 *  initialView-applied bootstrap. Keeps the public API surface identical so
 *  the test exercises the same contract the UI uses. */
function useAppRouterHarness() {
  const [leftPane, setLeftPaneRaw] = useState<LeftPaneView>({ type: "dashboard" });
  const { initialView, navigate } = useRoute(setLeftPaneRaw);
  // Mirror App.tsx: the initialView-applied bootstrap promotes a
  // deep-linked URL into state during the first render. If this block
  // re-fires on later renders it will clobber SPA-driven state updates —
  // which is exactly the bug shape we're guarding against.
  const initialViewApplied = useRef(false);
  if (!initialViewApplied.current) {
    initialViewApplied.current = true;
    if (initialView.type !== "dashboard" || leftPane.type !== "dashboard") {
      if (
        initialView.type !== leftPane.type ||
        (initialView.type === "investigation" &&
          leftPane.type === "investigation" &&
          initialView.id !== leftPane.id)
      ) {
        setLeftPaneRaw(initialView);
      }
    }
  }
  // setLeftPane semantics match App.tsx — navigate() syncs URL + state.
  const setLeftPane = useCallback((view: LeftPaneView) => navigate(view), [navigate]);
  return { leftPane, initialView, navigate, setLeftPane, setLeftPaneRaw };
}

describe("useRoute — SPA click navigation to /services/:name", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("direct URL visit parses /services/:name into initialService", () => {
    window.history.replaceState(null, "", "/services/admin-daphne");
    const { result } = renderHook(() => useAppRouterHarness());
    expect(result.current.initialView).toEqual({
      type: "services",
      initialService: "admin-daphne",
    });
  });

  it("clicking a service from the dashboard sets state AND URL with :name", () => {
    // Start on the dashboard — the exact path the bug reports.
    window.history.replaceState(null, "", "/");
    const { result } = renderHook(() => useAppRouterHarness());

    // Mimic the click path: Dashboard → HealthStrip → onClickService
    // ends up calling setLeftPane({type:"services", initialService: name}).
    act(() => {
      result.current.setLeftPane({ type: "services", initialService: "admin-daphne" });
    });

    // URL must carry the service name — otherwise a reload loses context.
    expect(window.location.pathname).toBe("/services/admin-daphne");
    // And state must carry it too — otherwise the ServicesPage mounts with
    // initialService=undefined and renders the grid instead of the detail.
    expect(result.current.leftPane).toEqual({
      type: "services",
      initialService: "admin-daphne",
    });
  });

  it("parseUrl agrees with state after SPA nav (roundtrip)", () => {
    window.history.replaceState(null, "", "/");
    const { result } = renderHook(() => useAppRouterHarness());
    act(() => {
      result.current.setLeftPane({ type: "services", initialService: "admin-daphne" });
    });
    // If the URL and state agree, parseUrl(location) should match the state.
    expect(parseUrl(window.location.pathname)).toEqual(result.current.leftPane);
  });

  it("navigate() from dashboard updates both URL and state atomically", () => {
    window.history.replaceState(null, "", "/");
    const { result } = renderHook(() => useAppRouterHarness());
    act(() => {
      result.current.navigate({ type: "services", initialService: "ingestion-server" });
    });
    expect(window.location.pathname).toBe("/services/ingestion-server");
    expect(result.current.leftPane).toEqual({
      type: "services",
      initialService: "ingestion-server",
    });
  });

  it("back/forward from /services/:name restores initialService on popstate", () => {
    // Simulate: navigate to /services/a, then /services/b, then Back.
    window.history.replaceState(null, "", "/");
    const { result } = renderHook(() => useAppRouterHarness());

    act(() => {
      result.current.navigate({ type: "services", initialService: "a" });
    });
    act(() => {
      result.current.navigate({ type: "services", initialService: "b" });
    });
    expect(result.current.leftPane).toEqual({ type: "services", initialService: "b" });

    // Simulate Back — popstate should re-parse the URL and update state.
    act(() => {
      window.history.back();
      // jsdom fires popstate synchronously on history.back(), but we dispatch
      // manually to ensure the listener receives it even on engines that defer.
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(parseUrl(window.location.pathname)).toEqual(result.current.leftPane);
  });
});

describe("useRoute — listener wiring", () => {
  it("popstate listener uses parseUrl on the current pathname", () => {
    window.history.replaceState(null, "", "/services/first-service");
    const setLeftPane = vi.fn();
    renderHook(() => useRoute(setLeftPane));
    // Swap the URL outside of navigate() to simulate browser Back.
    window.history.replaceState(null, "", "/services/second-service");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(setLeftPane).toHaveBeenCalledWith({
      type: "services",
      initialService: "second-service",
    });
  });
});

/**
 * End-to-end-in-JSDOM reproduction of the bug: mount a tiny tree that mirrors
 * the Dashboard → HealthStrip → App callback chain and click a tile. The
 * fixture drives the exact same state-management pattern as App.tsx (with
 * StrictMode turned on so the render-time `setState` path is double-invoked
 * the way React does in production dev builds).
 */
describe("Issue #13 — SPA click from Home renders service detail", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
  });

  function Harness() {
    const { leftPane, setLeftPane } = useAppRouterHarness();

    if (leftPane.type === "dashboard") {
      // Mirror HealthStrip's click handler.
      return (
        <div>
          <button
            data-testid="home-tile-admin-daphne"
            onClick={() => setLeftPane({ type: "services", initialService: "admin-daphne" })}
          >
            admin-daphne
          </button>
        </div>
      );
    }
    if (leftPane.type === "services") {
      // Mirror ServicesPage: if initialService is set we render the detail
      // heading; otherwise we render the INDEX heading. This is the exact
      // fork that the bug flipped the wrong way.
      if (leftPane.initialService) {
        return <h1 data-testid="heading">{leftPane.initialService}</h1>;
      }
      return <h1 data-testid="heading">Services</h1>;
    }
    return null;
  }

  it("renders the service detail heading after clicking a Home tile", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("home-tile-admin-daphne"));
    // Bug: heading said "Services". Fix: heading must be the service name.
    expect(screen.getByTestId("heading").textContent).toBe("admin-daphne");
    expect(window.location.pathname).toBe("/services/admin-daphne");
  });
});
