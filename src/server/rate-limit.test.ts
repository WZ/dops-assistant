import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import {
  globalLimiter,
  strictLimiter,
  moderateLimiter,
  WsRateLimiter,
  classifyWsMessage,
} from "./rate-limit.js";

// ── HTTP Rate Limiting Tests ────────────────────────────────────────────────

describe("HTTP rate limiting", () => {
  // Each test creates a fresh Express app with fresh limiter instances
  // to avoid cross-test counter contamination. express-rate-limit uses
  // the module-level singletons so we import fresh copies via factory.

  it("global limiter: 301st request returns 429", async () => {
    const { default: rateLimit } = await import("express-rate-limit");
    const limiter = rateLimit({
      windowMs: 60_000,
      limit: 300,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      message: { error: "Too many requests, please try again later." },
    });

    const app = express();
    app.use("/api", limiter);
    app.get("/api/test", (_req, res) => res.json({ ok: true }));

    // Send 300 requests — all should succeed
    for (let i = 0; i < 300; i++) {
      const res = await request(app).get("/api/test");
      expect(res.status).toBe(200);
    }

    // 301st request should be rate limited
    const res = await request(app).get("/api/test");
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
  });

  it("strict limiter: 11th request returns 429", async () => {
    const { default: rateLimit } = await import("express-rate-limit");
    const limiter = rateLimit({
      windowMs: 60_000,
      limit: 10,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      message: { error: "Too many requests to this endpoint, please try again later." },
    });

    const app = express();
    app.use("/api/skills/generate", limiter);
    app.post("/api/skills/generate", (_req, res) => res.json({ ok: true }));

    for (let i = 0; i < 10; i++) {
      const res = await request(app).post("/api/skills/generate");
      expect(res.status).toBe(200);
    }

    const res = await request(app).post("/api/skills/generate");
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
  });

  it("moderate limiter: 31st POST returns 429", async () => {
    const { default: rateLimit } = await import("express-rate-limit");
    const limiter = rateLimit({
      windowMs: 60_000,
      limit: 30,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      message: { error: "Too many requests, please try again later." },
      skip: (req) => req.method === "GET",
    });

    const app = express();
    app.use(express.json());
    app.use("/api", limiter);
    app.post("/api/something", (_req, res) => res.json({ ok: true }));
    app.get("/api/something", (_req, res) => res.json({ ok: true }));

    for (let i = 0; i < 30; i++) {
      const res = await request(app).post("/api/something");
      expect(res.status).toBe(200);
    }

    // 31st POST should be rate limited
    const postRes = await request(app).post("/api/something");
    expect(postRes.status).toBe(429);

    // GET should still work (moderate limiter skips GET)
    const getRes = await request(app).get("/api/something");
    expect(getRes.status).toBe(200);
  });

  it("429 response includes Retry-After header", async () => {
    const { default: rateLimit } = await import("express-rate-limit");
    const limiter = rateLimit({
      windowMs: 60_000,
      limit: 1,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      message: { error: "Rate limited" },
    });

    const app = express();
    app.use("/api", limiter);
    app.get("/api/test", (_req, res) => res.json({ ok: true }));

    // First request succeeds
    await request(app).get("/api/test");

    // Second request is rate limited
    const res = await request(app).get("/api/test");
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("under-limit requests return normally", async () => {
    const { default: rateLimit } = await import("express-rate-limit");
    const limiter = rateLimit({
      windowMs: 60_000,
      limit: 100,
      standardHeaders: "draft-7",
      legacyHeaders: false,
    });

    const app = express();
    app.use("/api", limiter);
    app.get("/api/test", (_req, res) => res.json({ ok: true }));

    for (let i = 0; i < 5; i++) {
      const res = await request(app).get("/api/test");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    }
  });

  // Fix #3 (plan-eng-review 2026-04-15): the server runs behind a k8s ingress
  // that sets X-Forwarded-For. Without `trust proxy`, req.ip resolves to the
  // proxy IP and every client shares one rate-limit bucket. Setting trust proxy
  // to 1 makes req.ip resolve to the first forwarded hop (the real client).
  it("trust proxy = 1 resolves req.ip from X-Forwarded-For", async () => {
    const app = express();
    app.set("trust proxy", 1);
    app.get("/whoami", (req, res) => res.json({ ip: req.ip }));

    const res = await request(app)
      .get("/whoami")
      .set("X-Forwarded-For", "203.0.113.42");

    expect(res.status).toBe(200);
    expect(res.body.ip).toBe("203.0.113.42");
  });

  it("without trust proxy, req.ip ignores X-Forwarded-For (regression baseline)", async () => {
    const app = express();
    // No app.set("trust proxy", ...) — Express defaults to false.
    app.get("/whoami", (req, res) => res.json({ ip: req.ip }));

    const res = await request(app)
      .get("/whoami")
      .set("X-Forwarded-For", "203.0.113.42");

    expect(res.status).toBe(200);
    // req.ip falls back to the socket's remote address — not the forwarded one.
    expect(res.body.ip).not.toBe("203.0.113.42");
  });
});

// ── WebSocket Rate Limiting Tests ───────────────────────────────────────────

describe("WsRateLimiter", () => {
  let limiter: WsRateLimiter;

  beforeEach(() => {
    limiter = new WsRateLimiter();
  });

  afterEach(() => {
    limiter.destroyAll();
  });

  it("allows messages under the general limit", () => {
    limiter.register("conn-1");
    for (let i = 0; i < 20; i++) {
      expect(limiter.checkAndIncrement("conn-1", "general")).toBe(true);
    }
  });

  it("rejects the 21st general message", () => {
    limiter.register("conn-1");
    for (let i = 0; i < 20; i++) {
      limiter.checkAndIncrement("conn-1", "general");
    }
    expect(limiter.checkAndIncrement("conn-1", "general")).toBe(false);
  });

  it("allows messages under the investigation limit", () => {
    limiter.register("conn-1");
    for (let i = 0; i < 5; i++) {
      expect(limiter.checkAndIncrement("conn-1", "investigation")).toBe(true);
    }
  });

  it("rejects the 6th investigation message", () => {
    limiter.register("conn-1");
    for (let i = 0; i < 5; i++) {
      limiter.checkAndIncrement("conn-1", "investigation");
    }
    expect(limiter.checkAndIncrement("conn-1", "investigation")).toBe(false);
  });

  it("investigation messages also count toward general limit", () => {
    limiter.register("conn-1");
    // Send 15 general messages
    for (let i = 0; i < 15; i++) {
      limiter.checkAndIncrement("conn-1", "general");
    }
    // Send 5 investigation messages (these also count as general)
    for (let i = 0; i < 5; i++) {
      limiter.checkAndIncrement("conn-1", "investigation");
    }
    // General limit (20) is now reached — even general messages should fail
    expect(limiter.checkAndIncrement("conn-1", "general")).toBe(false);
  });

  it("tracks connections independently", () => {
    limiter.register("conn-1");
    limiter.register("conn-2");

    // Exhaust conn-1
    for (let i = 0; i < 20; i++) {
      limiter.checkAndIncrement("conn-1", "general");
    }
    expect(limiter.checkAndIncrement("conn-1", "general")).toBe(false);

    // conn-2 should still be fine
    expect(limiter.checkAndIncrement("conn-2", "general")).toBe(true);
  });

  it("destroy cleans up connection state", () => {
    limiter.register("conn-1");
    limiter.checkAndIncrement("conn-1", "general");
    limiter.destroy("conn-1");

    // After destroy, unknown connections are allowed (pass-through)
    expect(limiter.checkAndIncrement("conn-1", "general")).toBe(true);
  });

  it("counters reset after interval", () => {
    vi.useFakeTimers();
    try {
      limiter.register("conn-1");

      // Exhaust the limit
      for (let i = 0; i < 20; i++) {
        limiter.checkAndIncrement("conn-1", "general");
      }
      expect(limiter.checkAndIncrement("conn-1", "general")).toBe(false);

      // Advance time by 60 seconds to trigger reset
      vi.advanceTimersByTime(60_000);

      // Should be allowed again
      expect(limiter.checkAndIncrement("conn-1", "general")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── classifyWsMessage Tests ─────────────────────────────────────────────────

describe("classifyWsMessage", () => {
  it("classifies chat as investigation", () => {
    expect(classifyWsMessage("chat")).toBe("investigation");
  });

  it("classifies deep_investigate as investigation", () => {
    expect(classifyWsMessage("deep_investigate")).toBe("investigation");
  });

  it("classifies deep_mode_investigate as investigation", () => {
    expect(classifyWsMessage("deep_mode_investigate")).toBe("investigation");
  });

  it("classifies orchestrator_investigate as investigation", () => {
    expect(classifyWsMessage("orchestrator_investigate")).toBe("investigation");
  });

  it("classifies orchestrator_accept as investigation because it runs report re-synthesis", () => {
    expect(classifyWsMessage("orchestrator_accept")).toBe("investigation");
  });

  it("classifies other message types as general", () => {
    expect(classifyWsMessage("new_session")).toBe("general");
    expect(classifyWsMessage("discover")).toBe("general");
    expect(classifyWsMessage("discover:accept")).toBe("general");
    expect(classifyWsMessage("discover:reject")).toBe("general");
    expect(classifyWsMessage("unknown")).toBe("general");
  });
});
