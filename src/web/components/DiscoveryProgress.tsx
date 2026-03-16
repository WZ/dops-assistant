interface ToolCallEntry {
  timestamp: string;
  tool: string;
  status: "calling" | "success" | "error";
  args?: Record<string, unknown>;
}

interface DiscoveryProgressProps {
  phase: string;
  phaseStatus: "running" | "complete";
  iteration?: { current: number; max: number; description: string };
  toolCalls: ToolCallEntry[];
  onBack: () => void;
}

export function DiscoveryProgress({ phase, phaseStatus, iteration, toolCalls, onBack }: DiscoveryProgressProps) {
  const phases = ["discovery", "validation", "review"];
  const currentIdx = phases.indexOf(phase);

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="text-xs text-muted-foreground/50 mb-4">
        <button onClick={onBack} className="text-primary hover:underline">Dashboard</button>
        <span className="mx-1.5">{"\u203A"}</span>
        <span>Services</span>
        <span className="mx-1.5">{"\u203A"}</span>
        <span>Discovery</span>
      </div>

      <div className="flex items-center gap-3 mb-6">
        {phases.map((p, i) => (
          <div key={p} className="flex items-center gap-2">
            {i > 0 && <div className={`w-8 h-px ${i <= currentIdx ? "bg-primary" : "bg-border"}`} />}
            <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] ${
              i < currentIdx ? "bg-green-500 text-black" :
              i === currentIdx ? "bg-primary text-primary-foreground" :
              "bg-muted text-muted-foreground"
            }`}>
              {i < currentIdx ? "\u2713" : i + 1}
            </div>
            <span className={`text-xs ${i <= currentIdx ? "text-foreground" : "text-muted-foreground/50"}`}>
              {p.charAt(0).toUpperCase() + p.slice(1)}
            </span>
          </div>
        ))}
      </div>

      <div className="rounded-lg border bg-card/40 p-4">
        {iteration && iteration.max > 0 && (
          <>
            <div className="flex items-center gap-2 mb-2 text-sm">
              <div className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <span>{iteration.description} ({iteration.current}/{iteration.max})</span>
            </div>
            <div className="h-1 bg-muted rounded mb-4">
              <div
                className="h-1 bg-primary rounded transition-all"
                style={{ width: `${(iteration.current / iteration.max) * 100}%` }}
              />
            </div>
          </>
        )}

        <div className="font-mono text-[11px] text-muted-foreground/60 max-h-40 overflow-y-auto space-y-0.5">
          {toolCalls.slice(-20).map((tc, i) => (
            <div key={i}>
              <span className="text-muted-foreground/30">{tc.timestamp}</span>{" "}
              <span className={tc.status === "error" ? "text-red-400" : tc.status === "success" ? "text-green-400" : "text-primary"}>
                {tc.status === "success" ? "\u2713" : tc.status === "error" ? "\u2717" : "\u2192"}
              </span>{" "}
              {tc.tool}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
