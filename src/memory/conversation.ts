import type { Message } from "../types/llm-types.js";

type ThreadEntry = {
  messages: Message[];
  lastActivity: Date;
};

export class ConversationMemory {
  private store = new Map<string, ThreadEntry>();
  private maxMessages: number;
  private ttlMs: number;
  private evictionInterval: ReturnType<typeof setInterval>;

  constructor(opts: { maxMessages: number; ttlMinutes: number }) {
    this.maxMessages = opts.maxMessages;
    this.ttlMs = opts.ttlMinutes * 60 * 1000;
    this.evictionInterval = setInterval(() => this.evict(), 60 * 1000);
    this.evictionInterval.unref();
  }

  get(threadId: string): Message[] {
    return this.store.get(threadId)?.messages ?? [];
  }

  append(threadId: string, message: Message): void {
    const entry = this.store.get(threadId) ?? { messages: [], lastActivity: new Date() };
    entry.messages.push(message);
    if (entry.messages.length > this.maxMessages) {
      entry.messages = entry.messages.slice(entry.messages.length - this.maxMessages);
    }
    entry.lastActivity = new Date();
    this.store.set(threadId, entry);
  }

  clear(threadId: string): void {
    this.store.delete(threadId);
  }

  /** Clear all threads — used when the user clears all console messages. */
  clearAll(): void {
    this.store.clear();
  }

  destroy(): void {
    clearInterval(this.evictionInterval);
  }

  private evict(): void {
    const now = Date.now();
    for (const [id, entry] of this.store) {
      if (now - entry.lastActivity.getTime() > this.ttlMs) {
        this.store.delete(id);
      }
    }
  }
}
