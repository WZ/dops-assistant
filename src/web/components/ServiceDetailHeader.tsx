import { Button } from "@/components/ui/button";
import { ArrowLeft, Search, ExternalLink, Pencil, Plus } from "lucide-react";

interface ServiceDetailHeaderProps {
  serviceName: string;
  healthStatus?: "healthy" | "degraded" | "down" | "unknown";
  alias?: string | null;
  tags?: string[];
  investigationCount?: number;
  onBack: () => void;
  onInvestigate: () => void;
  onEditAlias: () => void;
  onAddTag: () => void;
}

function healthDotClass(status?: string): string {
  switch (status) {
    case "healthy":
      return "w-2.5 h-2.5 rounded-full bg-success ring-2 ring-success/20";
    case "degraded":
      return "w-2.5 h-2.5 rounded-full bg-warning ring-2 ring-warning/20";
    case "down":
      return "w-2.5 h-2.5 rounded-full bg-destructive ring-2 ring-destructive/20 animate-status-pulse";
    default:
      return "w-2.5 h-2.5 rounded-full bg-muted-foreground/30 ring-2 ring-muted-foreground/10";
  }
}

function healthLabel(status?: string): string {
  switch (status) {
    case "healthy": return "Healthy";
    case "degraded": return "Degraded";
    case "down": return "Down";
    default: return "Unknown";
  }
}

export function ServiceDetailHeader({
  serviceName,
  healthStatus,
  alias,
  tags = [],
  investigationCount = 0,
  onBack,
  onInvestigate,
  onEditAlias,
  onAddTag,
}: ServiceDetailHeaderProps) {
  const displayName = alias || serviceName;

  return (
    <div className="px-6 pt-5 pb-4 border-b border-border/25">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1.5 mb-3">
        <button
          onClick={onBack}
          className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground/60 hover:text-primary transition-colors"
        >
          Dashboard
        </button>
        <span className="font-mono text-[9px] text-muted-foreground/30">&rsaquo;</span>
        <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground/40">
          Service Detail
        </span>
      </div>

      {/* Title row */}
      <div className="flex items-center gap-3 mb-2">
        <button
          onClick={onBack}
          className="p-1 -ml-1 text-muted-foreground/50 hover:text-foreground/70 transition-colors"
          aria-label="Back to dashboard"
        >
          <ArrowLeft size={16} />
        </button>
        <div className={healthDotClass(healthStatus)} />
        <h1 className="font-display text-[22px] font-semibold text-foreground/90 leading-tight">
          {displayName}
        </h1>
        {alias && (
          <span className="font-mono text-[11px] text-muted-foreground/40">
            {serviceName}
          </span>
        )}
      </div>

      {/* Tags */}
      {tags.length > 0 && (
        <div className="flex items-center gap-1.5 mb-3 ml-9">
          {tags.map((tag) => (
            <span
              key={tag}
              className="font-mono text-[11px] bg-secondary/50 text-muted-foreground/70 rounded px-1.5 py-0.5"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Actions row */}
      <div className="flex items-center gap-2 ml-9 mb-2">
        <Button
          onClick={onInvestigate}
          className="h-8 px-3 text-[11px] font-mono bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <Search size={12} className="mr-1.5" />
          Investigate
        </Button>
        <Button
          variant="outline"
          className="h-8 px-3 text-[11px] font-mono bg-secondary border-border text-foreground/70 hover:text-foreground/90 hover:bg-secondary/80 transition-colors"
          onClick={() => {
            // TODO: Wire to Grafana dashboard URL from provider config
          }}
        >
          <ExternalLink size={12} className="mr-1.5" />
          Open in Grafana
        </Button>
        <Button
          variant="ghost"
          onClick={onEditAlias}
          className="h-8 px-3 text-[11px] font-mono text-muted-foreground border border-border/50 hover:text-foreground/70 hover:bg-secondary/30 transition-colors"
        >
          <Pencil size={12} className="mr-1.5" />
          Edit Name
        </Button>
        <Button
          variant="ghost"
          onClick={onAddTag}
          className="h-8 px-3 text-[11px] font-mono text-muted-foreground border border-border/50 hover:text-foreground/70 hover:bg-secondary/30 transition-colors"
        >
          <Plus size={12} className="mr-1.5" />
          Tag
        </Button>
      </div>

      {/* Meta line */}
      <div className="ml-9 text-[11px] text-muted-foreground/50 font-mono">
        {healthLabel(healthStatus)} &middot; {investigationCount} investigation{investigationCount !== 1 ? "s" : ""}
      </div>
    </div>
  );
}
