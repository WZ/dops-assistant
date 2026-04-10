import { useState, useEffect, useRef, useCallback } from "react";
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
import { Sidebar } from "./components/Sidebar";
import type { SidebarPage } from "./components/Sidebar";
import { ServicesPage } from "./components/ServicesPage";
import { SettingsPage } from "./components/SettingsPage";
import { useRoute } from "./hooks/useRoute";
import { StackSwitcher } from "./components/StackSwitcher";
import { StackProvider } from "./contexts/StackContext";
import { useWebSocket } from "./hooks/useWebSocket";
import { useStacks } from "./hooks/useStacks";
import { useHealthPolling } from "./components/dashboard/useHealthPolling";
import type { ValidatedServiceConfig } from "../types/discovery-types.js";

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export type LeftPaneView =
  | { type: "dashboard" }
  | { type: "investigation"; id: string }
  | { type: "services"; initialService?: string }
  | { type: "settings"; initialTab?: "providers" | "skills" | "stacks" };

function useTheme() {
  const [dark, setDark] = useState(() => safeGetItem("theme") === "dark");
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
  const setLeftPane = useCallback((view: LeftPaneView) => navigate(view), [navigate]);

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
  const { stacks, activeStackId, activeStack, switchStack, refetch: refetchStacks } = useStacks();
  const ws = useWebSocket(activeStackId);
  const theme = useTheme();
  const health = useHealthPolling();

  const hasMultipleStacks = stacks.length > 1;

  const activePage: SidebarPage =
    leftPane.type === "services" ? "services"
    : leftPane.type === "settings" ? "settings"
    : "dashboard";

  const [branding, setBranding] = useState<{ title: string; subtitle: string; grafanaUrl?: string; prometheusDatasource?: string }>({ title: "dops", subtitle: "assistant" });
  useEffect(() => {
    fetch("/api/branding", { headers: { "X-Stack-Id": activeStackId } }).then((r) => r.json()).then((data) => setBranding((prev) => ({ ...prev, ...data }))).catch(() => {});
  }, [activeStackId]);

  const [discoveryState, setDiscoveryState] = useState({
    phase: "",
    status: "complete" as "running" | "complete",
    iteration: { current: 0, max: 0, description: "" },
    toolCalls: [] as Array<{ timestamp: string; tool: string; status: "calling" | "success" | "error"; args?: Record<string, unknown> }>,
    results: [] as ValidatedServiceConfig[],
    error: null as string | null,
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
      } else if (msg.type === "discover:error") {
        setDiscoveryState((prev) => ({ ...prev, error: msg.message }));
      }
    }
  }, [ws.messages]);

  // Reset view and discovery state on stack switch
  const prevStackRef = useRef(activeStackId);
  useEffect(() => {
    if (prevStackRef.current !== activeStackId && prevStackRef.current) {
      setLeftPane({ type: "dashboard" });
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
    <div className="h-screen flex bg-background text-foreground noise relative overflow-hidden">
      {/* Sidebar */}
      <Sidebar
        activePage={activePage}
        onNavigate={(page) => setLeftPane({ type: page })}
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
          </div>
        </header>

        {/* Content */}
        <div className="flex-1 min-h-0">
          <ResizablePanelGroup orientation="horizontal">
            <ResizablePanel defaultSize={60} minSize={30}>
              <div className="h-full bg-grid relative">
                <div key={leftPane.type === "investigation" ? `inv-${leftPane.id}` : leftPane.type} className="h-full animate-fade-in">
                  {leftPane.type === "dashboard" ? (
                    <Dashboard
                      wsMessages={ws.messages}
                      onInvestigationClick={(id) => setLeftPane({ type: "investigation", id })}
                      onViewService={(name) => setLeftPane({ type: "services", initialService: name })}
                      onViewAllServices={() => setLeftPane({ type: "services" })}
                      stackName={hasMultipleStacks ? activeStack?.name : undefined}
                    />
                  ) : leftPane.type === "investigation" ? (
                    <InvestigationPane
                      investigationId={leftPane.id}
                      wsMessages={ws.messages}
                      onBack={() => setLeftPane({ type: "dashboard" })}
                      onNavigateSkills={() => setLeftPane({ type: "settings", initialTab: "skills" })}
                      onRerun={(invId, template) => {
                        ws.send({ type: "rerun", investigationId: invId, template: template as any });
                      }}
                    />
                  ) : leftPane.type === "services" ? (
                    <ServicesPage
                      ws={ws}
                      onViewInvestigation={(id) => setLeftPane({ type: "investigation", id })}
                      initialService={leftPane.initialService}
                      onInitialServiceConsumed={() => { if (leftPane.type === "services") setLeftPane({ ...leftPane, initialService: undefined }); }}
                      discoveryState={discoveryState}
                      onStartDiscovery={() => { ws.send({ type: "discover" }); }}
                      onResetDiscovery={() => setDiscoveryState({ phase: "", status: "complete", iteration: { current: 0, max: 0, description: "" }, toolCalls: [], results: [], error: null, phaseTokens: {}, totalUsage: null })}
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
                    />
                  ) : null}
                </div>
              </div>
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize={40} minSize={25}>
              <ChatPane
                ws={ws}
                onInvestigationStarted={(id) => setLeftPane({ type: "investigation", id })}
                onViewInvestigation={(id) => setLeftPane({ type: "investigation", id })}
                activeInvestigationId={leftPane.type === "investigation" ? leftPane.id : undefined}
              />
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      </div>
    </div>
    </TooltipProvider>
    </StackProvider>
  );
}
