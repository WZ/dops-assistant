import { useState, useRef, useEffect } from "react";
import type { ClientMessage, ServerMessage } from "../../shared/ws-types.js";

interface DeepMessage {
  role: "user" | "assistant";
  content: string;
}

const SUGGESTED_PROMPTS = [
  "Why did this metric spike?",
  "Show me the raw log samples",
  "What other services could be affected?",
  "How do I implement the recommended fix?",
  "Is this a recurring issue?",
];

interface DeepInvestigationPaneProps {
  investigationId: string;
  wsMessages: ServerMessage[];
  send: (msg: ClientMessage) => void;
}

export function DeepInvestigationPane({ investigationId, wsMessages, send }: DeepInvestigationPaneProps) {
  const [messages, setMessages] = useState<DeepMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const processedCount = useRef(0);

  useEffect(() => {
    const newMessages = wsMessages.slice(processedCount.current);
    processedCount.current = wsMessages.length;

    for (const msg of newMessages) {
      if (msg.type === "deep_investigate:response" && msg.investigationId === investigationId) {
        setMessages((prev) => [...prev, { role: "assistant", content: msg.content }]);
        setIsLoading(false);
      }
    }
  }, [wsMessages, investigationId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const handleSend = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isLoading) return;
    setMessages((prev) => [...prev, { role: "user", content: trimmed }]);
    send({ type: "deep_investigate", investigationId, message: trimmed });
    setIsLoading(true);
    setInput("");
  };

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 overflow-y-auto px-4 py-4" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center">
            <div className="w-10 h-10 rounded-xl bg-accent/8 border border-accent/15 flex items-center justify-center mb-3">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-accent/50">
                <path d="M12 20h9"/><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.855z"/>
              </svg>
            </div>
            <p className="text-xs text-muted-foreground/50 mb-4">Ask follow-up questions about this investigation</p>
            <div className="flex flex-wrap gap-1.5 justify-center max-w-sm">
              {SUGGESTED_PROMPTS.map((prompt, i) => (
                <button
                  key={i}
                  onClick={() => handleSend(prompt)}
                  className="px-2.5 py-1 rounded-full bg-secondary/40 border border-border/30 text-[10px] font-mono text-muted-foreground/50 hover:text-primary/70 hover:border-primary/30 transition-colors cursor-pointer"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {messages.map((msg, i) => (
              <div
                key={i}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"} animate-fade-up`}
              >
                <div className={`max-w-[90%] px-3.5 py-2 rounded-xl text-sm font-body whitespace-pre-wrap ${
                  msg.role === "user"
                    ? "rounded-br-sm bg-accent/12 border border-accent/20 text-foreground/85"
                    : "rounded-bl-sm bg-secondary/50 border border-border/40 text-foreground/75"
                }`}>
                  {msg.content.split("**").map((part, j) =>
                    j % 2 === 1 ? (
                      <span key={j} className="font-semibold text-foreground/90">{part}</span>
                    ) : (
                      <span key={j}>{part}</span>
                    )
                  )}
                </div>
              </div>
            ))}
            {isLoading && (
              <div className="flex justify-start animate-fade-in">
                <div className="px-3.5 py-2 rounded-xl rounded-bl-sm bg-secondary/50 border border-border/40">
                  <div className="flex items-center gap-1.5">
                    <div className="w-1.5 h-1.5 rounded-full bg-accent/50 animate-status-pulse" />
                    <div className="w-1.5 h-1.5 rounded-full bg-accent/40 animate-status-pulse" style={{ animationDelay: "0.3s" }} />
                    <div className="w-1.5 h-1.5 rounded-full bg-accent/30 animate-status-pulse" style={{ animationDelay: "0.6s" }} />
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="p-3 border-t border-border/40">
        <form onSubmit={(e) => { e.preventDefault(); handleSend(input); }} className="relative">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="w-full px-4 py-2.5 pr-10 rounded-lg bg-secondary/40 border border-border/50 text-sm font-body text-foreground/85 placeholder:text-muted-foreground/35 focus:outline-none focus:border-accent/40 transition-all disabled:opacity-30"
            placeholder="Ask about this investigation..."
            disabled={isLoading}
          />
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-md text-muted-foreground/40 hover:text-accent hover:bg-accent/10 transition-all disabled:opacity-20"
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
