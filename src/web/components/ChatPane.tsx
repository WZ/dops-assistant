import type { useWebSocket } from "../hooks/useWebSocket";

interface ChatPaneProps {
  ws: ReturnType<typeof useWebSocket>;
  onInvestigationStarted: (id: string) => void;
}

export function ChatPane({
  ws: _ws,
  onInvestigationStarted: _cb,
}: ChatPaneProps) {
  return (
    <div className="h-full flex flex-col border-l">
      <div className="p-4 border-b font-semibold">Chat</div>
      <div className="flex-1 p-4 text-muted-foreground">
        Chat messages will appear here
      </div>
      <div className="p-4 border-t">
        <input
          className="w-full p-2 rounded border"
          placeholder="Type a message..."
        />
      </div>
    </div>
  );
}
