import { useState, useRef, useEffect } from "react";
import type { useWebSocket } from "../hooks/useWebSocket";
import type { ServerMessage } from "../../shared/ws-types.js";

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

interface ChatPaneProps {
  ws: ReturnType<typeof useWebSocket>;
  onInvestigationStarted: (id: string) => void;
}

export function ChatPane({ ws, onInvestigationStarted }: ChatPaneProps) {
  const { status, messages: wsMessages, send } = ws;
  const [input, setInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const processedCount = useRef(0);

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
    }
  }, [wsMessages, onInvestigationStarted]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [chatMessages]);

  const handleSubmit = () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    setChatMessages((prev) => [...prev, { role: "user", content: trimmed }]);
    send({ type: "chat", message: trimmed });
    setInput("");
  };

  return (
    <div className="h-full flex flex-col bg-card/30">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border/40 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-primary/60">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
          <span className="font-display text-xs font-semibold tracking-wide uppercase text-foreground/60">
            Chat
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className={`w-1.5 h-1.5 rounded-full transition-colors ${status === "connected" ? "bg-success" : status === "connecting" ? "bg-accent animate-status-pulse" : "bg-destructive"}`} />
          <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider">
            {status === "connected" ? "live" : status}
          </span>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4" ref={scrollRef}>
        <div className="space-y-3">
          {chatMessages.length === 0 && (
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
          {chatMessages.map((msg, i) => (
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
                <div className="max-w-[85%] px-3.5 py-2 rounded-xl rounded-br-sm bg-primary/12 border border-primary/20 text-sm font-body text-foreground/85 whitespace-pre-wrap">
                  {msg.content}
                </div>
              ) : msg.role === "system" ? (
                <div className="max-w-[90%] px-3 py-1.5 text-[11px] font-mono text-muted-foreground/40 text-center">
                  {msg.content}
                </div>
              ) : (
                <div className="max-w-[85%] px-3.5 py-2 rounded-xl rounded-bl-sm bg-secondary/50 border border-border/40 text-sm font-body text-foreground/75 whitespace-pre-wrap">
                  {msg.content.split("**").map((part, j) =>
                    j % 2 === 1 ? (
                      <span key={j} className="font-semibold text-foreground/90">{part}</span>
                    ) : (
                      <span key={j}>{part}</span>
                    )
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Input */}
      <div className="p-3 border-t border-border/40">
        <form onSubmit={(e) => { e.preventDefault(); handleSubmit(); }} className="relative">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="w-full px-4 py-2.5 pr-10 rounded-lg bg-secondary/40 border border-border/50 text-sm font-body text-foreground/85 placeholder:text-muted-foreground/35 focus:outline-none focus:border-primary/40 transition-all disabled:opacity-30"
            placeholder={status === "connected" ? "Type a message..." : "Reconnecting..."}
            disabled={status !== "connected"}
          />
          <button
            type="submit"
            disabled={status !== "connected" || !input.trim()}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-md text-muted-foreground/40 hover:text-primary hover:bg-primary/10 transition-all disabled:opacity-20 disabled:hover:bg-transparent disabled:hover:text-muted-foreground/40"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2Z"/>
            </svg>
          </button>
        </form>
      </div>
    </div>
  );
}
