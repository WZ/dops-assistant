import { Button } from "@/components/ui/button";
import { formatTokens } from "../lib/formatTokens.js";
import { useAutoScroll } from "../hooks/useAutoScroll.js";

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
  error?: string | null;
  phaseTokens?: Record<string, { inputTokens: number; outputTokens: number; durationMs: number }>;
  totalUsage?: { inputTokens: number; outputTokens: number; durationMs: number } | null;
  onRetry?: () => void;
  onBack: () => void;
}

export function DiscoveryProgress({ phase, phaseStatus, iteration, toolCalls, error, phaseTokens, totalUsage, onRetry, onBack }: DiscoveryProgressProps) {
  const toolCallLogRef = useAutoScroll([toolCalls.length]);
  const phases = ["discovery", "validation", "review"];
  const currentIdx = phases.indexOf(phase);

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="text-xs text-muted-foreground/50 mb-4">
        <Button variant="link" className="text-primary h-auto p-0 text-xs" onClick={onBack}>Dashboard</Button>
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
              i < currentIdx ? "bg-success text-success-foreground" :
              i === currentIdx ? "bg-primary text-primary-foreground" :
              "bg-muted text-muted-foreground"
            }`}>
              {i < currentIdx ? "\u2713" : i + 1}
            </div>
            <span className={`text-xs ${i <= currentIdx ? "text-foreground" : "text-muted-foreground/50"}`}>
              {p.charAt(0).toUpperCase() + p.slice(1)}
            </span>
            {phaseTokens?.[p] && (
              <span className="text-[8px] font-mono text-muted-foreground/50">
                {formatTokens(phaseTokens[p]!.inputTokens + phaseTokens[p]!.outputTokens)} tok · {(phaseTokens[p]!.durationMs / 1000).toFixed(1)}s
              </span>
            )}
          </div>
        ))}
      </div>

      <div className="rounded-lg border bg-card/40 p-4">
        {/* Spinner + status when running */}
        {!error && (
          <div className="flex items-center gap-3 mb-4">
            <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            <div>
              <div className="text-sm font-medium">
                {phase === "discovery" ? "Discovering services..." : "Validating services..."}
              </div>
              {iteration && iteration.max > 0 && (
                <div className="text-[11px] text-muted-foreground/50">
                  Step {iteration.current} of {iteration.max}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Progress bar */}
        {iteration && iteration.max > 0 && !error && (
          <div className="h-1 bg-muted rounded mb-4">
            <div
              className="h-1 bg-primary rounded transition-all"
              style={{ width: `${(iteration.current / iteration.max) * 100}%` }}
            />
          </div>
        )}

        {/* Tool call log */}
        {toolCalls.length > 0 && (
          <div ref={toolCallLogRef} className="font-mono text-[11px] text-muted-foreground/60 max-h-40 overflow-y-auto space-y-0.5">
            {toolCalls.slice(-20).map((tc, i) => (
              <div key={i}>
                <span className="text-muted-foreground/60">{tc.timestamp}</span>{" "}
                <span className={tc.status === "error" ? "text-destructive" : tc.status === "success" ? "text-success" : "text-primary"}>
                  {tc.status === "success" ? "\u2713" : tc.status === "error" ? "\u2717" : "\u2192"}
                </span>{" "}
                {tc.tool}
              </div>
            ))}
          </div>
        )}

        {/* Empty state — waiting for first tool call */}
        {toolCalls.length === 0 && !error && (
          <div className="text-xs text-muted-foreground/70">Waiting for agent to start...</div>
        )}
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 p-4">
          <p className="text-sm text-destructive mb-3">{error}</p>
          <div className="flex gap-2">
            {onRetry && (
              <Button
                onClick={onRetry}
                size="sm"
              >
                Retry
              </Button>
            )}
            <Button
              onClick={onBack}
              variant="outline"
              size="sm"
            >
              Back
            </Button>
          </div>
        </div>
      )}

      {totalUsage && (
        <div className="flex items-center gap-2 px-4 py-2 text-[10px] font-mono text-muted-foreground/50 border-t border-border/20">
          <span>Total:</span>
          <span>{formatTokens(totalUsage.inputTokens)} input</span>
          <span>·</span>
          <span>{formatTokens(totalUsage.outputTokens)} output</span>
          <span>·</span>
          <span>{formatTokens(totalUsage.inputTokens + totalUsage.outputTokens)} tokens</span>
          <span>·</span>
          <span>{(totalUsage.durationMs / 1000).toFixed(1)}s</span>
        </div>
      )}
    </div>
  );
}
