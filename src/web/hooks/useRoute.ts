import { useEffect, useCallback, useRef } from "react";
import type { LeftPaneView } from "../App";

/** Parse a URL pathname into a LeftPaneView state. */
export function parseUrl(pathname: string): LeftPaneView {
  const p = pathname.replace(/\/+$/, "") || "/";

  // /investigations/:id
  const invMatch = p.match(/^\/investigations\/(.+)$/);
  if (invMatch) return { type: "investigation", id: invMatch[1]! };

  // /services/:name or /services
  const svcMatch = p.match(/^\/services(?:\/(.+))?$/);
  if (svcMatch) return { type: "services", initialService: svcMatch[1] };

  // /settings/:tab or /settings
  const setMatch = p.match(/^\/settings(?:\/(.+))?$/);
  if (setMatch) {
    const tab = setMatch[1] as "providers" | "skills" | "stacks" | undefined;
    return { type: "settings", initialTab: tab };
  }

  // Default: dashboard
  return { type: "dashboard" };
}

/** Convert a LeftPaneView state to a URL pathname. */
export function viewToUrl(view: LeftPaneView): string {
  switch (view.type) {
    case "investigation":
      return `/investigations/${view.id}`;
    case "services":
      return view.initialService ? `/services/${view.initialService}` : "/services";
    case "settings":
      return view.initialTab ? `/settings/${view.initialTab}` : "/settings";
    case "dashboard":
    default:
      return "/";
  }
}

/**
 * Sync LeftPaneView state with the browser URL.
 *
 * - On mount: parses window.location.pathname into initial state
 * - On state change: pushes new URL via history.pushState
 * - On popstate (back/forward): updates state from URL
 */
export function useRoute(
  setLeftPane: (view: LeftPaneView) => void,
): { initialView: LeftPaneView; navigate: (view: LeftPaneView) => void } {
  const suppressPopstate = useRef(false);

  const navigate = useCallback((view: LeftPaneView) => {
    const url = viewToUrl(view);
    if (url !== window.location.pathname) {
      suppressPopstate.current = true;
      window.history.pushState(null, "", url);
    }
    setLeftPane(view);
  }, [setLeftPane]);

  useEffect(() => {
    const onPopstate = () => {
      if (suppressPopstate.current) {
        suppressPopstate.current = false;
        return;
      }
      setLeftPane(parseUrl(window.location.pathname));
    };
    window.addEventListener("popstate", onPopstate);
    return () => window.removeEventListener("popstate", onPopstate);
  }, [setLeftPane]);

  return {
    initialView: parseUrl(window.location.pathname),
    navigate,
  };
}
