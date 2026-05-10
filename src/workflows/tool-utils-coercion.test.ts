import { describe, it, expect, vi } from "vitest";
import { wrapToolsWithCallbacks } from "./tool-utils.js";

const MASTRA_TOOL_MARKER = Symbol.for("mastra.core.tool.Tool");

/**
 * Smoke test verifying wrapToolsWithCallbacks actually calls
 * coercePrometheusArgs on the LLM-provided args before invoking
 * the underlying tool. Added after a prod log showed the first
 * grafana_query_prometheus call still hitting "startTime: null"
 * validation errors despite the wrapper being wired in discover.ts.
 */
describe("wrapToolsWithCallbacks — end-to-end coercion", () => {
  it("coercePrometheusArgs runs when the wrapped tool is invoked", async () => {
    const innerExecute = vi.fn(async (args: any) => ({ ok: true, sawArgs: args }));
    const tools = {
      grafana_query_prometheus: {
        id: "grafana_query_prometheus",
        inputSchema: { properties: {} },
        execute: innerExecute,
      },
    };

    const wrapped = wrapToolsWithCallbacks(tools, undefined, "test");
    // Invoke the wrapped tool the way Mastra would: tool.execute(inputData, ctx)
    const result = await wrapped.grafana_query_prometheus.execute(
      { datasourceUid: "prometheus", expr: "up", queryType: "instant",
        startTime: null, endTime: null, stepSeconds: null },
      { mastra: {} } as any,
    );

    expect(result).toEqual({ ok: true, sawArgs: expect.anything() });
    expect(innerExecute).toHaveBeenCalledTimes(1);
    const [seenArgs] = innerExecute.mock.calls[0]!;
    // The inner tool must see coerced, non-null values.
    expect(seenArgs.startTime).not.toBeNull();
    expect(seenArgs.endTime).not.toBeNull();
    expect(seenArgs.stepSeconds).toBe(0);
  });

  it("strips the Mastra tool marker so Mastra treats it as a Vercel tool", () => {
    // Simulate a Mastra Tool instance (symbol marker + inputSchema + execute)
    const mcpLikeTool: any = {
      id: "grafana_query_prometheus",
      description: "query Prometheus",
      inputSchema: { properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
      outputSchema: { properties: {} },
    };
    mcpLikeTool[MASTRA_TOOL_MARKER] = true;

    const wrapped = wrapToolsWithCallbacks(
      { grafana_query_prometheus: mcpLikeTool },
      undefined,
      "test",
    );

    const wt = wrapped.grafana_query_prometheus as any;
    // Marker must be gone so Mastra's isMastraTool() returns false.
    expect(wt[MASTRA_TOOL_MARKER]).toBeUndefined();
    expect(MASTRA_TOOL_MARKER in wt).toBe(false);
    // Output schema stripped to avoid Vercel-path output validation surprises.
    expect(wt.outputSchema).toBeUndefined();
    // Input schema still present — the LLM-facing tool spec shouldn't change.
    expect(wt.inputSchema).toBeDefined();
    // Execute is our wrapped function, not the original.
    expect(wt.execute).not.toBe(mcpLikeTool.execute);
  });

  it("relaxes Prometheus defaulted fields in the LLM-facing schema", () => {
    const wrapped = wrapToolsWithCallbacks(
      {
        grafana_query_prometheus: {
          id: "grafana_query_prometheus",
          inputSchema: {
            type: "object",
            required: ["datasourceUid", "expr", "startTime", "endTime", "stepSeconds", "queryType"],
            properties: {
              datasourceUid: { type: "string" },
              expr: { type: "string" },
              startTime: { type: "string" },
              endTime: { type: "string" },
              stepSeconds: { type: "integer" },
              queryType: { type: "string" },
            },
          },
          execute: vi.fn(),
        },
      },
      undefined,
      "test",
    );

    const schema = (wrapped.grafana_query_prometheus as any).inputSchema;
    expect(schema.required).toEqual(["datasourceUid", "expr"]);
    expect(schema.properties.startTime.type).toEqual(["string", "null"]);
    expect(schema.properties.endTime.type).toEqual(["string", "null"]);
    expect(schema.properties.stepSeconds.type).toEqual(["integer", "null"]);
    expect(schema.properties.queryType.type).toEqual(["string", "null"]);
    expect(schema.properties.expr.type).toBe("string");
  });

  it("does not relax non-Prometheus schemas", () => {
    const inputSchema = {
      type: "object",
      required: ["startTime"],
      properties: { startTime: { type: "string" } },
    };
    const wrapped = wrapToolsWithCallbacks(
      {
        grafana_query_loki_logs: {
          id: "grafana_query_loki_logs",
          inputSchema,
          execute: vi.fn(),
        },
      },
      undefined,
      "test",
    );

    expect((wrapped.grafana_query_loki_logs as any).inputSchema).toBe(inputSchema);
  });

  it("coerces hallucinated datasourceUid short name to real UID", async () => {
    const innerExecute = vi.fn(async (args: any) => ({ ok: true, sawArgs: args }));
    const tools = {
      grafana_query_prometheus: {
        id: "grafana_query_prometheus",
        inputSchema: { properties: {} },
        execute: innerExecute,
      },
    };
    const uidMap = new Map([["prometheus", "abc-real-uid-123"]]);

    const wrapped = wrapToolsWithCallbacks(tools, undefined, "test", uidMap);
    await wrapped.grafana_query_prometheus.execute(
      { datasourceUid: "prometheus", expr: "up" },
      {} as any,
    );

    const [seenArgs] = innerExecute.mock.calls[0]!;
    expect(seenArgs.datasourceUid).toBe("abc-real-uid-123");
  });

  it("leaves datasourceUid unchanged when it already matches the real UID", async () => {
    const innerExecute = vi.fn(async (args: any) => ({ ok: true, sawArgs: args }));
    const tools = {
      grafana_query_prometheus: {
        id: "grafana_query_prometheus",
        inputSchema: { properties: {} },
        execute: innerExecute,
      },
    };
    const uidMap = new Map([["prometheus", "abc-real-uid-123"]]);

    const wrapped = wrapToolsWithCallbacks(tools, undefined, "test", uidMap);
    await wrapped.grafana_query_prometheus.execute(
      { datasourceUid: "abc-real-uid-123", expr: "up" },
      {} as any,
    );

    const [seenArgs] = innerExecute.mock.calls[0]!;
    expect(seenArgs.datasourceUid).toBe("abc-real-uid-123");
  });

  it("passes through unknown datasourceUid values without coercion", async () => {
    const innerExecute = vi.fn(async (args: any) => ({ ok: true, sawArgs: args }));
    const tools = {
      grafana_query_prometheus: {
        id: "grafana_query_prometheus",
        inputSchema: { properties: {} },
        execute: innerExecute,
      },
    };
    const uidMap = new Map([["prometheus", "abc-real-uid-123"]]);

    const wrapped = wrapToolsWithCallbacks(tools, undefined, "test", uidMap);
    await wrapped.grafana_query_prometheus.execute(
      { datasourceUid: "some-other-uid", expr: "up" },
      {} as any,
    );

    const [seenArgs] = innerExecute.mock.calls[0]!;
    expect(seenArgs.datasourceUid).toBe("some-other-uid");
  });

  it("skips datasourceUid coercion when map is undefined", async () => {
    const innerExecute = vi.fn(async (args: any) => ({ ok: true, sawArgs: args }));
    const tools = {
      grafana_query_prometheus: {
        id: "grafana_query_prometheus",
        inputSchema: { properties: {} },
        execute: innerExecute,
      },
    };

    const wrapped = wrapToolsWithCallbacks(tools, undefined, "test");
    await wrapped.grafana_query_prometheus.execute(
      { datasourceUid: "prometheus", expr: "up" },
      {} as any,
    );

    const [seenArgs] = innerExecute.mock.calls[0]!;
    expect(seenArgs.datasourceUid).toBe("prometheus");
  });

  it("does not coerce datasourceUid on non-grafana tools", async () => {
    const innerExecute = vi.fn(async (args: any) => ({ ok: true, sawArgs: args }));
    const tools = {
      k8s_pods_list: {
        id: "k8s_pods_list",
        inputSchema: { properties: {} },
        execute: innerExecute,
      },
    };
    const uidMap = new Map([["prometheus", "abc-real-uid-123"]]);

    const wrapped = wrapToolsWithCallbacks(tools, undefined, "test", uidMap);
    await wrapped.k8s_pods_list.execute(
      { datasourceUid: "prometheus", namespace: "default" },
      {} as any,
    );

    const [seenArgs] = innerExecute.mock.calls[0]!;
    expect(seenArgs.datasourceUid).toBe("prometheus");
  });

  it("coerces queryType: null to 'instant'", async () => {
    const innerExecute = vi.fn(async (args: any) => ({ ok: true, sawArgs: args }));
    const tools = {
      grafana_query_prometheus: {
        id: "grafana_query_prometheus",
        inputSchema: { properties: {} },
        execute: innerExecute,
      },
    };

    const wrapped = wrapToolsWithCallbacks(tools, undefined, "test");
    await wrapped.grafana_query_prometheus.execute(
      { datasourceUid: "prometheus", expr: "up", queryType: null, startTime: "now", endTime: "now", stepSeconds: 0 },
      {} as any,
    );

    const [seenArgs] = innerExecute.mock.calls[0]!;
    expect(seenArgs.queryType).toBe("instant");
  });

  it("preserves queryType when already set", async () => {
    const innerExecute = vi.fn(async (args: any) => ({ ok: true, sawArgs: args }));
    const tools = {
      grafana_query_prometheus: {
        id: "grafana_query_prometheus",
        inputSchema: { properties: {} },
        execute: innerExecute,
      },
    };

    const wrapped = wrapToolsWithCallbacks(tools, undefined, "test");
    await wrapped.grafana_query_prometheus.execute(
      { datasourceUid: "prometheus", expr: "up", queryType: "range", startTime: "now-1h", endTime: "now", stepSeconds: 60 },
      {} as any,
    );

    const [seenArgs] = innerExecute.mock.calls[0]!;
    expect(seenArgs.queryType).toBe("range");
  });

  it("coerceLokiArgs drops stepSeconds and forces direction=backward", async () => {
    const innerExecute = vi.fn(async (args: any) => ({ ok: true, sawArgs: args }));
    const tools = {
      grafana_query_loki_logs: {
        id: "grafana_query_loki_logs",
        inputSchema: { properties: {} },
        execute: innerExecute,
      },
    };

    const wrapped = wrapToolsWithCallbacks(tools, undefined, "test");
    await wrapped.grafana_query_loki_logs.execute(
      { datasourceUid: "loki", logql: '{app="foo"}', direction: "forward",
        limit: 20, stepSeconds: 300 },
      {} as any,
    );

    const [seenArgs] = innerExecute.mock.calls[0]!;
    expect(seenArgs.direction).toBe("backward");
    expect(seenArgs.limit).toBe(50);
    expect(seenArgs).not.toHaveProperty("stepSeconds");
  });
});
