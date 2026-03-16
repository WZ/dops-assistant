import { useState, useRef, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { renderInline } from "../lib/renderInline";
import { renderMarkdown } from "../lib/renderMarkdown";
import { MetricChart, type TimeSeriesData } from "./MetricChart";
import type { useWebSocket } from "../hooks/useWebSocket";
import type { ChartSeries } from "../../types/ws-types.js";

interface RcaReportSummary {
  rootCause: string;
  trigger: string;
  confidence: string;
  confidenceScore?: number;
  severity: string;
  summary: string;
  service?: string;
  skillsUsed?: string[];
}

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  investigationId?: string;
  report?: RcaReportSummary;
  chartData?: ChartSeries[];
  skillsUsed?: string[];
}

interface ChatPaneProps {
  ws: ReturnType<typeof useWebSocket>;
  onInvestigationStarted: (id: string) => void;
  onViewInvestigation: (id: string) => void;
  activeInvestigationId?: string;
}

const DEEP_DIVE_PROMPTS = [
  "Why did this happen?",
  "Show me the raw log samples",
  "What other services were affected?",
  "What should we check first?",
];

/** Convert ChartSeries (wire format) to TimeSeriesData (component prop) */
function toTimeSeries(c: ChartSeries): TimeSeriesData {
  return {
    metric: c.metric,
    instance: c.instance,
    query: c.query,
    values: c.values,
    min: c.min,
    max: c.max,
    avg: c.avg,
  };
}

