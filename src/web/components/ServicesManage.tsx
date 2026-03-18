import { useState, useEffect } from "react";
import { stringify, parse } from "yaml";
import { YamlEditor } from "./YamlEditor.js";
import type { ServiceConfig } from "../../config/schema.js";

interface ServicesManageProps {
  onRunDiscovery: () => void;
  onViewHistory: () => void;
  onBack: () => void;
}

export function ServicesManage({ onRunDiscovery, onViewHistory, onBack }: ServicesManageProps) {
  const [services, setServices] = useState<ServiceConfig[]>([]);
  const [yamlValue, setYamlValue] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/services")
      .then((r) => r.json())
      .then((data: ServiceConfig[]) => {
        setServices(data);
        setYamlValue(stringify(data, { indent: 2 }));
      })
      .catch(() => {});
  }, []);

  const handleChange = (value: string) => {
    setYamlValue(value);
    setDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const parsed = parse(yamlValue);
      if (!Array.isArray(parsed)) throw new Error("Must be an array");

      const res = await fetch("/api/services", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });

      if (res.ok) {
        setDirty(false);
        setServices(parsed);
      }
    } catch (err) {
      console.error("Save failed:", err);
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    setYamlValue(stringify(services, { indent: 2 }));
    setDirty(false);
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="text-xs text-muted-foreground/50 mb-4">
        <button onClick={onBack} className="text-primary hover:underline">Dashboard</button>
        <span className="mx-1.5">{"\u203A"}</span>
        <span>Services</span>
      </div>

      <div className="flex items-center gap-2 mb-4">
        <button
          onClick={() => {
            if (window.confirm("Run service discovery? This will replace your current service registry if you accept the results.")) {
              onRunDiscovery();
            }
          }}
          className="px-3 py-1.5 text-xs font-medium rounded bg-primary text-primary-foreground hover:bg-primary/90"
        >
          Run Discovery
        </button>
        <button
          onClick={onViewHistory}
          className="px-3 py-1.5 text-xs rounded border border-border text-muted-foreground hover:bg-accent"
        >
          Version History
        </button>
        <span className="flex-1" />
        <span className="text-xs text-muted-foreground/50">{services.length} services</span>
      </div>

      <div className="rounded-lg border bg-card/40 overflow-hidden">
        <div className="flex items-center px-3 py-2 border-b bg-card/30 text-[11px]">
          <span className="text-muted-foreground/50 flex-1">services.yaml</span>
          {dirty && (
            <>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-2.5 py-1 rounded bg-success text-success-foreground text-[11px] mr-1.5 hover:bg-success/80 disabled:opacity-50"
              >
                {saving ? "Saving..." : "Save"}
              </button>
              <button
                onClick={handleDiscard}
                className="px-2.5 py-1 rounded border border-border text-muted-foreground text-[11px] hover:bg-accent"
              >
                Discard
              </button>
            </>
          )}
        </div>
        <YamlEditor value={yamlValue} onChange={handleChange} />
      </div>
    </div>
  );
}
