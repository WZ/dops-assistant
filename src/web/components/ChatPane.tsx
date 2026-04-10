import { useState, useRef, useEffect, useCallback } from "react";
import { useAutoScroll } from "../hooks/useAutoScroll.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Search, SearchCode, MessageSquare, Plus, FileText, ChevronRight, Send, Trash2, Loader2 } from "lucide-react";
import { renderInline } from "../lib/renderInline";
import { renderMarkdown } from "../lib/renderMarkdown";
import { formatTokens } from "../lib/formatTokens.js";
import { MetricChart, type TimeSeriesData } from "./MetricChart";
import { useStackContext } from "../contexts/StackContext";
import { safeGetItem, safeSetItem } from "../lib/utils";
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
  id?: string;
  createdAt?: string;
  role: "user" | "assistant" | "system";
  content: string;
  investigationId?: string;
  report?: RcaReportSummary;
  chartData?: ChartSeries[];
  skillsUsed?: string[];
  tokenUsage?: { inputTokens: number; outputTokens: number; durationMs: number };
}

interface ChatPaneProps {
  ws: ReturnType<typeof useWebSocket>;
  onInvestigationStarted: (id: string) => void;
  onViewInvestigation: (id: string) => void;
  activeInvestigationId?: string;
  serviceContext?: string;
}

const DEEP_DIVE_PROMPTS = [
  "Why did this happen?",
  "Show me the raw log samples",
  "What other services were affected?",
  "What should we check first?",
];

const LAST_VISITED_KEY = "consoleFeed:lastVisitedAt";

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

