import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { ServiceCard } from "./ServiceCard";
import { ConfirmHideDialog } from "./ConfirmHideDialog";
import { FirstRunBanner } from "./FirstRunBanner";
import { StatCard } from "./dashboard/StatCard";
import { InvestigationRow } from "./dashboard/InvestigationRow";
import { ToastContainer } from "./dashboard/ToastContainer";
import type { ToastItem } from "./dashboard/ToastContainer";
import { formatDuration, severityVariant, normalizeConfidence } from "@/lib/dashboard-utils";
import type { InvestigationSummary, Pattern, KpiStats } from "@/lib/dashboard-utils";
import type { ServiceConfig } from "../../config/schema.js";
import type { ServerMessage } from "../../types/ws-types.js";

interface DashboardProps {
  wsMessages: ServerMessage[];
  onInvestigationClick: (id: string) => void;
  onViewService: (serviceName: string) => void;
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

export function Dashboard({ wsMessages, onInvestigationClick, onViewService, onManageServices, onRunDiscovery }: DashboardProps) {
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
  const [searchQuery, setSearchQuery] = useState("");
  const [hiddenServices, setHiddenServices] = useState<Map<string, { reason: string | null; hidden_at: string }>>(new Map());
  const [staleServices, setStaleServices] = useState<Set<string>>(new Set());
  const [kpiStats, setKpiStats] = useState<KpiStats | null>(null);

  const [hideTarget, setHideTarget] = useState<{ name: string; defaultReason?: string } | null>(null);
  const [bulkHideTarget, setBulkHideTarget] = useState<string[] | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedServices, setSelectedServices] = useState<Set<string>>(new Set());

