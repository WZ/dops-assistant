import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { ServiceCard } from "./ServiceCard";
import { ServiceDetail } from "./ServiceDetail";
import { ServicesManage } from "./ServicesManage";
import { VersionHistory } from "./VersionHistory";
import { DiscoveryProgress } from "./DiscoveryProgress";
import { DiscoveryReview } from "./DiscoveryReview";
import { ConfirmHideDialog } from "./ConfirmHideDialog";
import { FirstRunBanner } from "./FirstRunBanner";
import { ToastContainer } from "./dashboard/ToastContainer";
import type { ToastItem } from "./dashboard/ToastContainer";
import type { useWebSocket } from "../hooks/useWebSocket";
import type { ServiceConfig } from "../../config/schema.js";
import type { ValidatedServiceConfig } from "../../types/discovery-types.js";
import type { InvestigationSummary } from "@/lib/dashboard-utils";

// ── Types ─────────────────────────────────────────────────────────────

type HealthStatus = "healthy" | "degraded" | "down" | "unknown";

type SubView =
  | { type: "grid" }
  | { type: "detail"; serviceName: string }
  | { type: "manage" }
  | { type: "history" }
  | { type: "discovery" }
  | { type: "review" };

interface DiscoveryState {
  phase: string;
  status: "running" | "complete";
  iteration: { current: number; max: number; description: string };
  toolCalls: Array<{
    timestamp: string;
    tool: string;
    status: "calling" | "success" | "error";
    args?: Record<string, unknown>;
  }>;
  results: ValidatedServiceConfig[];
  error: string | null;
  phaseTokens: Record<string, { inputTokens: number; outputTokens: number; durationMs: number }>;
  totalUsage: { inputTokens: number; outputTokens: number; durationMs: number } | null;
}

interface ServicesPageProps {
  ws: ReturnType<typeof useWebSocket>;
  onViewInvestigation: (id: string) => void;
  initialService?: string;
  onInitialServiceConsumed?: () => void;
  discoveryState: DiscoveryState;
  onStartDiscovery: () => void;
  onResetDiscovery: () => void;
}

// ── Component ─────────────────────────────────────────────────────────

