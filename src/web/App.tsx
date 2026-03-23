import { useState, useEffect, useRef } from "react";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sun, Moon } from "lucide-react";
import { ChatPane } from "./components/ChatPane";
import { Dashboard } from "./components/Dashboard";
import { InvestigationPane } from "./components/InvestigationPane";
import { ServiceDetail } from "./components/ServiceDetail";
import { SkillsPage } from "./components/SkillsPage";
import { ProvidersPage } from "./components/ProvidersPage";
import { ServicesManage } from "./components/ServicesManage";
import { VersionHistory } from "./components/VersionHistory";
import { DiscoveryProgress } from "./components/DiscoveryProgress";
import { DiscoveryReview } from "./components/DiscoveryReview";
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
  | { type: "service:detail"; serviceName: string }
  | { type: "skills" }
  | { type: "providers" }
  | { type: "services:manage" }
  | { type: "services:history" }
  | { type: "services:discovery" }
  | { type: "services:review" };

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
        setLeftPane({ type: "services:review" });
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
        setLeftPane({ type: "services:review" });
      } else if (msg.type === "discover:error") {
        setDiscoveryState((prev) => ({ ...prev, error: msg.message }));
      }
    }
  }, [ws.messages]);

  return (
    <TooltipProvider delayDuration={200}>
    <div className="h-screen flex flex-col bg-background text-foreground noise relative overflow-hidden">
      {/* ── Top bar ── */}
      <header className="h-11 flex items-center justify-between px-5 border-b border-border/50 bg-card/60 backdrop-blur-md shrink-0 relative z-10">
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
          {/* Nav items */}
          <nav className="flex items-center gap-1 ml-4">
            <Button
              variant="ghost"
              onClick={() => setLeftPane({ type: "dashboard" })}
              className={`px-2.5 py-2 min-h-[44px] text-[10px] font-mono rounded transition-colors ${leftPane.type === "dashboard" ? "text-primary bg-primary/8" : "text-muted-foreground/50 hover:text-foreground/70 hover:bg-secondary/30"}`}
            >
              Dashboard
            </Button>
            <Button
              variant="ghost"
              onClick={() => setLeftPane({ type: "providers" })}
              className={`px-2.5 py-2 min-h-[44px] text-[10px] font-mono rounded transition-colors ${leftPane.type === "providers" ? "text-primary bg-primary/8" : "text-muted-foreground/50 hover:text-foreground/70 hover:bg-secondary/30"}`}
            >
              Providers
            </Button>
            <Button
              variant="ghost"
              onClick={() => setLeftPane({ type: "skills" })}
              className={`px-2.5 py-2 min-h-[44px] text-[10px] font-mono rounded transition-colors ${leftPane.type === "skills" ? "text-primary bg-primary/8" : "text-muted-foreground/50 hover:text-foreground/70 hover:bg-secondary/30"}`}
            >
              Skills
            </Button>
          </nav>
        </div>
        <div className="flex items-center gap-3">
          {/* Health status indicators */}
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-secondary/30">
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
          {/* WS status pill */}
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-secondary/30">
            <div className={`w-1.5 h-1.5 rounded-full transition-colors ${ws.status === "connected" ? "bg-success" : ws.status === "connecting" ? "bg-accent animate-status-pulse" : "bg-destructive"}`} />
            <span className="text-[9px] font-mono text-muted-foreground/60 uppercase tracking-wider">
              {ws.status === "connected" ? "live" : ws.status}
            </span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={theme.toggle}
            aria-label={theme.dark ? "Switch to light mode" : "Switch to dark mode"}
            className="min-h-[44px] min-w-[44px] text-muted-foreground/70 hover:text-foreground/70 hover:bg-secondary/50"
            title={theme.dark ? "Switch to light" : "Switch to dark"}
          >
            {theme.dark ? (
              <Sun size={13} className="!size-auto" />
            ) : (
              <Moon size={13} className="!size-auto" />
            )}
          </Button>
        </div>
      </header>

      {/* ── Main content ── */}
      <div className="flex-1 min-h-0">
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel defaultSize={60} minSize={30}>
            <div className="h-full bg-grid relative">
              <div key={leftPane.type === "investigation" ? `inv-${leftPane.id}` : leftPane.type === "service:detail" ? `svc-${leftPane.serviceName}` : leftPane.type} className="h-full animate-fade-in">
                {leftPane.type === "services:manage" ? (
                  <ServicesManage
                    onRunDiscovery={() => {
                      ws.send({ type: "discover" });
                      setLeftPane({ type: "services:discovery" });
                    }}
                    onViewHistory={() => setLeftPane({ type: "services:history" })}
                    onBack={() => setLeftPane({ type: "dashboard" })}
                  />
                ) : leftPane.type === "services:history" ? (
                  <VersionHistory
                    onBack={() => setLeftPane({ type: "services:manage" })}
                  />
                ) : leftPane.type === "services:discovery" ? (
                  <DiscoveryProgress
                    phase={discoveryState.phase}
                    phaseStatus={discoveryState.status}
                    iteration={discoveryState.iteration}
                    toolCalls={discoveryState.toolCalls}
                    error={discoveryState.error}
                    phaseTokens={discoveryState.phaseTokens}
                    totalUsage={discoveryState.totalUsage}
                    onRetry={() => {
                      setDiscoveryState({
                        phase: "discovery", status: "running",
                        iteration: { current: 0, max: 0, description: "" },
                        toolCalls: [], results: [], error: null,
                        phaseTokens: {}, totalUsage: null,
                      });
                      ws.send({ type: "discover" });
                    }}
                    onBack={() => setLeftPane({ type: "services:manage" })}
                  />
                ) : leftPane.type === "services:review" ? (
                  <DiscoveryReview
                    services={discoveryState.results}
                    onAccept={(services) => {
                      ws.send({ type: "discover:accept", services });
                      setLeftPane({ type: "dashboard" });
                    }}
                    onReject={() => {
                      ws.send({ type: "discover:reject" });
                      setLeftPane({ type: "dashboard" });
                    }}
                    onRerun={() => {
                      setDiscoveryState({
                        phase: "discovery", status: "running",
                        iteration: { current: 0, max: 0, description: "" },
                        toolCalls: [], results: [], error: null,
                        phaseTokens: {}, totalUsage: null,
                      });
                      ws.send({ type: "discover" });
                      setLeftPane({ type: "services:discovery" });
                    }}
                    onBack={() => setLeftPane({ type: "services:manage" })}
                  />
                ) : leftPane.type === "service:detail" ? (
                  <ServiceDetail
                    serviceName={leftPane.serviceName}
                    ws={ws}
                    onBack={() => setLeftPane({ type: "dashboard" })}
                    onViewInvestigation={(id) => setLeftPane({ type: "investigation", id })}
                    onViewService={(name) => setLeftPane({ type: "service:detail", serviceName: name })}
                  />
                ) : leftPane.type === "dashboard" ? (
                  <Dashboard
                    wsMessages={ws.messages}
                    onInvestigationClick={(id) =>
                      setLeftPane({ type: "investigation", id })
                    }
                    onViewService={(serviceName) => {
                      setLeftPane({ type: "service:detail", serviceName });
                    }}
                    onManageServices={() => setLeftPane({ type: "services:manage" })}
                    onRunDiscovery={() => {
                      ws.send({ type: "discover" });
                      setLeftPane({ type: "services:discovery" });
                    }}
                  />
                ) : leftPane.type === "providers" ? (
                  <ProvidersPage
                    onRunDiscovery={() => {
                      ws.send({ type: "discover" });
                      setLeftPane({ type: "services:discovery" });
                    }}
                  />
                ) : leftPane.type === "skills" ? (
                  <SkillsPage />
                ) : (
                  <InvestigationPane
                    investigationId={leftPane.id}
                    wsMessages={ws.messages}
                    onBack={() => setLeftPane({ type: "dashboard" })}
                    onNavigateSkills={() => setLeftPane({ type: "skills" })}
                  />
                )}
              </div>
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={40} minSize={25}>
            <ChatPane
              ws={ws}
              onInvestigationStarted={(id) =>
                setLeftPane({ type: "investigation", id })
              }
              onViewInvestigation={(id) =>
                setLeftPane({ type: "investigation", id })
              }
              activeInvestigationId={leftPane.type === "investigation" ? leftPane.id : undefined}
              serviceContext={leftPane.type === "service:detail" ? leftPane.serviceName : undefined}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
    </TooltipProvider>
  );
}
