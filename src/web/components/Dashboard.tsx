import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { ServiceCard } from "./ServiceCard";

interface ServiceConfig { name: string; }

interface InvestigationSummary {
  id: string;
  service: string;
  status: string;
  report: string | null;
  created_at: string;
}

export function Dashboard({ onInvestigationClick, onInvestigateService }: { onInvestigationClick: (id: string) => void; onInvestigateService: (serviceName: string) => void }) {
  const [services, setServices] = useState<ServiceConfig[]>([]);
  const [investigations, setInvestigations] = useState<InvestigationSummary[]>([]);

  useEffect(() => {
    fetch("/api/services").then((r) => r.json()).then(setServices).catch(() => {});
    fetch("/api/investigations?limit=10").then((r) => r.json()).then(setInvestigations).catch(() => {});
  }, []);

  const timeAgo = (dateStr: string): string => {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  };

  return (
    <div className="h-full overflow-y-auto p-6 relative z-[2]">
      {/* Title */}
      <div className="mb-8 animate-fade-up">
        <h1 className="font-display text-xl font-bold tracking-tight text-foreground/90">
          Services Overview
        </h1>
        <p className="text-xs font-mono text-muted-foreground/40 mt-1 tracking-wide">
          {services.length} service{services.length !== 1 ? "s" : ""} monitored
        </p>
      </div>

      {/* Services Grid */}
      <section className="mb-10">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-1 h-4 rounded-full bg-primary/60" />
          <h2 className="text-[11px] font-display font-semibold text-muted-foreground/60 uppercase tracking-[0.15em]">
            Services
          </h2>
        </div>
        {services.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-sm text-muted-foreground/40">No services configured</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            {services.map((svc, i) => (
              <div key={svc.name} className={`animate-fade-up delay-${i + 1}`}>
                <ServiceCard name={svc.name} onClick={() => onInvestigateService(svc.name)} />
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Recent Investigations */}
      <section>
        <div className="flex items-center gap-2 mb-4">
          <div className="w-1 h-4 rounded-full bg-accent/60" />
          <h2 className="text-[11px] font-display font-semibold text-muted-foreground/60 uppercase tracking-[0.15em]">
            Recent Investigations
          </h2>
        </div>
        {investigations.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-sm text-muted-foreground/40">No investigations yet</p>
            <p className="text-xs text-muted-foreground/25 mt-1 font-mono">
              click a service card or use the chat to start one
            </p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {investigations.map((inv, i) => {
              let rootCause = "";
              let confidence = "";
              if (inv.report) {
                try { const r = JSON.parse(inv.report); rootCause = r.rootCause ?? ""; confidence = r.confidence ?? ""; } catch { /* ignore */ }
              }
              const statusColor = inv.status === "complete" ? "bg-success" : inv.status === "failed" ? "bg-destructive" : "bg-accent animate-status-pulse";
              return (
                <div
                  key={inv.id}
                  onClick={() => onInvestigationClick(inv.id)}
                  className={`animate-fade-up delay-${Math.min(i + 1, 8)} group cursor-pointer rounded-lg border border-border/40 bg-card/40 hover:bg-card/70 hover:border-primary/25 px-4 py-3 transition-all card-lift`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <div className={`w-1.5 h-1.5 rounded-full ${statusColor}`} />
                      <span className="font-body text-sm font-medium text-foreground/80 group-hover:text-foreground/95 transition-colors">{inv.service}</span>
                    </div>
                    <span className="text-[10px] font-mono text-muted-foreground/35">{timeAgo(inv.created_at)}</span>
                  </div>
                  {rootCause && (
                    <p className="text-xs text-muted-foreground/50 truncate pl-3.5 font-body">{rootCause}</p>
                  )}
                  {confidence && (
                    <div className="flex gap-1.5 mt-1.5 pl-3.5">
                      <Badge variant="outline" className="text-[10px] py-0 h-4 border-border/40 text-muted-foreground/50">{confidence}</Badge>
                      <Badge
                        variant={inv.status === "complete" ? "default" : inv.status === "failed" ? "destructive" : "secondary"}
                        className="text-[10px] py-0 h-4"
                      >
                        {inv.status}
                      </Badge>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
