import type { ServiceHealth } from "../../../types/services";

export interface FilterValue {
  status: ServiceHealth[];
  tiers: string[];
  owners: string[];
}

interface Props {
  value: FilterValue;
  onChange: (next: FilterValue) => void;
  availableTiers: string[];
  availableOwners: string[];
  counts: Record<ServiceHealth, number>;
}

const statusOrder: ServiceHealth[] = ["healthy", "degraded", "down", "unknown"];

const statusDot: Record<ServiceHealth, string> = {
  healthy: "bg-success",
  degraded: "bg-warning",
  down: "bg-destructive",
  unknown: "bg-muted-foreground/30",
};

function toggle<T>(arr: T[], v: T): T[] {
  return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
}

function Chip({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] transition-colors ${
        pressed
          ? "border-primary/60 bg-primary/10 text-primary"
          : "border-border bg-card text-muted-foreground hover:border-muted-foreground/40"
      }`}
    >
      {children}
    </button>
  );
}

export function FilterChips({ value, onChange, availableTiers, availableOwners, counts }: Props) {
  return (
    <div className="flex flex-wrap items-center gap-4">
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/50">
          Status
        </span>
        {statusOrder.map((s) => (
          <Chip
            key={s}
            pressed={value.status.includes(s)}
            onClick={() => onChange({ ...value, status: toggle(value.status, s) })}
          >
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${statusDot[s]}`} aria-hidden />
            {s}
            <span className="tabular-nums text-muted-foreground/60">{counts[s]}</span>
          </Chip>
        ))}
      </div>

      {availableTiers.length > 0 && (
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/50">
            Tier
          </span>
          {availableTiers.map((t) => (
            <Chip
              key={t}
              pressed={value.tiers.includes(t)}
              onClick={() => onChange({ ...value, tiers: toggle(value.tiers, t) })}
            >
              T{t}
            </Chip>
          ))}
        </div>
      )}

      {availableOwners.length > 0 && (
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/50">
            Owner
          </span>
          {availableOwners.map((o) => (
            <Chip
              key={o}
              pressed={value.owners.includes(o)}
              onClick={() => onChange({ ...value, owners: toggle(value.owners, o) })}
            >
              {o}
            </Chip>
          ))}
        </div>
      )}
    </div>
  );
}
