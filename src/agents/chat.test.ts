import { describe, it, expect } from "vitest";
import { createChatAgent } from "./chat.js";
import type { LanguageModel } from "ai";

const fakeModel = {} as LanguageModel;

describe("createChatAgent", () => {
  it("creates an agent with name 'chat'", () => {
    const agent = createChatAgent({ model: fakeModel });
    expect(agent.name).toBe("chat");
  });

  it("creates an agent with id 'chat'", () => {
    const agent = createChatAgent({ model: fakeModel });
    expect(agent.id).toBe("chat");
  });

  it("creates an agent without throwing when tools are provided", () => {
    const agent = createChatAgent({ model: fakeModel, tools: {}, maxSteps: 5 });
    expect(agent).toBeDefined();
  });
});
