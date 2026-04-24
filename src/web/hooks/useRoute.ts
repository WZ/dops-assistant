import { useEffect, useCallback, useRef } from "react";
import type { LeftPaneView } from "../App";
import { APP_BASE_PATH } from "../lib/createStackFetch";
import {
  parseInvestigationsQuery,
  stringifyInvestigationsQuery,
} from "../lib/investigations-query";

/** Strip the base path prefix so route matching works regardless of sub-path. */
function stripBase(pathname: string): string {
  if (APP_BASE_PATH === "/") return pathname;
  const base = APP_BASE_PATH.replace(/\/+$/, "");
  if (pathname.startsWith(base)) return pathname.slice(base.length) || "/";
  return pathname;
}

/**
 * Parse a URL pathname (+ optional search) into a LeftPaneView state.
 *
 * Search string is only consulted for routes that expose URL-as-state filters
 * (today: /investigations list view). Other routes ignore it so a stray
 * `?foo=bar` on the dashboard URL doesn't knock the parser off its rails.
 */
export function parseUrl(pathname: string, search: string = ""): LeftPaneView {
  const p = stripBase(pathname).replace(/\/+$/, "") || "/";

  // The root path (and explicit /dashboard) is the dashboard. Any other
  // unmatched path falls through to the NotFound view at the bottom — a
  // typo'd URL previously rendered the dashboard silently, which made
  // dead links invisible and hid routing bugs.
  if (p === "/" || p === "/dashboard") return { type: "dashboard" };

  // /investigations — the list page. Must come before the /investigations/:id
  // branch below so the bare path doesn't match as an empty id.
  if (p === "/investigations") {
    return { type: "investigations", query: parseInvestigationsQuery(search) };
  }

  // /investigations/:id
  const invMatch = p.match(/^\/investigations\/(.+)$/);
  if (invMatch) return { type: "investigation", id: invMatch[1]! };

  // /scan/runs/:id — scan run detail page. Navigated to from the Ops Desk
  // "Recent Scans" rows and the optimistic nav after a manual Scan now.
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

/**
 * Convert a LeftPaneView state to a URL (pathname + optional search, includes
 * base path). Callers feed this straight into pushState / replaceState.
 */
export function viewToUrl(view: LeftPaneView): string {
  const base = APP_BASE_PATH.replace(/\/+$/, "");
  switch (view.type) {
    case "investigation":
      return `${base}/investigations/${view.id}`;
    case "investigations": {
      const search = stringifyInvestigationsQuery(view.query);
      return search ? `${base}/investigations?${search}` : `${base}/investigations`;
    }
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
 * - On mount: parses window.location.pathname (+ search) into initial state
 * - On state change: pushes new URL via history.pushState
 * - On popstate (back/forward): updates state from URL
 */
export function useRoute(
  setLeftPane: (view: LeftPaneView) => void,
): { initialView: LeftPaneView; navigate: (view: LeftPaneView) => void } {
  const suppressPopstate = useRef(false);

  const navigate = useCallback((view: LeftPaneView) => {
    const url = viewToUrl(view);
    // Compare against pathname + search: the list page's query is part of the
    // URL, so a change of filters must still push a new history entry even if
    // the pathname is unchanged.
    const current = window.location.pathname + window.location.search;
    if (url !== current) {
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
      setLeftPane(parseUrl(window.location.pathname, window.location.search));
    };
    window.addEventListener("popstate", onPopstate);
    return () => window.removeEventListener("popstate", onPopstate);
  }, [setLeftPane]);

  return {
    initialView: parseUrl(window.location.pathname, window.location.search),
    navigate,
  };
}
