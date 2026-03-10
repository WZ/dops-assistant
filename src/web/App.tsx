import { useState, useEffect } from "react";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { ChatPane } from "./components/ChatPane";
import { Dashboard } from "./components/Dashboard";
import { InvestigationPane } from "./components/InvestigationPane";
import { useWebSocket } from "./hooks/useWebSocket";

export type LeftPaneView =
  | { type: "dashboard" }
  | { type: "investigation"; id: string };

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

  return (
    <div className="h-screen flex flex-col bg-background text-foreground noise relative overflow-hidden">
      {/* ── Top bar ── */}
      <header className="h-11 flex items-center justify-between px-5 border-b border-border/50 bg-card/60 backdrop-blur-md shrink-0 relative z-10">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1">
            <div className="w-1.5 h-1.5 rounded-full bg-primary animate-glow-pulse" />
            <div className="w-1.5 h-1.5 rounded-full bg-primary/50" />
            <div className="w-1.5 h-1.5 rounded-full bg-primary/25" />
          </div>
          <div className="flex items-baseline gap-1.5">
            <span className="font-display font-bold text-sm tracking-wide text-foreground/90 uppercase">
              dops
            </span>
            <span className="text-[9px] font-mono text-muted-foreground/40 tracking-[0.2em] uppercase">
              assistant
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-secondary/30">
            <div className={`w-1.5 h-1.5 rounded-full transition-colors ${ws.status === "connected" ? "bg-success" : ws.status === "connecting" ? "bg-accent animate-status-pulse" : "bg-destructive"}`} />
            <span className="text-[9px] font-mono text-muted-foreground/60 uppercase tracking-wider">
              {ws.status === "connected" ? "live" : ws.status}
            </span>
          </div>
          <button
            onClick={theme.toggle}
            className="p-1.5 rounded-md text-muted-foreground/40 hover:text-foreground/70 hover:bg-secondary/50 transition-all"
            title={theme.dark ? "Switch to light" : "Switch to dark"}
          >
            {theme.dark ? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="5"/><path d="M12 1v2"/><path d="M12 21v2"/><path d="M4.22 4.22l1.42 1.42"/><path d="M18.36 18.36l1.42 1.42"/><path d="M1 12h2"/><path d="M21 12h2"/><path d="M4.22 19.78l1.42-1.42"/><path d="M18.36 5.64l1.42-1.42"/>
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
              </svg>
            )}
          </button>
        </div>
      </header>

      {/* ── Main content ── */}
      <div className="flex-1 min-h-0">
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel defaultSize={60} minSize={30}>
            <div className="h-full bg-grid relative">
              <div key={leftPane.type === "investigation" ? `inv-${leftPane.id}` : "dashboard"} className="h-full animate-fade-in">
                {leftPane.type === "dashboard" ? (
                  <Dashboard
                    onInvestigationClick={(id) =>
                      setLeftPane({ type: "investigation", id })
                    }
                    onInvestigateService={(serviceName) => {
                      ws.send({ type: "chat", message: `investigate ${serviceName}` });
                    }}
                  />
                ) : (
                  <InvestigationPane
                    investigationId={leftPane.id}
                    wsMessages={ws.messages}
                    onBack={() => setLeftPane({ type: "dashboard" })}
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
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
