import { useState, useEffect } from "react";
import { ReactFlow, Background, Controls, type Node, type Edge } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useStackContext } from "../contexts/StackContext";

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

type HealthStatus = "healthy" | "degraded" | "unhealthy" | "unknown";

interface ServiceDependencyGraphProps {
  serviceName: string;
  onViewService: (name: string) => void;
  healthMap?: Record<string, HealthStatus>;
  dependencySource?: "prometheus" | "kubernetes" | "inferred";
  /** When provided, skip the internal fetch and use this data directly. */
  initialData?: DependencyData;
  /** When provided alongside initialData, skip the internal healthMap fetch. */
  initialHealthMap?: Record<string, HealthStatus>;
}

function healthDotColor(status: HealthStatus): string {
  switch (status) {
    case "healthy":
      return "hsl(var(--success))";
    case "degraded":
      return "hsl(var(--warning))";
    case "unhealthy":
      return "hsl(var(--destructive))";
    case "unknown":
    default:
      return "hsl(var(--muted-foreground) / 0.4)";
  }
}

export function ServiceDependencyGraph({
  serviceName,
  onViewService,
  healthMap: healthMapProp,
  dependencySource,
  initialData,
  initialHealthMap,
}: ServiceDependencyGraphProps) {
  const { stackFetch } = useStackContext();
  const [data, setData] = useState<DependencyData | null>(initialData ?? null);
  const [loading, setLoading] = useState(initialData === undefined);
  const [error, setError] = useState<string | null>(null);
  const [tableOpen, setTableOpen] = useState(false);

  // Merge: initialHealthMap takes precedence when initialData is provided;
  // otherwise fall back to the healthMap prop passed from parent.
  const healthMap = initialData !== undefined ? (initialHealthMap ?? healthMapProp) : healthMapProp;

  // Sync when initialData arrives after mount (parent fetched it async)
  useEffect(() => {
    if (initialData !== undefined) {
      setData(initialData);
      setLoading(false);
    }
  }, [initialData]);

  useEffect(() => {
    // Skip fetch when pre-fetched data was supplied.
    if (initialData !== undefined) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    stackFetch(`/api/dependencies/${encodeURIComponent(serviceName)}`)
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
  }, [serviceName, initialData]);

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

  const isInferred = !dependencySource || dependencySource === "inferred";

  const nodes: Node[] = data.nodes.map((n, i) => {
    const health: HealthStatus = healthMap?.[n.name] ?? "unknown";
    const dotColor = healthDotColor(health);
    const showDot = !!healthMap;

    return {
      id: n.id,
      position: { x: 150 * (i % 4), y: 120 * Math.floor(i / 4) },
      data: {
        label: showDot ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                display: "inline-block",
                width: 6,
                height: 6,
                borderRadius: 9999,
                background: dotColor,
                flexShrink: 0,
              }}
            />
            {n.name}
          </span>
        ) : n.name,
        _labelText: n.name,
      },
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
    };
  });

  const edges: Edge[] = data.edges.map((e) => ({
    id: `${e.source}->${e.target}`,
    source: e.source,
    target: e.target,
    label: e.label,
    style: { stroke: border },
    labelStyle: { fontSize: 9, fill: mutedFg },
  }));

  // Build accessible table rows
  const tableRows = data.nodes.map((n) => {
    const outgoing = data.edges.filter((e) => e.source === n.id);
    const incoming = data.edges.filter((e) => e.target === n.id);
    let connection = "none";
    if (outgoing.length > 0 && incoming.length > 0) connection = "upstream + downstream";
    else if (outgoing.length > 0) connection = "upstream";
    else if (incoming.length > 0) connection = "downstream";
    const health: HealthStatus = healthMap?.[n.name] ?? "unknown";
    return { node: n, health, connection };
  });

  return (
    <div className="flex flex-col gap-2">
      <div
        className="rounded-lg border border-border/25 bg-card/40 overflow-hidden"
        style={{ height: 400 }}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodeClick={(_, node) => onViewService((node.data._labelText ?? node.data.label) as string)}
          fitView
          fitViewOptions={{ maxZoom: 0.8 }}
        >
          <Background color={border} gap={16} />
          <Controls />
        </ReactFlow>
      </div>

      {/* Estimated topology disclaimer */}
      {isInferred && (
        <p
          style={{
            fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)",
            fontSize: 10,
            color: "hsl(var(--muted-foreground) / 0.5)",
            margin: 0,
            paddingLeft: 2,
          }}
        >
          Estimated topology — based on query and log analysis
        </p>
      )}

      {/* Accessible dependency table (collapsible) */}
      <div>
        <button
          type="button"
          onClick={() => setTableOpen((prev) => !prev)}
          style={{
            fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)",
            fontSize: 10,
            color: "hsl(var(--muted-foreground))",
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: "2px 0",
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
          aria-expanded={tableOpen}
          aria-controls="dependency-table"
        >
          <span style={{ fontSize: 8, display: "inline-block", transform: tableOpen ? "rotate(90deg)" : "none", transition: "transform 150ms ease-out" }}>▶</span>
          {tableOpen ? "Hide table" : "Show as table"}
        </button>

        {tableOpen && (
          <div
            id="dependency-table"
            className="mt-1 rounded-lg border border-border/25 bg-card/40 overflow-auto"
          >
            <table
              role="table"
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)",
                fontSize: 10,
              }}
            >
              <thead>
                <tr role="row">
                  {["Service", "Type", "Status", "Connection"].map((col) => (
                    <th
                      key={col}
                      role="columnheader"
                      style={{
                        textAlign: "left",
                        padding: "6px 12px",
                        borderBottom: "1px solid hsl(var(--border) / 0.4)",
                        color: "hsl(var(--muted-foreground))",
                        fontWeight: 600,
                        fontSize: 9,
                        textTransform: "uppercase",
                        letterSpacing: "0.08em",
                      }}
                    >
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tableRows.map(({ node, health, connection }) => (
                  <tr
                    key={node.id}
                    role="row"
                    style={{
                      borderBottom: "1px solid hsl(var(--border) / 0.2)",
                      cursor: "pointer",
                    }}
                    onClick={() => onViewService(node.name)}
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onViewService(node.name); }}
                    aria-label={`View service ${node.name}`}
                  >
                    <td
                      role="cell"
                      style={{
                        padding: "5px 12px",
                        color: node.name === serviceName ? "hsl(var(--primary))" : "hsl(var(--foreground))",
                        fontWeight: node.name === serviceName ? 600 : 400,
                      }}
                    >
                      {node.name}
                    </td>
                    <td
                      role="cell"
                      style={{ padding: "5px 12px", color: "hsl(var(--muted-foreground))" }}
                    >
                      {node.type ?? "—"}
                    </td>
                    <td role="cell" style={{ padding: "5px 12px" }}>
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 5,
                          color: "hsl(var(--muted-foreground))",
                        }}
                      >
                        {healthMap && (
                          <span
                            style={{
                              display: "inline-block",
                              width: 6,
                              height: 6,
                              borderRadius: 9999,
                              background: healthDotColor(health),
                              flexShrink: 0,
                            }}
                          />
                        )}
                        {health}
                      </span>
                    </td>
                    <td
                      role="cell"
                      style={{ padding: "5px 12px", color: "hsl(var(--muted-foreground))" }}
                    >
                      {connection}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
