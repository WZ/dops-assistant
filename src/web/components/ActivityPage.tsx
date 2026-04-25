import { Activity, FileSearch, Radar, Bell, Sparkles } from "lucide-react";
import type { ActivityTab, ActivityView } from "../App";
import type { InvestigationsQuery } from "../lib/investigations-query";
import type { ScanRunsQuery } from "../lib/scan-runs-query";
import type { PatternsQuery } from "../lib/patterns-query";
import type { EventsQuery } from "../lib/events-query";
import { InvestigationsPage } from "./InvestigationsPage";
import { ScansTab } from "./ScansTab";
import { PatternsTab } from "./PatternsTab";
import { EventsTab } from "./EventsTab";

interface ActivityPageProps {
  /** Discriminated view — `view.tab` narrows `view.query` automatically. */
  view: ActivityView;
  onChangeTab: (tab: ActivityTab) => void;
  onUpdateInvestigationsQuery: (query: InvestigationsQuery) => void;
  onUpdateScansQuery: (query: ScanRunsQuery) => void;
  onUpdatePatternsQuery: (query: PatternsQuery) => void;
  onUpdateEventsQuery: (query: EventsQuery) => void;
  onViewInvestigation: (id: string) => void;
  onOpenScanRun: (runId: string) => void;
  /** Generic in-app navigation — used by event rows whose `href` deep-links to investigations / scan runs. */
  onNavigateHref: (href: string) => void;
}

const TABS: { id: ActivityTab; label: string; icon: typeof Activity; ready: boolean }[] = [
  { id: "investigations", label: "Investigations", icon: FileSearch, ready: true },
  { id: "scans",          label: "Scans",          icon: Radar,      ready: true },
  { id: "patterns",       label: "Patterns",       icon: Sparkles,   ready: true },
  { id: "events",         label: "Events",         icon: Bell,       ready: true },
];

const PLACEHOLDER_COPY: Record<ActivityTab, { title: string; body: string } | null> = {
  investigations: null,
  scans: null,
  patterns: null,
  events: null,
};

/**
 * Unified Activity page. Single sidebar destination for chronological views
 * of stack activity. Each tab gets its own URL (/activity/:tab) so deep
 * links + bookmarks work per surface; the URL-as-state pattern lives in
 * `useRoute`. This component is presentation only.
 *
 * All four tabs ship real implementations as of v0.3.5.0 (the Activity
 * refactor is complete: Investigations + Scans + Patterns + Events).
 */
export function ActivityPage({
  view,
  onChangeTab,
  onUpdateInvestigationsQuery,
  onUpdateScansQuery,
  onUpdatePatternsQuery,
  onUpdateEventsQuery,
  onViewInvestigation,
  onOpenScanRun,
  onNavigateHref,
}: ActivityPageProps) {
  const tab = view.tab;
  const placeholder = PLACEHOLDER_COPY[tab];
  return (
    <div className="h-full flex flex-col min-h-0">
      <div role="tablist" aria-label="Activity sections" className="shrink-0 flex items-center gap-1 px-4 pt-3 border-b border-border/50">
        {TABS.map(({ id, label, icon: Icon, ready }) => {
          const active = id === tab;
          return (
            <button
              key={id}
              role="tab"
              aria-selected={active}
              aria-controls={`activity-panel-${id}`}
              id={`activity-tab-${id}`}
              onClick={() => onChangeTab(id)}
              className={`relative flex items-center gap-1.5 px-3 h-9 text-xs font-medium transition-colors ${
                active
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon size={14} strokeWidth={1.8} />
              <span>{label}</span>
              {!ready && (
                <span className="ml-1 text-[9px] uppercase tracking-wider text-muted-foreground/70 font-mono">soon</span>
              )}
              <div
                className={`absolute left-2 right-2 -bottom-px h-[2px] bg-primary rounded-t-sm transition-opacity ${
                  active ? "opacity-100" : "opacity-0"
                }`}
              />
            </button>
          );
        })}
      </div>

      <div
        id={`activity-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`activity-tab-${tab}`}
        className="flex-1 min-h-0"
      >
        {view.tab === "investigations" ? (
          <InvestigationsPage
            query={view.query}
            onUpdateQuery={onUpdateInvestigationsQuery}
            onViewInvestigation={onViewInvestigation}
          />
        ) : view.tab === "scans" ? (
          <ScansTab
            query={view.query}
            onUpdateQuery={onUpdateScansQuery}
            onOpenScanRun={onOpenScanRun}
          />
        ) : view.tab === "patterns" ? (
          <PatternsTab
            query={view.query}
            onUpdateQuery={onUpdatePatternsQuery}
            onViewInvestigation={onViewInvestigation}
          />
        ) : view.tab === "events" ? (
          <EventsTab
            query={view.query}
            onUpdateQuery={onUpdateEventsQuery}
            onNavigate={onNavigateHref}
          />
        ) : placeholder ? (
          <div className="h-full flex flex-col items-center justify-center gap-3 px-8 text-center">
            <h2 className="font-mono text-sm uppercase tracking-[0.12em] text-foreground/80">{placeholder.title}</h2>
            <p className="text-sm text-muted-foreground max-w-xl leading-relaxed">{placeholder.body}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
