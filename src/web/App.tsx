import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { safeGetItem, safeSetItem } from "./lib/utils";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ChatPane } from "./components/ChatPane";
import { Dashboard } from "./components/Dashboard";
import { InvestigationPane } from "./components/InvestigationPane";
import { PatternDetail } from "./components/PatternDetail";
import { ScanRunDetail } from "./components/ScanRunDetail";
import { ActivityPage } from "./components/ActivityPage";
import { Sidebar } from "./components/Sidebar";
import type { SidebarPage } from "./components/Sidebar";
import { ServicesPage } from "./components/ServicesPage";
import { SettingsPage } from "./components/SettingsPage";
import { ScanActivityBadge } from "./components/ScanActivityBadge";
import { SetupStepper } from "./components/SetupStepper";
import { DemoBanner } from "./components/DemoBanner";
import { useRoute, viewToUrl, parseUrl } from "./hooks/useRoute";
import type { InvestigationsQuery } from "./lib/investigations-query";
import type { ScanRunsQuery } from "./lib/scan-runs-query";
import type { PatternsQuery } from "./lib/patterns-query";
import type { EventsQuery } from "./lib/events-query";
import { StackSwitcher } from "./components/StackSwitcher";
import { StackProvider } from "./contexts/StackContext";
import { useWebSocket } from "./hooks/useWebSocket";
import { useStacks } from "./hooks/useStacks";
import { useSetupStage } from "./hooks/useSetupStage";
import { useHealthPolling } from "./components/dashboard/useHealthPolling";
import { createStackFetch } from "./lib/createStackFetch";
import type { ValidatedServiceConfig } from "../types/discovery-types.js";

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/** Tab inside the unified Activity page. New tabs add cases without churning the LeftPaneView union. */
export type ActivityTab = "investigations" | "scans" | "events" | "patterns";

/**
 * Per-tab query shapes. Discriminated by `tab` so callers narrow with a
 * single check. With AP12 (patterns) and AP14 (events) both shipped, all
 * four tabs carry their own URL state.
 */
export type ActivityView =
  | { type: "activity"; tab: "investigations"; query: InvestigationsQuery }
  | { type: "activity"; tab: "scans"; query: ScanRunsQuery }
  | { type: "activity"; tab: "patterns"; query: PatternsQuery }
  | { type: "activity"; tab: "events"; query: EventsQuery };

export type LeftPaneView =
  | { type: "dashboard" }
  // `stackId` is the stack that owns this investigation. Empty string is the
  // legacy-URL sentinel: the user landed on /investigations/:id (no stack in
  // the URL) and the SPA has not yet resolved which stack owns this id.
  // InvestigationPane handles that case by hitting /api/investigations/:id/locate
  // and replaceState'ing the URL to the canonical /stacks/:stackId/investigations/:id form.
  | { type: "investigation"; id: string; stackId: string }
  | { type: "pattern"; id: string }
  | ActivityView
  | { type: "services"; initialService?: string }
  | { type: "settings"; initialTab?: "providers" | "skills" | "stacks" | "scan" | "notifications" }
  | { type: "scanrun"; runId: string }
  | { type: "notfound"; path: string };

/**
 * Pure helper: given the current pane type, decide whether a stack switch
 * should forcibly redirect the user to the dashboard.
 *
 * Exported for unit testing. Only panes that render stack-specific data
 * (investigation, services) reset — stack-neutral panes (settings, dashboard,
 * notfound) are left alone so a concurrent sidebar click isn't clobbered.
 */
export function shouldResetOnStackSwitch(paneType: LeftPaneView["type"]): boolean {
  return (
    paneType === "services" ||
    paneType === "investigation" ||
    paneType === "pattern" ||
    paneType === "scanrun" ||
    paneType === "activity"
  );
}

/**
 * Pure helper: given the current setup stage and pane type, decide whether
 * the auto-routing useEffect should redirect the user to a different page,
 * and to which one.
 *
 * Returns `null` when no redirect should happen — including when the user
 * is on a non-dashboard route (deep links, bookmarks, refreshed pages get
 * to render the URL they asked for, with the setup stepper still nudging
 * them via the page header). Returns "settings" or "services" when the
 * user is on the dashboard and the setup stage warrants a redirect.
 *
 * Exported for unit testing. The full effect in App.tsx still owns
 * `lastRoutedStageRef` bookkeeping; this helper only encodes the
 * stage → target-page decision.
 */
