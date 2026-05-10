import { useEffect, useState } from "react";
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
  retry?: { attempt: number; maxRetries: number; reason: string } | null;
  phaseTokens?: Record<string, { inputTokens: number; outputTokens: number; durationMs: number }>;
  phaseTimings?: Record<string, number>;
  totalUsage?: { inputTokens: number; outputTokens: number; durationMs: number } | null;
  onRetry?: () => void;
  onBack: () => void;
}

export function DiscoveryProgress({ phase, phaseStatus, iteration, toolCalls, error, retry, phaseTokens, phaseTimings, totalUsage, onRetry, onBack }: DiscoveryProgressProps) {
  // Elapsed timer + LLM thinking detection
  const [startTime] = useState(() => Date.now());
  const [elapsed, setElapsed] = useState(0);
  const [lastToolCallAt, setLastToolCallAt] = useState(Date.now());
  const [secondsSinceToolCall, setSecondsSinceToolCall] = useState(0);

  // Track when new tool calls arrive
  useEffect(() => {
    if (toolCalls.length > 0) setLastToolCallAt(Date.now());
  }, [toolCalls.length]);

  useEffect(() => {
    if (error || phaseStatus === "complete") return;
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
      setSecondsSinceToolCall(Math.floor((Date.now() - lastToolCallAt) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [startTime, lastToolCallAt, error, phaseStatus]);

  const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
  const isThinking = phase === "discovery" && toolCalls.length > 0 && secondsSinceToolCall >= 5 && !error;

  const toolCallLogRef = useAutoScroll([toolCalls.length, isThinking]);
  const phases = ["discovery", "validation", "review"];
  const currentIdx = phases.indexOf(phase);
  const phaseMeta = (p: string) => {
    const tokens = phaseTokens?.[p];
    const durationMs = phaseTimings?.[p] ?? tokens?.durationMs;
    if (!tokens && durationMs === undefined) return null;
    const parts: string[] = [];
    if (tokens) parts.push(`${formatTokens(tokens.inputTokens + tokens.outputTokens)} tok`);
    if (durationMs !== undefined) parts.push(`${(durationMs / 1000).toFixed(1)}s`);
    return parts.join(" · ");
  };

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
              i < currentIdx ? "bg-success text-success-foreground" :
              i === currentIdx ? "bg-primary text-primary-foreground" :
              "bg-muted text-muted-foreground"
            }`}>
              {i < currentIdx ? "\u2713" : i + 1}
            </div>
            <span className={`text-xs ${i <= currentIdx ? "text-foreground" : "text-muted-foreground/50"}`}>
              {p.charAt(0).toUpperCase() + p.slice(1)}
            </span>
            {phaseMeta(p) && (
              <span className="text-[8px] font-mono text-muted-foreground/50">
                {phaseMeta(p)}
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
              <div className="text-[11px] text-muted-foreground/50 flex items-center gap-2">
                {iteration && iteration.max > 0 && (
                  <span>Step {iteration.current} of {iteration.max}</span>
                )}
                <span className="tabular-nums">{elapsedStr} elapsed</span>
              </div>
              {retry ? (
                <div className="text-[10px] text-warning mt-0.5">Attempt {retry.attempt + 1} of {retry.maxRetries} — previous attempt failed ({retry.reason})</div>
              ) : (
                <div className="text-[10px] text-muted-foreground/40 mt-0.5">This may take several minutes to complete</div>
              )}
            </div>
          </div>
        )}

        {/* Progress bar — shimmer overlay shows activity even when no iterations are firing */}
        {!error && (
          <div className="h-1 bg-muted rounded mb-4 overflow-hidden relative">
            {iteration && iteration.max > 0 ? (
              <div
                className="h-1 bg-primary rounded transition-all"
                style={{ width: `${(iteration.current / iteration.max) * 100}%` }}
              />
            ) : null}
            <div
              className="absolute inset-0 h-1 rounded"
              style={{
                background: "linear-gradient(90deg, transparent 25%, hsl(var(--primary) / 0.4) 50%, transparent 75%)",
                backgroundSize: "200% 100%",
                animation: "shimmer 1.6s infinite",
              }}
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
            {isThinking && (
              <div className="flex items-center gap-2 pt-1.5 text-primary/60">
                <span className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-status-pulse flex-shrink-0" />
                LLM is analyzing results and generating service list...
              </div>
            )}
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
              <button
                onClick={onRetry}
                className="px-4 py-1.5 text-xs font-medium rounded bg-primary text-primary-foreground hover:bg-primary/90"
              >
                Retry
              </button>
            )}
            <button
              onClick={onBack}
              className="px-4 py-1.5 text-xs rounded border border-border text-muted-foreground hover:bg-accent"
            >
              Back
            </button>
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
