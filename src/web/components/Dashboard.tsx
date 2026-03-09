import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
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
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <h1 className="text-2xl font-bold mb-6">dops-assistant</h1>

      <section className="mb-8">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">Services</h2>
        {services.length === 0 ? (
          <p className="text-sm text-muted-foreground">No services configured</p>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            {services.map((svc) => (
              <ServiceCard key={svc.name} name={svc.name} onClick={() => onInvestigateService(svc.name)} />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">Recent Investigations</h2>
        {investigations.length === 0 ? (
          <p className="text-sm text-muted-foreground">No investigations yet</p>
        ) : (
          <div className="space-y-2">
            {investigations.map((inv) => {
              let rootCause = "";
              let confidence = "";
              if (inv.report) {
                try { const r = JSON.parse(inv.report); rootCause = r.rootCause ?? ""; confidence = r.confidence ?? ""; } catch { /* ignore */ }
              }
              return (
                <Card key={inv.id} className="cursor-pointer hover:border-primary transition-colors" onClick={() => onInvestigationClick(inv.id)}>
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-medium text-sm">{inv.service}</span>
                      <span className="text-xs text-muted-foreground">{timeAgo(inv.created_at)}</span>
                    </div>
                    {rootCause && <p className="text-xs text-muted-foreground truncate">{rootCause}</p>}
                    <div className="flex gap-1 mt-1">
                      {confidence && <Badge variant="outline" className="text-xs">{confidence}</Badge>}
                      <Badge variant={inv.status === "complete" ? "default" : inv.status === "failed" ? "destructive" : "secondary"} className="text-xs">{inv.status}</Badge>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
