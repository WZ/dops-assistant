import { useEffect, useCallback } from "react";
import type { ActivityTab, LeftPaneView } from "../App";
import { APP_BASE_PATH } from "../lib/createStackFetch";
import {
  parseInvestigationsQuery,
  stringifyInvestigationsQuery,
} from "../lib/investigations-query";
import {
  parseScanRunsQuery,
  stringifyScanRunsQuery,
} from "../lib/scan-runs-query";
import {
  parsePatternsQuery,
  stringifyPatternsQuery,
} from "../lib/patterns-query";

/** Strip the base path prefix so route matching works regardless of sub-path. */
function stripBase(pathname: string): string {
  if (APP_BASE_PATH === "/") return pathname;
  const base = APP_BASE_PATH.replace(/\/+$/, "");
  if (pathname.startsWith(base)) return pathname.slice(base.length) || "/";
  return pathname;
}

const ACTIVITY_TABS: readonly ActivityTab[] = ["investigations", "scans", "events", "patterns"] as const;

function isActivityTab(s: string): s is ActivityTab {
  return (ACTIVITY_TABS as readonly string[]).includes(s);
}

/**
 * Parse a URL pathname (+ optional search) into a LeftPaneView state.
 *
 * Search string is only consulted for routes that expose URL-as-state filters
 * (today: the Activity page's investigations tab). Other routes ignore it so
 * a stray `?foo=bar` on the dashboard URL doesn't knock the parser off its
 * rails.
 *
 * Backwards compat: legacy `/investigations` (with optional query) parses to
 * the Activity page on the investigations tab. The mount-time redirect in
 * `useRoute` rewrites the URL to `/activity/investigations` so old bookmarks
 * silently update on first load. `/investigations/:id` (the detail page) is
 * unchanged — that's a different concept and keeps its own URL.
 */
export function parseUrl(pathname: string, search: string = ""): LeftPaneView {
  const p = stripBase(pathname).replace(/\/+$/, "") || "/";

  // The root path (and explicit /dashboard) is the dashboard. Any other
  // unmatched path falls through to the NotFound view at the bottom — a
  // typo'd URL previously rendered the dashboard silently, which made
  // dead links invisible and hid routing bugs.
  if (p === "/" || p === "/dashboard") return { type: "dashboard" };

  // /activity → default tab (investigations).
  // /activity/<tab> → that tab. Unknown tabs fall through to notfound.
  if (p === "/activity") {
    return { type: "activity", tab: "investigations", query: parseInvestigationsQuery(search) };
  }
  const actMatch = p.match(/^\/activity\/(.+)$/);
  if (actMatch) {
    const tab = actMatch[1]!;
    if (isActivityTab(tab)) {
      // Each tab parses its own URL state; mismatched query keys fall through
      // to the empty object via the per-parser tolerance. Events still carries
      // no URL state in this PR — that tab's filter shape lands when AP14
      // ships (blocked on persistence).
      if (tab === "investigations") return { type: "activity", tab, query: parseInvestigationsQuery(search) };
      if (tab === "scans")          return { type: "activity", tab, query: parseScanRunsQuery(search) };
      if (tab === "patterns")       return { type: "activity", tab, query: parsePatternsQuery(search) };
      return { type: "activity", tab: "events", query: {} };
    }
  }

  // Legacy /investigations — list page. Backwards compat for bookmarks /
  // external links from before the Activity refactor. Parses to the same
  // pane as /activity/investigations; the mount-time redirect in useRoute
  // swaps the URL so the user sees the canonical path on first load.
  // Must come before the /investigations/:id branch so the bare path
  // doesn't match as an empty id.
  if (p === "/investigations") {
    return { type: "activity", tab: "investigations", query: parseInvestigationsQuery(search) };
  }

  // /investigations/:id — single investigation detail page. Unchanged.
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
    case "activity": {
      // Each tab serializes its own query shape. Events and patterns are
      // placeholders today and emit no URL state.
      let search = "";
      if (view.tab === "investigations") search = stringifyInvestigationsQuery(view.query);
      else if (view.tab === "scans")     search = stringifyScanRunsQuery(view.query);
      else if (view.tab === "patterns")  search = stringifyPatternsQuery(view.query);
      const path = `${base}/activity/${view.tab}`;
      return search ? `${path}?${search}` : path;
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
 *   AND silently rewrites the URL when it differs from the canonical form
 *   for that view (e.g. legacy `/investigations` → `/activity/investigations`).
 *   The rewrite uses replaceState so it doesn't pollute back-button history.
 * - On state change: pushes new URL via history.pushState
 * - On popstate (back/forward): updates state from URL
 */
export function useRoute(
  setLeftPane: (view: LeftPaneView) => void,
): { initialView: LeftPaneView; navigate: (view: LeftPaneView, opts?: { replace?: boolean }) => void } {
  // `replace: true` swaps the current history entry via replaceState instead of
  // pushing a new one. Used for same-route state updates (filter bar changes on
  // the activity/investigations tab) so the Back button still exits the page
  // in one press rather than unwinding every keystroke and pill click.
  //
  // There is no popstate guard here: pushState / replaceState do NOT fire
  // popstate (browser spec guarantee), so only genuine user-initiated
  // back/forward runs the listener below. An earlier version kept a
  // `suppressPopstate` ref that swallowed the next genuine back-button click
  // — the UI stayed on the detail page while the URL quietly rolled back one
  // entry, so the next Back landed two entries away on an unrelated page.
  const navigate = useCallback((view: LeftPaneView, opts?: { replace?: boolean }) => {
    const url = viewToUrl(view);
    const current = window.location.pathname + window.location.search;
    if (url !== current) {
      // Tag each entry with `{ fromApp: true }` so detail pages can distinguish
      // in-app history from direct-link arrivals when rendering "Back". Detail
      // pages (/investigations/:id) use the tag to return to the activity list
      // with filters preserved via history.back() when the user came from the
      // list, and fall back to the dashboard when they pasted a direct link.
      // Replace-state entries carry the same tag so filter-bar updates on
      // activity/investigations don't strip it mid-session.
      if (opts?.replace) {
        window.history.replaceState({ fromApp: true }, "", url);
      } else {
        window.history.pushState({ fromApp: true }, "", url);
      }
    }
    setLeftPane(view);
  }, [setLeftPane]);

  const initialView = parseUrl(window.location.pathname, window.location.search);

  useEffect(() => {
    // Mount-time canonicalization: if the parsed view serializes to a URL
    // different from what the user typed (e.g. they hit /investigations and
    // we resolved it to the activity page), silently swap the URL via
    // replaceState. No new history entry, no new state push — same view.
    const canonical = viewToUrl(initialView);
    const current = window.location.pathname + window.location.search;
    if (canonical !== current && initialView.type !== "notfound") {
      window.history.replaceState({ fromApp: true }, "", canonical);
    }
    const onPopstate = () => {
      setLeftPane(parseUrl(window.location.pathname, window.location.search));
    };
    window.addEventListener("popstate", onPopstate);
    return () => window.removeEventListener("popstate", onPopstate);
    // initialView intentionally captured once at mount via the closure above.
    // Re-running this effect on every state change would fight pushState.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setLeftPane]);

  return {
    initialView,
    navigate,
  };
}
