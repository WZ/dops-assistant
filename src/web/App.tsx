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
    <div className="h-screen bg-background text-foreground">
      <ResizablePanelGroup orientation="horizontal">
        <ResizablePanel defaultSize={60} minSize={30}>
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
  );
}
