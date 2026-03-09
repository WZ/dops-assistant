import { useState } from "react";
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

export function App() {
  const [leftPane, setLeftPane] = useState<LeftPaneView>({
    type: "dashboard",
  });
  const ws = useWebSocket();

  return (
    <div className="h-screen flex flex-col bg-background text-foreground noise relative overflow-hidden">
      {/* ── Top bar ── */}
      <header className="h-11 flex items-center justify-between px-5 border-b border-border/60 bg-card/50 backdrop-blur-sm shrink-0 relative z-10">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-primary animate-glow-pulse" />
            <div className="w-2 h-2 rounded-full bg-primary/60" />
            <div className="w-2 h-2 rounded-full bg-primary/30" />
          </div>
          <span className="font-display font-bold text-sm tracking-wide text-foreground/90 uppercase">
            dops
          </span>
          <span className="text-[10px] font-mono text-muted-foreground/60 tracking-widest uppercase">
            assistant
          </span>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className={`w-1.5 h-1.5 rounded-full ${ws.status === "connected" ? "bg-success" : ws.status === "connecting" ? "bg-accent animate-status-pulse" : "bg-destructive"}`} />
            <span className="text-[10px] font-mono text-muted-foreground/70 uppercase tracking-wider">
              {ws.status === "connected" ? "live" : ws.status}
            </span>
          </div>
          <span className="text-[10px] font-mono text-muted-foreground/40">
            v0.1.0
          </span>
        </div>
      </header>

      {/* ── Main content ── */}
      <div className="flex-1 min-h-0">
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel defaultSize={60} minSize={30}>
            <div className="h-full bg-grid relative">
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
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={40} minSize={25}>
            <ChatPane
              ws={ws}
              onInvestigationStarted={(id) =>
                setLeftPane({ type: "investigation", id })
              }
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
