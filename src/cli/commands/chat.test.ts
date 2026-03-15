import { describe, it, expect, vi } from "vitest";
import { runChat } from "./chat.js";
import type { IChatAgent } from "../../types/agent-interfaces.js";

function makeMockChatAgent(response: string): IChatAgent {
  return {
    chat: vi.fn().mockResolvedValue({
      response,
      updatedHistory: [],
      images: [],
    }),
  };
}

describe("runChat", () => {
  it("returns chat response with success status", async () => {
    const agent = makeMockChatAgent("There are 3 alerts firing.");
    const result = await runChat(agent, "What alerts fired?", { verbose: false });

    expect(result.command).toBe("chat");
    expect(result.message).toBe("What alerts fired?");
    expect(result.status).toBe("success");
    expect(result.result).toEqual({ response: "There are 3 alerts firing." });
    expect(result.error).toBeNull();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("passes correct ChatRequest to agent", async () => {
    const agent = makeMockChatAgent("ok");
    await runChat(agent, "hello", { verbose: false });

    expect(agent.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "conversational",
        message: "hello",
        history: [],
      }),
    );
  });

  it("returns error status on agent failure", async () => {
    const agent: IChatAgent = {
      chat: vi.fn().mockRejectedValue(new Error("LLM timeout")),
    };
    const result = await runChat(agent, "hello", { verbose: false });

    expect(result.status).toBe("error");
    expect(result.error).toBe("LLM timeout");
    expect(result.result).toBeNull();
  });
});
