import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { CirclePlus, Plus } from "lucide-react";
import { ProviderCard, type TestResult } from "./providers/ProviderCard";
import { ProviderForm, type ProviderFormData } from "./providers/ProviderForm";
import { YamlModal } from "./providers/YamlModal";
import { ConfirmActionDialog } from "./ConfirmActionDialog";
import { useStackContext } from "../contexts/StackContext";

interface ProviderData {
  name: string;
  roles: string[];
  region?: string;
  transport: string;
  url?: string;
  webUrl?: string;
  source: "config" | "gui";
  status: "connected" | "error" | "unknown";
  toolCount: number;
  enabledToolCount?: number;
  error?: string;
}

interface ProvidersPageProps {
  onRunDiscovery: () => void;
  onProviderSaved?: () => void;
}

export function ProvidersPage({ onRunDiscovery, onProviderSaved }: ProvidersPageProps) {
  const { stackFetch } = useStackContext();
  const [providers, setProviders] = useState<ProviderData[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingProvider, setEditingProvider] = useState<ProviderFormData | null>(null);
  const [saving, setSaving] = useState(false);
  const [showYamlModal, setShowYamlModal] = useState(false);
  const [testingName, setTestingName] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const formSectionRef = useRef<HTMLElement | null>(null);

  const fetchProviders = useCallback(async () => {
    try {
      const res = await stackFetch("/api/providers");
      const data = await res.json();
      setProviders(data);
    } catch { /* silently fail */ }
    setLoading(false);
  }, [stackFetch]);

  // Initial fetch + periodic polling every 30s
  useEffect(() => {
    fetchProviders();
    pollRef.current = setInterval(fetchProviders, 30_000);
    return () => clearInterval(pollRef.current);
  }, [fetchProviders]);

  // Scroll the form into view when it opens — with many providers, the form
  // can render below the fold and the user wouldn't notice it appeared.
  useEffect(() => {
    if (!showForm) return;
    formSectionRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, [showForm, editingProvider]);

  // Add or update provider
  const handleSave = async (data: ProviderFormData) => {
    setSaving(true);
    try {
      const body = {
        name: data.name,
        roles: data.roles,
        region: data.region,
        webUrl: data.webUrl,
        mcpServer: data.mcpServer,
      };
      const isEdit = Boolean(editingProvider);
      const url = isEdit
        ? `/api/providers/${encodeURIComponent(editingProvider!.name)}`
        : "/api/providers";
      const res = await stackFetch(url, {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || `Failed to ${isEdit ? "update" : "add"} provider`);
      }
      setShowForm(false);
      setEditingProvider(null);
      await fetchProviders();
      onProviderSaved?.();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to save");
    }
    setSaving(false);
  };

  // Test connection (from form, before save)
  const handleTestFromForm = async (data: ProviderFormData) => {
    try {
      const res = await stackFetch("/api/providers/test-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: data.name,
          roles: data.roles,
          region: data.region,
          webUrl: data.webUrl,
          mcpServer: data.mcpServer,
        }),
      });
      return await res.json();
    } catch {
      return { status: "error", toolCount: 0, error: "Network error" };
    }
  };

  // Test existing provider (from card)
  const handleTest = async (name: string) => {
    setTestingName(name);
    // Clear previous result for this provider
    setTestResults((prev) => { const next = { ...prev }; delete next[name]; return next; });
    try {
      const res = await stackFetch(`/api/providers/${encodeURIComponent(name)}/test`, { method: "POST" });
      const result: TestResult = await res.json();
      setTestResults((prev) => ({ ...prev, [name]: result }));
      await fetchProviders();
    } catch {
      setTestResults((prev) => ({ ...prev, [name]: { status: "error", toolCount: 0, error: "Network error" } }));
    }
    setTestingName(null);
  };

  // Remove provider — opens confirm dialog
  const handleRemoveClick = (name: string) => {
    setRemoveTarget(name);
  };

  // Actually perform the delete after user confirms
  const performRemove = async (name: string) => {
    try {
      const res = await stackFetch(`/api/providers/${encodeURIComponent(name)}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || "Failed to remove");
        return;
      }
      await fetchProviders();
    } catch { /* ignore */ }
  };

  // Edit provider
  const handleEdit = (name: string) => {
    const p = providers.find(p => p.name === name);
    if (!p) return;
    setEditingProvider({
      name: p.name,
      roles: p.roles,
      region: p.region,
      webUrl: p.webUrl,
      mcpServer: {
        transport: "http",
        url: p.url,
      },
    });
    setShowForm(true);
  };

  return (
    <div className="h-full overflow-y-auto relative z-[2]">
      {/* Title */}
      <div className="mb-6 animate-fade-up flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-extrabold tracking-tight text-foreground/90">Providers</h1>
          <p className="text-xs font-mono text-muted-foreground/70 mt-1 tracking-wide">
            {providers.length} MCP provider{providers.length !== 1 ? "s" : ""} configured
          </p>
        </div>
        {!showForm && (
          <Button
            variant="outline"
            onClick={() => { setEditingProvider(null); setShowForm(true); }}
            className="h-9 px-4 text-[12px] font-mono bg-primary/10 border-primary/20 text-primary hover:bg-primary/15 hover:text-primary rounded-lg gap-1.5 shrink-0"
          >
            <Plus size={12} className="!size-auto" />
            New Provider
          </Button>
        )}
      </div>

      {/* Section: PROVIDERS */}
      <section aria-label="Providers" className="mb-6">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-0.5 h-3.5 rounded-full bg-primary/60" />
          <h2 className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">
            Providers
          </h2>
        </div>

        {loading ? (
          /* 3 shimmer skeleton cards */
          <div className="space-y-3">
            {[0, 1, 2].map(i => (
              <div key={i} className="h-24 rounded-lg" style={{
                background: "linear-gradient(90deg, hsl(var(--muted)) 25%, hsl(var(--secondary)) 50%, hsl(var(--muted)) 75%)",
                backgroundSize: "200% 100%",
                animation: "shimmer 1.6s infinite",
                animationDelay: `${i * 0.1}s`,
              }} />
            ))}
          </div>
        ) : providers.length === 0 ? (
          /* Empty state */
          <div className="py-12 text-center">
            <CirclePlus size={48} strokeWidth={1.5} className="mx-auto mb-3 text-muted-foreground/15" />
            <p className="text-sm text-muted-foreground/70">No providers configured</p>
            <p className="text-xs font-mono text-muted-foreground/50 mt-1">
              Connect your Grafana, K8s, or GitLab to start investigating
            </p>
            <Button
              onClick={() => setShowForm(true)}
              className="mt-4 font-mono text-xs font-medium min-h-[44px]"
            >
              New Provider
            </Button>
          </div>
        ) : (
          /* Provider cards */
          <div className="space-y-3">
            {providers.map((p, i) => (
              <div key={p.name} className={`animate-fade-up delay-${Math.min(i + 1, 8)}`}>
                <ProviderCard
                  {...p}
                  onTest={() => handleTest(p.name)}
                  onEdit={p.source === "gui" ? () => handleEdit(p.name) : undefined}
                  onRemove={p.source === "gui" ? () => handleRemoveClick(p.name) : undefined}
                  testing={testingName === p.name}
                  testResult={testResults[p.name] ?? null}
                />
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Secondary actions row */}
      {!loading && (
        <div className="flex items-center gap-3 mb-6">
          <Button
            variant="ghost"
            onClick={() => setShowYamlModal(true)}
            className="text-[10px] font-mono text-primary/70 hover:text-primary hover:bg-transparent py-3 px-2 h-auto min-h-[44px]"
          >
            YAML
          </Button>
          {providers.length > 0 && (
            <>
              <span className="text-muted-foreground/20">&middot;</span>
              <Button
                variant="ghost"
                onClick={onRunDiscovery}
                className="text-[10px] font-mono text-primary/70 hover:text-primary hover:bg-transparent py-3 px-2 h-auto min-h-[44px]"
              >
                Run Discovery
              </Button>
            </>
          )}
        </div>
      )}

      {/* Inline form */}
      {showForm && (
        <section ref={formSectionRef} aria-label="New Provider" className="mb-6 animate-fade-up scroll-mt-4">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-0.5 h-3.5 rounded-full bg-primary/60" />
            <h2 className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">
              {editingProvider ? "Edit Provider" : "New Provider"}
            </h2>
          </div>
          <div className="rounded-lg border border-border/40 bg-card/50 p-4">
            <ProviderForm
              onSave={handleSave}
              onCancel={() => { setShowForm(false); setEditingProvider(null); }}
              onTest={handleTestFromForm}
              initialValues={editingProvider ?? undefined}
              saving={saving}
            />
          </div>
        </section>
      )}
      <YamlModal
        open={showYamlModal}
        onOpenChange={setShowYamlModal}
        onImported={fetchProviders}
      />
      <ConfirmActionDialog
        open={removeTarget !== null}
        onOpenChange={(open) => { if (!open) setRemoveTarget(null); }}
        title={removeTarget ? `Remove provider "${removeTarget}"?` : "Remove provider"}
        body="This will disconnect the MCP server and wipe any per-tool settings. You can add it back later, but enabled-tool choices will be lost."
        confirmLabel="Remove"
        variant="destructive"
        onConfirm={async () => {
          if (removeTarget) await performRemove(removeTarget);
        }}
      />
    </div>
  );
}
