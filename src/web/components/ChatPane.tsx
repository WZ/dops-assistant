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
    <div className="h-full flex flex-col border-l border-border">
      <div className="p-3 border-b border-border font-semibold text-sm flex items-center justify-between">
        <span>Chat</span>
        <span className={`text-xs ${status === "connected" ? "text-green-500" : "text-red-500"}`}>
          {status}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-4" ref={scrollRef}>
        <div className="space-y-4">
          {chatMessages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : msg.role === "system"
                      ? "bg-muted text-muted-foreground italic"
                      : "bg-muted text-foreground"
                }`}
              >
                {msg.content}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="p-3 border-t border-border">
        <form onSubmit={(e) => { e.preventDefault(); handleSubmit(); }} className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="flex-1 rounded-md border border-input px-3 py-2 text-sm bg-background"
            placeholder="Type a message..."
            disabled={status !== "connected"}
          />
          <button
            type="submit"
            disabled={status !== "connected" || !input.trim()}
            className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
