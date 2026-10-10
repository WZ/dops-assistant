import { useEffect, useRef, useState, useCallback } from "react";
import type { ClientMessage, ServerMessage } from "../../types/ws-types.js";
import { APP_BASE_PATH } from "../lib/createStackFetch";

type ConnectionStatus = "connecting" | "connected" | "disconnected";

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export function useWebSocket(stackId?: string) {
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [messages, setMessages] = useState<ServerMessage[]>([]);

  useEffect(() => {
    // Don't connect until we have a stackId (may be empty string during initial load)
    if (stackId === undefined || stackId === "") return;

    // Clear messages on stack switch only. Auto-reconnects keep them: consumers
    // track a processed index into this array.
    setMessages([]);

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsPath = APP_BASE_PATH === "/" ? "/ws" : `${APP_BASE_PATH}ws`;
    const url = `${protocol}//${window.location.host}${wsPath}?stackId=${encodeURIComponent(stackId)}`;

    let disposed = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      setStatus("connecting");
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        attempt = 0;
        setStatus("connected");
      };
      // onerror is always followed by onclose, which owns the retry.
      ws.onerror = () => setStatus("disconnected");
      ws.onclose = () => {
        if (disposed) return;
        setStatus("disconnected");
        const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
        attempt++;
        retryTimer = setTimeout(connect, delay);
      };

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
    };

    connect();

    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      wsRef.current?.close();
    };
  }, [stackId]);

  const send = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  return { status, messages, send };
}
