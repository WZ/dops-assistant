export function ServiceCard({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="group w-full text-left rounded-lg border border-border/40 bg-card/50 hover:bg-card/80 hover:border-primary/25 px-4 py-3 transition-all card-lift"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-2 h-2 rounded-full bg-success/80 ring-2 ring-success/15" />
          <span className="font-body text-sm font-medium text-foreground/75 group-hover:text-foreground/95 transition-colors">
            {name}
          </span>
        </div>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-muted-foreground/15 group-hover:text-primary/50 transition-colors">
          <circle cx="11" cy="11" r="8"/>
          <path d="m21 21-4.3-4.3"/>
        </svg>
      </div>
      <div className="mt-1.5 pl-[18px]">
        <span className="text-[9px] font-mono text-muted-foreground/30 uppercase tracking-[0.15em]">
          healthy
        </span>
      </div>
    </button>
  );
}
