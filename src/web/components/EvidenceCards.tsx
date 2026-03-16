import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { MetricChart, type TimeSeriesData } from "./MetricChart";

/*
 * Evidence comes in two shapes:
 *  1. Phase-level findings (structured objects from the investigation phases)
 *  2. Report-level evidence (plain strings from the RCA synthesis)
 * The observations array can contain either. We detect and render both.
 */

interface StructuredMetric { metric: string; currentValue: string; baselineValue: string; severity?: string; timestamp?: string }
interface StructuredLog { pattern: string; count: string; sample?: string; sampleLines?: string[] }
interface StructuredInfra { resource: string; status: string; detail: string }

type Observation = string | StructuredMetric | StructuredLog | StructuredInfra | Record<string, unknown>;

interface EvidenceData {
  metrics?: { observations: Observation[]; summary?: string };
  logs?: { observations: Observation[]; summary?: string };
  infra?: { observations: Observation[]; summary?: string };
  timeSeries?: TimeSeriesData[];
}

function isString(obs: Observation): obs is string {
  return typeof obs === "string";
}

function isStructuredMetric(obs: Observation): obs is StructuredMetric {
  return typeof obs === "object" && obs !== null && "metric" in obs;
}

function isStructuredLog(obs: Observation): obs is StructuredLog {
  return typeof obs === "object" && obs !== null && "pattern" in obs;
}

function isStructuredInfra(obs: Observation): obs is StructuredInfra {
  return typeof obs === "object" && obs !== null && "resource" in obs;
}

function EvidenceItem({ children, index }: { children: React.ReactNode; index: number }) {
  return (
    <div
      className="rounded-lg border border-border/25 bg-card/30 px-3.5 py-2.5 animate-fade-up card-lift"
      style={{ animationDelay: `${index * 0.05}s` }}
    >
      {children}
    </div>
  );
}

function StringEvidence({ text, index }: { text: string; index: number }) {
  return (
    <EvidenceItem index={index}>
      <p className="font-mono text-xs text-foreground/70 leading-relaxed whitespace-pre-wrap">{text}</p>
    </EvidenceItem>
  );
}

export function EvidenceCards({ evidence }: { evidence: EvidenceData }) {
  const mc = evidence.metrics?.observations.length ?? 0;
  const lc = evidence.logs?.observations.length ?? 0;
  const ic = evidence.infra?.observations.length ?? 0;

  return (
    <Tabs defaultValue="metrics" className="w-full">
      <TabsList className="w-full bg-secondary/20 border border-border/25 rounded-lg p-0.5">
        <TabsTrigger value="metrics" className="flex-1 text-[10px] font-mono uppercase tracking-wider">Metrics ({mc})</TabsTrigger>
        <TabsTrigger value="logs" className="flex-1 text-[10px] font-mono uppercase tracking-wider">Logs ({lc})</TabsTrigger>
        <TabsTrigger value="infra" className="flex-1 text-[10px] font-mono uppercase tracking-wider">Infra ({ic})</TabsTrigger>
      </TabsList>

      <TabsContent value="metrics" className="space-y-2 mt-3">
        {evidence.timeSeries && evidence.timeSeries.length > 0 && (
          <div className="grid gap-2">
            {evidence.timeSeries.map((ts, i) => (
              <MetricChart key={`ts-${i}`} series={ts} />
            ))}
          </div>
        )}
        {evidence.metrics?.observations.map((obs, i) =>
          isString(obs) ? (
            <StringEvidence key={i} text={obs} index={i} />
          ) : isStructuredMetric(obs) ? (
            <EvidenceItem key={i} index={i}>
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs text-foreground/70">{obs.metric}</span>
                {obs.severity && <Badge variant={obs.severity === "critical" ? "destructive" : "secondary"} className="text-[10px]">{obs.severity}</Badge>}
              </div>
              <div className="flex items-center gap-3 mt-1.5">
                <span className="text-[11px] font-mono text-primary/70">{obs.currentValue}</span>
                <span className="text-[10px] text-muted-foreground/60">/</span>
                <span className="text-[11px] font-mono text-muted-foreground/70">baseline {obs.baselineValue}</span>
              </div>
            </EvidenceItem>
          ) : (
            <StringEvidence key={i} text={JSON.stringify(obs)} index={i} />
          )
        )}
        {mc === 0 && (!evidence.timeSeries || evidence.timeSeries.length === 0) && <p className="text-xs text-muted-foreground/65 py-4 text-center font-mono">No metric findings yet</p>}
      </TabsContent>

      <TabsContent value="logs" className="space-y-2 mt-3">
        {evidence.logs?.observations.map((obs, i) =>
          isString(obs) ? (
            <EvidenceItem key={i} index={i}>
              <pre className="font-mono text-xs text-foreground/70 leading-relaxed whitespace-pre-wrap">{obs}</pre>
            </EvidenceItem>
          ) : isStructuredLog(obs) ? (
            <EvidenceItem key={i} index={i}>
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs text-foreground/70">{obs.pattern}</span>
                <span className="text-[10px] font-mono text-accent/60">{obs.count}x</span>
              </div>
              {obs.sample && (
                <pre className="text-[11px] font-mono bg-background/60 rounded-md p-2.5 mt-2 overflow-x-auto text-muted-foreground/60 border border-border/20">{obs.sample}</pre>
              )}
            </EvidenceItem>
          ) : (
            <StringEvidence key={i} text={JSON.stringify(obs)} index={i} />
          )
        )}
        {lc === 0 && <p className="text-xs text-muted-foreground/65 py-4 text-center font-mono">No log findings yet</p>}
      </TabsContent>

      <TabsContent value="infra" className="space-y-2 mt-3">
        {evidence.infra?.observations.map((obs, i) =>
          isString(obs) ? (
            <StringEvidence key={i} text={obs} index={i} />
          ) : isStructuredInfra(obs) ? (
            <EvidenceItem key={i} index={i}>
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs text-foreground/70">{obs.resource}</span>
                <Badge variant={obs.status === "unhealthy" ? "destructive" : "secondary"} className="text-[10px]">{obs.status}</Badge>
              </div>
              <p className="text-[11px] text-muted-foreground/65 mt-1">{obs.detail}</p>
            </EvidenceItem>
          ) : (
            <StringEvidence key={i} text={JSON.stringify(obs)} index={i} />
          )
        )}
        {ic === 0 && <p className="text-xs text-muted-foreground/65 py-4 text-center font-mono">No infra findings yet</p>}
      </TabsContent>
    </Tabs>
  );
}
