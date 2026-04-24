import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { HealthStrip } from "./HealthStrip";
import { StatCard } from "./dashboard/StatCard";
import { InvestigationRow } from "./dashboard/InvestigationRow";
import { ToastContainer } from "./dashboard/ToastContainer";
import { EventStream } from "./dashboard/EventStream.js";
import type { ToastItem } from "./dashboard/ToastContainer";
import {
  formatDuration,
  severityVariant,
  normalizeConfidence,
} from "@/lib/dashboard-utils";
import type {
  InvestigationSummary,
  Pattern,
  KpiStats,
} from "@/lib/dashboard-utils";
import { useStackContext } from "../contexts/StackContext";
import { useRecentEvents } from "../hooks/useRecentEvents.js";
import type { ServiceConfig } from "../../config/schema.js";
import type { ServerMessage } from "../../types/ws-types.js";

interface DashboardProps {
  wsMessages: ServerMessage[];
  onInvestigationClick: (id: string) => void;
  onViewService: (serviceName: string) => void;
  onViewAllServices: () => void;
  stackName?: string;
  setupStage?: import("../hooks/useSetupStage").SetupStage | null;
  setupDismissed?: boolean;
  onResumeSetup?: () => void;
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

export function Dashboard({
  wsMessages,
  onInvestigationClick,
  onViewService,
  onViewAllServices,
  stackName,
  setupStage,
  setupDismissed,
  onResumeSetup,
}: DashboardProps) {
  const { stackFetch } = useStackContext();
  const [services, setServices] = useState<ServiceConfig[]>([]);
  const [investigations, setInvestigations] = useState<InvestigationSummary[]>(
    [],
  );
  // Total count matching any filter (none applied on the dashboard snippet) —
  // used to render the "View all N →" link when the list exceeds the snippet
  // cap of 10.
  const [investigationsTotal, setInvestigationsTotal] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [patterns, setPatterns] = useState<Pattern[]>([]);
  const [patternsExpanded, setPatternsExpanded] = useState(false);
  const [activeInvestigations, setActiveInvestigations] = useState<
    Map<string, ActiveInvestigation>
  >(new Map());
  const [fetchError, setFetchError] = useState<string | null>(null);
  // refreshProgress state removed — replaced with CSS breathing animation
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [healthData, setHealthData] = useState<Record<string, HealthStatus>>(
    {},
  );
  const [hiddenServices, setHiddenServices] = useState<
    Map<string, { reason: string | null; hidden_at: string }>
  >(new Map());
  const [kpiStats, setKpiStats] = useState<KpiStats | null>(null);

  const {
    events: recentEvents,
    loading: recentEventsLoading,
    error: recentEventsError,
    truncated: recentEventsTruncated,
  } = useRecentEvents({ limit: 50, pollMs: 5000 });

  const processedRef = useRef(0);
  const fetchSeqRef = useRef(0);

  // Fetch data from API (sequence counter prevents stale responses from overwriting newer data)
  async function fetchData() {
    const seq = ++fetchSeqRef.current;
    try {
      const [invRes, svcRes, healthRes, hiddenRes, kpiRes] = await Promise.all([
        stackFetch("/api/investigations?limit=100"),
        stackFetch("/api/services"),
        stackFetch("/api/services/health"),
        stackFetch("/api/services/hidden"),
        stackFetch("/api/stats/kpi"),
      ]);
      if (!invRes.ok || !svcRes.ok) {
        throw new Error(
          `Server error: ${!invRes.ok ? invRes.status : svcRes.status}`,
        );
      }
      if (seq !== fetchSeqRef.current) return; // stale response — newer fetch in flight
      const [invData, svcData] = await Promise.all([
        invRes.json(),
        svcRes.json(),
      ]);
      if (healthRes.ok) {
        const hData = await healthRes.json();
        setHealthData(hData as Record<string, HealthStatus>);
      }
      if (hiddenRes.ok) {
        const hData = (await hiddenRes.json()) as Array<{
          service: string;
          reason: string | null;
          hidden_at: string;
        }>;
        setHiddenServices(
          new Map(
            hData.map((h) => [
              h.service,
              { reason: h.reason, hidden_at: h.hidden_at },
            ]),
          ),
        );
      }
      if (kpiRes.ok) {
        setKpiStats((await kpiRes.json()) as KpiStats);
      }
      // API returns {rows, total, hasMore} after PR 1. Store rows for the
      // Investigation Log snippet; total drives the "View all N →" link.
      setInvestigations(invData.rows);
      setInvestigationsTotal(invData.total);
      setServices(svcData);
      // Reconcile: remove active investigations that are now complete/failed in DB
      setActiveInvestigations((prev) => {
        if (prev.size === 0) return prev;
        let changed = false;
        const next = new Map(prev);
        const completedOrFailed = new Set(
          (invData as InvestigationSummary[])
            .filter(
              (inv) => inv.status === "complete" || inv.status === "failed",
            )
            .map((inv) => inv.id),
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
      const message =
        err instanceof Error ? err.message : "Failed to load data";
      console.error("Dashboard fetch failed:", message);
      setFetchError(message);
    }
    setLoading(false);
  }

  // Initial data fetch
  useEffect(() => {
    fetchData();
  }, [stackFetch]);

  // Auto-refresh every 60 seconds
  useEffect(() => {
    const refreshTick = setInterval(() => fetchData(), 60_000);
    return () => clearInterval(refreshTick);
  }, [stackFetch]);

  // WS-driven re-fetch and active investigation tracking
  useEffect(() => {
    const start = processedRef.current;
    if (wsMessages.length <= start) return;
    processedRef.current = wsMessages.length;

    let shouldRefetch = false;

    for (let i = start; i < wsMessages.length; i++) {
      const msg = wsMessages[i];

      if (msg.type === "investigation:started") {
        setActiveInvestigations((prev) => {
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
        setActiveInvestigations((prev) => {
          const next = new Map(prev);
          const existing = next.get(msg.id);
          if (existing && !existing.failed) {
            next.set(msg.id, { ...existing, phase: msg.phase });
          }
          return next;
        });
      }

      if (msg.type === "investigation:complete") {
        setActiveInvestigations((prev) => {
          const next = new Map(prev);
          const service = next.get(msg.id)?.service ?? "Unknown";
          next.delete(msg.id);
          setToasts((t) => [
            ...t.slice(-9),
            { id: msg.id, service, status: "complete", timestamp: Date.now() },
          ]);
          return next;
        });
        shouldRefetch = true;
      }

      if (msg.type === "investigation:failed") {
        setActiveInvestigations((prev) => {
          const next = new Map(prev);
          const existing = next.get(msg.id);
          const service = existing?.service ?? "Unknown";
          if (existing) {
            next.set(msg.id, {
              ...existing,
              failed: true,
              failedAt: Date.now(),
            });
          }
          setToasts((t) => [
            ...t.slice(-9),
            { id: msg.id, service, status: "failed", timestamp: Date.now() },
          ]);
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
      setActiveInvestigations((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const [id, inv] of next) {
          const isFailedStale =
            inv.failed &&
            inv.failedAt &&
            now - inv.failedAt > FAILED_MAX_AGE_MS;
          const isStartStale =
            !inv.failed && now - inv.startTime > ACTIVE_MAX_AGE_MS;
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
      topServices.map((svc) =>
        stackFetch(`/api/patterns?service=${encodeURIComponent(svc)}`)
          .then((r) => r.json())
          .catch(() => []),
      ),
    ).then((results) => setPatterns(results.flat()));
  }, [investigations]);

  // KPI computations
  // KPI stats are fetched from server-side aggregation (no client-side computation)

  // Derive hidden set for quick lookup
  const hiddenSet = useMemo(
    () => new Set(hiddenServices.keys()),
    [hiddenServices],
  );

  // Live health KPI counts from /api/services/health (exclude hidden)
  const healthKpi = useMemo(() => {
    let healthy = 0,
      degraded = 0,
      down = 0,
      unknown = 0;
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
  const visibleServiceCount = useMemo(
    () => services.filter((s) => !hiddenSet.has(s.name)).length,
    [services, hiddenSet],
  );

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
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [activeInvestigations.size]);

  const activeList = useMemo(
    () => [...activeInvestigations.values()],
    [activeInvestigations],
  );

  // Format and compute freshness of last updated timestamp
  const formatLastUpdated = (date: Date): string => {
    return date.toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  };

  const isStale = lastUpdated
    ? Date.now() - lastUpdated.getTime() > 2 * 60 * 1000
    : false;

  const handleToastDismiss = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  return (
    <div className="h-full overflow-y-auto px-4 py-5 relative z-[2] dashboard-container">
      {/* Auto-refresh breathing indicator */}
      <div className="absolute top-0 left-0 right-0 z-10 h-[2px] bg-primary/8">
        <div className="h-full w-full bg-primary/30 animate-refresh-breathe" />
      </div>
      {/* Section A: Title */}
      <div className="mb-8 animate-fade-up">
        <h1 className="font-display text-2xl font-extrabold tracking-tight text-foreground">
          Operations Desk
        </h1>
        <p className="text-xs font-mono text-muted-foreground/70 mt-1.5 tracking-wide">
          {stackName && (
            <span className="text-primary/60 uppercase">
              {stackName} &middot;{" "}
            </span>
          )}
          {services.filter((s) => !hiddenSet.has(s.name)).length} services
          monitored
          {lastUpdated && (
            <span
              className={`text-[9px] tabular-nums ${isStale ? "text-warning/60" : "text-muted-foreground/50"}`}
            >
              {" · "}Updated {formatLastUpdated(lastUpdated)}
            </span>
          )}
        </p>
        <div className="mt-4 h-px bg-border/60" />
      </div>

      {/* Error banner */}
      {fetchError && (
        <div className="mb-6 rounded-lg border border-destructive/15 bg-destructive/6 px-4 py-3 animate-fade-up">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-destructive text-sm flex-shrink-0">⚠</span>
              <div className="min-w-0">
                <p className="font-body text-[13px] text-foreground/70">
                  Unable to load dashboard data
                </p>
                <p className="font-mono text-[10px] text-muted-foreground/50 truncate">
                  {fetchError}
                </p>
              </div>
            </div>
            <button
              onClick={() => {
                setFetchError(null);
                fetchData();
              }}
              className="flex-shrink-0 font-mono text-[10px] uppercase tracking-[0.1em] text-destructive hover:text-destructive/80 transition-colors py-2 px-3 min-h-[44px]"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {/* Setup-aware empty state */}
      {setupStage && setupStage !== "complete" ? (
        <section aria-label="Setup" className="mb-8">
          <div className="py-16 flex flex-col items-center gap-4 text-center">
            <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center">
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                className="text-primary"
                aria-hidden="true"
              >
                <path
                  d="M12 2L2 7l10 5 10-5-10-5z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
                <path
                  d="M2 17l10 5 10-5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M2 12l10 5 10-5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <div>
              <p className="font-display text-sm font-semibold text-foreground/80">
                {setupStage === "needs-provider" ||
                setupStage === "needs-provider-connected"
                  ? "Connect your monitoring stack to get started"
                  : "Provider connected! Run service discovery to populate your dashboard"}
              </p>
              <p className="font-body text-xs text-muted-foreground/50 mt-1.5">
                {setupStage === "needs-provider" ||
                setupStage === "needs-provider-connected"
                  ? "The setup guide above will walk you through each step."
                  : "Head to Services to scan for your monitored services."}
              </p>
            </div>
            {setupDismissed && onResumeSetup && (
              <button
                onClick={onResumeSetup}
                className="mt-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground font-body text-sm font-medium hover:bg-primary/90 transition-colors"
              >
                Resume setup
              </button>
            )}
          </div>
        </section>
      ) : (
        <>
          {/* Section B: KPI Stat Cards */}
          <section aria-label="Overview" className="mb-4">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-0.5 h-3.5 rounded-full bg-primary/60" />
              <h2 className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">
                Overview
              </h2>
            </div>
            <div className="grid grid-cols-3 gap-3 dashboard-kpi-grid">
              <StatCard
                label="Investigations"
                value={String(kpiStats?.investigations.total ?? 0)}
                detail={
                  <>
                    {kpiStats?.investigations.complete ?? 0} complete ·{" "}
                    {kpiStats?.investigations.failed ?? 0} failed ·{" "}
                    {kpiStats?.confidence.avg != null
                      ? normalizeConfidence(kpiStats.confidence.avg)
                      : "—"}{" "}
                    confidence
                  </>
                }
                loading={loading}
              />
              <StatCard
                label="Services Health"
                value={`${healthKpi.healthy}/${visibleServiceCount}`}
                variant={
                  healthKpi.healthy === visibleServiceCount &&
                  visibleServiceCount > 0
                    ? "success"
                    : "default"
                }
                detail={
                  <>
                    {healthKpi.down > 0 ? (
                      <span className="text-destructive">
                        {healthKpi.down} down
                      </span>
                    ) : (
                      <>{healthKpi.down} down</>
                    )}{" "}
                    ·{" "}
                    {healthKpi.degraded > 0 ? (
                      <span className="text-warning">
                        {healthKpi.degraded} degraded
                      </span>
                    ) : (
                      <>{healthKpi.degraded} degraded</>
                    )}{" "}
                    · {healthKpi.unknown} unknown
                  </>
                }
                loading={loading}
              />
              <StatCard
                label="Avg MTTR (7d)"
                value={
                  kpiStats && kpiStats.mttr.completed7d > 0
                    ? formatDuration(kpiStats.mttr.avg7d)
                    : "\u2014"
                }
                detail={
                  kpiStats && kpiStats.mttr.completed7d > 0
                    ? `${kpiStats.mttr.completed7d} completed investigations`
                    : "needs completed investigations"
                }
                trend={kpiStats?.mttr.trend}
                loading={loading}
              />
            </div>
          </section>

          {/* Section C: Active Investigations */}
          {activeList.length > 0 && (
            <section aria-label="Active" className="mb-4 animate-fade-up">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-0.5 h-3.5 rounded-full bg-accent/60" />
                <h2 className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">
                  Active
                </h2>
              </div>
              <div className="rounded-lg border-l-[3px] border-l-accent/70 border border-accent/25 bg-accent/5 p-3 space-y-2 glow-coral">
                {activeList.map((inv) => (
                  <div
                    key={inv.id}
                    className="flex items-center justify-between"
                  >
                    <div className="flex items-center gap-2">
                      <div
                        className={`w-2 h-2 rounded-full ring-2 ${inv.failed ? "bg-destructive ring-destructive/25" : "bg-accent ring-accent/20 animate-status-pulse"}`}
                      />
                      <span className="font-body text-sm font-semibold text-foreground/90">
                        {inv.service}
                      </span>
                      <Badge
                        variant="secondary"
                        className="text-[10px] py-0 h-4"
                      >
                        {inv.phase}
                      </Badge>
                    </div>
                    <span className="font-mono text-[10px] tabular-nums text-accent/60 font-medium">
                      {formatElapsed(inv.startTime)}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Section D: Services Health */}
          {services.length > 0 && (
            <section aria-label="Services" className="mb-8">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-0.5 h-3.5 rounded-full bg-primary/60" />
                <h2 className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">
                  Services
                </h2>
              </div>
              <HealthStrip
                services={services
                  .filter((s) => !hiddenSet.has(s.name))
                  .map((s) => ({
                    name: s.name,
                    health: (healthData[s.name] ?? "unknown") as
                      | "healthy"
                      | "degraded"
                      | "down"
                      | "unknown",
                  }))
                  .filter((s) => s.health !== "unknown")}
                onClickService={onViewService}
                onViewAll={onViewAllServices}
              />
            </section>
          )}

          {/* Section E: Investigation Log */}
          <section aria-label="Investigation Log" className="mb-4">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-0.5 h-4 rounded-full bg-primary" />
              <h2 className="font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-foreground/50">
                Investigation Log
              </h2>
              <span className="font-mono text-[9px] tabular-nums text-muted-foreground/40">
                {investigations.length}
              </span>
            </div>
            {loading ? (
              <div className="space-y-2">
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className="h-16 rounded-lg shimmer-skeleton"
                    style={{ animationDelay: `${i * 0.1}s` }}
                  />
                ))}
              </div>
            ) : investigations.length === 0 ? (
              <div className="py-8 flex flex-col items-center gap-3">
                <svg
                  width="48"
                  height="48"
                  viewBox="0 0 64 64"
                  fill="none"
                  className="text-muted-foreground/15"
                  aria-hidden="true"
                >
                  <rect
                    x="12"
                    y="8"
                    width="32"
                    height="44"
                    rx="2"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  />
                  <line
                    x1="20"
                    y1="20"
                    x2="36"
                    y2="20"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    opacity="0.3"
                  />
                  <line
                    x1="20"
                    y1="28"
                    x2="36"
                    y2="28"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    opacity="0.3"
                  />
                  <line
                    x1="20"
                    y1="36"
                    x2="28"
                    y2="36"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    opacity="0.3"
                  />
                  <circle
                    cx="44"
                    cy="44"
                    r="12"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  />
                  <line
                    x1="52"
                    y1="52"
                    x2="58"
                    y2="58"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
                <div className="text-center">
                  <p className="font-display text-sm font-semibold text-muted-foreground/60">
                    All quiet on the operations front
                  </p>
                  <p className="font-mono text-[10px] text-muted-foreground/40 mt-1">
                    investigations will appear here as they run
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-1.5">
                {investigations.slice(0, 15).map((inv, i) => (
                  <div
                    key={inv.id}
                    className={`animate-fade-up delay-${Math.min(i + 1, 8)}`}
                  >
                    <InvestigationRow
                      investigation={inv}
                      onClick={onInvestigationClick}
                    />
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Section F: Learned Patterns */}
          {patterns.length > 0 && (
            <section aria-label="Learned Patterns" className="mb-4">
              <button
                aria-expanded={patternsExpanded}
                onClick={() => setPatternsExpanded(!patternsExpanded)}
                className="flex items-center gap-2 mb-3 group cursor-pointer"
              >
                <div className="w-0.5 h-3.5 rounded-full bg-primary/40" />
                <h2 className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60 group-hover:text-muted-foreground/80 transition-colors">
                  Learned Patterns ({patterns.length})
                </h2>
                <svg
                  className={`w-3 h-3 text-muted-foreground/40 transition-transform ${patternsExpanded ? "rotate-180" : ""}`}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
              <div
                className="grid transition-[grid-template-rows] duration-300 ease-out"
                style={{ gridTemplateRows: patternsExpanded ? "1fr" : "0fr" }}
                {...(patternsExpanded ? {} : { inert: "" as any })}
              >
                <div className="overflow-hidden">
                  <div className="space-y-1.5">
                    {patterns.map((p, i) => (
                      <div
                        key={i}
                        className="flex items-center gap-2 px-3 py-2 rounded-lg bg-card/30"
                      >
                        <Badge
                          variant={severityVariant(p.severity)}
                          className="text-[10px] py-0 h-4"
                        >
                          {p.severity}
                        </Badge>
                        <span className="font-body text-xs text-foreground/70">
                          {p.service}
                        </span>
                        <span className="font-mono text-[10px] text-muted-foreground/50 truncate">
                          {p.rootCause}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* Section G: Recent Events (EventStream supplies its own <aside> landmark) */}
          <div className="mb-4">
            <EventStream
              events={recentEvents}
              loading={recentEventsLoading}
              error={recentEventsError}
              truncated={recentEventsTruncated}
            />
          </div>
        </>
      )}

      <ToastContainer
        toasts={toasts}
        onDismiss={handleToastDismiss}
        onClickToast={(id) => {
          handleToastDismiss(id);
          onInvestigationClick(id);
        }}
      />
    </div>
  );
}