export function ChatPane({ ws, onInvestigationStarted, onViewInvestigation, activeInvestigationId }: ChatPaneProps) {
  const { status, messages: wsMessages, send } = ws;
  const [input, setInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [deepMessages, setDeepMessages] = useState<ChatMessage[]>([]);
  const [deepLoading, setDeepLoading] = useState(false);
  const [chatLoading, setChatLoading] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [contextSwitch, setContextSwitch] = useState<{ previousService: string; newService: string } | null>(null);
  const [streamingMessage, setStreamingMessage] = useState<{
    content: string;
    reasoning: string;
    showReasoning: boolean;
  } | null>(null);

  // Ref-based accumulator for high-frequency delta batching
  const streamRef = useRef<{ content: string; reasoning: string }>({ content: "", reasoning: "" });
  const rafRef = useRef<number | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const processedCount = useRef(0);
  const historyLoaded = useRef(false);

  const isDeepMode = !!activeInvestigationId;
  const messages = isDeepMode ? deepMessages : chatMessages;
  const isLoading = isDeepMode ? deepLoading : chatLoading;

  // Load historical messages on mount, enriching investigation summaries with report data
  useEffect(() => {
    if (historyLoaded.current) return;
    historyLoaded.current = true;
    fetch("/api/messages?limit=50")
      .then((r) => r.ok ? r.json() : [])
      .then(async (msgs: Array<{ role: string; content: string; investigation_id?: string | null; chart_data?: string | null }>) => {
        if (msgs.length === 0) return;

        // Find messages that have an investigation_id — these are RCA summaries
        const invIds = [...new Set(msgs.map((m) => m.investigation_id).filter(Boolean))] as string[];

        // Fetch reports for those investigations in parallel
        const reports = new Map<string, RcaReportSummary>();
        await Promise.all(invIds.map(async (id) => {
          try {
            const res = await fetch(`/api/investigations/${id}`);
            if (!res.ok) return;
            const data = await res.json();
            if (data.investigation?.report) {
              const rpt = JSON.parse(data.investigation.report);
              reports.set(id, rpt);
            }
          } catch { /* ignore */ }
        }));

        setChatMessages(msgs.map((m) => {
          const msg: ChatMessage = { role: m.role as ChatMessage["role"], content: m.content };
          if (m.investigation_id && reports.has(m.investigation_id)) {
            msg.investigationId = m.investigation_id;
            msg.report = reports.get(m.investigation_id);
          }
          if (m.chart_data) {
            try { msg.chartData = JSON.parse(m.chart_data); } catch { /* ignore */ }
          }
          return msg;
        }));
      })
      .catch(() => {});
  }, []);

  // Load deep investigation follow-up messages from DB when investigation changes
  useEffect(() => {
    setDeepMessages([]);
    setDeepLoading(false);
    setStreamingMessage(null);
    streamRef.current = { content: "", reasoning: "" };
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (!activeInvestigationId) return;
    fetch(`/api/messages?investigationId=${activeInvestigationId}`)
      .then((r) => r.ok ? r.json() : [])
      .then((msgs: Array<{ role: string; content: string }>) => {
        const followUps = msgs.filter((m) =>
          !m.content.startsWith("Starting investigation") && !m.content.startsWith("**Root Cause:**")
        );
        if (followUps.length > 0) {
          setDeepMessages(followUps.map((m) => ({ role: m.role as ChatMessage["role"], content: m.content })));
        }
      })
      .catch(() => {});
  }, [activeInvestigationId]);

  // Process WebSocket messages
  useEffect(() => {
    // Guard: if messages were trimmed/reset, ensure we don't miss the latest
    let start = processedCount.current;
    if (start > wsMessages.length) {
      start = Math.max(0, wsMessages.length - 1);
    }
    const newMessages = wsMessages.slice(start);
    processedCount.current = wsMessages.length;

    for (const msg of newMessages) {
      if (msg.type === "chat") {
        setChatMessages((prev) => [...prev, {
          role: msg.role,
          content: msg.content,
          investigationId: msg.investigationId,
          report: msg.report as RcaReportSummary | undefined,
          chartData: msg.chartData,
        }]);
        if (msg.role === "assistant") {
          setChatLoading(false);
          setActiveTool(null);
          setStreamingMessage(null);
        }
      }
      if (msg.type === "chat:stream_start") {
        streamRef.current = { content: "", reasoning: "" };
        setStreamingMessage({ content: "", reasoning: "", showReasoning: false });
        setChatLoading(false);
        setActiveTool(null);
      }
      if (msg.type === "chat:stream_delta") {
        if (msg.reasoning) {
          streamRef.current.reasoning += msg.content;
        } else {
          streamRef.current.content += msg.content;
        }
        // Batch re-renders via requestAnimationFrame
        if (rafRef.current === null) {
          rafRef.current = requestAnimationFrame(() => {
            rafRef.current = null;
            setStreamingMessage((prev) =>
              prev ? { ...prev, content: streamRef.current.content, reasoning: streamRef.current.reasoning } : null
            );
          });
        }
      }
      if (msg.type === "chat:stream_end") {
        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        const finalMsg: ChatMessage = {
          role: "assistant",
          content: msg.content,
          ...(msg.chartData ? { chartData: msg.chartData } : {}),
          ...(msg.skillsUsed ? { skillsUsed: msg.skillsUsed } : {}),
        };
        if (isDeepMode) {
          setDeepMessages((prev) => [...prev, finalMsg]);
        } else {
          setChatMessages((prev) => [...prev, finalMsg]);
        }
        setStreamingMessage(null);
        setChatLoading(false);
        setDeepLoading(false);
        setActiveTool(null);
      }
      if (msg.type === "chat:tool_call") {
        setActiveTool(msg.status === "calling" ? msg.tool : null);
      }
      if (msg.type === "investigation:started") {
        onInvestigationStarted(msg.id);
        setChatLoading(false);
        setActiveTool(null);
        setStreamingMessage(null);
      }
      if (msg.type === "session_cleared") {
        setChatMessages([]);
        setChatLoading(false);
        setActiveTool(null);
        setContextSwitch(null);
      }
      if (msg.type === "context_switch") {
        setContextSwitch({ previousService: msg.previousService, newService: msg.newService });
      }
    }
  }, [wsMessages, onInvestigationStarted, activeInvestigationId]);

  useEffect(() => {
    if (status === "disconnected" && streamingMessage) {
      const interrupted = streamRef.current.content || "(response interrupted)";
      if (isDeepMode) {
        setDeepMessages((prev) => [...prev, { role: "assistant", content: interrupted }]);
      } else {
        setChatMessages((prev) => [...prev, { role: "assistant", content: interrupted }]);
      }
      setStreamingMessage(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only reacts to status changes; streamingMessage and isDeepMode are checked but should not trigger re-runs
  }, [status]);

  // Scroll on new messages or loading state changes — NOT on every streaming delta
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [chatMessages, deepMessages, chatLoading]);

  // Scroll once when streaming starts (not on every token)
  const isStreaming = !!streamingMessage;
  useEffect(() => {
    if (isStreaming) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [isStreaming]);

  const handleSubmit = (text?: string) => {
    const trimmed = (text ?? input).trim();
    if (!trimmed) return;

    if (isDeepMode) {
      setDeepMessages((prev) => [...prev, { role: "user", content: trimmed }]);
      send({ type: "deep_investigate", investigationId: activeInvestigationId!, message: trimmed });
      setDeepLoading(true);
    } else {
      setChatMessages((prev) => [...prev, { role: "user", content: trimmed }]);
      send({ type: "chat", message: trimmed });
      setChatLoading(true);
      setActiveTool(null);
    }
    setInput("");
  };

  return (
    <div className="h-full flex flex-col bg-card/20">
      {/* Header — changes based on mode */}
      <div className={`px-4 py-2.5 border-b flex items-center justify-between transition-colors ${isDeepMode ? "border-accent/25 bg-accent/5" : "border-border/30"}`}>
        <div className="flex items-center gap-2">
          {isDeepMode ? (
            <>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent">
                <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><path d="M11 8v6"/><path d="M8 11h6"/>
              </svg>
              <span className="font-display text-[11px] font-semibold tracking-[0.12em] uppercase text-accent">
                Deep Investigation
              </span>
            </>
          ) : (
            <>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-muted-foreground/40">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
              <span className="font-display text-[11px] font-semibold tracking-[0.12em] uppercase text-muted-foreground/50">
                Console
              </span>
            </>
          )}
        </div>
        {!isDeepMode && chatMessages.length > 0 && (
          <button
            onClick={() => { send({ type: "new_session" }); }}
            className="flex items-center gap-1 px-2 py-1 text-[10px] font-mono rounded border border-border/30 text-muted-foreground/50 hover:text-foreground/70 hover:border-border/50 hover:bg-secondary/30 transition-colors"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 5v14M5 12h14"/>
            </svg>
            New chat
          </button>
        )}
      </div>

      {/* Deep mode banner */}
      {isDeepMode && (
        <div className="px-4 py-2 bg-accent/4 border-b border-accent/12 text-[10px] font-mono text-accent/60 flex items-center gap-2">
          <div className="w-1 h-1 rounded-full bg-accent/50" />
          Ask follow-up questions — has full MCP access for live queries
        </div>
      )}

      {/* Context switch banner */}
      {contextSwitch && !isDeepMode && (
        <div className="px-4 py-2 bg-accent/6 border-b border-accent/15 text-[11px] font-mono text-accent/70 flex items-center justify-between animate-fade-in">
          <span>
            New topic: <strong>{contextSwitch.newService}</strong> (was: {contextSwitch.previousService})
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { send({ type: "new_session" }); setContextSwitch(null); }}
              className="px-2 py-0.5 rounded border border-accent/25 text-accent/80 hover:bg-accent/10 transition-colors"
            >
              Start fresh
            </button>
            <button
              onClick={() => setContextSwitch(null)}
              className="px-2 py-0.5 rounded border border-border/25 text-muted-foreground/50 hover:bg-secondary/30 transition-colors"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4" ref={scrollRef}>
        <div className="space-y-3">
          {messages.length === 0 && !isDeepMode && !chatLoading && (
            <div className="h-full min-h-[200px] flex flex-col items-center justify-center text-center animate-fade-in">
              <div className="w-11 h-11 rounded-xl bg-primary/8 border border-primary/15 flex items-center justify-center mb-3">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-primary/50">
                  <circle cx="11" cy="11" r="8"/>
                  <path d="m21 21-4.3-4.3"/>
                </svg>
              </div>
              <p className="text-sm text-muted-foreground/50 font-body">
                Ask a question or start an investigation
              </p>
              <p className="text-[11px] text-muted-foreground/30 mt-1.5 font-mono">
                try &quot;investigate ingestion-server&quot;
              </p>
            </div>
          )}
          {messages.length === 0 && isDeepMode && (
            <p className="text-sm text-muted-foreground/50 font-body text-center mb-2 animate-fade-in">
              Drill deeper into the investigation results
            </p>
          )}
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`animate-fade-up flex ${
                msg.role === "user" ? "justify-end" :
                msg.role === "system" ? "justify-center" :
                "justify-start"
              }`}
              style={{ animationDelay: `${Math.min(i * 0.02, 0.1)}s` }}
            >
              {msg.role === "user" ? (
                <div className={`max-w-[85%] px-3.5 py-2 rounded-xl rounded-br-sm text-sm font-body whitespace-pre-wrap ${isDeepMode ? "bg-accent/12 border border-accent/20 text-foreground/85" : "bg-primary/12 border border-primary/20 text-foreground/85"}`}>
                  {msg.content}
                </div>
              ) : msg.role === "system" ? (
                <div className="max-w-[90%] px-3 py-1.5 text-[11px] font-mono text-muted-foreground/40 text-center">
                  {msg.content}
                </div>
              ) : msg.report && msg.investigationId ? (
                <button
                  onClick={() => onViewInvestigation(msg.investigationId!)}
                  className="max-w-[92%] w-full text-left group"
                >
                  <div className={`rounded-xl border bg-card/50 overflow-hidden transition-all group-hover:border-primary/40 group-hover:shadow-md ${
                    msg.report.severity === "critical" ? "border-destructive/30 glow-red" :
                    msg.report.severity === "high" ? "border-accent/25 glow-amber" :
                    "border-primary/20 glow-cyan"
                  }`}>
                    <div className="px-3.5 py-2.5 border-b border-border/20">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[10px] font-display font-bold uppercase tracking-[0.08em] text-foreground/60">
                          Root Cause Analysis
                        </span>
                        <div className="flex items-center gap-1.5">
                          <Badge variant={msg.report.severity === "critical" ? "destructive" : "secondary"} className="text-[8px] uppercase tracking-wider">
                            {msg.report.severity}
                          </Badge>
                          <span className="text-[8px] font-mono text-muted-foreground/50">{msg.report.confidence}{msg.report.confidenceScore != null ? ` (${msg.report.confidenceScore.toFixed(2)})` : ""}</span>
                        </div>
                      </div>
                      {msg.report.summary && (
                        <p className="text-xs font-body text-foreground/70 leading-relaxed line-clamp-2">
                          {renderInline(msg.report.summary)}
                        </p>
                      )}
                    </div>
                    <div className="px-3.5 py-2 space-y-1.5">
                      <div>
                        <span className="text-[9px] font-display font-semibold uppercase tracking-wider text-primary/70">Root Cause</span>
                        <p className="text-[11px] font-body text-foreground/75 leading-relaxed line-clamp-2">{renderInline(msg.report.rootCause)}</p>
                      </div>
                      <div>
                        <span className="text-[9px] font-display font-semibold uppercase tracking-wider text-accent/70">Trigger</span>
                        <p className="text-[11px] font-body text-foreground/65 leading-relaxed line-clamp-1">{renderInline(msg.report.trigger)}</p>
                      </div>
                    </div>
                    <div className="px-3.5 py-1.5 bg-secondary/20 border-t border-border/15 flex items-center justify-between">
                      <span className="text-[9px] font-mono text-primary/50 group-hover:text-primary/80 transition-colors">
                        View full investigation →
                      </span>
                    </div>
                  </div>
                </button>
              ) : (
                <div className="max-w-[85%] space-y-2">
                  {msg.skillsUsed && msg.skillsUsed.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-1">
                      {msg.skillsUsed.map((s, si) => (
                        <span key={si} className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-mono rounded bg-primary/8 text-primary/60 border border-primary/12">
                          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>
                          </svg>
                          {s}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="px-3.5 py-2.5 rounded-xl rounded-bl-sm bg-secondary/50 border border-border/40 text-sm font-body">
                    {renderMarkdown(msg.content)}
                  </div>
                  {msg.chartData && msg.chartData.length > 0 && (
                    <div className="space-y-2">
                      {msg.chartData.map((c, ci) => (
                        <MetricChart key={ci} series={toTimeSeries(c)} />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          {streamingMessage && (
            <div className="flex justify-start animate-fade-in">
              <div className="max-w-[85%] space-y-2">
                {/* Reasoning indicator */}
                {streamingMessage.reasoning && (
                  <div>
                    <button
                      onClick={() => setStreamingMessage((prev) => prev ? { ...prev, showReasoning: !prev.showReasoning } : null)}
                      className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground/60 hover:text-muted-foreground/80 transition-colors mb-1"
                    >
                      <svg
                        width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                        className={`transition-transform ${streamingMessage.showReasoning ? "rotate-90" : ""}`}
                      >
                        <path d="M9 18l6-6-6-6"/>
                      </svg>
                      {streamingMessage.content ? "Thought" : "Thinking..."}
                    </button>
                    {streamingMessage.showReasoning && (
                      <div className="px-3 py-2 rounded-lg bg-secondary/25 border border-border/20 text-[11px] font-mono text-muted-foreground/60 leading-relaxed max-h-[200px] overflow-y-auto whitespace-pre-wrap">
                        {streamingMessage.reasoning}
                      </div>
                    )}
                  </div>
                )}
                {/* Content — only show if we have content */}
                {streamingMessage.content ? (
                  <div className="px-3.5 py-2.5 rounded-xl rounded-bl-sm bg-secondary/50 border border-border/40 text-sm font-body">
                    {renderMarkdown(streamingMessage.content)}
                  </div>
                ) : streamingMessage.reasoning ? (
                  /* Still in reasoning phase — show pulsing indicator */
                  <div className="px-3.5 py-2 rounded-xl rounded-bl-sm bg-secondary/50 border border-border/40">
                    <div className="flex items-center gap-1.5">
                      <div className={`w-1.5 h-1.5 rounded-full animate-status-pulse ${isDeepMode ? "bg-accent" : "bg-primary"}`} />
                      <span className="text-[11px] font-mono text-muted-foreground/70">thinking...</span>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          )}
          {isLoading && !streamingMessage && (
            <div className="flex justify-start animate-fade-in">
              <div className="px-3.5 py-2 rounded-xl rounded-bl-sm bg-secondary/50 border border-border/40">
                <div className="flex items-center gap-1.5">
                  <div className={`w-1.5 h-1.5 rounded-full animate-status-pulse ${isDeepMode ? "bg-accent" : "bg-primary"}`} />
                  <span className="text-[11px] font-mono text-muted-foreground/50">
                    {activeTool
                      ? `querying ${activeTool.replace(/_/g, " ")}...`
                      : isDeepMode ? "investigating..." : "thinking..."}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Deep mode shortcut chips — always visible */}
      {isDeepMode && (
        <div className="px-3 pt-2 flex flex-wrap gap-1.5">
          {DEEP_DIVE_PROMPTS.map((prompt, i) => (
            <button
              key={prompt}
              style={{ animationDelay: `${i * 0.03}s` }}
              onClick={() => handleSubmit(prompt)}
              disabled={deepLoading || status !== "connected"}
              className="px-2.5 py-1 text-[10px] font-mono rounded-full border border-accent/25 text-accent/70 hover:bg-accent/10 hover:border-accent/40 transition-colors disabled:opacity-30 disabled:cursor-not-allowed animate-fade-in"
            >
              {prompt}
            </button>
          ))}
        </div>
      )}

      {/* Input */}
      <div className={`p-3 border-t transition-colors ${isDeepMode ? "border-accent/15" : "border-border/30"}`}>
        <form onSubmit={(e) => { e.preventDefault(); handleSubmit(); }} className="relative">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className={`w-full px-4 py-2.5 pr-10 rounded-lg border text-sm font-body text-foreground/85 placeholder:text-muted-foreground/30 focus:outline-none transition-all disabled:opacity-25 ${isDeepMode ? "bg-accent/4 border-accent/20 focus:border-accent/40" : "bg-secondary/30 border-border/40 focus:border-primary/35"}`}
            placeholder={
              status !== "connected" ? "Reconnecting..." :
              isDeepMode ? "Ask a follow-up about this investigation..." :
              "Type a message..."
            }
            disabled={status !== "connected" || isLoading}
          />
          <button
            type="submit"
            disabled={status !== "connected" || !input.trim() || isLoading}
            className={`absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-md transition-all disabled:opacity-15 ${isDeepMode ? "text-accent/40 hover:text-accent hover:bg-accent/10" : "text-muted-foreground/30 hover:text-primary hover:bg-primary/8"}`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2Z"/>
            </svg>
          </button>
        </form>
      </div>
    </div>
  );
}
