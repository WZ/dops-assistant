import { useState, useEffect } from "react";
import { ReactFlow, Background, Controls, type Node, type Edge } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

interface DependencyNode {
  id: string;
  name: string;
  type?: string;
}

interface DependencyEdge {
  source: string;
  target: string;
  label?: string;
}

interface DependencyData {
  nodes: DependencyNode[];
  edges: DependencyEdge[];
}

interface ServiceDependencyGraphProps {
  serviceName: string;
  onViewService: (name: string) => void;
}

export function ServiceDependencyGraph({ serviceName, onViewService }: ServiceDependencyGraphProps) {
  const [data, setData] = useState<DependencyData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`/api/dependencies/${encodeURIComponent(serviceName)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<DependencyData>;
      })
      .then((json) => {
        if (!cancelled) {
          setData(json);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError("Failed to load dependencies.");
          setLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [serviceName]);

  if (loading) {
    return (
      <div className="rounded-lg border border-border/25 bg-card/40 overflow-hidden shimmer-skeleton" style={{ height: 400 }}>
        <div className="h-full w-full bg-muted/30" />
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="rounded-lg border border-border/25 bg-card/40 flex items-center justify-center"
        style={{ height: 400 }}
      >
        <span className="font-mono text-[11px] text-muted-foreground/60">{error}</span>
      </div>
    );
  }

  if (!data || data.nodes.length === 0) {
    return (
      <div
        className="rounded-lg border border-border/25 bg-card/40 flex items-center justify-center text-center px-8"
        style={{ height: 400 }}
      >
        <span className="font-mono text-[11px] text-muted-foreground/60">
          No dependencies detected. Run discovery to map service relationships.
        </span>
      </div>
    );
  }

  const cs = getComputedStyle(document.documentElement);
  const varVal = (name: string) => `hsl(${cs.getPropertyValue(name).trim()})`;
  const primary = varVal("--primary");
  const secondary = varVal("--secondary");
  const border = varVal("--border");
  const fg = varVal("--foreground");
  const mutedFg = varVal("--muted-foreground");

  const nodes: Node[] = data.nodes.map((n, i) => ({
    id: n.id,
    position: { x: 150 * (i % 4), y: 120 * Math.floor(i / 4) },
    data: { label: n.name },
    style:
      n.name === serviceName
        ? {
            background: `color-mix(in srgb, ${primary} 15%, transparent)`,
            border: `1px solid ${primary}`,
            color: primary,
            borderRadius: 8,
            padding: "6px 14px",
            fontSize: 11,
            fontFamily: "var(--font-mono)",
          }
        : {
            background: secondary,
            border: `1px solid ${border}`,
            color: fg,
            borderRadius: 8,
            padding: "6px 14px",
            fontSize: 11,
            fontFamily: "var(--font-mono)",
          },
  }));

  const edges: Edge[] = data.edges.map((e) => ({
    id: `${e.source}->${e.target}`,
    source: e.source,
    target: e.target,
    label: e.label,
    style: { stroke: border },
    labelStyle: { fontSize: 9, fill: mutedFg },
  }));

  return (
    <div
      className="rounded-lg border border-border/25 bg-card/40 overflow-hidden"
      style={{ height: 400 }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodeClick={(_, node) => onViewService(node.data.label as string)}
        fitView
      >
        <Background color={border} gap={16} />
        <Controls />
      </ReactFlow>
    </div>
  );
}
