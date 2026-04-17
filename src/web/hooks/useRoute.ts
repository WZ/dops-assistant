import { useEffect, useCallback, useRef } from "react";
import type { LeftPaneView } from "../App";
import { APP_BASE_PATH } from "../lib/createStackFetch";

/** Strip the base path prefix so route matching works regardless of sub-path. */
function stripBase(pathname: string): string {
  if (APP_BASE_PATH === "/") return pathname;
  const base = APP_BASE_PATH.replace(/\/+$/, "");
  if (pathname.startsWith(base)) return pathname.slice(base.length) || "/";
  return pathname;
}

/** Parse a URL pathname into a LeftPaneView state. */
export function parseUrl(pathname: string): LeftPaneView {
  const p = stripBase(pathname).replace(/\/+$/, "") || "/";

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

/** Convert a LeftPaneView state to a URL pathname (includes base path). */
export function viewToUrl(view: LeftPaneView): string {
  const base = APP_BASE_PATH.replace(/\/+$/, "");
  switch (view.type) {
    case "investigation":
      return `${base}/investigations/${view.id}`;
    case "services":
      return view.initialService ? `${base}/services/${view.initialService}` : `${base}/services`;
    case "settings":
      return view.initialTab ? `${base}/settings/${view.initialTab}` : `${base}/settings`;
    case "dashboard":
    default:
      return `${base}/`;
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
