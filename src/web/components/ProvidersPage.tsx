import { useCallback, useEffect, useState } from "react";
import { ProviderCard } from "./providers/ProviderCard";
import { ProviderForm, type ProviderFormData } from "./providers/ProviderForm";

interface ProviderData {
  name: string;
  roles: string[];
  region?: string;
  transport: string;
  command?: string;
  url?: string;
  source: "config" | "gui";
  status: "connected" | "error" | "unknown";
  toolCount: number;
  error?: string;
}

interface ProvidersPageProps {
  onRunDiscovery: () => void;
}

export function ProvidersPage({ onRunDiscovery }: ProvidersPageProps) {
  const [providers, setProviders] = useState<ProviderData[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingProvider, setEditingProvider] = useState<ProviderFormData | null>(null);
  const [saving, setSaving] = useState(false);
  const [testingName, setTestingName] = useState<string | null>(null);

  const fetchProviders = useCallback(async () => {
    try {
      const res = await fetch("/api/providers");
      const data = await res.json();
      setProviders(data);
    } catch { /* silently fail */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetchProviders(); }, [fetchProviders]);

  // Add provider
  const handleSave = async (data: ProviderFormData) => {
    setSaving(true);
    try {
      const res = await fetch("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...data.mcpServer, name: data.name, roles: data.roles, region: data.region }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to add provider");
      }
      setShowForm(false);
      setEditingProvider(null);
      await fetchProviders();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to save");
    }
    setSaving(false);
  };

  // Test connection (from form, before save)
  const handleTestFromForm = async (_data: ProviderFormData) => {
    return { status: "unknown" as const, toolCount: 0 };
  };

  // Test existing provider (from card)
  const handleTest = async (name: string) => {
    setTestingName(name);
    try {
      await fetch(`/api/providers/${encodeURIComponent(name)}/test`, { method: "POST" });
      await fetchProviders();
    } catch { /* ignore */ }
    setTestingName(null);
  };

  // Remove provider
  const handleRemove = async (name: string) => {
    try {
      const res = await fetch(`/api/providers/${encodeURIComponent(name)}`, { method: "DELETE" });
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
      mcpServer: {
        transport: p.transport as "stdio" | "http",
        command: p.command,
        url: p.url,
      },
    });
    setShowForm(true);
  };

  return (
    <div className="h-full overflow-y-auto p-6 relative z-[2]">
      {/* Title */}
      <div className="mb-6 animate-fade-up">
        <h1 className="font-display text-xl font-bold tracking-tight text-foreground/90">Providers</h1>
        <p className="text-xs font-mono text-muted-foreground/70 mt-1 tracking-wide">
          {providers.length} MCP provider{providers.length !== 1 ? "s" : ""} configured
        </p>
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
          <div className="space-y-2">
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
            <svg className="mx-auto mb-3 w-12 h-12 text-muted-foreground/15" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="24" cy="24" r="18" strokeDasharray="4 4" />
              <path d="M16 24h16M24 16v16" />
            </svg>
            <p className="text-sm text-muted-foreground/70">No providers configured</p>
            <p className="text-xs font-mono text-muted-foreground/50 mt-1">
              Connect your Grafana, K8s, or GitLab to start investigating
            </p>
            <button
              onClick={() => setShowForm(true)}
              className="mt-4 rounded-md bg-primary text-primary-foreground px-4 py-2 font-mono text-xs font-medium min-h-[44px]"
            >
              Add First Provider
            </button>
          </div>
        ) : (
          /* Provider cards */
          <div className="space-y-2">
            {providers.map((p, i) => (
              <div key={p.name} className={`animate-fade-up delay-${Math.min(i + 1, 8)}`}>
                <ProviderCard
                  {...p}
                  onTest={() => handleTest(p.name)}
                  onEdit={p.source === "gui" ? () => handleEdit(p.name) : undefined}
                  onRemove={p.source === "gui" ? () => handleRemove(p.name) : undefined}
                  testing={testingName === p.name}
                />
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Actions row */}
      {!loading && (
        <div className="flex items-center gap-3 mb-6">
          {!showForm && (
            <button
              onClick={() => { setEditingProvider(null); setShowForm(true); }}
              className="text-[10px] font-mono text-primary/70 hover:text-primary transition-colors py-3 px-2 min-h-[44px]"
            >
              + Add Provider
            </button>
          )}
          {providers.length > 0 && (
            <>
              <span className="text-muted-foreground/20">&middot;</span>
              <button
                onClick={onRunDiscovery}
                className="text-[10px] font-mono text-primary/70 hover:text-primary transition-colors py-3 px-2 min-h-[44px]"
              >
                Run Discovery
              </button>
            </>
          )}
        </div>
      )}

      {/* Inline form */}
      {showForm && (
        <section aria-label="Add Provider" className="mb-6 animate-fade-up">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-0.5 h-3.5 rounded-full bg-primary/60" />
            <h2 className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">
              {editingProvider ? "Edit Provider" : "Add Provider"}
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
    </div>
  );
}
