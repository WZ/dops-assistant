/**
 * Tiered HTTP rate limiting middleware and WebSocket rate limiting helpers.
 *
 * Three HTTP tiers:
 *   - Global: 300 req/min per IP for all /api/* routes
 *   - Strict: 10 req/min per IP for LLM-triggering routes
 *   - Moderate: 30 req/min per IP for other POST/PUT/DELETE
 *
 * WebSocket per-connection rate limiting:
 *   - General: 20 messages/min per connection
 *   - Investigation-triggering: 5 messages/min per connection
 */

import rateLimit from "express-rate-limit";

// ── HTTP Rate Limiters ──────────────────────────────────────────────────────

/** Global limiter: 300 requests per minute per IP for all /api/* routes */
export const globalLimiter = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});

/** Strict limiter: 10 requests per minute per IP for LLM-triggering routes */
export const strictLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many requests to this endpoint, please try again later." },
});

/** Moderate limiter: 30 requests per minute per IP for POST/PUT/DELETE */
export const moderateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
  // Only apply to mutating methods
  skip: (req) => req.method === "GET",
});

// ── WebSocket Rate Limiting ─────────────────────────────────────────────────

/** Message type categories for WebSocket rate limiting */
type WsMessageCategory = "general" | "investigation";

interface WsRateState {
  general: number;
  investigation: number;
}

const WS_LIMITS = {
  general: 20,
  investigation: 5,
} as const;

/**
 * Manages per-connection WebSocket message rate limiting.
 *
 * Tracks two categories of messages:
 *   - general: all messages (20/min)
 *   - investigation: chat messages triggering investigations + deep_investigate (5/min)
 *
 * Counters reset every 60 seconds. Call `destroy()` on connection close.
 */
export class WsRateLimiter {
  private counters = new Map<string, WsRateState>();
  private timers = new Map<string, ReturnType<typeof setInterval>>();

  /** Register a new connection and start its reset timer. */
  register(connectionId: string): void {
    this.counters.set(connectionId, { general: 0, investigation: 0 });
    const timer = setInterval(() => {
      const state = this.counters.get(connectionId);
      if (state) {
        state.general = 0;
        state.investigation = 0;
      }
    }, 60_000);
    this.timers.set(connectionId, timer);
  }

  /**
   * Check if a message is allowed for the given connection.
   * Increments the counter if allowed.
   *
   * @returns true if the message is allowed, false if rate limited
   */
  checkAndIncrement(connectionId: string, category: WsMessageCategory): boolean {
    const state = this.counters.get(connectionId);
    if (!state) return true; // Unknown connection — allow (shouldn't happen)

    // Always check general limit
    if (state.general >= WS_LIMITS.general) {
      return false;
    }

    // Check investigation limit for investigation messages
    if (category === "investigation" && state.investigation >= WS_LIMITS.investigation) {
      return false;
    }

    // Allowed — increment counters
    state.general++;
    if (category === "investigation") {
      state.investigation++;
    }

    return true;
  }

  /** Clean up a connection's state and timer. */
  destroy(connectionId: string): void {
    this.counters.delete(connectionId);
    const timer = this.timers.get(connectionId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(connectionId);
    }
  }

  /** Clean up all connections — for server shutdown. */
  destroyAll(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
    this.counters.clear();
  }
}

/**
 * Classify a WebSocket message type into a rate limiting category.
 *
 * Investigation-triggering messages:
 *   - "chat" messages (which may trigger investigations via intent routing)
 *   - "deep_investigate" messages
 *
 * All other messages are "general".
 */
export function classifyWsMessage(msgType: string): WsMessageCategory {
  if (msgType === "chat" || msgType === "deep_investigate") {
    return "investigation";
  }
  return "general";
}
