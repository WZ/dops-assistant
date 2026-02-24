import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ObservabilityServer } from "./server.js";
import { registry } from "./metrics.js";

const TEST_PORT = 19090;

describe("ObservabilityServer", () => {
  let server: ObservabilityServer;

  beforeEach(async () => {
    registry.resetMetrics();
    server = new ObservabilityServer(TEST_PORT, () => true);
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it("GET /health returns 200 when MCP connected", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; mcpConnected: boolean };
    expect(body.status).toBe("ok");
    expect(body.mcpConnected).toBe(true);
  });

  it("GET /health returns 503 when MCP disconnected", async () => {
    await server.stop();
    server = new ObservabilityServer(TEST_PORT, () => false);
    await server.start();
    const res = await fetch(`http://localhost:${TEST_PORT}/health`);
    expect(res.status).toBe(503);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("degraded");
  });

  it("GET /metrics returns Prometheus text format", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
  });

  it("GET /unknown returns 404", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/unknown`);
    expect(res.status).toBe(404);
  });
});
