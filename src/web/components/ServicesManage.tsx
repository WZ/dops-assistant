import { useState, useEffect } from "react";
import { stringify, parse } from "yaml";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  const [confirmDiscovery, setConfirmDiscovery] = useState(false);

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
        <Button variant="link" className="text-primary h-auto p-0 text-xs" onClick={onBack}>Dashboard</Button>
        <span className="mx-1.5">{"\u203A"}</span>
        <span>Services</span>
      </div>

      <div className="flex items-center gap-2 mb-4">
        <Button
          onClick={() => setConfirmDiscovery(true)}
          size="sm"
        >
          Run Discovery
        </Button>
        <Button
          onClick={onViewHistory}
          variant="outline"
          size="sm"
        >
          Version History
        </Button>
        <span className="flex-1" />
        <span className="text-xs text-muted-foreground/50">{services.length} services</span>
      </div>

      <div className="rounded-lg border bg-card/40 overflow-hidden">
        <div className="flex items-center px-3 py-2 border-b bg-card/30 text-[11px]">
          <span className="text-muted-foreground/50 flex-1">services.yaml</span>
          {dirty && (
            <>
              <Button
                onClick={handleSave}
                disabled={saving}
                variant="success"
                size="sm"
                className="text-[11px] mr-1.5"
              >
                {saving ? "Saving..." : "Save"}
              </Button>
              <Button
                onClick={handleDiscard}
                variant="outline"
                size="sm"
                className="text-[11px]"
              >
                Discard
              </Button>
            </>
          )}
        </div>
        <YamlEditor value={yamlValue} onChange={handleChange} />
      </div>

      <Dialog open={confirmDiscovery} onOpenChange={setConfirmDiscovery}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Run Service Discovery?</DialogTitle>
            <DialogDescription>
              This will replace your current service registry if you accept the results.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDiscovery(false)}>
              Cancel
            </Button>
            <Button onClick={() => { setConfirmDiscovery(false); onRunDiscovery(); }}>
              Run Discovery
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