export function autoRouteTargetForSetupStage(
  args: {
    setupStage: string | null | undefined;
    setupDismissed: boolean;
    setupLoading: boolean;
    paneType: LeftPaneView["type"];
    lastRoutedStage: string | null;
  },
): "settings" | "services" | null {
  const { setupStage, setupDismissed, setupLoading, paneType, lastRoutedStage } = args;
  if (!setupStage || setupStage === "complete" || setupDismissed || setupLoading) return null;
  if (lastRoutedStage === setupStage) return null;
  // Only redirect from the dashboard. Any deliberate navigation to a deep
  // route stays put — the stepper at the top still surfaces the next step.
  if (paneType !== "dashboard") return null;
  if (setupStage === "needs-provider" || setupStage === "needs-provider-connected") return "settings";
  if (setupStage === "needs-discovery") return "services";
  return null;
}

function useTheme() {
  const [dark, setDark] = useState(() => safeGetItem("theme") !== "light");
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    safeSetItem("theme", dark ? "dark" : "light");
  }, [dark]);
  return { dark, toggle: () => setDark((d) => !d) };
}

export function App() {
  const [leftPane, setLeftPaneRaw] = useState<LeftPaneView>({ type: "dashboard" });
  const { initialView, navigate } = useRoute(setLeftPaneRaw);
  // Use navigate() for all pane changes — it syncs URL + state
  const setLeftPane = useCallback(
    (view: LeftPaneView, opts?: { replace?: boolean }) => navigate(view, opts),
    [navigate],
  );

  // Set initial view from URL on first render
  const initialViewApplied = useRef(false);
  if (!initialViewApplied.current) {
    initialViewApplied.current = true;
    if (initialView.type !== "dashboard" || leftPane.type !== "dashboard") {
      // Only override if URL points somewhere other than dashboard
      if (initialView.type !== leftPane.type || (initialView.type === "investigation" && leftPane.type === "investigation" && initialView.id !== leftPane.id)) {
        setLeftPaneRaw(initialView);
      }
    }
  }
  const { stacks, activeStackId, activeStack, switchStack, loading: stacksLoading, refetch: refetchStacks } = useStacks();
  const ws = useWebSocket(activeStackId);
  const theme = useTheme();
  const health = useHealthPolling();

  const hasMultipleStacks = stacks.length > 1;

  const { stage: setupStage, loading: setupLoading, refreshSetupStage } = useSetupStage(activeStackId);
  const [setupDismissed, setSetupDismissed] = useState(() => !!safeGetItem(`dops:setup_dismissed:${activeStackId}`));
  const showStepper = setupStage !== null && setupStage !== "complete" && !setupDismissed && !setupLoading;

  const handleSkipSetup = useCallback(() => {
    safeSetItem(`dops:setup_dismissed:${activeStackId}`, "true");
    setSetupDismissed(true);
  }, [activeStackId]);

  useEffect(() => {
    setSetupDismissed(!!safeGetItem(`dops:setup_dismissed:${activeStackId}`));
  }, [activeStackId]);

  // Auto-routing: on setup stage transitions, nudge the user toward the next
  // setup step — but ONLY when the user is on the dashboard (the natural
  // starting page). If they explicitly navigated to /investigations,
  // /services, /scan/runs/:id, or any other deep route (bookmark, shared
  // link, browser reload), respect that intent and leave them there. The
  // setup stepper at the top of the page still surfaces the next step, so
  // operators don't lose the onboarding nudge — they just don't get yanked
  // away from a URL they typed on purpose. See autoRouteTargetForSetupStage.
  const lastRoutedStageRef = useRef<string | null>(null);
  useEffect(() => {
    const target = autoRouteTargetForSetupStage({
      setupStage,
      setupDismissed,
      setupLoading,
      paneType: leftPane.type,
      lastRoutedStage: lastRoutedStageRef.current,
    });
    // Track that we've seen this stage even if we didn't redirect, so a
    // later transition (e.g. provider added → needs-discovery) doesn't
    // re-fire on the same stage.
    if (setupStage && setupStage !== lastRoutedStageRef.current) {
      lastRoutedStageRef.current = setupStage;
    }
    if (!target) return;
    if (target === "settings") {
      setLeftPaneRaw({ type: "settings", initialTab: "providers" });
      history.replaceState(null, "", viewToUrl({ type: "settings" }));
    } else if (target === "services") {
      setLeftPaneRaw({ type: "services" });
      history.replaceState(null, "", viewToUrl({ type: "services" }));
    }
  }, [setupStage, setupDismissed, setupLoading, leftPane.type]);

  useEffect(() => {
    if (setupStage === "complete" && lastRoutedStageRef.current && lastRoutedStageRef.current !== "complete") {
      setLeftPaneRaw({ type: "dashboard" });
      history.replaceState(null, "", viewToUrl({ type: "dashboard" }));
      lastRoutedStageRef.current = "complete";
    }
  }, [setupStage]);

  // Map the richer LeftPaneView union down to the 4 sidebar buckets. The
  // activity list (any tab) and a single-investigation detail page both
  // highlight "Activity" so the operator's mental model of "I'm in the
  // activity section" stays stable while drilling in and out of detail.
  const activePage: SidebarPage =
    leftPane.type === "services" ? "services"
    : leftPane.type === "settings" ? "settings"
    : leftPane.type === "activity" ? "activity"
    : leftPane.type === "investigation" ? "activity"
    : "dashboard";

  const stackFetchForBranding = useMemo(() => createStackFetch(activeStackId), [activeStackId]);
  const [branding, setBranding] = useState<{ title: string; subtitle: string; grafanaUrl?: string; prometheusDatasource?: string }>({ title: "dops", subtitle: "assistant" });
  useEffect(() => {
    stackFetchForBranding("/api/branding").then((r) => r.json()).then((data) => setBranding((prev) => ({ ...prev, ...data }))).catch(() => {});
  }, [stackFetchForBranding]);

  const [discoveryState, setDiscoveryState] = useState({
    phase: "",
    status: "complete" as "running" | "complete",
    iteration: { current: 0, max: 0, description: "" },
    toolCalls: [] as Array<{ timestamp: string; tool: string; status: "calling" | "success" | "error"; args?: Record<string, unknown> }>,
    results: [] as ValidatedServiceConfig[],
    error: null as string | null,
    retry: null as { attempt: number; maxRetries: number; reason: string } | null,
    phaseTokens: {} as Record<string, { inputTokens: number; outputTokens: number; durationMs: number }>,
    totalUsage: null as { inputTokens: number; outputTokens: number; durationMs: number } | null,
  });

  const lastProcessedIdx = useRef(0);
  useEffect(() => {
    const start = lastProcessedIdx.current;
    const msgs = ws.messages;
    if (msgs.length <= start) return;
    lastProcessedIdx.current = msgs.length;

    for (let i = start; i < msgs.length; i++) {
      const msg = msgs[i];
      if (msg.type === "discover:phase") {
        setDiscoveryState((prev) => ({ ...prev, phase: msg.phase, status: msg.status }));
      } else if (msg.type === "discover:iteration") {
        setDiscoveryState((prev) => ({
          ...prev,
          iteration: { current: msg.iteration, max: msg.maxIterations, description: msg.description },
        }));
      } else if (msg.type === "discover:tool_call") {
        setDiscoveryState((prev) => ({
          ...prev,
          toolCalls: [...prev.toolCalls.slice(-50), {
            timestamp: new Date().toLocaleTimeString(),
            tool: msg.tool,
            status: msg.status,
            args: msg.args,
          }],
        }));
      } else if (msg.type === "discover:complete") {
        setDiscoveryState((prev) => ({ ...prev, results: msg.services, error: null }));
      } else if (msg.type === "discover:phase_usage") {
        setDiscoveryState((prev) => ({
          ...prev,
          phaseTokens: {
            ...prev.phaseTokens,
            [msg.phase]: { inputTokens: msg.inputTokens, outputTokens: msg.outputTokens, durationMs: msg.durationMs },
          },
        }));
      } else if (msg.type === "discover:total_usage") {
        setDiscoveryState((prev) => ({
          ...prev,
          totalUsage: { inputTokens: msg.inputTokens, outputTokens: msg.outputTokens, durationMs: msg.durationMs },
        }));
      } else if (msg.type === "discover:pending") {
        setDiscoveryState((prev) => ({ ...prev, results: msg.services, error: null }));
      } else if (msg.type === "discover:retry") {
        setDiscoveryState((prev) => ({
          ...prev,
          retry: { attempt: msg.attempt, maxRetries: msg.maxRetries, reason: msg.reason },
          toolCalls: [],
          iteration: { current: 0, max: prev.iteration.max, description: "" },
        }));
      } else if (msg.type === "discover:error") {
        setDiscoveryState((prev) => ({ ...prev, error: msg.message }));
      }
    }
  }, [ws.messages]);

  // Keep a ref of the current pane so effects can read the latest value
  // without re-running every time the pane changes.
  const leftPaneRef = useRef(leftPane);
  leftPaneRef.current = leftPane;

  // Auto-navigate to the new investigation when a Re-investigate fires.
  // Rerun creates a NEW id server-side; without this the user would sit
  // on the old pane watching events for an id it doesn't know about.
  const lastRerunNavIdx = useRef(0);
  useEffect(() => {
    const start = lastRerunNavIdx.current;
    const msgs = ws.messages;
    if (msgs.length <= start) return;
    lastRerunNavIdx.current = msgs.length;

    for (let i = start; i < msgs.length; i++) {
      const msg = msgs[i];
      if (msg.type !== "investigation:started" || !msg.parentInvestigationId) continue;
      const pane = leftPaneRef.current;
      if (pane.type === "investigation" && pane.id === msg.parentInvestigationId) {
        setLeftPane({ type: "investigation", id: msg.id, stackId: activeStackId });
      }
    }
  }, [ws.messages, setLeftPane]);

  // Sync the global active stack to the investigation pane's owning stack.
  //
  // Two cases:
  //   1. Legacy URL `/investigations/:id` (parser sets stackId="") — hit
  //      `/api/investigations/:id/locate` to discover the owning stack,
  //      switch to it, and replaceState the URL to the canonical
  //      `/stacks/:stackId/investigations/:id` form.
  //   2. Stack-scoped URL `/stacks/:stackId/investigations/:id` opened in a
  //      browser whose last-active stack is different — switch to the URL's
  //      stack so the investigation, the sidebar, and any subsequent
  //      navigation share one consistent stack context.
  //
  // Effect waits for `useStacks` to finish its initial fetch (`stacksLoading`)
  // so it has a real stack list to validate against — otherwise it could
  // race with the bootstrap and switch to a stack that's about to be
  // overwritten by the localStorage default-pick.
  const investigationStackId = leftPane.type === "investigation" ? leftPane.stackId : null;
  const investigationId = leftPane.type === "investigation" ? leftPane.id : null;
  // True when the URL names a stack we know about. Used both to decide
  // whether to skip the locate fetch and as a stable effect dep — comparing
  // a boolean avoids re-firing on every `stacks` array reference change.
  const ownedByKnownStack =
    investigationStackId !== null && investigationStackId !== "" &&
    stacks.some((s) => s.id === investigationStackId);
  useEffect(() => {
    if (stacksLoading) return;
    if (investigationId == null) return;

    // Need to discover the owning stack: either the URL omitted it (legacy
    // /investigations/:id) or it names a stack that isn't in the registry
    // anymore (renamed, deleted, or typo'd). Both fall back to the locate
    // endpoint and replaceState the user onto the canonical URL.
    if (!ownedByKnownStack) {
      let cancelled = false;
      const fetcher = createStackFetch(activeStackId);
      // When locate can't resolve the id (truly missing, or network error),
      // route to the not-found view. Keeping the URL the user typed makes
      // copy-paste honest — an earlier draft replaceState'd to /stacks/<active>
      // /investigations/<id>, which falsely implied the id belonged to the
      // active stack and sent the next person digging in the wrong place.
      const fallbackToNotFound = () => {
        if (cancelled) return;
        setLeftPane(
          { type: "notfound", path: window.location.pathname + window.location.search },
          { replace: true },
        );
      };
      fetcher(`/api/investigations/${investigationId}/locate`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data: { stackId?: string } | null) => {
          if (cancelled) return;
          if (data?.stackId) {
            switchStack(data.stackId);
            setLeftPane(
              { type: "investigation", id: investigationId, stackId: data.stackId },
              { replace: true },
            );
          } else {
            fallbackToNotFound();
          }
        })
        .catch(fallbackToNotFound);
      return () => { cancelled = true; };
    }

    if (investigationStackId !== activeStackId) {
      switchStack(investigationStackId!);
    }
  }, [investigationId, investigationStackId, ownedByKnownStack, stacksLoading, activeStackId, switchStack, setLeftPane]);

  // Recovery for wrong-but-known stack URLs. Hand-edited links and
  // rename-stale bookmarks land on a known stack that doesn't actually own
  // the investigation; InvestigationPane catches the per-stack 404, probes
  // /api/investigations/:id/locate, and asks us to relocate when the id
  // genuinely lives elsewhere. Wrapped in useCallback so the pane's data
  // effect can include it in deps without re-running on every parent
  // render.
  const handleWrongStack = useCallback(
    (correctStackId: string) => {
      const pane = leftPaneRef.current;
      if (pane.type !== "investigation") return;
      switchStack(correctStackId);
      setLeftPane(
        { type: "investigation", id: pane.id, stackId: correctStackId },
        { replace: true },
      );
    },
    [switchStack, setLeftPane],
  );

  // Reset view + discovery state on stack switch.
  //
  // The reset-to-dashboard is only needed for panes that render
  // stack-specific data (a service from stack A would be stale under stack
  // B). For stack-neutral panes (settings, notfound) we leave the view
  // alone — otherwise a sidebar click + stack switch racing together would
  // briefly land on `/`, then snap to the clicked target, producing the
  // QA-reported "double redirect" flash.
  const prevStackRef = useRef(activeStackId);
  useEffect(() => {
    if (prevStackRef.current !== activeStackId && prevStackRef.current) {
      const pane = leftPaneRef.current;
      // Deep-link case: when the URL is /stacks/:stackId/investigations/:id,
      // the locate-and-switch effect below switches the global active stack
      // to match the investigation's owning stack. The pane is already in
      // its canonical state — bouncing to dashboard would break the deep
      // link the user just opened. Only reset when the new active stack
      // genuinely doesn't match the pane's intent.
      const investigationOwnsThisStack =
        pane.type === "investigation" && pane.stackId === activeStackId;
      if (shouldResetOnStackSwitch(pane.type) && !investigationOwnsThisStack) {
        setLeftPane({ type: "dashboard" });
      }
    }
    prevStackRef.current = activeStackId;
    lastProcessedIdx.current = 0;
    setDiscoveryState({
      phase: "",
      status: "complete",
      iteration: { current: 0, max: 0, description: "" },
      toolCalls: [],
      results: [],
      error: null,
      retry: null,
      phaseTokens: {},
      totalUsage: null,
    });
  }, [activeStackId]);

  // Don't render until we have a stack ID
  if (!activeStackId) {
    return (
      <div className="h-screen flex items-center justify-center bg-background text-muted-foreground">
        <span className="font-mono text-[10px] uppercase tracking-wider">Loading...</span>
      </div>
    );
  }

  return (
    <StackProvider activeStackId={activeStackId}>
    <TooltipProvider delayDuration={200}>
    <div className="h-screen flex flex-col bg-background text-foreground noise relative overflow-hidden">
    <DemoBanner />
    <div className="flex-1 flex min-h-0">
      {/* Sidebar */}
      <Sidebar
        activePage={activePage}
        onNavigate={(page) => {
          // "activity" is a LeftPaneView that carries a tab + query; clicking
          // the sidebar icon always means "take me to the investigations tab,
          // unfiltered", since that's the most-used surface. The other three
          // sidebar pages map 1:1.
          if (page === "activity") setLeftPane({ type: "activity", tab: "investigations", query: {} });
          else setLeftPane({ type: page });
        }}
        dark={theme.dark}
        onToggleTheme={theme.toggle}
      />

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Slimmed top bar — branding + stack switcher + health */}
        <header className="h-10 flex items-center justify-between px-4 border-b border-border/50 bg-card/60 backdrop-blur-md shrink-0 relative z-10">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1">
              <div className="w-1.5 h-1.5 rounded-full bg-primary animate-status-pulse" />
              <div className="w-1.5 h-1.5 rounded-full bg-primary/50" />
              <div className="w-1.5 h-1.5 rounded-full bg-primary/25" />
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="font-display font-bold text-sm tracking-wide text-foreground uppercase">
                {branding.title}
              </span>
              <span className="text-[9px] font-mono text-muted-foreground/70 tracking-[0.2em] uppercase">
                {branding.subtitle}
              </span>
            </div>
            {/* Divider + Stack Switcher */}
            <div className="w-px h-4 bg-border" />
            <StackSwitcher
              stacks={stacks}
              activeStackId={activeStackId}
              onSwitch={switchStack}
              onStackCreated={refetchStacks}
            />
          </div>
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-secondary/30">
            {/* Health status cluster */}
            <div className={`w-1.5 h-1.5 rounded-full transition-colors ${
              health.connectionState === "connected" && health.health?.status === "healthy"
                ? "bg-success"
                : health.health?.status === "degraded"
                ? "bg-warning"
                : health.connectionState === "unreachable"
                ? "bg-destructive"
                : "bg-muted-foreground/30"
            }`} />
            <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground/75">
              {health.connectionState === "connected" && health.health?.status === "healthy"
                ? "HEALTHY"
                : health.health?.status === "degraded"
                ? "DEGRADED"
                : health.connectionState === "unreachable"
                ? "UNREACHABLE"
                : "UNKNOWN"}
            </span>
            <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground/75">
              {health.health ? formatUptime(health.health.uptime) : "\u2014"}
            </span>
            <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground/75">
              {health.health ? (health.health.probes.mcp.status === "ok" ? "mcp:ok" : "mcp:\u2014") : "mcp:\u2014"}
            </span>
            <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground/75">
              {health.health ? (health.health.probes.db.status === "ok" ? "db:ok" : "db:\u2014") : "db:\u2014"}
            </span>
            <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground/75">
              {health.health?.version ? `v${health.health.version}` : "v\u2014"}
            </span>
            <ScanActivityBadge onNavigate={() => setLeftPane({ type: "settings", initialTab: "scan" })} />
          </div>
        </header>

        {/* Setup stepper */}
        {showStepper && (
          <SetupStepper
            stage={setupStage}
            onNavigate={(page) => {
              // SetupStepper only ever emits settings / services / dashboard
              // today (see SetupStepper STEPS). The "activity" branch exists
              // for type soundness — if a future step ever points there,
              // landing on the investigations tab is the right default.
              if (page === "activity") setLeftPane({ type: "activity", tab: "investigations", query: {} });
              else setLeftPane({ type: page });
            }}
            onSkip={handleSkipSetup}
          />
        )}

        {/* Content */}
        <div className="flex-1 min-h-0">
          <ResizablePanelGroup orientation="horizontal">
            <ResizablePanel defaultSize={60} minSize={30}>
              <div className="h-full bg-grid relative">
                <div key={leftPane.type === "investigation" ? `inv-${leftPane.id}` : leftPane.type === "pattern" ? `pattern-${leftPane.id}` : leftPane.type} className="h-full animate-fade-in">
                  {leftPane.type === "dashboard" ? (
                    <Dashboard
                      wsMessages={ws.messages}
                      wsSend={ws.send}
                      onInvestigationClick={(id) => setLeftPane({ type: "investigation", id, stackId: activeStackId })}
                      onViewService={(name) => setLeftPane({ type: "services", initialService: name })}
                      onViewAllServices={() => setLeftPane({ type: "services" })}
                      onViewAllInvestigations={() => setLeftPane({ type: "activity", tab: "investigations", query: {} })}
                      onViewAllScans={() => setLeftPane({ type: "activity", tab: "scans", query: {} })}
                      onViewAllPatterns={() => setLeftPane({ type: "activity", tab: "patterns", query: {} })}
                      onViewAllEvents={() => setLeftPane({ type: "activity", tab: "events", query: {} })}
                      onOpenScanRun={(runId) => setLeftPane({ type: "scanrun", runId })}
                      stackName={hasMultipleStacks ? activeStack?.name : undefined}
                      setupStage={setupStage}
                      setupDismissed={setupDismissed}
                      onResumeSetup={() => { setSetupDismissed(false); safeSetItem(`dops:setup_dismissed:${activeStackId}`, ""); }}
                    />
                  ) : leftPane.type === "investigation" ? (
                    // Two states delay rendering the pane until the active
                    // stack matches the investigation's owning stack:
                    //   1. stackId === ""  → legacy URL, locate-and-redirect
                    //                        effect is in flight
                    //   2. stackId mismatch → URL stack differs from active,
                    //                         switchStack effect in flight
                    // Mounting the pane during either state would fetch with
                    // the wrong X-Stack-Id header and 404, then never re-fetch
                    // (the pane's data effect doesn't depend on stackFetch).
                    leftPane.stackId && leftPane.stackId === activeStackId ? (
                    <InvestigationPane
                      investigationId={leftPane.id}
                      wsMessages={ws.messages}
                      onBack={() => {
                        // Smart back-nav. If the current history entry was
                        // pushed by the app (user clicked a row rather than
                        // pasted a direct link), `history.back()` returns them
                        // to where they came from — typically /investigations
                        // with their filters preserved, but also services,
                        // dashboard, etc. If they direct-linked, fall back to
                        // the dashboard instead of popping off the site.
                        if (window.history.state?.fromApp) {
                          window.history.back();
                        } else {
                          setLeftPane({ type: "dashboard" });
                        }
                      }}
                      onNavigateSkills={() => setLeftPane({ type: "settings", initialTab: "skills" })}
                      onRerun={(invId, template) => {
                        ws.send({ type: "rerun", investigationId: invId, template: template as any });
                      }}
                      onWrongStack={handleWrongStack}
                    />
                    ) : (
                      <div className="h-full flex items-center justify-center">
                        <span className="font-mono text-[11px] text-muted-foreground/70">
                          Resolving investigation…
                        </span>
                      </div>
                    )
                  ) : leftPane.type === "pattern" ? (
                    <PatternDetail
                      patternId={leftPane.id}
                      onBack={() => {
                        if (window.history.state?.fromApp) {
                          window.history.back();
                        } else {
                          setLeftPane({ type: "activity", tab: "patterns", query: {} });
                        }
                      }}
                      onViewInvestigation={(id) => setLeftPane({ type: "investigation", id, stackId: activeStackId })}
                    />
                  ) : leftPane.type === "services" ? (
                    <ServicesPage
                      ws={ws}
                      onViewInvestigation={(id) => setLeftPane({ type: "investigation", id, stackId: activeStackId })}
                      initialService={leftPane.initialService}
                      onSelectService={(name) => {
                        if (leftPane.type === "services") setLeftPane({ ...leftPane, initialService: name });
                      }}
                      discoveryState={discoveryState}
                      onStartDiscovery={() => {
                        setDiscoveryState({ phase: "discovery", status: "running", iteration: { current: 0, max: 0, description: "" }, toolCalls: [], results: [], error: null, retry: null, phaseTokens: {}, totalUsage: null });
                        ws.send({ type: "discover" });
                      }}
                      onResetDiscovery={() => setDiscoveryState({ phase: "", status: "complete", iteration: { current: 0, max: 0, description: "" }, toolCalls: [], results: [], error: null, retry: null, phaseTokens: {}, totalUsage: null })}
                      onDiscoveryAccepted={() => setLeftPane({ type: "dashboard" })}
                      grafanaUrl={branding.grafanaUrl}
                      prometheusDatasource={branding.prometheusDatasource}
                      stackName={hasMultipleStacks ? activeStack?.name : undefined}
                    />
                  ) : leftPane.type === "settings" ? (
                    <SettingsPage
                      onRunDiscovery={() => {
                        ws.send({ type: "discover" });
                        setLeftPane({ type: "services" });
                      }}
                      initialTab={leftPane.initialTab}
                      stacks={stacks}
                      activeStackId={activeStackId}
                      onSwitchStack={switchStack}
                      onRefetchStacks={refetchStacks}
                      onProviderSaved={refreshSetupStage}
                    />
                  ) : leftPane.type === "scanrun" ? (
                    <ScanRunDetail
                      runId={leftPane.runId}
                      onBack={() => setLeftPane({ type: "dashboard" })}
                      onOpenInvestigation={(invId) => setLeftPane({ type: "investigation", id: invId, stackId: activeStackId })}
                      onSwitchStack={switchStack}
                      wsMessages={ws.messages}
                    />
                  ) : leftPane.type === "activity" ? (
                    <ActivityPage
                      view={leftPane}
                      onChangeTab={(tab) => {
                        // Each tab carries its own query shape; switching
                        // tabs resets to that tab's empty query rather than
                        // trying to translate filters across surfaces.
                        if (tab === "investigations") setLeftPane({ type: "activity", tab, query: {} });
                        else if (tab === "scans") setLeftPane({ type: "activity", tab, query: {} });
                        else if (tab === "events") setLeftPane({ type: "activity", tab, query: {} });
                        else setLeftPane({ type: "activity", tab, query: {} });
                      }}
                      onUpdateInvestigationsQuery={(query) =>
                        setLeftPane({ type: "activity", tab: "investigations", query }, { replace: true })
                      }
                      onUpdateScansQuery={(query) =>
                        setLeftPane({ type: "activity", tab: "scans", query }, { replace: true })
                      }
                      onUpdatePatternsQuery={(query) =>
                        setLeftPane({ type: "activity", tab: "patterns", query }, { replace: true })
                      }
                      onUpdateEventsQuery={(query) =>
                        setLeftPane({ type: "activity", tab: "events", query }, { replace: true })
                      }
                      onViewPattern={(id) => setLeftPane({ type: "pattern", id })}
                      onViewInvestigation={(id) => setLeftPane({ type: "investigation", id, stackId: activeStackId })}
                      onOpenScanRun={(runId) => setLeftPane({ type: "scanrun", runId })}
                      onNavigateHref={(href) => {
                        // Event rows carry an href like `/investigations/inv_…`
                        // or `/scan/runs/run_…`. Reuse the URL parser to resolve
                        // it to the correct LeftPaneView; falls back to
                        // dashboard for unknown shapes (defensive).
                        const view = parseUrl(href);
                        setLeftPane(view);
                      }}
                    />
                  ) : leftPane.type === "notfound" ? (
                    <div className="h-full flex flex-col items-center justify-center gap-3 p-8 text-center">
                      <h2 className="font-mono text-sm uppercase tracking-[0.12em] text-foreground/80">
                        Page not found
                      </h2>
                      <p className="font-mono text-[11px] text-muted-foreground/70 max-w-md">
                        <code className="text-foreground/60">{leftPane.path}</code> doesn&apos;t map to a route.
                      </p>
                      <button
                        className="mt-2 font-mono text-[11px] uppercase tracking-[0.12em] text-primary hover:text-primary/80"
                        onClick={() => setLeftPane({ type: "dashboard" })}
                      >
                        ← Back to dashboard
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize={40} minSize={25}>
              <ChatPane
                ws={ws}
                onInvestigationStarted={(id) => setLeftPane({ type: "investigation", id, stackId: activeStackId })}
                onViewInvestigation={(id) => setLeftPane({ type: "investigation", id, stackId: activeStackId })}
                activeInvestigationId={leftPane.type === "investigation" ? leftPane.id : undefined}
              />
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      </div>
    </div>
    </div>
    </TooltipProvider>
    </StackProvider>
  );
}