  const processedRef = useRef(0);
  const fetchSeqRef = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);

  // Fetch data from API (sequence counter prevents stale responses from overwriting newer data)
  async function fetchData() {
    const seq = ++fetchSeqRef.current;
    try {
      const [invRes, svcRes, healthRes, hiddenRes, staleRes, kpiRes] = await Promise.all([
        fetch("/api/investigations?limit=100"),
        fetch("/api/services"),
        fetch("/api/services/health"),
        fetch("/api/services/hidden"),
        fetch("/api/services/stale-unknown?days=7"),
        fetch("/api/stats/kpi"),
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
      if (hiddenRes.ok) {
        const hData = await hiddenRes.json() as Array<{ service: string; reason: string | null; hidden_at: string }>;
        setHiddenServices(new Map(hData.map(h => [h.service, { reason: h.reason, hidden_at: h.hidden_at }])));
      }
      if (staleRes.ok) {
        const sData = await staleRes.json() as string[];
        setStaleServices(new Set(sData));
      }
      if (kpiRes.ok) {
        setKpiStats(await kpiRes.json() as KpiStats);
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

  // Keyboard shortcuts: / to focus search, Escape to clear
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        if (e.key === "Escape" && e.target === searchRef.current) {
          setSearchQuery("");
          searchRef.current?.blur();
          e.preventDefault();
        }
        return;
      }
      if (e.key === "/" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
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
  // KPI stats are fetched from server-side aggregation (no client-side computation)

  // Derive hidden set for quick lookup
  const hiddenSet = useMemo(() => new Set(hiddenServices.keys()), [hiddenServices]);

  // Live health KPI counts from /api/services/health (exclude hidden)
  const healthKpi = useMemo(() => {
    let healthy = 0, degraded = 0, down = 0, unknown = 0;
    for (const svc of services) {
      if (hiddenSet.has(svc.name)) continue;
      const status = healthData[svc.name] ?? "unknown";
      if (status === "healthy") healthy++;
      else if (status === "degraded") degraded++;
      else if (status === "down") down++;
      else unknown++;
    }
    return { healthy, degraded, down, unknown };
  }, [healthData, services, hiddenSet]);

  // Visible (non-hidden) service count for header
  const visibleServiceCount = useMemo(() => services.filter(s => !hiddenSet.has(s.name)).length, [services, hiddenSet]);

  // Group services by health category, sorted alphabetically within each
  // Search filters across ALL groups including hidden
  const serviceGroups = useMemo(() => {
    const unhealthy: typeof services = [];
    const healthy: typeof services = [];
    const unknown: typeof services = [];
    const hidden: typeof services = [];
    const query = searchQuery.toLowerCase();
    for (const svc of services) {
      if (query && !svc.name.toLowerCase().includes(query)) continue;
      if (hiddenSet.has(svc.name)) { hidden.push(svc); continue; }
      const status = healthData[svc.name] ?? "unknown";
      if (status === "down" || status === "degraded") unhealthy.push(svc);
      else if (status === "healthy") healthy.push(svc);
      else unknown.push(svc);
    }
    unhealthy.sort((a, b) => a.name.localeCompare(b.name));
    healthy.sort((a, b) => a.name.localeCompare(b.name));
    unknown.sort((a, b) => a.name.localeCompare(b.name));
    hidden.sort((a, b) => a.name.localeCompare(b.name));
    return { unhealthy, healthy, unknown, hidden };
  }, [services, healthData, hiddenSet, searchQuery]);

  // Collapsed state for each group (unhealthy always open by default, hidden always collapsed)
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({
    unhealthy: false,
    healthy: false,
    unknown: true,
    hidden: true,
  });
  const toggleGroup = (group: string) => setCollapsedGroups(prev => ({ ...prev, [group]: !prev[group] }));

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

  // ── Hide/unhide handlers ──────────────────────────────────────────────

  const handleHideConfirm = useCallback(async (reason: string) => {
    if (bulkHideTarget) {
      const res = await fetch("/api/services/hidden/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ services: bulkHideTarget, reason: reason || undefined }),
      });
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      setHiddenServices(prev => {
        const next = new Map(prev);
        for (const name of bulkHideTarget) next.set(name, { reason: reason || null, hidden_at: new Date().toISOString() });
        return next;
      });
      for (const name of bulkHideTarget) {
        setToasts(t => [...t.slice(-9), { id: `hide_${name}_${Date.now()}`, service: name, status: "hidden" as const, timestamp: Date.now() }]);
      }
      setBulkHideTarget(null);
      setSelectionMode(false);
      setSelectedServices(new Set());
    } else if (hideTarget) {
      const res = await fetch("/api/services/hidden", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: hideTarget.name, reason: reason || undefined }),
      });
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      setHiddenServices(prev => {
        const next = new Map(prev);
        next.set(hideTarget.name, { reason: reason || null, hidden_at: new Date().toISOString() });
        return next;
      });
      setToasts(t => [...t.slice(-9), { id: `hide_${hideTarget.name}_${Date.now()}`, service: hideTarget.name, status: "hidden" as const, timestamp: Date.now() }]);
      setHideTarget(null);
    }
  }, [hideTarget, bulkHideTarget]);

  const handleUnhide = useCallback(async (name: string) => {
    try {
      await fetch(`/api/services/hidden/${encodeURIComponent(name)}`, { method: "DELETE" });
      setHiddenServices(prev => { const next = new Map(prev); next.delete(name); return next; });
      setToasts(t => [...t.slice(-9), { id: `unhide_${name}_${Date.now()}`, service: name, status: "unhidden" as const, timestamp: Date.now() }]);
    } catch { /* toast already shown for the action */ }
  }, []);

  const toggleServiceSelection = useCallback((name: string) => {
    setSelectedServices(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }, []);

  return (
    <div className="h-full overflow-y-auto px-4 py-5 relative z-[2] dashboard-container">
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
          <span>{visibleServiceCount} services monitored</span>
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
              {hiddenServices.size > 0 && (
                <span className="flex items-center gap-1">
                  <svg width="6" height="6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground/20">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                    <line x1="1" y1="1" x2="23" y2="23"/>
                  </svg>
                  <span className="text-muted-foreground/30">{hiddenServices.size} hidden</span>
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
        <div className="grid grid-cols-3 gap-3 dashboard-kpi-grid">
          <StatCard
            label="Investigations"
            value={String(kpiStats?.investigations.total ?? 0)}
            detail={<>{kpiStats?.investigations.complete ?? 0} complete · {kpiStats?.investigations.failed ?? 0} failed · {kpiStats?.confidence.avg != null ? normalizeConfidence(kpiStats.confidence.avg) : "—"} confidence</>}
            loading={loading}
          />
          <StatCard
            label="Services Health"
            value={`${healthKpi.healthy}/${visibleServiceCount}`}
            variant={healthKpi.healthy === visibleServiceCount && visibleServiceCount > 0 ? "success" : "default"}
            detail={<>{healthKpi.down > 0 ? <span className="text-destructive/80">{healthKpi.down} down</span> : <>{healthKpi.down} down</>} · {healthKpi.degraded > 0 ? <span className="text-warning/80">{healthKpi.degraded} degraded</span> : <>{healthKpi.degraded} degraded</>} · {healthKpi.unknown} unknown</>}
            loading={loading}
          />
          <StatCard
            label="Avg MTTR (7d)"
            value={kpiStats && kpiStats.mttr.completed7d > 0 ? formatDuration(kpiStats.mttr.avg7d) : "\u2014"}
            detail={kpiStats && kpiStats.mttr.completed7d > 0 ? `${kpiStats.mttr.completed7d} completed investigations` : "needs completed investigations"}
            trend={kpiStats?.mttr.trend}
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

      {/* Section D: Services Grid (grouped) */}
      <section aria-label="Services" className="mb-6">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-0.5 h-3.5 rounded-full bg-primary/60" />
          <h2 className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">Services</h2>
          <div className="flex-1" />
          <div className="relative">
            <input
              ref={searchRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter services..."
              aria-label="Filter services"
              className="font-mono text-[10px] text-muted-foreground/60 placeholder:text-muted-foreground/40 bg-card/50 border border-border/40 rounded px-2 py-1 h-7 w-40 focus:w-52 focus:border-primary/30 focus:outline-none transition-all"
            />
            {!searchQuery && (
              <kbd className="absolute right-1.5 top-1/2 -translate-y-1/2 font-mono text-[8px] text-muted-foreground/30 border border-border/30 rounded px-1 py-0.5 pointer-events-none">/</kbd>
            )}
            {searchQuery && (
              <button
                onClick={() => { setSearchQuery(""); searchRef.current?.focus(); }}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground/40 hover:text-muted-foreground/60 transition-colors"
                aria-label="Clear search"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M18 6 6 18M6 6l12 12"/>
                </svg>
              </button>
            )}
          </div>
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
            {/* Search no-results state */}
            {searchQuery && serviceGroups.unhealthy.length === 0 && serviceGroups.healthy.length === 0 && serviceGroups.unknown.length === 0 && serviceGroups.hidden.length === 0 && (
              <div className="py-8 flex flex-col items-center gap-3">
                <svg width="48" height="48" viewBox="0 0 64 64" fill="none" className="text-muted-foreground/15" aria-hidden="true">
                  <circle cx="26" cy="26" r="16" stroke="currentColor" strokeWidth="1.5" />
                  <line x1="38" y1="38" x2="52" y2="52" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  <line x1="20" y1="26" x2="32" y2="26" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.3" />
                </svg>
                <div className="text-center">
                  <p className="font-body text-[13px] text-muted-foreground/70">No matching services</p>
                  <p className="font-mono text-[10px] text-muted-foreground/50 mt-1">try a different query</p>
                </div>
              </div>
            )}
            {/* Service groups */}
            {([
              { key: "unhealthy", label: "Unhealthy", services: serviceGroups.unhealthy, dotColor: "bg-destructive/70", textColor: "text-destructive/70", isHidden: false },
              { key: "healthy", label: "Healthy", services: serviceGroups.healthy, dotColor: "bg-success/70", textColor: "text-success/70", isHidden: false },
              { key: "unknown", label: "Unknown", services: serviceGroups.unknown, dotColor: "bg-muted-foreground/30", textColor: "text-muted-foreground/50", isHidden: false },
              ...(serviceGroups.hidden.length > 0 ? [{ key: "hidden" as const, label: "Hidden", services: serviceGroups.hidden, dotColor: "bg-muted-foreground/20", textColor: "text-muted-foreground/30", isHidden: true }] : []),
            ]).filter(g => g.services.length > 0).map((group) => (
              <div key={group.key} className="mb-4">
                <button
                  onClick={() => toggleGroup(group.key)}
                  className="flex items-center gap-2 mb-2 py-2.5 px-2 -ml-2 rounded hover:bg-secondary/30 transition-colors w-full text-left min-h-[44px]"
                >
                  <span className={`text-[9px] font-mono ${collapsedGroups[group.key] ? "text-muted-foreground/40" : "text-muted-foreground/60"}`}>
                    {collapsedGroups[group.key] ? "▸" : "▾"}
                  </span>
                  <span className={`w-1.5 h-1.5 rounded-full ${group.dotColor}`} />
                  <span className={`text-[10px] font-mono font-medium uppercase tracking-[0.1em] ${group.textColor}`}>
                    {group.label}
                  </span>
                  <span className="text-[9px] font-mono text-muted-foreground/35">{group.services.length}</span>
                  {group.key === "unknown" && group.services.length > 0 && (
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => { e.stopPropagation(); setBulkHideTarget(group.services.map(s => s.name)); }}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); setBulkHideTarget(group.services.map(s => s.name)); } }}
                      className="ml-auto text-[9px] font-mono text-muted-foreground/40 hover:text-destructive/60 transition-colors"
                    >
                      hide all
                    </span>
                  )}
                </button>
                {!collapsedGroups[group.key] && (
                  <div className="grid grid-cols-3 gap-3 dashboard-services-grid">
                    {group.services.map((svc, i) => (
                      <div key={svc.name} className={`animate-fade-up delay-${Math.min(i + 1, 8)}`}>
                        <ServiceCard
                          name={svc.name}
                          onClick={() => onViewService(svc.name)}
                          lastInvestigation={serviceInvData.get(svc.name)?.lastInvestigation ?? null}
                          investigationCount={serviceInvData.get(svc.name)?.count ?? 0}
                          healthStatus={healthData[svc.name] as "healthy" | "degraded" | "down" | "unknown" | undefined}
                          onHide={group.isHidden ? undefined : () => setHideTarget({ name: svc.name, defaultReason: staleServices.has(svc.name) ? "No monitoring data for 7+ days" : undefined })}
                          onUnhide={group.isHidden ? () => handleUnhide(svc.name) : undefined}
                          isHidden={group.isHidden}
                          suggestHide={!group.isHidden && staleServices.has(svc.name)}
                          hideReason={hiddenServices.get(svc.name)?.reason}
                          selectionMode={selectionMode && !group.isHidden}
                          selected={selectedServices.has(svc.name)}
                          onToggleSelect={() => toggleServiceSelection(svc.name)}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
            <div className="flex items-center gap-3 mt-1 pl-3">
              <button onClick={onManageServices} className="py-3 px-2 min-h-[44px] text-[10px] font-mono text-primary/70 hover:text-primary transition-colors">Manage</button>
              <span className="text-muted-foreground/20">&middot;</span>
              <button onClick={onRunDiscovery} className="text-[10px] font-mono text-primary/70 hover:text-primary transition-colors py-3 px-2 min-h-[44px]">Re-discover</button>
              <span className="text-muted-foreground/20">&middot;</span>
              <button
                onClick={() => { setSelectionMode(!selectionMode); setSelectedServices(new Set()); }}
                className={`text-[10px] font-mono transition-colors py-3 px-2 min-h-[44px] ${
                  selectionMode ? "text-destructive/70 hover:text-destructive" : "text-primary/70 hover:text-primary"
                }`}
              >
                {selectionMode ? "Cancel" : "Select"}
              </button>
            </div>
            {/* Bulk selection action bar */}
            {selectionMode && selectedServices.size > 0 && (
              <div className="mt-3 flex items-center justify-between bg-card/90 backdrop-blur-sm border-t border-border/40 rounded-lg px-4 py-3 animate-fade-up">
                <span className="font-mono text-[10px] text-muted-foreground/60">{selectedServices.size} selected</span>
                <button
                  onClick={() => setBulkHideTarget([...selectedServices])}
                  className="font-mono text-[10px] uppercase tracking-[0.1em] bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors py-2 px-4 rounded min-h-[44px]"
                >
                  Hide {selectedServices.size} selected
                </button>
              </div>
            )}
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

      {/* Hide confirmation dialog */}
      {(hideTarget || bulkHideTarget) && (
        <ConfirmHideDialog
          serviceName={hideTarget?.name ?? null}
          serviceNames={bulkHideTarget ?? undefined}
          defaultReason={hideTarget?.defaultReason}
          onConfirm={handleHideConfirm}
          onCancel={() => { setHideTarget(null); setBulkHideTarget(null); }}
        />
      )}
    </div>
  );
}
