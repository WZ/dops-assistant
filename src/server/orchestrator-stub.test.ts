import { describe, it, expect, vi } from "vitest";
import { streamStubbedOrchestrator } from "./ws-handler";
import type { ServerMessage } from "../types/ws-types.js";

const ID = "inv_stub";
type Pending = { resolve: (d: "continue" | "escalate" | "wait") => void; timer: ReturnType<typeof setTimeout> };

function collect() {
  const sent: ServerMessage[] = [];
  return { sent, send: (m: ServerMessage) => sent.push(m) };
}
const types = (sent: ServerMessage[]) => sent.map((m) => m.type);

/** Resolve the stub's pending pause the way the real orchestrator_decision handler does. */
async function answerPause(pending: Map<string, Pending>, decision: "continue" | "escalate" | "wait") {
  await vi.waitFor(() => expect(pending.has(ID)).toBe(true));
  const p = pending.get(ID)!;
  clearTimeout(p.timer);
  pending.delete(ID);
  p.resolve(decision);
}

describe("streamStubbedOrchestrator (E2E engine stub)", () => {
  it("continue → streams, pauses, resumes, and confirms a cause", async () => {
    const { sent, send } = collect();
    const pending = new Map<string, Pending>();
    const run = streamStubbedOrchestrator(ID, send, pending, new AbortController().signal, 0);
    await answerPause(pending, "continue");
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
    expect(done.causalChain?.some((l) => l.kind === "root-cause")).toBe(true);
  });

  it("escalate → stops with an operator-pause outcome (no further steps)", async () => {
    const { sent, send } = collect();
    const pending = new Map<string, Pending>();
    const run = streamStubbedOrchestrator(ID, send, pending, new AbortController().signal, 0);
    await answerPause(pending, "escalate");
    await run;
    const done = sent.at(-1) as Extract<ServerMessage, { type: "orchestrator:complete" }>;
    expect(done.outcome).toBe("operator-pause");
    expect(types(sent).filter((t) => t === "orchestrator:step")).toHaveLength(2); // no resume step
  });

  it("abort before the pause → completes as aborted", async () => {
    const { sent, send } = collect();
    const pending = new Map<string, Pending>();
    const ac = new AbortController();
    ac.abort();
    await streamStubbedOrchestrator(ID, send, pending, ac.signal, 0);
    const done = sent.at(-1) as Extract<ServerMessage, { type: "orchestrator:complete" }>;
    expect(done.outcome).toBe("aborted");
  });
});
