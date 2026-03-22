import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { ServiceCard } from "./ServiceCard";
import { FirstRunBanner } from "./FirstRunBanner";
import { StatCard } from "./dashboard/StatCard";
import { InvestigationRow } from "./dashboard/InvestigationRow";
import { ToastContainer } from "./dashboard/ToastContainer";
import type { ToastItem } from "./dashboard/ToastContainer";
import { formatTokens } from "@/lib/formatTokens";
import { formatDuration, severityVariant, computeKpiData } from "@/lib/dashboard-utils";
import type { InvestigationSummary, Pattern } from "@/lib/dashboard-utils";
import type { ServiceConfig } from "../../config/schema.js";
import type { ServerMessage } from "../../types/ws-types.js";

interface DashboardProps {
  wsMessages: ServerMessage[];
  onInvestigationClick: (id: string) => void;
  onInvestigateService: (serviceName: string) => void;
  onManageServices: () => void;
  onRunDiscovery: () => void;
}

interface ActiveInvestigation {
  id: string;
  service: string;
  startTime: number;
  phase: string;
  failed?: boolean;
  failedAt?: number;
}

type HealthStatus = "healthy" | "degraded" | "down" | "unknown";

export function Dashboard({ wsMessages, onInvestigationClick, onInvestigateService, onManageServices, onRunDiscovery }: DashboardProps) {
  const [services, setServices] = useState<ServiceConfig[]>([]);
  const [investigations, setInvestigations] = useState<InvestigationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [patterns, setPatterns] = useState<Pattern[]>([]);
  const [patternsExpanded, setPatternsExpanded] = useState(false);
  const [activeInvestigations, setActiveInvestigations] = useState<Map<string, ActiveInvestigation>>(new Map());
  const [fetchError, setFetchError] = useState<string | null>(null);
  // refreshProgress state removed — replaced with CSS breathing animation
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [servicesExpanded, setServicesExpanded] = useState(false);
  const [healthData, setHealthData] = useState<Record<string, HealthStatus>>({});

  const processedRef = useRef(0);
  const fetchSeqRef = useRef(0);

  // Fetch data from API (sequence counter prevents stale responses from overwriting newer data)
  async function fetchData() {
    const seq = ++fetchSeqRef.current;
    try {
      const [invRes, svcRes, healthRes] = await Promise.all([
        fetch("/api/investigations?limit=100"),
        fetch("/api/services"),
        fetch("/api/services/health"),
      ]);
      if (!invRes.ok || !svcRes.ok) {
        throw new Error(`Server error: ${!invRes.ok ? invRes.status : svcRes.status}`);
      }
      if (seq !== fetchSeqRef.current) return; // stale response — newer fetch in flight
      const [invData, svcData] = await Promise.all([invRes.json(), svcRes.json()]);
      if (healthRes.ok) {
        const hData = await healthRes.json();
        setHealthData(hData as Record<string, HealthStatus>);
      }
      setInvestigations(invData);
      setServices(svcData);
      // Reconcile: remove active investigations that are now complete/failed in DB
      setActiveInvestigations(prev => {
        if (prev.size === 0) return prev;
        let changed = false;
        const next = new Map(prev);
        const completedOrFailed = new Set(
          (invData as InvestigationSummary[])
            .filter(inv => inv.status === "complete" || inv.status === "failed")
            .map(inv => inv.id)
        );
        for (const id of next.keys()) {
          if (completedOrFailed.has(id)) {
            next.delete(id);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
      setFetchError(null);
      setLastUpdated(new Date());
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load data";
      console.error("Dashboard fetch failed:", message);
      setFetchError(message);
    }
    setLoading(false);
  }

  // Initial data fetch
  useEffect(() => {
    fetchData();
  }, []);

  // Auto-refresh every 60 seconds
  useEffect(() => {
    const refreshTick = setInterval(() => fetchData(), 60_000);
    return () => clearInterval(refreshTick);
  }, []);

  // WS-driven re-fetch and active investigation tracking
  useEffect(() => {
    const start = processedRef.current;
    if (wsMessages.length <= start) return;
    processedRef.current = wsMessages.length;

    let shouldRefetch = false;

    for (let i = start; i < wsMessages.length; i++) {
      const msg = wsMessages[i];

      if (msg.type === "investigation:started") {
        setActiveInvestigations(prev => {
          const next = new Map(prev);
          next.set(msg.id, {
            id: msg.id,
            service: msg.service,
            startTime: Date.now(),
            phase: "starting",
          });
          return next;
        });
      }

      if (msg.type === "investigation:phase") {
        setActiveInvestigations(prev => {
          const next = new Map(prev);
          const existing = next.get(msg.id);
          if (existing && !existing.failed) {
            next.set(msg.id, { ...existing, phase: msg.phase });
          }
          return next;
        });
      }

      if (msg.type === "investigation:complete") {
        setActiveInvestigations(prev => {
          const next = new Map(prev);
          const service = next.get(msg.id)?.service ?? "Unknown";
          next.delete(msg.id);
          setToasts(t => [...t.slice(-9), { id: msg.id, service, status: "complete", timestamp: Date.now() }]);
          return next;
        });
        shouldRefetch = true;
      }

      if (msg.type === "investigation:failed") {
        setActiveInvestigations(prev => {
          const next = new Map(prev);
          const existing = next.get(msg.id);
          const service = existing?.service ?? "Unknown";
          if (existing) {
            next.set(msg.id, { ...existing, failed: true, failedAt: Date.now() });
          }
          setToasts(t => [...t.slice(-9), { id: msg.id, service, status: "failed", timestamp: Date.now() }]);
          return next;
        });
        shouldRefetch = true;
      }
    }

    if (shouldRefetch) {
      fetchData();
    }
  }, [wsMessages]);

  // Clean up stale active investigations (failed: 30min, non-failed: 2h to allow long investigations)
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      const FAILED_MAX_AGE_MS = 30 * 60 * 1000;
      const ACTIVE_MAX_AGE_MS = 2 * 60 * 60 * 1000;
      setActiveInvestigations(prev => {
        let changed = false;
        const next = new Map(prev);
        for (const [id, inv] of next) {
          const isFailedStale = inv.failed && inv.failedAt && now - inv.failedAt > FAILED_MAX_AGE_MS;
          const isStartStale = !inv.failed && now - inv.startTime > ACTIVE_MAX_AGE_MS;
          if (isFailedStale || isStartStale) {
            next.delete(id);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 60_000);
    return () => clearInterval(interval);
  }, []);

  // Fetch patterns for top 3 services after investigations load
  useEffect(() => {
    if (investigations.length === 0) return;
    const serviceCounts = new Map<string, number>();
    for (const inv of investigations) {
      serviceCounts.set(inv.service, (serviceCounts.get(inv.service) ?? 0) + 1);
    }
    const topServices = [...serviceCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name]) => name);

    Promise.all(
      topServices.map(svc => fetch(`/api/patterns?service=${encodeURIComponent(svc)}`).then(r => r.json()).catch(() => []))
    ).then(results => setPatterns(results.flat()));
  }, [investigations]);

  // KPI computations
  const kpiData = useMemo(() => computeKpiData(investigations, services), [investigations, services]);

  // Live health KPI counts from /api/services/health
  const healthKpi = useMemo(() => {
    let healthy = 0, degraded = 0, down = 0, unknown = 0;
    for (const svc of services) {
      const status = healthData[svc.name] ?? "unknown";
      if (status === "healthy") healthy++;
      else if (status === "degraded") degraded++;
      else if (status === "down") down++;
      else unknown++;
    }
    return { healthy, degraded, down, unknown };
  }, [healthData, services]);

  // Sort services by health: down first, then degraded, then unknown, then healthy
  const sortedServices = useMemo(() => {
    const order: Record<string, number> = { down: 0, degraded: 1, unknown: 2, healthy: 3 };
    return [...services].sort((a, b) => {
      const aStatus = healthData[a.name] ?? "unknown";
      const bStatus = healthData[b.name] ?? "unknown";
      const aOrder = order[aStatus] ?? 2;
      const bOrder = order[bStatus] ?? 2;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return a.name.localeCompare(b.name);
    });
  }, [services, healthData]);

  // Format elapsed time for active investigations
  const formatElapsed = (startTime: number): string => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    if (elapsed < 60) return `${elapsed}s`;
    return `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
  };

  // Force re-render for elapsed time updates
  const [, setTick] = useState(0);
  useEffect(() => {
    if (activeInvestigations.size === 0) return;
    const interval = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, [activeInvestigations.size]);

  const activeList = useMemo(() => [...activeInvestigations.values()], [activeInvestigations]);

  // Pre-compute per-service investigation data for ServiceCards
  const serviceInvData = useMemo(() => {
    const map = new Map<string, { lastInvestigation: { status: string; created_at: string } | null; count: number }>();
    for (const svc of services) {
      const svcInvs = investigations.filter(inv => inv.service === svc.name);
      const latest = svcInvs.length > 0
        ? svcInvs.reduce((a, b) => new Date(a.created_at) > new Date(b.created_at) ? a : b)
        : null;
      map.set(svc.name, {
        lastInvestigation: latest ? { status: latest.status, created_at: latest.created_at } : null,
        count: svcInvs.length,
      });
    }
    return map;
  }, [investigations, services]);

  // Format and compute freshness of last updated timestamp
  const formatLastUpdated = (date: Date): string => {
    return date.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };

  const isStale = lastUpdated ? Date.now() - lastUpdated.getTime() > 2 * 60 * 1000 : false;

  const handleToastDismiss = (id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  return (
    <div className="h-full overflow-y-auto p-6 relative z-[2] dashboard-container">
      {/* Auto-refresh breathing indicator */}
      <div className="absolute top-0 left-0 right-0 z-10 h-[2px] bg-primary/8">
        <div className="h-full w-full bg-primary/30 animate-refresh-breathe" />
      </div>
      {/* First-run banner */}
      {services.length === 0 && !bannerDismissed && (
        <FirstRunBanner onRunDiscovery={onRunDiscovery} onDismiss={() => setBannerDismissed(true)} />
      )}

      {/* Section A: Title */}
      <div className="mb-6 animate-fade-up">
        <h1 className="font-display text-xl font-bold tracking-tight text-foreground/90">Operations Desk</h1>
        <p className="text-xs font-mono text-muted-foreground/70 mt-1 tracking-wide flex items-center gap-2 flex-wrap">
          <span>{services.length} services monitored</span>
          {lastUpdated && (
            <span className={`text-[9px] tabular-nums ${isStale ? "text-warning/60" : "text-muted-foreground/50"}`}>
              {" · "}Updated {formatLastUpdated(lastUpdated)}
            </span>
          )}
          {services.length > 0 && (
            <span className="text-[10px] font-mono flex items-center gap-2">
              <span className="text-muted-foreground/40">·</span>
              {healthKpi.healthy > 0 && (
                <span className="flex items-center gap-1">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-success/80" />
                  <span className="text-muted-foreground/60">{healthKpi.healthy} healthy</span>
                </span>
              )}
              {healthKpi.degraded > 0 && (
                <span className="flex items-center gap-1">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-warning/80" />
                  <span className="text-muted-foreground/60">{healthKpi.degraded} degraded</span>
                </span>
              )}
              {healthKpi.down > 0 && (
                <span className="flex items-center gap-1">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-destructive/80" />
                  <span className="text-muted-foreground/60">{healthKpi.down} down</span>
                </span>
              )}
              {healthKpi.unknown > 0 && (
                <span className="flex items-center gap-1">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-muted-foreground/30" />
                  <span className="text-muted-foreground/40">{healthKpi.unknown} unknown</span>
                </span>
              )}
            </span>
          )}
        </p>
      </div>

      {/* Error banner */}
      {fetchError && (
        <div className="mb-6 rounded-lg border border-destructive/15 bg-destructive/6 px-4 py-3 animate-fade-up">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-destructive text-sm flex-shrink-0">⚠</span>
              <div className="min-w-0">
                <p className="font-body text-[13px] text-foreground/70">Unable to load dashboard data</p>
                <p className="font-mono text-[10px] text-muted-foreground/50 truncate">{fetchError}</p>
              </div>
            </div>
            <button
              onClick={() => { setFetchError(null); fetchData(); }}
              className="flex-shrink-0 font-mono text-[10px] uppercase tracking-[0.1em] text-destructive hover:text-destructive/80 transition-colors py-2 px-3 min-h-[44px]"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {/* Section B: KPI Stat Cards */}
      <section aria-label="Overview" className="mb-6">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-0.5 h-3.5 rounded-full bg-primary/60" />
          <h2 className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">Overview</h2>
        </div>
        <div className="grid grid-cols-2 gap-3 dashboard-kpi-grid">
          <StatCard
            label="Investigations"
            value={String(kpiData.total)}
            detail={`${kpiData.active} active \u00b7 ${kpiData.complete} complete \u00b7 ${kpiData.failed} failed`}
            loading={loading}
          />
          <StatCard
            label="Services Healthy"
            value={`${kpiData.healthyCount}/${kpiData.totalServices}`}
            variant={kpiData.healthyCount === kpiData.totalServices && kpiData.totalServices > 0 ? "success" : "default"}
            detail={`${kpiData.criticalCount} critical \u00b7 ${kpiData.degradedCount} degraded`}
            loading={loading}
          />
          <StatCard
            label="Avg MTTR (7d)"
            value={kpiData.completedLast7dCount > 0 ? formatDuration(kpiData.avgMttr7d) : "\u2014"}
            detail={kpiData.completedLast7dCount > 0 ? `${kpiData.completedLast7dCount} completed investigations` : "needs completed investigations"}
            trend={kpiData.mttrTrend}
            loading={loading}
          />
          <StatCard
            label="Token Usage"
            value={formatTokens(kpiData.totalTokens)}
            detail={`${formatTokens(kpiData.totalInput)} input \u00b7 ${formatTokens(kpiData.totalOutput)} output`}
            loading={loading}
          />
        </div>
      </section>

      {/* Section C: Active Investigations */}
      {activeList.length > 0 && (
        <section aria-label="Active" className="mb-6 animate-fade-up">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-0.5 h-3.5 rounded-full bg-accent/60" />
            <h2 className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">Active</h2>
          </div>
          <div className="rounded-lg border border-accent/20 bg-accent/5 p-3 space-y-2">
            {activeList.map(inv => (
              <div key={inv.id} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className={`w-1.5 h-1.5 rounded-full ${inv.failed ? "bg-destructive" : "bg-accent animate-status-pulse"}`} />
                  <span className="font-body text-sm font-medium text-foreground/80">{inv.service}</span>
                  <Badge variant="secondary" className="text-[10px] py-0 h-4">{inv.phase}</Badge>
                </div>
                <span className="font-mono text-[10px] text-muted-foreground/65">{formatElapsed(inv.startTime)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Section D: Services Grid */}
      <section aria-label="Services" className="mb-6">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-0.5 h-3.5 rounded-full bg-primary/60" />
          <h2 className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">Services</h2>
        </div>
        {services.length === 0 ? (
          <div className="py-8 flex flex-col items-center gap-3">
            <svg width="48" height="48" viewBox="0 0 64 64" fill="none" className="text-muted-foreground/15" aria-hidden="true">
              <circle cx="32" cy="32" r="24" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 3" />
              <path d="M32 16v32M16 32h32" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.5" />
              <circle cx="32" cy="32" r="4" stroke="currentColor" strokeWidth="1.5" />
              <path d="M32 8l2 4-2-1-2 1 2-4z" stroke="currentColor" strokeWidth="1" fill="currentColor" opacity="0.4" />
            </svg>
            <div className="text-center">
              <p className="font-body text-[13px] text-muted-foreground/70">No services configured</p>
            </div>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 dashboard-services-grid">
              {(servicesExpanded ? sortedServices : sortedServices.slice(0, 9)).map((svc, i) => (
                <div key={svc.name} className={`animate-fade-up delay-${Math.min(i + 1, 8)}`}>
                  <ServiceCard
                    name={svc.name}
                    onClick={() => onInvestigateService(svc.name)}
                    lastInvestigation={serviceInvData.get(svc.name)?.lastInvestigation ?? null}
                    investigationCount={serviceInvData.get(svc.name)?.count ?? 0}
                    healthStatus={healthData[svc.name] as "healthy" | "degraded" | "down" | "unknown" | undefined}
                  />
                </div>
              ))}
            </div>
            <div className="flex items-center gap-3 mt-3 pl-3">
              {services.length > 9 && (
                <button
                  onClick={() => setServicesExpanded(!servicesExpanded)}
                  className="py-3 px-2 min-h-[44px] text-[10px] font-mono text-primary/70 hover:text-primary transition-colors"
                >
                  {servicesExpanded ? "Show less" : `Show all ${services.length}`}
                </button>
              )}
              {services.length > 9 && <span className="text-muted-foreground/20">&middot;</span>}
              <button onClick={onManageServices} className="py-3 px-2 min-h-[44px] text-[10px] font-mono text-primary/70 hover:text-primary transition-colors">Manage</button>
              <span className="text-muted-foreground/20">&middot;</span>
              <button onClick={onRunDiscovery} className="text-[10px] font-mono text-primary/70 hover:text-primary transition-colors py-3 px-2 min-h-[44px]">Re-discover</button>
            </div>
          </>
        )}
      </section>

      {/* Section E: Investigation Log */}
      <section aria-label="Investigation Log" className="mb-6">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-0.5 h-3.5 rounded-full bg-primary/60" />
          <h2 className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">Investigation Log</h2>
        </div>
        {loading ? (
          <div className="space-y-2">
            {[0, 1, 2].map(i => (
              <div key={i} className="h-16 rounded-lg shimmer-skeleton" style={{ animationDelay: `${i * 0.1}s` }} />
            ))}
          </div>
        ) : investigations.length === 0 ? (
          <div className="py-8 flex flex-col items-center gap-3">
            <svg width="48" height="48" viewBox="0 0 64 64" fill="none" className="text-muted-foreground/15" aria-hidden="true">
              <rect x="12" y="8" width="32" height="44" rx="2" stroke="currentColor" strokeWidth="1.5" />
              <line x1="20" y1="20" x2="36" y2="20" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.3" />
              <line x1="20" y1="28" x2="36" y2="28" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.3" />
              <line x1="20" y1="36" x2="28" y2="36" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.3" />
              <circle cx="44" cy="44" r="12" stroke="currentColor" strokeWidth="1.5" />
              <line x1="52" y1="52" x2="58" y2="58" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <div className="text-center">
              <p className="font-body text-[13px] text-muted-foreground/70">No investigations yet</p>
              <p className="font-mono text-[10px] text-muted-foreground/50 mt-1">start one from chat or click a service</p>
            </div>
          </div>
        ) : (
          <div className="space-y-1.5">
            {investigations.slice(0, 15).map((inv, i) => (
              <div key={inv.id} className={`animate-fade-up delay-${Math.min(i + 1, 8)}`}>
                <InvestigationRow investigation={inv} onClick={onInvestigationClick} />
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Section F: Learned Patterns */}
      {patterns.length > 0 && (
        <section aria-label="Learned Patterns" className="mb-6">
          <button
            aria-expanded={patternsExpanded}
            onClick={() => setPatternsExpanded(!patternsExpanded)}
            className="flex items-center gap-2 mb-3 group cursor-pointer"
          >
            <div className="w-0.5 h-3.5 rounded-full bg-primary/40" />
            <h2 className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60 group-hover:text-muted-foreground/80 transition-colors">
              Learned Patterns ({patterns.length})
            </h2>
            <svg className={`w-3 h-3 text-muted-foreground/40 transition-transform ${patternsExpanded ? "rotate-180" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="m6 9 6 6 6-6"/>
            </svg>
          </button>
          {patternsExpanded && (
            <div className="space-y-1.5 animate-fade-in">
              {patterns.map((p, i) => (
                <div key={i} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-card/30">
                  <Badge variant={severityVariant(p.severity)} className="text-[10px] py-0 h-4">{p.severity}</Badge>
                  <span className="font-body text-xs text-foreground/70">{p.service}</span>
                  <span className="font-mono text-[10px] text-muted-foreground/50 truncate">{p.rootCause}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <ToastContainer
        toasts={toasts}
        onDismiss={handleToastDismiss}
        onClickToast={(id) => { handleToastDismiss(id); onInvestigationClick(id); }}
      />
    </div>
  );
}
