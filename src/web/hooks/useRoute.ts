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

  // The root path (and explicit /dashboard) is the dashboard. Any other
  // unmatched path falls through to the NotFound view at the bottom — a
  // typo'd URL previously rendered the dashboard silently, which made
  // dead links invisible and hid routing bugs.
  if (p === "/" || p === "/dashboard") return { type: "dashboard" };

  // /investigations/:id
  const invMatch = p.match(/^\/investigations\/(.+)$/);
  if (invMatch) return { type: "investigation", id: invMatch[1]! };

  // /scan/runs/:id — scan run detail page (Task 23 will flesh out the view;
  // Task 21 just wires the route + a thin placeholder so the Ops Desk
  // "Recent Scans" rows have somewhere to navigate.)
  const scanRunMatch = p.match(/^\/scan\/runs\/([^/]+)$/);
  if (scanRunMatch) return { type: "scanrun", runId: decodeURIComponent(scanRunMatch[1]!) };

  // /services/:name or /services
  const svcMatch = p.match(/^\/services(?:\/(.+))?$/);
  if (svcMatch) return { type: "services", initialService: svcMatch[1] };

  // /settings/:tab or /settings. Tabs outside the known set fall through
  // to not-found rather than rendering an empty tab pane.
  const setMatch = p.match(/^\/settings(?:\/(.+))?$/);
  if (setMatch) {
    const rawTab = setMatch[1];
    if (!rawTab) return { type: "settings" };
    if (
      rawTab === "providers" ||
      rawTab === "skills" ||
      rawTab === "stacks" ||
      rawTab === "scan" ||
      rawTab === "notifications"
    ) {
      return { type: "settings", initialTab: rawTab };
    }
  }

  return { type: "notfound", path: pathname };
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
    case "scanrun":
      return `${base}/scan/runs/${encodeURIComponent(view.runId)}`;
    case "notfound":
      // Preserve the user-typed path so reload stays on the 404 page instead
      // of bouncing to dashboard. `path` was captured verbatim at parse time
      // and already includes the base prefix.
      return view.path;
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
