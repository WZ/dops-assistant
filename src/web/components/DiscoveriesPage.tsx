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

export function DiscoveriesPage() {
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

  return (
    <div className="h-full overflow-y-auto px-4 py-5">
      <h1 className="font-display text-2xl font-extrabold tracking-tight text-foreground/90 mb-1">
        Discoveries
      </h1>
      <p className="text-xs font-mono text-muted-foreground/70 tracking-wide mb-5">
        Services suggested by periodic discovery — accept, dismiss, or restore
      </p>

      <div className="flex gap-1 mb-4 border-b border-border">
        {(["additions", "removals", "dismissed"] as const).map((k) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`font-mono text-[10px] font-medium px-4 py-2 border-b-2 ${
              tab === k ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {tabLabels[k]}
            {data && k !== "dismissed" && ` (${data.counts[k]})`}
          </button>
        ))}
      </div>

      {error && <div className="text-xs text-destructive mb-3">{error}</div>}

      {tab === "additions" && (
        <Table
          empty="No pending additions."
          rows={data?.additions ?? []}
          render={(r) => (
            <tr key={r.id} className="border-t border-border">
              <td className="py-2 font-medium">{r.serviceName}</td>
              <td className="py-2 text-xs text-muted-foreground">{new Date(r.firstSeenAt).toLocaleString()}</td>
              <td className="py-2 text-xs">{r.seenCount}</td>
              <td className="py-2 text-right">
                <Button size="sm" onClick={() => onAccept(r.id)} className="mr-2">Accept</Button>
                <Button size="sm" variant="outline" onClick={() => onDismiss(r.id)}>Dismiss</Button>
              </td>
            </tr>
          )}
          headers={["Service", "First seen", "Seen count", ""]}
        />
      )}

      {tab === "removals" && (
        <Table
          empty="No pending removals."
          rows={data?.removals ?? []}
          render={(r) => (
            <tr key={r.id} className="border-t border-border">
              <td className="py-2 font-medium">{r.serviceName}</td>
              <td className="py-2 text-xs text-muted-foreground">{new Date(r.firstSeenAt).toLocaleString()}</td>
              <td className="py-2 text-xs">{r.seenCount}</td>
              <td className="py-2 text-right">
                <Button size="sm" variant="destructive" onClick={() => onConfirmRemoval(r.id)} className="mr-2">Confirm removal</Button>
                <Button size="sm" variant="outline" onClick={() => onDismiss(r.id)}>Dismiss</Button>
              </td>
            </tr>
          )}
          headers={["Service", "Last seen", "Missing count", ""]}
        />
      )}

      {tab === "dismissed" && (
        <Table
          empty="Nothing dismissed."
          rows={dismissed}
          render={(d) => (
            <tr key={d.id} className="border-t border-border">
              <td className="py-2 font-medium">{d.serviceName}</td>
              <td className="py-2 text-xs">{d.changeKind}</td>
              <td className="py-2 text-xs text-muted-foreground">{new Date(d.dismissedAt).toLocaleString()}</td>
              <td className="py-2 text-right">
                <Button size="sm" variant="outline" onClick={() => onRestore(d.id)}>Restore</Button>
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
        <tr className="text-left text-muted-foreground text-xs">
          {headers.map((h, i) => <th key={i} className="py-1 font-mono uppercase tracking-wide">{h}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr><td colSpan={headers.length} className="py-6 text-center text-muted-foreground">{empty}</td></tr>
        ) : rows.map(render)}
      </tbody>
    </table>
  );
}
