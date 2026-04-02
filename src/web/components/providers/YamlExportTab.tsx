import { useEffect, useState } from "react";
import { stringify } from "yaml";
import { Button } from "@/components/ui/button";
import { useStackContext } from "../../contexts/StackContext";

interface ProviderExportConfig {
  name: string;
  roles: string[];
  mcpServer: Record<string, unknown>;
  region?: string;
  webUrl?: string;
}

export function YamlExportTab() {
  const { stackFetch } = useStackContext();
  const [yaml, setYaml] = useState("");
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await stackFetch("/api/providers/export");
        const configs: ProviderExportConfig[] = await res.json();
        setYaml(stringify(configs, { indent: 2 }));
      } catch {
        setYaml("# Failed to load providers");
      }
      setLoading(false);
    })();
  }, [stackFetch]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(yaml);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-4">
      <textarea
        readOnly
        value={loading ? "Loading..." : yaml}
        className="w-full rounded-md border border-border/40 bg-secondary/30 px-3 py-2 font-mono text-[11px] text-foreground focus:outline-none resize-y"
        rows={14}
      />
      <div className="flex justify-end">
        <Button
          onClick={handleCopy}
          disabled={loading || !yaml}
          className="font-mono text-xs font-medium min-h-[44px]"
        >
          {copied ? "Copied!" : "Copy to Clipboard"}
        </Button>
      </div>
    </div>
  );
}
