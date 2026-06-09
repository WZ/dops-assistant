import { describe, it, expect, vi } from "vitest";
import { streamStubbedOrchestrator } from "./ws-handler";
import { OrchestratorRunRegistry } from "./orchestrator-run-registry.js";
import type { ServerMessage } from "../types/ws-types.js";

const ID = "inv_stub";

function collect() {
  const sent: ServerMessage[] = [];
  return { sent, send: (m: ServerMessage) => sent.push(m) };
}
const types = (sent: ServerMessage[]) => sent.map((m) => m.type);

/** A registry with the run registered (so setPause has an entry). The stub
 *  streams directly via the passed `send`; the registry only holds its pause. */
function registryFor(ac: AbortController): OrchestratorRunRegistry {
  const reg = new OrchestratorRunRegistry();
  reg.create(ID, ac);
  return reg;
}

/** Resolve the stub's pending pause the way the real orchestrator_decision handler does. */
async function answerPause(reg: OrchestratorRunRegistry, decision: "continue" | "escalate" | "wait") {
  await vi.waitFor(() => expect(reg.hasPause(ID)).toBe(true));
  reg.resolvePause(ID, decision);
}

describe("streamStubbedOrchestrator (E2E engine stub)", () => {
  it("continue → streams, pauses, resumes, and confirms a cause", async () => {
    const { sent, send } = collect();
    const reg = registryFor(new AbortController());
    const run = streamStubbedOrchestrator(ID, send, reg, new AbortController().signal, { stepDelayMs: 0 });
    await answerPause(reg, "continue");
    await run;

    expect(types(sent)).toEqual([
      "orchestrator:started",
      "orchestrator:step",
      "orchestrator:step",
      "orchestrator:operator_pause",
      "orchestrator:step",
      "orchestrator:complete",
    ]);
    const done = sent.at(-1) as Extract<ServerMessage, { type: "orchestrator:complete" }>;
    expect(done.outcome).toBe("confirmed");
    const root = done.causalChain?.find((l) => l.kind === "root-cause");
    expect(root).toBeTruthy();
    // PR-3: the confirmed root cause carries deep-link provenance (the query that
    // confirmed it) so the deep-run surfaces can render a "Grafana ↗" link.
    expect(root?.provenance?.tool).toBe("query_prometheus");
    expect(root?.provenance?.args).toContain("expr");
  });

  it("escalate → stops with an operator-pause outcome (no further steps)", async () => {
    const { sent, send } = collect();
    const reg = registryFor(new AbortController());
    const run = streamStubbedOrchestrator(ID, send, reg, new AbortController().signal, { stepDelayMs: 0 });
    await answerPause(reg, "escalate");
    await run;
    const done = sent.at(-1) as Extract<ServerMessage, { type: "orchestrator:complete" }>;
    expect(done.outcome).toBe("operator-pause");
    expect(types(sent).filter((t) => t === "orchestrator:step")).toHaveLength(2); // no resume step
  });

  it("abort before the pause → completes as aborted", async () => {
    const { sent, send } = collect();
    const ac = new AbortController();
    ac.abort();
    await streamStubbedOrchestrator(ID, send, registryFor(ac), ac.signal, { stepDelayMs: 0 });
    const done = sent.at(-1) as Extract<ServerMessage, { type: "orchestrator:complete" }>;
    expect(done.outcome).toBe("aborted");
  });

  it("anchors the scripted run to the real service + dependency (coherent demo)", async () => {
    const { sent, send } = collect();
    const reg = registryFor(new AbortController());
    const run = streamStubbedOrchestrator(ID, send, reg, new AbortController().signal, {
      stepDelayMs: 0, service: "minimax-m25-vllm-bench-2gpu", dependency: "minimax-m25-internal-service",
    });
    await answerPause(reg, "continue");
    await run;

    const done = sent.at(-1) as Extract<ServerMessage, { type: "orchestrator:complete" }>;
    const chain = done.causalChain ?? [];
    expect(chain[0]).toMatchObject({ label: "minimax-m25-vllm-bench-2gpu", kind: "incident" });
    expect(chain.find((l) => l.kind === "followed")?.label).toBe("minimax-m25-internal-service");
    const root = chain.find((l) => l.kind === "root-cause");
    expect(root?.label).toContain("minimax-m25-internal-service connection pool starvation");
    expect(root?.provenance?.args).toContain("minimax-m25-internal-service");
    expect(done.stats?.depth).toBe(1);
    // No hardcoded impala anywhere.
    expect(JSON.stringify(sent)).not.toContain("impala");
  });

  it("with no dependency, confirms on the incident service itself at depth 0", async () => {
    const { sent, send } = collect();
    const reg = registryFor(new AbortController());
    const run = streamStubbedOrchestrator(ID, send, reg, new AbortController().signal, { stepDelayMs: 0, service: "minimax-m25-vllm-bench-2gpu" });
    await answerPause(reg, "continue");
    await run;

    const done = sent.at(-1) as Extract<ServerMessage, { type: "orchestrator:complete" }>;
    const chain = done.causalChain ?? [];
    expect(chain.some((l) => l.kind === "followed")).toBe(false);
    expect(chain.find((l) => l.kind === "root-cause")?.label).toContain("minimax-m25-vllm-bench-2gpu connection pool starvation");
    expect(done.stats?.depth).toBe(0);
    expect(done.traceSummary).toContain("depth 0");
  });
});
