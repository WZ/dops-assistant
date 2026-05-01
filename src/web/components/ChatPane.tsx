import { useState, useRef, useEffect, useCallback } from "react";
import { useAutoScroll } from "../hooks/useAutoScroll.js";
import { useUnreadInvestigations } from "../hooks/useUnreadInvestigations.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Search, SearchCode, MessageSquare, Plus, FileText, ChevronRight, Send, Trash2, X, ArrowRight, Zap } from "lucide-react";
import { renderInline } from "../lib/renderInline";
import { renderMarkdown } from "../lib/renderMarkdown";
import { formatTokens } from "../lib/formatTokens.js";
import { formatTimestamp } from "../lib/formatTimestamp";
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
  // Server-resolved service for chat-agent replies. When present, the reply
  // renders the "Run full investigation on <service>" pill button.
  serviceContext?: string;
}

interface PendingConfirmDispatch {
  id: string;
  service: string;
  query: string;
  startedAt: number; // ms epoch
  expiresAt: number; // ms epoch
}

const MIGRATION_TOAST_KEY = "consoleFeed:migrationToastSeen";

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

/** Chat-message timestamp — local style via the shared formatter. */
function formatTime(isoStr: string): string {
  return formatTimestamp(isoStr, "local");
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
  const { isUnread, markViewed } = useUnreadInvestigations();
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

  // Pre-dispatch confirmation banner state. Cleared on `investigation:started`
  // (timer fired and runner kicked off), `investigation:dispatch_cancelled`
  // (user clicked Cancel), or when the user explicitly cancels.
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirmDispatch | null>(null);
  const dispatchPendingRef = useRef(false);
  const [dispatchPending, setDispatchPending] = useState(false);
  // Render-time tick: updates every 100ms while a confirm is pending so the
  // countdown text + progress bar advance smoothly. Stored as a number to
  // force re-renders without churning the pendingConfirm reference.
  const [confirmTick, setConfirmTick] = useState(0);

  // First-load migration toast — fires once per browser to teach the new
  // chat-default + /investigate UX. Suppressed via localStorage flag.
  const [showMigrationToast, setShowMigrationToast] = useState(false);

  // Slash-command autocomplete popover. Visible while the input starts with
  // "/" and the user hasn't yet typed enough to disambiguate. `slashIndex`
  // tracks the highlighted row so Enter / Tab autocomplete the selection
  // instead of submitting the form with the partial slash.
  const [showSlashPopover, setShowSlashPopover] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const SLASH_COMMANDS: Array<{ command: string; placeholder: string; hint: string }> = [
    { command: "/investigate", placeholder: "<service>", hint: "Run full RCA" },
    { command: "/rca", placeholder: "<incident>", hint: "Same as above" },
  ];
  const acceptSlashCommand = (index: number) => {
    const choice = SLASH_COMMANDS[index];
    if (!choice) return;
    setInput(`${choice.command} `);
    setShowSlashPopover(false);
    setSlashIndex(0);
  };

  // Ref-based accumulator for high-frequency delta batching
  const streamRef = useRef<{ content: string; reasoning: string }>({ content: "", reasoning: "" });
  const rafRef = useRef<number | null>(null);

  // Track streaming content length so auto-scroll re-fires as the assistant's
  // bubble grows during streaming. Watching just `!!streamingMessage` (a
  // boolean) only fires once at start; the bubble can then grow past the
  // viewport without follow-up scroll updates.
  const streamingContentLen = streamingMessage?.content.length ?? 0;
  const streamingReasoningLen = streamingMessage?.reasoning.length ?? 0;
  const scrollRef = useAutoScroll([
    chatMessages,
    deepMessages,
    chatLoading,
    deepLoading,
    !!streamingMessage,
    streamingContentLen,
    streamingReasoningLen,
    // The DISPATCHING confirmation banner is a chat-stream sibling — when it
    // appears we want the same scroll-to-bottom behavior as a new message,
    // so the [Cancel] pill is reachable without scrolling.
    pendingConfirm?.id,
  ]);
  const processedCount = useRef(0);
  const historyLoaded = useRef(false);
  const initialScrollDone = useRef(false);

  // Last visited timestamp for unread marker
  const lastVisitedAt = useRef<string | null>(null);

  const isDeepMode = !!activeInvestigationId;
  const messages = isDeepMode ? deepMessages : chatMessages;
  const isLoading = isDeepMode ? deepLoading : chatLoading;

  // First-load migration toast: show once to teach the new chat-default + /investigate UX
  useEffect(() => {
    if (isDeepMode) return;
    if (safeGetItem(MIGRATION_TOAST_KEY)) return;
    setShowMigrationToast(true);
    const timer = setTimeout(() => {
      setShowMigrationToast(false);
      safeSetItem(MIGRATION_TOAST_KEY, "1");
    }, 12_000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: only fires once on first mount of Console mode
  }, []);

  const dismissMigrationToast = () => {
    setShowMigrationToast(false);
    safeSetItem(MIGRATION_TOAST_KEY, "1");
  };

  // Tick the countdown while a confirm-dispatch is pending. 100ms cadence keeps
  // the progress bar smooth without churning unrelated re-renders.
  useEffect(() => {
    if (!pendingConfirm) return;
    const interval = setInterval(() => {
      setConfirmTick((t) => t + 1);
      if (Date.now() >= pendingConfirm.expiresAt) {
        clearInterval(interval);
      }
    }, 100);
    return () => clearInterval(interval);
  }, [pendingConfirm]);

  const cancelPendingDispatch = () => {
    if (!pendingConfirm) return;
    send({ type: "investigation:cancel_dispatch", id: pendingConfirm.id });
    // Optimistic clear — the server will also send `dispatch_cancelled`.
    setPendingConfirm(null);
  };

  // Send a slash-command "/investigate <service>" — used by the in-reply pill button.
  // Guarded against double-dispatch: a confirm-dispatch banner is already in flight,
  // or a chat round-trip is already in progress. The pill is also visually disabled
  // in those states so the user can't keep clicking through them.
  const dispatchSlashInvestigate = (service: string) => {
    if (status !== "connected") return;
    if (dispatchPendingRef.current || pendingConfirm || chatLoading || streamingMessage) return;
    dispatchPendingRef.current = true;
    setDispatchPending(true);
    send({ type: "chat", message: `/investigate ${service}` });
  };

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
          ...(msg.serviceContext ? { serviceContext: msg.serviceContext } : {}),
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
        dispatchPendingRef.current = false;
        setDispatchPending(false);
        setPendingConfirm((prev) => (prev && prev.id === msg.id ? null : prev));
      }
      if (msg.type === "investigation:confirm_dispatch") {
        const startedAt = Date.now();
        dispatchPendingRef.current = false;
        setDispatchPending(false);
        setPendingConfirm({
          id: msg.id,
          service: msg.service,
          query: msg.query,
          startedAt,
          expiresAt: startedAt + msg.timerMs,
        });
      }
      if (msg.type === "investigation:dispatch_cancelled") {
        dispatchPendingRef.current = false;
        setDispatchPending(false);
        setPendingConfirm((prev) => (prev && prev.id === msg.id ? null : prev));
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
    // Force-scroll to bottom on submit. useAutoScroll uses behavior:"smooth"
    // and only scrolls when the user was already near the bottom. When the
    // user types into a partially-scrolled chat, the smooth animation can
    // leave the new bubble + thinking indicator partially hidden behind the
    // input. Snap immediately, twice (now + after layout) to cover the
    // streaming bubble appearing on the next paint.
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
      requestAnimationFrame(() => {
        const el2 = scrollRef.current;
        if (el2) el2.scrollTop = el2.scrollHeight;
      });
    });
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
            (() => {
              const unread = isUnread(msg.investigationId);
              return (
            <div className="max-w-[92%] w-full flex flex-col gap-0.5">
              <button
                onClick={() => { markViewed(msg.investigationId!); onViewInvestigation(msg.investigationId!); }}
                className="w-full text-left group"
              >
                <div className={`rca-reveal rca-reveal-glow rounded-xl border bg-card/50 overflow-hidden transition-all group-hover:border-primary/40 group-hover:shadow-md ${
                  unread ? "rca-unread-pulse" : ""
                } ${
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
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] font-mono font-semibold uppercase tracking-[0.1em] text-foreground/85">
                          Root Cause Analysis
                        </span>
                        {unread && (
                          <span className="font-mono text-[9px] uppercase tracking-[0.12em] px-1.5 py-px rounded-sm bg-accent text-accent-foreground animate-status-pulse">
                            New
                          </span>
                        )}
                      </div>
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
              );
            })()
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
              {/* "Run full investigation" pill — only when chat agent resolved
                  a service AND we're not already inside a deep investigation
                  context. Click sends a /investigate slash command which goes
                  through the explicit-opt-in path on the server. */}
              {!isDeepMode && msg.serviceContext && status === "connected" && (
                <Button
                  variant="outline"
                  onClick={() => dispatchSlashInvestigate(msg.serviceContext!)}
                  disabled={dispatchPending || !!pendingConfirm || chatLoading || !!streamingMessage}
                  className="h-9 px-4 text-[11px] font-mono bg-primary/10 border-primary/25 text-primary hover:bg-primary/15 hover:text-primary rounded-md gap-1.5 mt-1 disabled:opacity-40 disabled:pointer-events-none"
                >
                  <Zap size={12} className="!size-auto" />
                  Run full investigation on
                  <code className="font-mono text-[11px] text-primary">{msg.serviceContext}</code>
                  <ArrowRight size={12} className="!size-auto" />
                </Button>
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

      {/* First-load migration toast — teaches the new chat-default + /investigate UX */}
      {showMigrationToast && !isDeepMode && (
        <div
          data-testid="migration-toast"
          className="px-4 py-2 bg-primary/8 border-b border-primary/15 text-[11px] font-mono text-primary/80 flex items-center justify-between gap-3 animate-fade-in"
        >
          <span className="flex-1">
            Investigation is now opt-in. Type <code className="px-1.5 py-0.5 rounded bg-primary/10 text-primary">/investigate &lt;service&gt;</code> for a full RCA. Chat answers stay fast and tool-driven.
          </span>
          <Button
            variant="ghost"
            onClick={dismissMigrationToast}
            className="h-auto px-1.5 py-0.5 rounded text-primary/60 hover:text-primary hover:bg-primary/10"
            aria-label="Dismiss migration tip"
          >
            <X size={11} className="!size-auto" />
          </Button>
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
          {/* Loading state for initial history fetch — 3 fake message rows
              using Tailwind `animate-pulse`. Mirrors the real bubble layout
              (user right, assistant left, with varying widths) so the
              skeleton feels like the real thing is about to appear. */}
          {historyLoading && !isDeepMode && (
            <div
              className="space-y-3 animate-fade-in"
              role="status"
              aria-label="Loading messages"
              data-testid="chat-loading-skeleton"
            >
              {/* Assistant row */}
              <div className="flex justify-start">
                <div className="max-w-[70%] w-60 h-9 rounded-xl rounded-bl-sm bg-secondary/50 border border-border/40 animate-pulse" />
              </div>
              {/* User row */}
              <div className="flex justify-end">
                <div className="max-w-[60%] w-40 h-9 rounded-xl rounded-br-sm bg-primary/8 border border-primary/15 animate-pulse" />
              </div>
              {/* Assistant row */}
              <div className="flex justify-start">
                <div className="max-w-[75%] w-72 h-12 rounded-xl rounded-bl-sm bg-secondary/50 border border-border/40 animate-pulse" />
              </div>
              <span className="sr-only">Loading messages...</span>
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
          {/* Pre-dispatch confirmation banner — chat-originated investigations
              get a 5-second cancellable window before the multi-agent runner
              kicks off. confirmTick keeps the countdown ticking. */}
          {pendingConfirm && (() => {
            const total = Math.max(1, pendingConfirm.expiresAt - pendingConfirm.startedAt);
            const remaining = Math.max(0, pendingConfirm.expiresAt - Date.now());
            const elapsed = total - remaining;
            const pct = Math.min(100, Math.round((elapsed / total) * 100));
            const seconds = Math.max(0, Math.ceil(remaining / 1000));
            return (
              <div
                key={pendingConfirm.id}
                data-testid="confirm-dispatch-banner"
                data-confirm-id={pendingConfirm.id}
                data-confirm-tick={confirmTick}
                className="rounded-md bg-accent/10 border border-accent/20 border-l-2 border-l-accent px-3 py-2 my-1 animate-fade-in"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-accent flex items-center gap-2 min-w-0">
                    <span>DISPATCHING</span>
                    <span className="text-accent/40">·</span>
                    <code className="px-1.5 py-0.5 rounded bg-accent/15 text-accent font-mono text-[11px] truncate">
                      {pendingConfirm.service}
                    </code>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="font-mono text-[11px] text-muted-foreground/70">{seconds}s</span>
                    <Button
                      variant="outline"
                      onClick={cancelPendingDispatch}
                      data-testid="confirm-dispatch-cancel"
                      className="h-auto px-2.5 py-1 text-[10px] font-mono rounded border-accent/40 text-accent hover:bg-accent/15"
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
                <div className="h-[2px] bg-accent/15 rounded-sm overflow-hidden mt-2">
                  <div
                    className="h-full bg-accent transition-[width] duration-100 ease-linear"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })()}
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
        {/* Spacer so auto-scroll clears the shortcut chips overlay (deep mode)
            or so the streaming bubble + thinking indicator have breathing
            room above the input box (console mode). */}
        {isDeepMode ? <div className="h-12" /> : <div className="h-3" />}
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
          {/* Slash-command autocomplete popover. Only shown in Console mode
              (not Deep Investigation) when the input starts with "/". The
              popover sits above the input with a soft shadow. */}
          {!isDeepMode && showSlashPopover && (
            <div
              data-testid="slash-popover"
              role="listbox"
              aria-label="Slash command suggestions"
              className="absolute left-0 right-0 bottom-full mb-2 rounded-md bg-card border border-border/60 shadow-lg overflow-hidden z-10"
            >
              {SLASH_COMMANDS.map((cmd, idx) => {
                const active = idx === slashIndex;
                return (
                  <button
                    key={cmd.command}
                    type="button"
                    role="option"
                    aria-selected={active}
                    data-testid={`slash-popover-${cmd.command.slice(1)}`}
                    onMouseDown={(e) => { e.preventDefault(); acceptSlashCommand(idx); }}
                    onMouseEnter={() => setSlashIndex(idx)}
                    className={`w-full flex items-baseline justify-between px-3 py-2 text-left transition-colors ${
                      active ? "bg-primary/15" : "hover:bg-secondary/50"
                    } ${idx > 0 ? "border-t border-border/30" : ""}`}
                  >
                    <span className={`font-mono text-[12px] ${active ? "text-primary font-medium" : "text-primary/85"}`}>
                      {cmd.command} <span className="text-muted-foreground/60">{cmd.placeholder}</span>
                    </span>
                    <span className="font-body text-[11px] text-muted-foreground/80">{cmd.hint}</span>
                  </button>
                );
              })}
            </div>
          )}
          <input
            value={input}
            onChange={(e) => {
              const v = e.target.value;
              setInput(v);
              // Show popover when in Console mode and the input begins with "/"
              // and the user hasn't typed past the command name + a space yet.
              if (!isDeepMode) {
                const open = v.startsWith("/") && !/^\s*\/(?:investigate|rca)\s+\S/.test(v);
                setShowSlashPopover(open);
                if (open) setSlashIndex(0);
              }
            }}
            // 200ms blur defers the popover close so an onMouseDown on a popover
            // row still gets to call acceptSlashCommand (the row uses
            // preventDefault to keep the input focused, but defensive in case
            // a future row doesn't).
            onBlur={() => setTimeout(() => setShowSlashPopover(false), 150)}
            onKeyDown={(e) => {
              if (!showSlashPopover) return;
              // Popover is open — keys take precedence over form submit.
              if (e.key === "Escape") {
                e.preventDefault();
                setShowSlashPopover(false);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                // Autocomplete the highlighted row instead of submitting the
                // form. Without this, Enter on "/inves" submits "/inves" as
                // a chat message — the user's exact bug report.
                e.preventDefault();
                acceptSlashCommand(slashIndex);
                return;
              }
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSlashIndex((i) => (i + 1) % SLASH_COMMANDS.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSlashIndex((i) => (i - 1 + SLASH_COMMANDS.length) % SLASH_COMMANDS.length);
                return;
              }
            }}
            className={`w-full px-4 py-2.5 pr-10 rounded-lg border text-sm font-body text-foreground/85 placeholder:text-muted-foreground/60 focus:outline-none transition-all disabled:opacity-25 ${isDeepMode ? "bg-accent/4 border-accent/20 focus:border-accent/40" : "bg-secondary/30 border-border/40 focus:border-primary/35"}`}
            placeholder={
              status !== "connected" ? "Reconnecting..." :
              isDeepMode ? "Ask a follow-up about this investigation..." :
              "Ask anything... or /investigate <service> for full RCA"
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
        {/* Persistent caption hint — only in Console mode */}
        {!isDeepMode && (
          <div className="mt-1.5 px-1 font-mono text-[10px] text-muted-foreground/50 tracking-wide">
            Tip: type <code className="text-muted-foreground/80">/investigate &lt;service&gt;</code> for full RCA · press <code className="text-muted-foreground/80">/</code> to see commands
          </div>
        )}
      </div>
    </div>
  );
}
