import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
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
      <TabsList className="w-full">
        <TabsTrigger value="metrics" className="flex-1">Metrics ({mc})</TabsTrigger>
        <TabsTrigger value="logs" className="flex-1">Logs ({lc})</TabsTrigger>
        <TabsTrigger value="infra" className="flex-1">Infra ({ic})</TabsTrigger>
      </TabsList>

      <TabsContent value="metrics" className="space-y-2 mt-2">
        {evidence.metrics?.observations.map((obs, i) => (
          <Card key={i}>
            <CardContent className="p-3">
              <div className="flex items-center justify-between">
                <span className="font-mono text-sm">{obs.metric}</span>
                <Badge variant={obs.severity === "critical" ? "destructive" : "secondary"}>{obs.severity}</Badge>
              </div>
              <div className="text-xs text-muted-foreground mt-1">{obs.currentValue} (baseline: {obs.baselineValue})</div>
            </CardContent>
          </Card>
        ))}
        {mc === 0 && <p className="text-sm text-muted-foreground">No metric findings yet</p>}
      </TabsContent>

      <TabsContent value="logs" className="space-y-2 mt-2">
        {evidence.logs?.observations.map((obs, i) => (
          <Card key={i}>
            <CardContent className="p-3">
              <div className="font-mono text-sm">{obs.pattern}</div>
              <div className="text-xs text-muted-foreground mt-1">Count: {obs.count}</div>
              {obs.sample && <pre className="text-xs bg-muted rounded p-2 mt-2 overflow-x-auto">{obs.sample}</pre>}
            </CardContent>
          </Card>
        ))}
        {lc === 0 && <p className="text-sm text-muted-foreground">No log findings yet</p>}
      </TabsContent>

      <TabsContent value="infra" className="space-y-2 mt-2">
        {evidence.infra?.observations.map((obs, i) => (
          <Card key={i}>
            <CardContent className="p-3">
              <div className="flex items-center justify-between">
                <span className="font-mono text-sm">{obs.resource}</span>
                <Badge variant={obs.status === "unhealthy" ? "destructive" : "secondary"}>{obs.status}</Badge>
              </div>
              <div className="text-xs text-muted-foreground mt-1">{obs.detail}</div>
            </CardContent>
          </Card>
        ))}
        {ic === 0 && <p className="text-sm text-muted-foreground">No infra findings yet</p>}
      </TabsContent>
    </Tabs>
  );
}
