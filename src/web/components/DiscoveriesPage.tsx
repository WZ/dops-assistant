// src/web/components/DiscoveriesPage.tsx
//
// Inbox UI for periodic discovery suggestions. Three subtabs:
//   - Pending Additions   — services discovered but not yet registered
//   - Pending Removals    — registered services missing from recent discovery
//                           runs AND corroborated by Prometheus
//   - Dismissed           — names the user has decided not to act on
//
// On accept: a 409 with kind=globals_drift surfaces a modal that offers to
// re-run the sanity probe against the current registry's globals. A 409 with
// kind=registry_advanced asks the user to refresh and re-review.

import { useEffect, useState } from "react";
import { useStackContext } from "../contexts/StackContext";
import { Button } from "@/components/ui/button";

interface PendingRow {
  id: string;
  serviceName: string;
  changeKind: "addition" | "removal";
  firstSeenAt: string;
  seenCount: number;
  qualifiedAt: string | null;
  payload: string | null;
}

interface DismissedRow {
  id: string;
  serviceName: string;
  changeKind: "addition" | "removal";
  dismissedAt: string;
}

interface DiscoveriesPayload {
  additions: PendingRow[];
  removals: PendingRow[];
  counts: { additions: number; removals: number; dismissed: number };
}

interface ConflictBody {
  kind: "globals_drift" | "registry_advanced" | "sanity_probe_failed";
  [key: string]: unknown;
}

type Tab = "additions" | "removals" | "dismissed";

interface DiscoveriesPageProps {
  /** When true, suppress the page-level h1 + outer padding so the component
   *  reads as a section inside another tab (DiscoveryTab embeds it this way). */
  embedded?: boolean;
}

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const diff = Date.now() - t;
  if (diff < 0) return "now";
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 4) return `${w}w ago`;
  return new Date(iso).toLocaleDateString();
}

