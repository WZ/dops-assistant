import { useEffect, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
  useNodesState,
  useEdgesState,
  Position,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

interface DependencyNode {
  id: string;
  name: string;
  type: "service" | "database" | "queue" | "cache" | "external";
  status?: "healthy" | "degraded" | "unhealthy";
}

interface DependencyEdge {
  source: string;
  target: string;
  label?: string;
}

const TYPE_ICONS: Record<string, string> = {
  service: "\u2B21",
  database: "\u25A8",
  queue: "\u2B95",
  cache: "\u26A1",
  external: "\u2B1C",
};

const STATUS_COLORS: Record<string, string> = {
  healthy: "#22c55e",
  degraded: "#f59e0b",
  unhealthy: "#ef4444",
};

function nodeColor(status?: string, isTarget?: boolean): string {
  if (isTarget) return "hsl(185 100% 50%)";
  if (status && STATUS_COLORS[status]) return STATUS_COLORS[status]!;
  return "hsl(222 18% 35%)";
}

function toFlowNodes(nodes: DependencyNode[], targetService: string): Node[] {
  const count = nodes.length;
  const angleStep = (2 * Math.PI) / Math.max(count - 1, 1);
  const radius = 150;

  return nodes.map((n, i) => {
    const isTarget = n.name === targetService || n.id === targetService;
    const x = isTarget ? 300 : 300 + radius * Math.cos(i * angleStep);
    const y = isTarget ? 200 : 200 + radius * Math.sin(i * angleStep);
    const color = nodeColor(n.status, isTarget);

    return {
      id: n.id,
      position: { x, y },
      data: { label: `${TYPE_ICONS[n.type] ?? ""} ${n.name}` },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      style: {
        background: "hsl(222 30% 10%)",
        color: "hsl(210 40% 92%)",
        border: `2px solid ${color}`,
        borderRadius: "8px",
        padding: "8px 12px",
        fontSize: "11px",
        fontFamily: '"JetBrains Mono", monospace',
        boxShadow: isTarget ? `0 0 12px ${color}40` : "none",
      },
    };
  });
}

function toFlowEdges(edges: DependencyEdge[]): Edge[] {
  return edges.map((e, i) => ({
    id: `e-${i}`,
    source: e.source,
    target: e.target,
    label: e.label,
    style: { stroke: "hsl(222 18% 25%)", strokeWidth: 1.5 },
    labelStyle: { fill: "hsl(215 20% 50%)", fontSize: 9, fontFamily: '"JetBrains Mono", monospace' },
    animated: true,
  }));
}

export function DependencyGraph({ service }: { service: string }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  useEffect(() => {
    if (!service) return;
    setLoading(true);
    setError(null);

    fetch(`/api/dependencies/${encodeURIComponent(service)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: { nodes: DependencyNode[]; edges: DependencyEdge[] }) => {
        setNodes(toFlowNodes(data.nodes, service));
        setEdges(toFlowEdges(data.edges));
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [service]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <div className="flex items-center justify-center gap-1.5 mb-2">
            <div className="w-1.5 h-1.5 rounded-full bg-primary/50 animate-status-pulse" />
            <div className="w-1.5 h-1.5 rounded-full bg-primary/40 animate-status-pulse" style={{ animationDelay: "0.3s" }} />
            <div className="w-1.5 h-1.5 rounded-full bg-primary/30 animate-status-pulse" style={{ animationDelay: "0.6s" }} />
          </div>
          <p className="text-[11px] font-mono text-muted-foreground/30">Loading dependencies...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-[11px] font-mono text-destructive/50">{error}</p>
      </div>
    );
  }

  if (nodes.length <= 1) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <p className="text-xs text-muted-foreground/40 mb-1">No dependency provider configured</p>
          <p className="text-[10px] text-muted-foreground/25 font-mono">
            Add a provider with &quot;dependencies&quot; role to config.yaml
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full" style={{ minHeight: 300 }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        fitView
        proOptions={{ hideAttribution: true }}
        style={{ background: "transparent" }}
      >
        <Background color="hsl(222 18% 16%)" gap={20} size={1} />
        <Controls
          showInteractive={false}
          style={{ background: "hsl(222 30% 10%)", border: "1px solid hsl(222 18% 20%)", borderRadius: "6px" }}
        />
      </ReactFlow>
    </div>
  );
}