/** Format a UTC ISO timestamp to local time string like "2:14 PM" */
function formatTime(isoStr: string): string {
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Get a local date string for grouping (YYYY-MM-DD in local tz) */
function localDateKey(isoStr: string): string {
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Get day group label: "Today", "Yesterday", or "Mar 22" */
function dayLabel(isoStr: string): string {
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const todayKey = localDateKey(now.toISOString());
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = localDateKey(yesterday.toISOString());
  const msgKey = localDateKey(isoStr);

  if (msgKey === todayKey) return "Today";
  if (msgKey === yesterdayKey) return "Yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function DaySeparator({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 py-2">
      <div className="flex-1 h-px bg-border/30" />
      <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground/50">
        {label}
      </span>
      <div className="flex-1 h-px bg-border/30" />
    </div>
  );
}

function UnreadMarker() {
  return (
    <div className="flex items-center gap-3 py-2">
      <div className="flex-1 h-px bg-destructive/40" />
      <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-destructive/70 font-semibold">
        NEW
      </span>
      <div className="flex-1 h-px bg-destructive/40" />
    </div>
  );
}

export function ChatPane({ ws, onInvestigationStarted, onViewInvestigation, activeInvestigationId, serviceContext }: ChatPaneProps) {
  const { stackFetch, activeStackId } = useStackContext();
  const { status, messages: wsMessages, send } = ws;
  const [input, setInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [deepMessages, setDeepMessages] = useState<ChatMessage[]>([]);
  const [deepLoading, setDeepLoading] = useState(false);
  const [chatLoading, setChatLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [contextSwitch, setContextSwitch] = useState<{ previousService: string; newService: string } | null>(null);
  const [sessionTokens, setSessionTokens] = useState({ inputTokens: 0, outputTokens: 0, messageCount: 0 });
  const [streamingMessage, setStreamingMessage] = useState<{
    content: string;
    reasoning: string;
    showReasoning: boolean;
  } | null>(null);

  // Ref-based accumulator for high-frequency delta batching
  const streamRef = useRef<{ content: string; reasoning: string }>({ content: "", reasoning: "" });
  const rafRef = useRef<number | null>(null);

  const scrollRef = useAutoScroll([chatMessages, deepMessages, chatLoading, deepLoading, !!streamingMessage]);
  const processedCount = useRef(0);
  const historyLoaded = useRef(false);
  const initialScrollDone = useRef(false);

  // Last visited timestamp for unread marker
  const lastVisitedAt = useRef<string | null>(null);

  const isDeepMode = !!activeInvestigationId;
  const messages = isDeepMode ? deepMessages : chatMessages;
  const isLoading = isDeepMode ? deepLoading : chatLoading;

  // Load lastVisitedAt from localStorage on mount
  useEffect(() => {
    lastVisitedAt.current = safeGetItem(LAST_VISITED_KEY);
    // Update on window focus
    const onFocus = () => {
      const now = new Date().toISOString();
      safeSetItem(LAST_VISITED_KEY, now);
      lastVisitedAt.current = now;
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // Reset chat history when stack changes
  useEffect(() => {
    historyLoaded.current = false;
    setChatMessages([]);
    setDeepMessages([]);
    processedCount.current = 0;
    initialScrollDone.current = false;
  }, [activeStackId]);

  // Load historical messages on mount or stack switch
  useEffect(() => {
    if (historyLoaded.current) return;
    historyLoaded.current = true;
    setHistoryLoading(true);
    stackFetch("/api/messages?limit=50")
      .then((r) => r.ok ? r.json() : [])
      .then(async (msgs: Array<{ id: string; role: string; content: string; investigation_id?: string | null; chart_data?: string | null; created_at?: string }>) => {
        if (msgs.length === 0) {
          setHistoryLoading(false);
          return;
        }

        // Enrich messages that have investigation_id with their RCA reports (for RCA cards)
        const invIds = [...new Set(msgs.map((m) => m.investigation_id).filter(Boolean))] as string[];
        const reports = new Map<string, RcaReportSummary>();
        await Promise.all(invIds.map(async (id) => {
          try {
            const res = await stackFetch(`/api/investigations/${id}`);
            if (!res.ok) return;
            const data = await res.json();
            if (data.investigation?.report) {
              const rpt = JSON.parse(data.investigation.report);
              reports.set(id, rpt);
            }
          } catch { /* ignore */ }
        }));

        setChatMessages(msgs.map((m) => {
          const msg: ChatMessage = {
            id: m.id,
            createdAt: m.created_at,
            role: m.role as ChatMessage["role"],
            content: m.content,
          };
          if (m.investigation_id && reports.has(m.investigation_id)) {
            msg.investigationId = m.investigation_id;
            msg.report = reports.get(m.investigation_id);
          }
          if (m.chart_data) {
            try { msg.chartData = JSON.parse(m.chart_data); } catch { /* ignore */ }
          }
          return msg;
        }));
        setHistoryLoading(false);
      })
      .catch(() => { setHistoryLoading(false); });
  }, [stackFetch]);

  // Force scroll to bottom after initial history load
  useEffect(() => {
    if (!historyLoading && !initialScrollDone.current && chatMessages.length > 0) {
      initialScrollDone.current = true;
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight });
        }
      });
    }
  }, [historyLoading, chatMessages.length, scrollRef]);

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
    stackFetch(`/api/messages?investigationId=${activeInvestigationId}`)
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
        // Skip investigation follow-up Q&A (has investigationId but no report).
        // KEEP investigation completion summaries (has investigationId AND report) — these render as RCA cards.
        if (msg.investigationId && !msg.report) continue;
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
        // Skip investigation messages ONLY when NOT in deep investigation mode
        // When in deep mode, investigation messages should be added to deepMessages
        if (msg.investigationId && !isDeepMode) {
          // Clean up streaming state but don't add to chatMessages
          if (rafRef.current !== null) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
          }
          setStreamingMessage(null);
          setChatLoading(false);
          setDeepLoading(false);
          setActiveTool(null);
          continue;
        }
        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        const finalMsg: ChatMessage = {
          role: "assistant",
          content: msg.content,
          ...(msg.id ? { id: msg.id } : {}),
          ...(msg.createdAt ? { createdAt: msg.createdAt } : {}),
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
      if (msg.type === "chat:usage") {
        const usage = { inputTokens: msg.inputTokens, outputTokens: msg.outputTokens, durationMs: msg.durationMs };

        const updateMessages = (prev: ChatMessage[]) => {
          if (prev.length === 0) return prev;
          const last = prev[prev.length - 1]!;
          if (last.role !== "assistant") return prev;
          return [...prev.slice(0, -1), { ...last, tokenUsage: usage }];
        };

        if (isDeepMode) {
          setDeepMessages(updateMessages);
        } else {
          setChatMessages(updateMessages);
        }

        setSessionTokens((prev) => ({
          inputTokens: prev.inputTokens + msg.inputTokens,
          outputTokens: prev.outputTokens + msg.outputTokens,
          messageCount: prev.messageCount + 1,
        }));
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
        setSessionTokens({ inputTokens: 0, outputTokens: 0, messageCount: 0 });
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

  // Auto-scroll is handled by useAutoScroll hook on scrollRef

  const handleSubmit = (text?: string) => {
    const trimmed = (text ?? input).trim();
    if (!trimmed) return;

    if (isDeepMode) {
      setDeepMessages((prev) => [...prev, { role: "user", content: trimmed }]);
      send({ type: "deep_investigate", investigationId: activeInvestigationId!, message: trimmed });
      setDeepLoading(true);
    } else {
      setChatMessages((prev) => [...prev, { role: "user", content: trimmed }]);
      send({ type: "chat", message: trimmed, ...(serviceContext ? { serviceContext } : {}) });
      setChatLoading(true);
      setActiveTool(null);
    }
    setInput("");
  };

  const handleDeleteMessage = useCallback(async (msgId: string) => {
    try {
      const res = await stackFetch(`/api/messages/${msgId}`, { method: "DELETE" });
      if (res.ok) {
        setChatMessages((prev) => prev.filter((m) => m.id !== msgId));
      }
    } catch { /* ignore */ }
  }, [stackFetch]);


  // Compute unread marker index (insert before first message newer than lastVisitedAt)
  const unreadMarkerIndex = (() => {
    if (!lastVisitedAt.current || isDeepMode) return -1;
    for (let i = 0; i < chatMessages.length; i++) {
      const msg = chatMessages[i]!;
      if (msg.createdAt && msg.createdAt > lastVisitedAt.current) {
        return i;
      }
    }
    return -1;
  })();

  // Build rendered message elements with day separators and unread marker
  const renderMessages = () => {
    const elements: React.ReactNode[] = [];
    let lastDateKey = "";
    let unreadInserted = false;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;

      // Unread marker (only in console mode, before day separator)
      if (!isDeepMode && !unreadInserted && unreadMarkerIndex >= 0 && i === unreadMarkerIndex) {
        elements.push(<UnreadMarker key="unread-marker" />);
        unreadInserted = true;
      }

      // Day separator
      if (msg.createdAt) {
        const dateKey = localDateKey(msg.createdAt);
        if (dateKey && dateKey !== lastDateKey) {
          lastDateKey = dateKey;
          elements.push(<DaySeparator key={`day-${dateKey}`} label={dayLabel(msg.createdAt)} />);
        }
      }

      elements.push(
        <div
          key={msg.id || i}
          className={`animate-fade-up group/msg flex ${
            msg.role === "user" ? "justify-end" :
            msg.role === "system" ? "justify-center" :
            "justify-start"
          }`}
          style={{ animationDelay: `${Math.min(i * 0.02, 0.1)}s` }}
        >
          {msg.role === "user" ? (
            <div className="max-w-[85%] flex flex-col items-end gap-0.5">
              <div className="flex items-center gap-1.5">
                {msg.id && (
                  <button
                    onClick={() => handleDeleteMessage(msg.id!)}
                    className="opacity-0 group-hover/msg:opacity-100 transition-opacity p-1 rounded text-muted-foreground hover:text-destructive"
                    aria-label="Delete message"
                  >
                    <Trash2 size={12} className="!size-auto" />
                  </button>
                )}
                <div className={`px-3.5 py-2 rounded-xl rounded-br-sm text-sm font-body whitespace-pre-wrap ${isDeepMode ? "bg-accent/12 border border-accent/20 text-foreground/85" : "bg-primary/12 border border-primary/20 text-foreground/85"}`}>
                  {msg.content}
                </div>
              </div>
              {msg.createdAt && (
                <span className="font-mono text-[10px] text-muted-foreground/50 mr-1">
                  {formatTime(msg.createdAt)}
                </span>
              )}
            </div>
          ) : msg.role === "system" ? (
            <div className="max-w-[90%] px-3 py-1.5 text-[11px] font-mono text-muted-foreground/70 text-center">
              {msg.content}
            </div>
          ) : msg.report && msg.investigationId ? (
            <div className="max-w-[92%] w-full flex flex-col gap-0.5">
              <button
                onClick={() => onViewInvestigation(msg.investigationId!)}
                className="w-full text-left group"
              >
                <div className={`rca-reveal rca-reveal-glow rounded-xl border bg-card/50 overflow-hidden transition-all group-hover:border-primary/40 group-hover:shadow-md ${
                  msg.report.severity === "critical" ? "border-destructive/30 glow-red rca-reveal-glow-red" :
                  msg.report.severity === "high" ? "border-accent/25 glow-coral rca-reveal-glow-coral" :
                  "border-primary/20 glow-teal rca-reveal-glow-teal"
                }`}>
                  {/* Severity classification stripe */}
                  <div className={`h-[2px] rca-stripe ${
                    msg.report.severity === "critical" ? "bg-destructive" :
                    msg.report.severity === "high" ? "bg-accent" :
                    "bg-primary/60"
                  }`} />
                  <div className="px-3.5 py-2.5 border-b border-border/20 rca-section-1">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[11px] font-mono font-semibold uppercase tracking-[0.1em] text-foreground/85">
                        Root Cause Analysis
                      </span>
                      <div className="flex items-center gap-1.5">
                        <Badge variant={msg.report.severity === "critical" ? "destructive" : "secondary"} className="text-[8px] uppercase tracking-[0.1em]">
                          {msg.report.severity}
                        </Badge>
                        <span className="text-[8px] font-mono text-muted-foreground/70">{msg.report.confidence}{msg.report.confidenceScore != null ? ` (${msg.report.confidenceScore.toFixed(2)})` : ""}</span>
                      </div>
                    </div>
                    {msg.report.summary && (
                      <p className="text-[12px] font-body text-foreground/85 leading-relaxed line-clamp-2">
                        {renderInline(msg.report.summary)}
                      </p>
                    )}
                  </div>
                  <div className="px-3.5 py-2 space-y-1.5">
                    <div className="rca-section-2">
                      <span className="text-[9px] font-mono font-semibold uppercase tracking-[0.1em] text-primary/90">Root Cause</span>
                      <p className="text-[12px] font-body text-foreground/90 leading-relaxed line-clamp-2">{renderInline(msg.report.rootCause)}</p>
                    </div>
                    <div className="rca-section-3">
                      <span className="text-[9px] font-mono font-semibold uppercase tracking-[0.1em] text-accent/90">Trigger</span>
                      <p className="text-[12px] font-body text-foreground/85 leading-relaxed line-clamp-1">{renderInline(msg.report.trigger)}</p>
                    </div>
                  </div>
                  <div className="px-3.5 py-1.5 bg-secondary/20 border-t border-border/15 flex items-center justify-between rca-section-4">
                    <span className="text-[9px] font-mono text-primary/70 group-hover:text-primary/90 transition-colors">
                      View full investigation →
                    </span>
                  </div>
                </div>
              </button>
              {msg.createdAt && (
                <span className="font-mono text-[10px] text-muted-foreground/50 ml-1">
                  {formatTime(msg.createdAt)}
                </span>
              )}
            </div>
          ) : (
            <div className="max-w-[85%] space-y-2">
              {msg.skillsUsed && msg.skillsUsed.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-1">
                  {msg.skillsUsed.map((s, si) => (
                    <span key={si} className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-mono rounded bg-primary/8 text-primary/60 border border-primary/12">
                      <FileText size={8} className="!size-auto" />
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
              {msg.tokenUsage && (
                <div className="text-[10px] font-mono text-muted-foreground/70 mt-1">
                  {formatTokens(msg.tokenUsage.inputTokens + msg.tokenUsage.outputTokens)} tokens · {(msg.tokenUsage.durationMs / 1000).toFixed(1)}s
                </div>
              )}
              {msg.createdAt && (
                <span className="font-mono text-[10px] text-muted-foreground/50">
                  {formatTime(msg.createdAt)}
                </span>
              )}
            </div>
          )}
        </div>
      );
    }

    return elements;
  };

  return (
    <div className="h-full flex flex-col bg-card/20">
      {/* Header -- changes based on mode */}
      <div className={`px-4 py-2.5 border-b flex items-center justify-between transition-colors ${isDeepMode ? "border-accent/25 bg-accent/5" : "border-border/30"}`}>
        <div className="flex items-center gap-2">
          {isDeepMode ? (
            <>
              <SearchCode size={13} className="!size-auto text-accent" />
              <span className="font-mono text-[11px] font-semibold tracking-[0.12em] uppercase text-accent">
                Deep Investigation
              </span>
            </>
          ) : (
            <>
              <MessageSquare size={13} strokeWidth={1.5} className="!size-auto text-primary/50" />
              <span className="font-mono text-[11px] font-semibold tracking-[0.12em] uppercase text-primary/40">
                Console
              </span>
              {serviceContext && (
                <span className="text-[10px] font-mono uppercase tracking-[0.12em] px-2 py-0.5 rounded bg-primary/10 text-primary border border-primary/20">
                  {serviceContext}
                </span>
              )}
            </>
          )}
        </div>
        {!isDeepMode && chatMessages.length > 0 && (
          <Button
              variant="ghost"
              disabled={isLoading || !!streamingMessage}
              onClick={() => { send({ type: "new_session" }); }}
              className={`h-9 px-4 text-[12px] font-mono rounded-lg border border-border/50 text-muted-foreground hover:text-foreground/70 hover:bg-secondary/30 transition-colors${isLoading || !!streamingMessage ? " opacity-40 pointer-events-none" : ""}`}
            >
              <Plus size={13} className="!size-auto" />
              New chat
            </Button>
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
            <Button
              variant="outline"
              disabled={isLoading || !!streamingMessage}
              onClick={() => { send({ type: "new_session" }); setContextSwitch(null); }}
              className={`h-auto px-2 py-0.5 rounded border-accent/25 text-accent/80 hover:bg-accent/10${isLoading || !!streamingMessage ? " opacity-40 pointer-events-none" : ""}`}
            >
              Start fresh
            </Button>
            <Button
              variant="outline"
              onClick={() => setContextSwitch(null)}
              className="h-auto px-2 py-0.5 rounded border-border/25 text-muted-foreground/50 hover:bg-secondary/30"
            >
              Dismiss
            </Button>
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4" ref={scrollRef}>
        <div className="space-y-3">
          {/* Loading state for initial history fetch */}
          {historyLoading && !isDeepMode && (
            <div className="h-full min-h-[200px] flex flex-col items-center justify-center text-center animate-fade-in">
              <Loader2 size={20} className="!size-auto text-muted-foreground/40 animate-spin mb-2" />
              <p className="text-[11px] font-mono text-muted-foreground/40">Loading messages...</p>
            </div>
          )}
          {/* Empty state */}
          {!historyLoading && messages.length === 0 && !isDeepMode && !chatLoading && (
            <div className="h-full min-h-[200px] flex flex-col items-center justify-center text-center animate-fade-in">
              <div className="w-11 h-11 rounded-xl bg-primary/8 border border-primary/15 flex items-center justify-center mb-3">
                <Search size={18} strokeWidth={1.5} className="!size-auto text-primary/50" />
              </div>
              <p className="text-sm text-muted-foreground/60 font-body">
                Your investigation console
              </p>
              <p className="text-[11px] text-muted-foreground/40 mt-1 font-body">
                Ask about services, check health, or start an investigation
              </p>
              <div className="flex flex-wrap justify-center gap-1.5 mt-4">
                {["What services are unhealthy?", "Investigate the noisiest service", "Show recent incidents"].map((prompt, i) => (
                  <button
                    key={prompt}
                    onClick={() => handleSubmit(prompt)}
                    disabled={status !== "connected"}
                    className="px-2.5 py-1 text-[10px] font-mono rounded-full border border-primary/20 text-primary/60 hover:bg-primary/8 hover:border-primary/30 hover:text-primary/80 transition-colors disabled:opacity-30 animate-fade-up"
                    style={{ animationDelay: `${i * 0.06}s` }}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.length === 0 && isDeepMode && (
            <p className="text-sm text-muted-foreground/50 font-body text-center mb-2 animate-fade-in">
              Drill deeper into the investigation results
            </p>
          )}
          {!historyLoading && renderMessages()}
          {streamingMessage && (
            <div className="flex justify-start animate-fade-in">
              <div className="max-w-[85%] space-y-2">
                {/* Reasoning indicator */}
                {streamingMessage.reasoning && (
                  <div>
                    <Button
                      variant="ghost"
                      onClick={() => setStreamingMessage((prev) => prev ? { ...prev, showReasoning: !prev.showReasoning } : null)}
                      className="h-auto p-0 text-[10px] font-mono text-muted-foreground/60 hover:text-muted-foreground/80 hover:bg-transparent mb-1"
                    >
                      <ChevronRight
                        size={8}
                        className={`!size-auto transition-transform ${streamingMessage.showReasoning ? "rotate-90" : ""}`}
                      />
                      {streamingMessage.content ? "Thought" : "Thinking..."}
                    </Button>
                    {streamingMessage.showReasoning && (
                      <div className="px-3 py-2 rounded-lg bg-secondary/25 border border-border/20 text-[11px] font-mono text-muted-foreground/60 leading-relaxed max-h-[200px] overflow-y-auto whitespace-pre-wrap">
                        {streamingMessage.reasoning}
                      </div>
                    )}
                  </div>
                )}
                {/* Content -- only show if we have content */}
                {streamingMessage.content ? (
                  <div className="px-3.5 py-2.5 rounded-xl rounded-bl-sm bg-secondary/50 border border-border/40 text-sm font-body">
                    {renderMarkdown(streamingMessage.content)}
                  </div>
                ) : streamingMessage.reasoning ? (
                  /* Still in reasoning phase -- show pulsing indicator */
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
        {/* Spacer so auto-scroll clears the shortcut chips overlay */}
        {isDeepMode && <div className="h-12" />}
      </div>

      {/* Deep mode shortcut chips -- always visible */}
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

      {/* Session token usage footer */}
      {sessionTokens.messageCount > 0 && (
        <div className="flex items-center gap-2 px-4 py-1.5 text-[10px] font-mono text-muted-foreground/70 border-t border-border/20 bg-background/80">
          <span>This session:</span>
          <span>{formatTokens(sessionTokens.inputTokens + sessionTokens.outputTokens)} tokens</span>
          <span>·</span>
          <span>{sessionTokens.messageCount} messages</span>
        </div>
      )}

      {/* Input */}
      <div className={`p-3 border-t transition-colors ${isDeepMode ? "border-accent/15" : "border-border/30"}`}>
        <form onSubmit={(e) => { e.preventDefault(); handleSubmit(); }} className="relative">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className={`w-full px-4 py-2.5 pr-10 rounded-lg border text-sm font-body text-foreground/85 placeholder:text-muted-foreground/60 focus:outline-none transition-all disabled:opacity-25 ${isDeepMode ? "bg-accent/4 border-accent/20 focus:border-accent/40" : "bg-secondary/30 border-border/40 focus:border-primary/35"}`}
            placeholder={
              status !== "connected" ? "Reconnecting..." :
              isDeepMode ? "Ask a follow-up about this investigation..." :
              "Type a message..."
            }
            disabled={status !== "connected" || isLoading}
          />
          <Button
            variant="ghost"
            size="icon"
            type="submit"
            aria-label="Send message"
            disabled={status !== "connected" || !input.trim() || isLoading}
            className={`absolute right-2 top-1/2 -translate-y-1/2 h-auto w-auto p-1.5 rounded-md disabled:opacity-15 ${isDeepMode ? "text-accent/40 hover:text-accent hover:bg-accent/10" : "text-muted-foreground/60 hover:text-primary hover:bg-primary/8"}`}
          >
            <Send size={14} className="!size-auto" />
          </Button>
        </form>
      </div>
    </div>
  );
}
