import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";

interface EvidenceData {
  metrics?: { observations: { metric: string; currentValue: string; baselineValue: string; severity: string }[]; summary: string };
  logs?: { observations: { pattern: string; count: string; sample: string }[]; summary: string };
  infra?: { observations: { resource: string; status: string; detail: string }[]; summary: string };
}

export function EvidenceCards({ evidence }: { evidence: EvidenceData }) {
  const mc = evidence.metrics?.observations.length ?? 0;
  const lc = evidence.logs?.observations.length ?? 0;
  const ic = evidence.infra?.observations.length ?? 0;

  return (
    <Tabs defaultValue="metrics" className="w-full">
      <TabsList className="w-full bg-secondary/30 border border-border/30 rounded-lg p-0.5">
        <TabsTrigger value="metrics" className="flex-1 text-[11px] font-mono">Metrics ({mc})</TabsTrigger>
        <TabsTrigger value="logs" className="flex-1 text-[11px] font-mono">Logs ({lc})</TabsTrigger>
        <TabsTrigger value="infra" className="flex-1 text-[11px] font-mono">Infra ({ic})</TabsTrigger>
      </TabsList>

      <TabsContent value="metrics" className="space-y-2 mt-3">
        {evidence.metrics?.observations.map((obs, i) => (
          <div key={i} className="rounded-lg border border-border/30 bg-card/40 px-3.5 py-2.5 animate-fade-up" style={{ animationDelay: `${i * 0.05}s` }}>
            <div className="flex items-center justify-between">
              <span className="font-mono text-xs text-foreground/70">{obs.metric}</span>
              <Badge variant={obs.severity === "critical" ? "destructive" : "secondary"} className="text-[10px]">{obs.severity}</Badge>
            </div>
            <div className="flex items-center gap-3 mt-1.5">
              <span className="text-[11px] font-mono text-primary/70">{obs.currentValue}</span>
              <span className="text-[10px] text-muted-foreground/30">/</span>
              <span className="text-[11px] font-mono text-muted-foreground/40">baseline {obs.baselineValue}</span>
            </div>
          </div>
        ))}
        {mc === 0 && <p className="text-xs text-muted-foreground/35 py-4 text-center font-mono">No metric findings yet</p>}
      </TabsContent>

      <TabsContent value="logs" className="space-y-2 mt-3">
        {evidence.logs?.observations.map((obs, i) => (
          <div key={i} className="rounded-lg border border-border/30 bg-card/40 px-3.5 py-2.5 animate-fade-up" style={{ animationDelay: `${i * 0.05}s` }}>
            <div className="flex items-center justify-between">
              <span className="font-mono text-xs text-foreground/70">{obs.pattern}</span>
              <span className="text-[10px] font-mono text-accent/60">{obs.count}x</span>
            </div>
            {obs.sample && (
              <pre className="text-[11px] font-mono bg-background/60 rounded-md p-2.5 mt-2 overflow-x-auto text-muted-foreground/60 border border-border/20">{obs.sample}</pre>
            )}
          </div>
        ))}
        {lc === 0 && <p className="text-xs text-muted-foreground/35 py-4 text-center font-mono">No log findings yet</p>}
      </TabsContent>

      <TabsContent value="infra" className="space-y-2 mt-3">
        {evidence.infra?.observations.map((obs, i) => (
          <div key={i} className="rounded-lg border border-border/30 bg-card/40 px-3.5 py-2.5 animate-fade-up" style={{ animationDelay: `${i * 0.05}s` }}>
            <div className="flex items-center justify-between">
              <span className="font-mono text-xs text-foreground/70">{obs.resource}</span>
              <Badge variant={obs.status === "unhealthy" ? "destructive" : "secondary"} className="text-[10px]">{obs.status}</Badge>
            </div>
            <p className="text-[11px] text-muted-foreground/45 mt-1">{obs.detail}</p>
          </div>
        ))}
        {ic === 0 && <p className="text-xs text-muted-foreground/35 py-4 text-center font-mono">No infra findings yet</p>}
      </TabsContent>
    </Tabs>
  );
}
