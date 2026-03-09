export function Dashboard({
  onInvestigationClick: _cb,
}: {
  onInvestigationClick: (id: string) => void;
}) {
  return (
    <div className="h-full p-6">
      <h1 className="text-2xl font-bold mb-6">dops-assistant</h1>
      <p className="text-muted-foreground">Dashboard loading...</p>
    </div>
  );
}
