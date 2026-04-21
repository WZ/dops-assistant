// src/web/components/ServicesTable.tsx
import type { ServiceListItem } from "../../types/services";
import { HealthDotTimeline } from "./services/HealthDotTimeline";

interface Props {
  items: ServiceListItem[];
  onOpenService: (name: string) => void;
  onInvestigate: (name: string) => void;
  grafanaUrlFor?: (name: string) => string | undefined;
}

const healthStroke: Record<ServiceListItem["health"], string> = {
  healthy: "bg-success",
  degraded: "bg-warning",
  down: "bg-destructive",
  unknown: "bg-muted-foreground/30",
};

function tierFromTags(tags: string[]): string | null {
  const t = tags.find((tag) => tag.startsWith("tier:"));
  if (!t) return null;
  const n = t.slice("tier:".length);
  return `T${n}`;
}

function ownerFromTags(tags: string[]): string | null {
  const t = tags.find((tag) => tag.startsWith("owner:"));
  return t ? t.slice("owner:".length) : null;
}

function extraTagFromTags(tags: string[]): string | null {
  const t = tags.find((tag) => !tag.startsWith("tier:") && !tag.startsWith("owner:"));
  return t ?? null;
}

function relTime(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function ServicesTable({ items, onOpenService, onInvestigate, grafanaUrlFor }: Props) {
  // Hide Tier and Owner columns when no service in the current view has data
  // for them. Prevents a grid of "—" cells that promise data we can't deliver.
  const hasAnyTier = items.some((s) => tierFromTags(s.metadata.tags) !== null);
  const hasAnyOwner = items.some((s) => ownerFromTags(s.metadata.tags) !== null);

  return (
    <table role="table" className="w-full border-collapse">
      <thead>
        <tr role="row" className="text-left font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60 border-b border-border">
          <th scope="col" className="w-1 p-0" aria-label="Status" />
          <th scope="col" className="py-2 pl-3">Service</th>
          {hasAnyOwner && <th scope="col" className="py-2">Owner</th>}
          {hasAnyTier && <th scope="col" className="py-2">Tier</th>}
          <th scope="col" className="py-2 w-[200px]">24h health</th>
          <th scope="col" className="py-2">Last investigation</th>
          <th scope="col" className="py-2 pr-3 text-right" aria-label="Actions" />
        </tr>
      </thead>
      <tbody>
        {items.map((s) => {
          const tier = tierFromTags(s.metadata.tags);
          const owner = ownerFromTags(s.metadata.tags);
          const extra = extraTagFromTags(s.metadata.tags);
          const inv = s.lastInvestigation;
          return (
            <tr
              key={s.name}
              role="row"
              className="group border-b border-border/50 hover:bg-secondary/40 cursor-pointer"
              tabIndex={0}
              onClick={() => onOpenService(s.name)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onOpenService(s.name);
              }}
            >
              <td className={`w-1 p-0 ${healthStroke[s.health]}`} aria-label={`status ${s.health}`}>
                <div className="w-1 h-10" />
              </td>
              <td className="py-2 pl-3 font-body text-[15px] font-medium text-foreground">
                {s.name}
                {extra && (
                  <span className="ml-2 font-mono text-[10px] text-muted-foreground/60">· {extra}</span>
                )}
              </td>
              {hasAnyOwner && (
                <td className="py-2">
                  {owner ? (
                    <span className="inline-flex items-center rounded-md bg-secondary/60 px-2 py-0.5 font-body text-[11px] text-muted-foreground">
                      {owner}
                    </span>
                  ) : (
                    <span className="text-muted-foreground/40">—</span>
                  )}
                </td>
              )}
              {hasAnyTier && (
                <td className="py-2">
                  {tier ? (
                    <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-foreground/70">
                      {tier}
                    </span>
                  ) : (
                    <span className="text-muted-foreground/40">—</span>
                  )}
                </td>
              )}
              <td className="py-2 pr-4">
                <HealthDotTimeline service={s.name} />
              </td>
              <td className="py-2 font-mono text-[11px] tabular-nums text-muted-foreground">
                {inv ? (
                  <span>
                    {relTime(inv.createdAt)}
                    {inv.confidence != null && (
                      <span className="ml-2 text-foreground/70">{Math.round(inv.confidence * 100)}%</span>
                    )}
                  </span>
                ) : (
                  <span className="text-muted-foreground/40">—</span>
                )}
              </td>
              <td className="py-2 pr-3 text-right">
                <div className="inline-flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                  {grafanaUrlFor?.(s.name) && (
                    <a
                      href={grafanaUrlFor(s.name)}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="font-mono text-[11px] text-primary hover:underline"
                    >
                      ↗ Grafana
                    </a>
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); onInvestigate(s.name); }}
                    className="font-mono text-[11px] text-primary hover:underline"
                  >
                    Investigate
                  </button>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
