import { useEffect, useRef, useState, useCallback } from "react";
import type { ClientMessage, ServerMessage } from "../../types/ws-types.js";
import { APP_BASE_PATH } from "../lib/createStackFetch";

type ConnectionStatus = "connecting" | "connected" | "disconnected";

export function useWebSocket(stackId?: string) {
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [messages, setMessages] = useState<ServerMessage[]>([]);

  useEffect(() => {
    // Don't connect until we have a stackId (may be empty string during initial load)
    if (stackId === undefined || stackId === "") return;

    setStatus("connecting");
    // Clear messages on reconnect (stack switch)
    setMessages([]);

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsPath = APP_BASE_PATH === "/" ? "/ws" : `${APP_BASE_PATH}ws`;
    const url = `${protocol}//${window.location.host}${wsPath}?stackId=${encodeURIComponent(stackId)}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => setStatus("connected");
    ws.onclose = () => setStatus("disconnected");
    ws.onerror = () => setStatus("disconnected");

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as ServerMessage;
        setMessages((prev) => {
          const next = [...prev, msg];
          if (next.length > 2000) {
            // Keep last 1500 messages, preserving stream_end and lifecycle messages
            return next.slice(-1500);
          }
          return next;
        });
      } catch {
        /* ignore parse errors */
      }
    };

    return () => {
      ws.close();
    };
  }, [stackId]);

  const send = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  return { status, messages, send };
}