export function DiscoveriesPage({ embedded = false }: DiscoveriesPageProps = {}) {
  const { stackFetch } = useStackContext();
  const [tab, setTab] = useState<Tab>("additions");
  const [data, setData] = useState<DiscoveriesPayload | null>(null);
  const [dismissed, setDismissed] = useState<DismissedRow[]>([]);
  const [conflict, setConflict] = useState<{ id: string; body: ConflictBody } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    const res = await stackFetch("/api/discoveries");
    if (res.ok) setData(await res.json());
  };

  const reloadDismissed = async () => {
    const res = await stackFetch("/api/discoveries/dismissed");
    if (res.ok) setDismissed(await res.json());
  };

  useEffect(() => {
    reload();
    // mark-viewed clears the badge for the qualified rows visible on this page.
    stackFetch("/api/discoveries/mark-viewed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (tab === "dismissed") reloadDismissed();
  }, [tab]);

  const onAccept = async (id: string) => {
    setError(null);
    const res = await stackFetch(`/api/discoveries/${id}/accept`, { method: "POST" });
    if (res.status === 409) {
      const body = await res.json();
      setConflict({ id, body });
      return;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? `Accept failed (${res.status})`);
      return;
    }
    reload();
  };

  const onConfirmRemoval = async (id: string) => {
    if (!confirm("This will delete the service from services.yaml. Continue?")) return;
    onAccept(id);
  };

  const onDismiss = async (id: string) => {
    await stackFetch(`/api/discoveries/${id}/dismiss`, { method: "POST" });
    reload();
  };

  const onDismissAll = async (kind: "addition" | "removal") => {
    const rows = kind === "addition" ? (data?.additions ?? []) : (data?.removals ?? []);
    if (rows.length === 0) return;
    const label = kind === "addition" ? "pending additions" : "pending removals";
    if (!confirm(`Dismiss all ${rows.length} ${label}? You can restore them from the Dismissed tab.`)) return;
    setError(null);
    const results = await Promise.allSettled(
      rows.map((r) => stackFetch(`/api/discoveries/${r.id}/dismiss`, { method: "POST" })),
    );
    const failures = results.filter((r) => r.status === "rejected" || !r.value.ok).length;
    if (failures > 0) setError(`${failures} of ${rows.length} dismissals failed.`);
    reload();
  };

  const onAcceptWithCurrentGlobals = async (id: string) => {
    const res = await stackFetch(`/api/discoveries/${id}/accept-with-current-globals`, { method: "POST" });
    if (res.ok) {
      setConflict(null);
      reload();
    } else {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Re-run failed");
    }
  };

  const onRestore = async (id: string) => {
    await stackFetch(`/api/discoveries/dismissed/${id}/restore`, { method: "POST" });
    reloadDismissed();
  };

  const tabLabels: Record<Tab, string> = {
    additions: "Pending Additions",
    removals: "Pending Removals",
    dismissed: "Dismissed",
  };

  const additionsCount = data?.additions.length ?? 0;
  const removalsCount = data?.removals.length ?? 0;

  return (
    <div className={embedded ? "" : "h-full overflow-y-auto px-4 py-5"}>
      {!embedded && (
        <>
          <h1 className="font-display text-2xl font-extrabold tracking-tight text-foreground/90 mb-1">
            Discoveries
          </h1>
          <p className="text-xs font-mono text-muted-foreground/70 tracking-wide mb-5">
            Services suggested by periodic discovery — accept, dismiss, or restore
          </p>
        </>
      )}

      <div className="flex gap-1 mb-4 border-b border-border/40">
        {(["additions", "removals", "dismissed"] as const).map((k) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`font-mono text-[10px] font-medium px-4 py-2 border-b-2 transition-colors ${
              tab === k ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {tabLabels[k]}
            {data && k !== "dismissed" && ` (${data.counts[k]})`}
          </button>
        ))}
      </div>

      {error && <div className="text-xs text-destructive mb-3 font-mono">{error}</div>}

      {tab === "additions" && (
        <>
          {additionsCount > 0 && (
            <div className="flex justify-end mb-2">
              <Button
                variant="outline"
                onClick={() => onDismissAll("addition")}
                className="font-mono text-[11px] h-8 rounded-md px-3"
              >
                Dismiss all ({additionsCount})
              </Button>
            </div>
          )}
          <Table
            empty="No pending additions."
            rows={data?.additions ?? []}
            render={(r) => (
              <tr key={r.id} className="border-t border-border/40">
                <td className="py-2 pr-4 font-medium whitespace-nowrap">{r.serviceName}</td>
                <td className="py-2 pr-4 text-xs text-muted-foreground whitespace-nowrap" title={new Date(r.firstSeenAt).toLocaleString()}>
                  {relativeTime(r.firstSeenAt)}
                </td>
                <td className="py-2 pr-4 text-xs whitespace-nowrap">{r.seenCount}</td>
                <td className="py-2 text-right whitespace-nowrap">
                  <div className="inline-flex items-center gap-2">
                    <Button size="sm" onClick={() => onAccept(r.id)} className="font-mono text-[11px] h-8 rounded-md px-3">Accept</Button>
                    <Button size="sm" variant="outline" onClick={() => onDismiss(r.id)} className="font-mono text-[11px] h-8 rounded-md px-3">Dismiss</Button>
                  </div>
                </td>
              </tr>
            )}
            headers={["Service", "First seen", "Seen count", ""]}
          />
        </>
      )}

      {tab === "removals" && (
        <>
          {removalsCount > 0 && (
            <div className="flex justify-end mb-2">
              <Button
                variant="outline"
                onClick={() => onDismissAll("removal")}
                className="font-mono text-[11px] h-8 rounded-md px-3"
              >
                Dismiss all ({removalsCount})
              </Button>
            </div>
          )}
          <Table
            empty="No pending removals."
            rows={data?.removals ?? []}
            render={(r) => (
              <tr key={r.id} className="border-t border-border/40">
                <td className="py-2 pr-4 font-medium whitespace-nowrap">{r.serviceName}</td>
                <td className="py-2 pr-4 text-xs text-muted-foreground whitespace-nowrap" title={new Date(r.firstSeenAt).toLocaleString()}>
                  {relativeTime(r.firstSeenAt)}
                </td>
                <td className="py-2 pr-4 text-xs whitespace-nowrap">{r.seenCount}</td>
                <td className="py-2 text-right whitespace-nowrap">
                  <div className="inline-flex items-center gap-2">
                    <Button size="sm" variant="destructive" onClick={() => onConfirmRemoval(r.id)} className="font-mono text-[11px] h-8 rounded-md px-3">Confirm removal</Button>
                    <Button size="sm" variant="outline" onClick={() => onDismiss(r.id)} className="font-mono text-[11px] h-8 rounded-md px-3">Dismiss</Button>
                  </div>
                </td>
              </tr>
            )}
            headers={["Service", "Last seen", "Missing count", ""]}
          />
        </>
      )}

      {tab === "dismissed" && (
        <Table
          empty="Nothing dismissed."
          rows={dismissed}
          render={(d) => (
            <tr key={d.id} className="border-t border-border/40">
              <td className="py-2 pr-4 font-medium whitespace-nowrap">{d.serviceName}</td>
              <td className="py-2 pr-4 text-xs whitespace-nowrap">{d.changeKind}</td>
              <td className="py-2 pr-4 text-xs text-muted-foreground whitespace-nowrap" title={new Date(d.dismissedAt).toLocaleString()}>
                {relativeTime(d.dismissedAt)}
              </td>
              <td className="py-2 text-right whitespace-nowrap">
                <Button size="sm" variant="outline" onClick={() => onRestore(d.id)} className="font-mono text-[11px] h-8 rounded-md px-3">Restore</Button>
              </td>
            </tr>
          )}
          headers={["Service", "Kind", "Dismissed at", ""]}
        />
      )}

      {conflict && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-card p-6 rounded-lg max-w-lg shadow-xl">
            <h3 className="font-bold mb-2">
              {conflict.body.kind === "globals_drift" ? "Globals drift detected"
                : conflict.body.kind === "registry_advanced" ? "Registry has changed"
                : "Sanity probe failed"}
            </h3>
            <p className="text-sm text-muted-foreground mb-3">
              {conflict.body.kind === "globals_drift"
                ? "The registry's globalProbeRules have changed since this candidate qualified. Re-running the sanity probe against the current globals will validate the service before accepting."
                : conflict.body.kind === "registry_advanced"
                ? "The services registry has been modified since this candidate qualified. Refresh and review again before accepting."
                : "The candidate's primary metric query did not return a value when re-run against the current stack."}
            </p>
            <pre className="text-[10px] bg-muted p-2 rounded overflow-x-auto max-h-48">{JSON.stringify(conflict.body, null, 2)}</pre>
            <div className="mt-4 flex gap-2 justify-end">
              {conflict.body.kind === "globals_drift" && (
                <Button size="sm" onClick={() => onAcceptWithCurrentGlobals(conflict.id)}>Re-run sanity probe & accept</Button>
              )}
              <Button size="sm" variant="outline" onClick={() => setConflict(null)}>Close</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface TableProps<T> {
  rows: T[];
  empty: string;
  render: (r: T) => React.ReactNode;
  headers: string[];
}

function Table<T>({ rows, empty, render, headers }: TableProps<T>) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-muted-foreground/60 border-b border-border/40">
          {headers.map((h, i) => (
            <th key={i} className="py-2 pr-4 font-mono font-semibold uppercase tracking-[0.1em] text-[10px] whitespace-nowrap">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr><td colSpan={headers.length} className="py-6 text-center text-muted-foreground font-mono text-xs">{empty}</td></tr>
        ) : rows.map(render)}
      </tbody>
    </table>
  );
}
