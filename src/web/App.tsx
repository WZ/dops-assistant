import { useState, useEffect, useRef } from "react";
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
import { useWebSocket } from "./hooks/useWebSocket";
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
  | { type: "settings"; initialTab?: "providers" | "skills" };

function useTheme() {
  const [dark, setDark] = useState(() => localStorage.getItem("theme") === "dark");
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("theme", dark ? "dark" : "light");
  }, [dark]);
  return { dark, toggle: () => setDark((d) => !d) };
}

export function App() {
  const [leftPane, setLeftPane] = useState<LeftPaneView>({
    type: "dashboard",
  });
  const ws = useWebSocket();
  const theme = useTheme();
  const health = useHealthPolling();

  const activePage: SidebarPage =
    leftPane.type === "services" ? "services"
    : leftPane.type === "settings" ? "settings"
    : "dashboard";

  const [branding, setBranding] = useState({ title: "dops", subtitle: "assistant" });
  useEffect(() => {
    fetch("/api/branding").then((r) => r.json()).then(setBranding).catch(() => {});
  }, []);

  const [discoveryState, setDiscoveryState] = useState({
    phase: "discovery",
    status: "running" as "running" | "complete",
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

  return (
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
        {/* Slimmed top bar — branding + health only */}
        <header className="h-10 flex items-center justify-between px-4 border-b border-border/50 bg-card/60 backdrop-blur-md shrink-0 relative z-10">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1">
              <div className="w-1.5 h-1.5 rounded-full bg-primary animate-status-pulse" />
              <div className="w-1.5 h-1.5 rounded-full bg-primary/50" />
              <div className="w-1.5 h-1.5 rounded-full bg-primary/25" />
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="font-display font-bold text-sm tracking-wide text-foreground/90 uppercase">
                {branding.title}
              </span>
              <span className="text-[9px] font-mono text-muted-foreground/70 tracking-[0.2em] uppercase">
                {branding.subtitle}
              </span>
            </div>
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
            <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground/60">
              {health.connectionState === "connected" && health.health?.status === "healthy"
                ? "HEALTHY"
                : health.health?.status === "degraded"
                ? "DEGRADED"
                : health.connectionState === "unreachable"
                ? "UNREACHABLE"
                : "UNKNOWN"}
            </span>
            <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground/60">
              {health.health ? formatUptime(health.health.uptime) : "—"}
            </span>
            <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground/60">
              {health.health ? (health.health.probes.mcp.status === "ok" ? "mcp:ok" : "mcp:—") : "mcp:—"}
            </span>
            <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground/60">
              {health.health ? (health.health.probes.db.status === "ok" ? "db:ok" : "db:—") : "db:—"}
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
                    />
                  ) : leftPane.type === "investigation" ? (
                    <InvestigationPane
                      investigationId={leftPane.id}
                      wsMessages={ws.messages}
                      onBack={() => setLeftPane({ type: "dashboard" })}
                      onNavigateSkills={() => setLeftPane({ type: "settings", initialTab: "skills" })}
                    />
                  ) : leftPane.type === "services" ? (
                    <ServicesPage
                      ws={ws}
                      onViewInvestigation={(id) => setLeftPane({ type: "investigation", id })}
                      initialService={leftPane.initialService}
                      onInitialServiceConsumed={() => setLeftPane((prev) => prev.type === "services" ? { ...prev, initialService: undefined } : prev)}
                      discoveryState={discoveryState}
                      onStartDiscovery={() => { ws.send({ type: "discover" }); }}
                      onResetDiscovery={() => setDiscoveryState({ phase: "discovery", status: "running", iteration: { current: 0, max: 0, description: "" }, toolCalls: [], results: [], error: null, phaseTokens: {}, totalUsage: null })}
                    />
                  ) : leftPane.type === "settings" ? (
                    <SettingsPage
                      onRunDiscovery={() => {
                        ws.send({ type: "discover" });
                        setLeftPane({ type: "services" });
                      }}
                      initialTab={leftPane.initialTab}
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
  );
}
