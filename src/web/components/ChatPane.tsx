import { useState, useRef, useEffect, type ReactNode } from "react";
import type { useWebSocket } from "../hooks/useWebSocket";

/** Parse inline markdown: **bold**, *italic*, `code` into JSX spans */
function renderInline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const regex = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    if (match[2]) {
      parts.push(<strong key={match.index} className="font-semibold text-foreground/90">{match[2]}</strong>);
    } else if (match[3]) {
      parts.push(<em key={match.index} className="italic">{match[3]}</em>);
    } else if (match[4]) {
      parts.push(<code key={match.index} className="px-1 py-0.5 rounded bg-secondary/40 text-[0.9em] font-mono text-foreground/70">{match[4]}</code>);
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts.length > 0 ? parts : [text];
}

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

interface ChatPaneProps {
  ws: ReturnType<typeof useWebSocket>;
  onInvestigationStarted: (id: string) => void;
  activeInvestigationId?: string;
}

const DEEP_DIVE_PROMPTS = [
  "Why did this happen?",
  "Show me the raw log samples",
  "What other services were affected?",
  "What should we check first?",
];

export function ChatPane({ ws, onInvestigationStarted, activeInvestigationId }: ChatPaneProps) {
  const { status, messages: wsMessages, send } = ws;
  const [input, setInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [deepMessages, setDeepMessages] = useState<ChatMessage[]>([]);
  const [deepLoading, setDeepLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const processedCount = useRef(0);
  const historyLoaded = useRef(false);

  const isDeepMode = !!activeInvestigationId;
  const messages = isDeepMode ? deepMessages : chatMessages;

  // Load historical messages on mount
  useEffect(() => {
    if (historyLoaded.current) return;
    historyLoaded.current = true;
    fetch("/api/messages?limit=50")
      .then((r) => r.ok ? r.json() : [])
      .then((msgs: Array<{ role: string; content: string }>) => {
        if (msgs.length > 0) {
          setChatMessages(msgs.map((m) => ({ role: m.role as ChatMessage["role"], content: m.content })));
        }
      })
      .catch(() => {});
  }, []);

  // Reset deep messages when investigation changes
  useEffect(() => {
    setDeepMessages([]);
    setDeepLoading(false);
  }, [activeInvestigationId]);

  // Process WebSocket messages
  useEffect(() => {
    const newMessages = wsMessages.slice(processedCount.current);
    processedCount.current = wsMessages.length;

    for (const msg of newMessages) {
      if (msg.type === "chat") {
        setChatMessages((prev) => [...prev, { role: msg.role, content: msg.content }]);
      }
      if (msg.type === "investigation:started") {
        onInvestigationStarted(msg.id);
      }
      if (msg.type === "deep_investigate:response" && msg.investigationId === activeInvestigationId) {
        setDeepMessages((prev) => [...prev, { role: "assistant", content: msg.content }]);
        setDeepLoading(false);
      }
    }
  }, [wsMessages, onInvestigationStarted, activeInvestigationId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [chatMessages, deepMessages]);

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
                Chat
              </span>
            </>
          )}
        </div>
      </div>

      {/* Deep mode banner */}
      {isDeepMode && (
        <div className="px-4 py-2 bg-accent/4 border-b border-accent/12 text-[10px] font-mono text-accent/60 flex items-center gap-2">
          <div className="w-1 h-1 rounded-full bg-accent/50" />
          Ask follow-up questions — has full MCP access for live queries
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4" ref={scrollRef}>
        <div className="space-y-3">
          {messages.length === 0 && !isDeepMode && (
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
              ) : (
                <div className="max-w-[85%] px-3.5 py-2 rounded-xl rounded-bl-sm bg-secondary/50 border border-border/40 text-sm font-body text-foreground/75 whitespace-pre-wrap">
                  {renderInline(msg.content)}
                </div>
              )}
            </div>
          ))}
          {deepLoading && (
            <div className="flex justify-start animate-fade-in">
              <div className="px-3.5 py-2 rounded-xl rounded-bl-sm bg-secondary/50 border border-border/40">
                <div className="flex items-center gap-1.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-accent animate-status-pulse" />
                  <span className="text-[11px] font-mono text-muted-foreground/50">investigating...</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Deep mode shortcut chips — always visible */}
      {isDeepMode && (
        <div className="px-3 pt-2 flex flex-wrap gap-1.5">
          {DEEP_DIVE_PROMPTS.map((prompt) => (
            <button
              key={prompt}
              onClick={() => handleSubmit(prompt)}
              disabled={deepLoading || status !== "connected"}
              className="px-2.5 py-1 text-[10px] font-mono rounded-full border border-accent/25 text-accent/70 hover:bg-accent/10 hover:border-accent/40 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
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
            disabled={status !== "connected" || deepLoading}
          />
          <button
            type="submit"
            disabled={status !== "connected" || !input.trim() || deepLoading}
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
