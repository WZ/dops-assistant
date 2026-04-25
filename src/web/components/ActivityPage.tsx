import { Activity, FileSearch, Radar, Bell, Sparkles } from "lucide-react";
import type { ActivityTab, ActivityView } from "../App";
import type { InvestigationsQuery } from "../lib/investigations-query";
import type { ScanRunsQuery } from "../lib/scan-runs-query";
import { InvestigationsPage } from "./InvestigationsPage";
import { ScansTab } from "./ScansTab";

interface ActivityPageProps {
  /** Discriminated view — `view.tab` narrows `view.query` automatically. */
  view: ActivityView;
  onChangeTab: (tab: ActivityTab) => void;
  onUpdateInvestigationsQuery: (query: InvestigationsQuery) => void;
  onUpdateScansQuery: (query: ScanRunsQuery) => void;
  onViewInvestigation: (id: string) => void;
  onOpenScanRun: (runId: string) => void;
}

const TABS: { id: ActivityTab; label: string; icon: typeof Activity; ready: boolean }[] = [
  { id: "investigations", label: "Investigations", icon: FileSearch, ready: true },
  { id: "scans",          label: "Scans",          icon: Radar,      ready: true },
  // Events and Patterns ship as scaffolded tabs in this PR but their bodies
  // land in follow-ups (AP14 / AP12). Empty-state copy is user-facing —
  // keep it specific so visitors know what's coming.
  { id: "events",         label: "Events",         icon: Bell,       ready: false },
  { id: "patterns",       label: "Patterns",       icon: Sparkles,   ready: false },
];

const PLACEHOLDER_COPY: Record<ActivityTab, { title: string; body: string } | null> = {
  investigations: null,
  scans: null,
  events: {
    title: "Events tab coming soon",
    body: "Recent system events — investigation lifecycle, scan dispatch, health transitions — are an in-memory ring buffer today. Persistence + a filterable feed lands once the events table migration is in.",
  },
  patterns: {
    title: "Patterns tab coming soon",
    body: "Learned incident patterns from your thumbs-up feedback. The Operations Desk shows top services today; this tab will list them all with filters by service / severity / date.",
  },
};

/**
 * Unified Activity page. Single sidebar destination for chronological views
 * of stack activity. Each tab gets its own URL (/activity/:tab) so deep
 * links + bookmarks work per surface; the URL-as-state pattern lives in
 * `useRoute`. This component is presentation only.
 *
 * Investigations and Scans render real implementations. Events and Patterns
 * ship as explanatory placeholders so the navigation story is coherent
 * today; the real surfaces land in follow-up PRs.
 */
export function ActivityPage({
  view,
  onChangeTab,
  onUpdateInvestigationsQuery,
  onUpdateScansQuery,
  onViewInvestigation,
  onOpenScanRun,
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
