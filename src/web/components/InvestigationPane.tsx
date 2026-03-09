import type { ServerMessage } from "../../shared/ws-types.js";

export function InvestigationPane({
  investigationId,
  wsMessages: _ws,
  onBack,
}: {
  investigationId: string;
  wsMessages: ServerMessage[];
  onBack: () => void;
}) {
  return (
    <div className="h-full p-6">
      <button
        onClick={onBack}
        className="text-sm text-muted-foreground hover:underline mb-4"
      >
        &larr; Back
      </button>
      <h2 className="text-xl font-bold">Investigation {investigationId}</h2>
    </div>
  );
}
