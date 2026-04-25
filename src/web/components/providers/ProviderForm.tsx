import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils.js";

export interface ProviderFormData {
  name: string;
  roles: string[];
  region?: string;
  webUrl?: string;
  mcpServer: {
    transport: "http";
    url?: string;
  };
}

interface ProviderFormProps {
  onSave: (config: ProviderFormData) => Promise<void>;
  onCancel: () => void;
  onTest: (
    config: ProviderFormData
  ) => Promise<{ status: string; toolCount: number; error?: string }>;
  initialValues?: ProviderFormData;
  saving?: boolean;
}

const AVAILABLE_ROLES = [
  "metrics",
  "logs",
  "dashboards",
  "dependencies",
  "infrastructure",
  "changes",
] as const;

const LABEL_CLASS =
  "font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/60";

const INPUT_CLASS =
  "w-full rounded-md border border-border/40 bg-card/50 px-3 py-2 font-mono text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/15";

export function ProviderForm({
  onSave,
  onCancel,
  onTest,
  initialValues,
  saving = false,
}: ProviderFormProps) {
  const [name, setName] = useState(initialValues?.name ?? "");
  const [url, setUrl] = useState(initialValues?.mcpServer.url ?? "");
  const [roles, setRoles] = useState<Set<string>>(
    new Set(initialValues?.roles ?? [])
  );
  const [region, setRegion] = useState(initialValues?.region ?? "");
  const [webUrl, setWebUrl] = useState(initialValues?.webUrl ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [testResult, setTestResult] = useState<{
    status: string;
    toolCount: number;
    error?: string;
  } | null>(null);
  const [testing, setTesting] = useState(false);

  // Re-seed form state when the parent swaps in a different provider to edit
  // (e.g. clicking Edit on a second provider while the form is already open).
  useEffect(() => {
    if (!initialValues) return;
    setName(initialValues.name);
    setUrl(initialValues.mcpServer.url ?? "");
    setRoles(new Set(initialValues.roles));
    setRegion(initialValues.region ?? "");
    setWebUrl(initialValues.webUrl ?? "");
    setErrors({});
    setTestResult(null);
  }, [initialValues]);

  const isEditMode = Boolean(initialValues);

  function buildFormData(): ProviderFormData {
    const data: ProviderFormData = {
      name,
      roles: Array.from(roles),
      mcpServer: {
        transport: "http",
      },
    };

    if (region.trim()) {
      data.region = region.trim();
    }

    if (webUrl.trim()) {
      data.webUrl = webUrl.trim();
    }

    if (url.trim()) data.mcpServer.url = url.trim();

    return data;
  }

  function validate(): boolean {
    const newErrors: Record<string, string> = {};

    if (!name.trim()) {
      newErrors.name = "Name is required";
    } else if (!/^[a-zA-Z0-9_-]+$/.test(name.trim())) {
      newErrors.name =
        "Name must only contain letters, numbers, underscores, and hyphens";
    }

    if (roles.size === 0) {
      newErrors.roles = "At least one role is required";
    }

    if (!url.trim()) {
      newErrors.url = "URL is required";
    }

    if (webUrl.trim()) {
      try {
        // eslint-disable-next-line no-new
        new URL(webUrl.trim());
      } catch {
        newErrors.webUrl = "Web URL must be a valid URL";
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }

  function toggleRole(role: string) {
    setRoles((prev) => {
      const next = new Set(prev);
      if (next.has(role)) {
        next.delete(role);
      } else {
        next.add(role);
      }
      return next;
    });
    if (errors.roles) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next.roles;
        return next;
      });
    }
  }

  async function handleTest() {
    if (!validate()) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await onTest(buildFormData());
      setTestResult(result);
    } catch (err) {
      setTestResult({
        status: "error",
        toolCount: 0,
        error: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    if (!validate()) return;
    await onSave(buildFormData());
  }

  return (
    <div className="space-y-4 p-4">
      {/* Name */}
      <div>
        <label className={LABEL_CLASS}>Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (errors.name) {
              setErrors((prev) => {
                const next = { ...prev };
                delete next.name;
                return next;
              });
            }
          }}
          readOnly={isEditMode}
          className={cn(
            INPUT_CLASS,
            "mt-1",
            isEditMode && "opacity-60 cursor-not-allowed"
          )}
          placeholder="my-provider"
        />
        {errors.name && (
          <p className="text-xs text-destructive/80 mt-1">{errors.name}</p>
        )}
      </div>

      {/* URL */}
      <div>
        <label className={LABEL_CLASS}>URL</label>
        <input
          type="text"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            if (errors.url) {
              setErrors((prev) => {
                const next = { ...prev };
                delete next.url;
                return next;
              });
            }
          }}
          className={cn(INPUT_CLASS, "mt-1")}
          placeholder="http://localhost:8080/mcp"
        />
        {errors.url && (
          <p className="text-xs text-destructive/80 mt-1">{errors.url}</p>
        )}
      </div>

      {/* Web URL (optional — Grafana UI link) */}
      <div>
        <label className={LABEL_CLASS} htmlFor="provider-web-url">Web URL (optional)</label>
        <input
          id="provider-web-url"
          type="text"
          value={webUrl}
          onChange={(e) => {
            setWebUrl(e.target.value);
            if (errors.webUrl) {
              setErrors((prev) => {
                const next = { ...prev };
                delete next.webUrl;
                return next;
              });
            }
          }}
          className={cn(INPUT_CLASS, "mt-1")}
          placeholder="https://grafana.example.com/"
          aria-label="Web URL"
        />
        {errors.webUrl && (
          <p className="text-xs text-destructive/80 mt-1">{errors.webUrl}</p>
        )}
      </div>

      {/* Roles */}
      <div>
        <label className={LABEL_CLASS}>Roles</label>
        <div className="mt-2 flex flex-wrap gap-3">
          {AVAILABLE_ROLES.map((role) => (
            <label key={role} className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={roles.has(role)}
                onChange={() => toggleRole(role)}
                className="accent-primary"
              />
              <span className="font-body text-xs text-foreground/80">{role}</span>
            </label>
          ))}
        </div>
        {errors.roles && (
          <p className="text-xs text-destructive/80 mt-1">{errors.roles}</p>
        )}
      </div>

      {/* Region */}
      <div>
        <label className={LABEL_CLASS}>Region (optional)</label>
        <input
          type="text"
          value={region}
          onChange={(e) => setRegion(e.target.value)}
          className={cn(INPUT_CLASS, "mt-1")}
          placeholder="us-east-1"
        />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1">
        <Button
          variant="ghost"
          onClick={handleTest}
          disabled={testing || saving}
          className="text-[10px] font-mono text-primary/70 hover:text-primary hover:bg-transparent h-auto py-3 px-2 min-h-[44px]"
        >
          {testing ? "Testing..." : "Test Connection"}
        </Button>

        <span className="flex-1" />

        <Button
          variant="outline"
          onClick={onCancel}
          disabled={saving}
          className="text-[10px] font-mono text-muted-foreground/70 hover:text-foreground h-auto py-3 px-2 min-h-[44px]"
        >
          Cancel
        </Button>

        <Button
          onClick={handleSave}
          disabled={saving}
          className="font-mono text-xs font-medium min-h-[44px]"
        >
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>

      {/* Test result */}
      {testResult && (
        <div className="pt-1">
          {testResult.error ? (
            <p className="text-xs text-destructive/70">
              Connection failed: {testResult.error}
            </p>
          ) : testResult.status === "ok" || testResult.status === "connected" ? (
            <p className="text-xs text-success">
              Connected &mdash; {testResult.toolCount} tools available
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {testResult.status}
            </p>
          )}
        </div>
      )}

      {testing && !testResult && (
        <div className="pt-1">
          <p className="text-xs text-muted-foreground animate-status-pulse">
            Testing connection...
          </p>
        </div>
      )}
    </div>
  );
}
