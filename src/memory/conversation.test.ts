import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ConversationMemory } from "./conversation.js";

describe("ConversationMemory", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns empty array for unknown thread", () => {
    const mem = new ConversationMemory({ maxMessages: 10, ttlMinutes: 60 });
    expect(mem.get("unknown")).toEqual([]);
  });

  it("appends messages and retrieves them", () => {
    const mem = new ConversationMemory({ maxMessages: 10, ttlMinutes: 60 });
    mem.append("thread-1", { role: "user", content: "Hello." });
    mem.append("thread-1", { role: "assistant", content: "Hi." });
    expect(mem.get("thread-1")).toHaveLength(2);
  });

  it("trims to maxMessages when exceeded", () => {
    const mem = new ConversationMemory({ maxMessages: 3, ttlMinutes: 60 });
    mem.append("thread-1", { role: "user", content: "1" });
    mem.append("thread-1", { role: "assistant", content: "2" });
    mem.append("thread-1", { role: "user", content: "3" });
    mem.append("thread-1", { role: "assistant", content: "4" });
    const history = mem.get("thread-1");
    expect(history).toHaveLength(3);
    expect(history[0].content).toBe("2"); // oldest removed
  });

  it("clears a thread", () => {
    const mem = new ConversationMemory({ maxMessages: 10, ttlMinutes: 60 });
    mem.append("thread-1", { role: "user", content: "Hello." });
    mem.clear("thread-1");
    expect(mem.get("thread-1")).toEqual([]);
  });

  it("evicts threads inactive beyond ttlMinutes", () => {
    const mem = new ConversationMemory({ maxMessages: 10, ttlMinutes: 60 });
    mem.append("thread-1", { role: "user", content: "Hello." });

    // Advance 61 minutes, trigger eviction interval
    vi.advanceTimersByTime(61 * 60 * 1000 + 60 * 1000);

    expect(mem.get("thread-1")).toEqual([]);
  });

  it("does not evict active threads", () => {
    const mem = new ConversationMemory({ maxMessages: 10, ttlMinutes: 60 });
    mem.append("thread-1", { role: "user", content: "Hello." });

    vi.advanceTimersByTime(30 * 60 * 1000); // 30 minutes
    mem.append("thread-1", { role: "assistant", content: "Still here." });
    vi.advanceTimersByTime(31 * 60 * 1000 + 60 * 1000); // another 31min + eviction tick

    expect(mem.get("thread-1")).toHaveLength(2);
  });

  it("destroy() stops the eviction interval", () => {
    const mem = new ConversationMemory({ maxMessages: 10, ttlMinutes: 60 });
    mem.append("thread-1", { role: "user", content: "Hello." });
    mem.destroy();

    // After destroy, advancing past TTL should NOT evict (interval is stopped)
    vi.advanceTimersByTime(61 * 60 * 1000 + 60 * 1000);

    // Thread still present — destroy() stopped the eviction timer
    expect(mem.get("thread-1")).toHaveLength(1);
  });

  it("clearAll() removes all threads at once", () => {
    const mem = new ConversationMemory({ maxMessages: 10, ttlMinutes: 60 });
    mem.append("thread-1", { role: "user", content: "Hello from thread 1." });
    mem.append("thread-2", { role: "user", content: "Hello from thread 2." });
    mem.append("thread-3", { role: "assistant", content: "Hello from thread 3." });

    expect(mem.get("thread-1")).toHaveLength(1);
    expect(mem.get("thread-2")).toHaveLength(1);
    expect(mem.get("thread-3")).toHaveLength(1);

    mem.clearAll();

    expect(mem.get("thread-1")).toEqual([]);
    expect(mem.get("thread-2")).toEqual([]);
    expect(mem.get("thread-3")).toEqual([]);
  });

  it("clearAll() allows new messages after clearing", () => {
    const mem = new ConversationMemory({ maxMessages: 10, ttlMinutes: 60 });
    mem.append("thread-1", { role: "user", content: "old" });
    mem.clearAll();
    mem.append("thread-1", { role: "user", content: "new" });

    expect(mem.get("thread-1")).toHaveLength(1);
    expect(mem.get("thread-1")[0].content).toBe("new");
  });

  it("clearAll() is a no-op on empty store", () => {
    const mem = new ConversationMemory({ maxMessages: 10, ttlMinutes: 60 });
    mem.clearAll(); // should not throw
    expect(mem.get("any")).toEqual([]);
  });
});