export function ServicesPage({
  ws,
  onViewInvestigation,
  initialService,
  onInitialServiceConsumed,
  discoveryState,
  onStartDiscovery,
  onResetDiscovery,
}: ServicesPageProps) {
  // ── Sub-view routing ──────────────────────────────────────────────
  const [subView, setSubView] = useState<SubView>({ type: "grid" });

  // ── Service data state ────────────────────────────────────────────
  const [services, setServices] = useState<ServiceConfig[]>([]);
  const [investigations, setInvestigations] = useState<InvestigationSummary[]>([]);
  const [healthData, setHealthData] = useState<Record<string, HealthStatus>>({});
  const [hiddenServices, setHiddenServices] = useState<Map<string, { reason: string | null; hidden_at: string }>>(new Map());
  const [staleServices, setStaleServices] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // ── UI state ──────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({
    unhealthy: false,
    healthy: false,
    unknown: true,
    hidden: true,
  });
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedServices, setSelectedServices] = useState<Set<string>>(new Set());
  const [hideTarget, setHideTarget] = useState<{ name: string; defaultReason?: string } | null>(null);
  const [bulkHideTarget, setBulkHideTarget] = useState<string[] | null>(null);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const fetchSeqRef = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);

  // ── Data fetching ─────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    const seq = ++fetchSeqRef.current;
    try {
      const [invRes, svcRes, healthRes, hiddenRes, staleRes] = await Promise.all([
        fetch("/api/investigations?limit=100"),
        fetch("/api/services"),
        fetch("/api/services/health"),
        fetch("/api/services/hidden"),
        fetch("/api/services/stale-unknown?days=7"),
      ]);
      if (!invRes.ok || !svcRes.ok) {
        throw new Error(`Server error: ${!invRes.ok ? invRes.status : svcRes.status}`);
      }
      if (seq !== fetchSeqRef.current) return; // stale response
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
      setInvestigations(invData);
      setServices(svcData);
      setFetchError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load data";
      console.error("ServicesPage fetch failed:", message);
      setFetchError(message);
    }
    setLoading(false);
  }, []);

  // Initial data fetch
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Auto-refresh every 60 seconds
  useEffect(() => {
    const refreshTick = setInterval(() => fetchData(), 60_000);
    return () => clearInterval(refreshTick);
  }, [fetchData]);

  // ── initialService prop → navigate to detail once data loads ──────
  const initialServiceConsumedRef = useRef(false);
  useEffect(() => {
    if (!initialService || initialServiceConsumedRef.current) return;
    if (services.length === 0) return; // wait for services data
    initialServiceConsumedRef.current = true;
    setSubView({ type: "detail", serviceName: initialService });
    onInitialServiceConsumed?.();
  }, [initialService, services, onInitialServiceConsumed]);

  // ── Discovery state → sub-view transitions ────────────────────────
  // Track previous values to detect *transitions*, not react to initial state
  const prevDiscoveryStatusRef = useRef(discoveryState.status);
  const prevResultsRef = useRef(discoveryState.results);

  useEffect(() => {
    // Only switch to discovery view on a transition TO running (not on mount)
    if (discoveryState.status === "running" && prevDiscoveryStatusRef.current !== "running") {
      setSubView({ type: "discovery" });
    }
    prevDiscoveryStatusRef.current = discoveryState.status;
  }, [discoveryState.status]);

  useEffect(() => {
    // When discover:complete fires (results array reference changes), switch to review
    if (discoveryState.results.length > 0 && discoveryState.results !== prevResultsRef.current) {
      setSubView({ type: "review" });
    }
    prevResultsRef.current = discoveryState.results;
  }, [discoveryState.results]);

  // ── Keyboard shortcuts: / to focus search, Escape to clear ────────
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

  // ── Computed values ───────────────────────────────────────────────

  const hiddenSet = useMemo(() => new Set(hiddenServices.keys()), [hiddenServices]);

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

  const visibleServiceCount = useMemo(
    () => services.filter(s => !hiddenSet.has(s.name)).length,
    [services, hiddenSet],
  );

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

  // ── Handlers ──────────────────────────────────────────────────────

  const toggleGroup = (group: string) =>
    setCollapsedGroups(prev => ({ ...prev, [group]: !prev[group] }));

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

  const handleToastDismiss = (id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  const handleDiscoveryAccept = useCallback((accepted: ServiceConfig[]) => {
    ws.send({ type: "discover:accept", services: accepted });
    onResetDiscovery();
    fetchData();
    setSubView({ type: "grid" });
  }, [ws, onResetDiscovery, fetchData]);

  const handleDiscoveryReject = useCallback(() => {
    ws.send({ type: "discover:reject" });
    onResetDiscovery();
    setSubView({ type: "grid" });
  }, [ws, onResetDiscovery]);

  // ── Sub-view routing ──────────────────────────────────────────────

  if (subView.type === "detail") {
    return (
      <ServiceDetail
        serviceName={subView.serviceName}
        ws={ws}
        onBack={() => setSubView({ type: "grid" })}
        onViewInvestigation={onViewInvestigation}
        onViewService={(name) => setSubView({ type: "detail", serviceName: name })}
      />
    );
  }

  if (subView.type === "manage") {
    return (
      <ServicesManage
        onRunDiscovery={() => {
          onStartDiscovery();
          setSubView({ type: "discovery" });
        }}
        onViewHistory={() => setSubView({ type: "history" })}
        onBack={() => setSubView({ type: "grid" })}
      />
    );
  }

  if (subView.type === "history") {
    return <VersionHistory onBack={() => setSubView({ type: "grid" })} />;
  }

  if (subView.type === "discovery") {
    return (
      <DiscoveryProgress
        phase={discoveryState.phase}
        phaseStatus={discoveryState.status}
        iteration={discoveryState.iteration}
        toolCalls={discoveryState.toolCalls}
        error={discoveryState.error}
        phaseTokens={discoveryState.phaseTokens}
        totalUsage={discoveryState.totalUsage}
        onRetry={onStartDiscovery}
        onBack={() => setSubView({ type: "grid" })}
      />
    );
  }

  if (subView.type === "review") {
    return (
      <DiscoveryReview
        services={discoveryState.results}
        onAccept={handleDiscoveryAccept}
        onReject={handleDiscoveryReject}
        onRerun={() => {
          onStartDiscovery();
          setSubView({ type: "discovery" });
        }}
        onBack={() => setSubView({ type: "grid" })}
      />
    );
  }

  // ── Grid view (default) ───────────────────────────────────────────

  return (
    <div className="h-full overflow-y-auto px-4 py-5 relative z-[2]">
      {/* First-run banner */}
      {services.length === 0 && !loading && !bannerDismissed && (
        <FirstRunBanner
          onRunDiscovery={() => {
            onStartDiscovery();
            setSubView({ type: "discovery" });
          }}
          onDismiss={() => setBannerDismissed(true)}
        />
      )}

      {/* Page title */}
      <div className="mb-6 animate-fade-up">
        <h1 className="font-display text-xl font-bold tracking-tight text-foreground/90">Services</h1>
        <p className="text-xs font-mono text-muted-foreground/70 mt-1 tracking-wide flex items-center gap-2 flex-wrap">
          <span>{visibleServiceCount} services</span>
          {services.length > 0 && (
            <span className="text-[10px] font-mono flex items-center gap-2">
              <span className="text-muted-foreground/40">&middot;</span>
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
              <span className="text-destructive text-sm flex-shrink-0">{"\u26A0"}</span>
              <div className="min-w-0">
                <p className="font-body text-[13px] text-foreground/70">Unable to load services data</p>
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

      {/* Services grid */}
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

        {loading ? (
          <div className="grid grid-cols-3 gap-3 dashboard-services-grid">
            {[0, 1, 2, 3, 4, 5].map(i => (
              <div key={i} className="h-24 rounded-lg shimmer-skeleton" style={{ animationDelay: `${i * 0.08}s` }} />
            ))}
          </div>
        ) : services.length === 0 ? (
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
                    {collapsedGroups[group.key] ? "\u25B8" : "\u25BE"}
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
                          onClick={() => setSubView({ type: "detail", serviceName: svc.name })}
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

            {/* Action toolbar */}
            <div className="flex items-center gap-3 mt-1 pl-3">
              <button onClick={() => setSubView({ type: "manage" })} className="py-3 px-2 min-h-[44px] text-[10px] font-mono text-primary/70 hover:text-primary transition-colors">Manage</button>
              <span className="text-muted-foreground/20">&middot;</span>
              <button
                onClick={() => {
                  onStartDiscovery();
                  setSubView({ type: "discovery" });
                }}
                className="text-[10px] font-mono text-primary/70 hover:text-primary transition-colors py-3 px-2 min-h-[44px]"
              >
                Re-discover
              </button>
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

      <ToastContainer
        toasts={toasts}
        onDismiss={handleToastDismiss}
        onClickToast={(id) => { handleToastDismiss(id); onViewInvestigation(id); }}
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
