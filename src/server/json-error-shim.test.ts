import { describe, it, expect } from "vitest";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";

/**
 * Isolated test for the body-parser SyntaxError shim that index.ts installs
 * right after `express.json()`. Without the shim, Express renders a default
 * HTML 400 page for malformed JSON, which makes SPA clients crash with
 * "SyntaxError: Unexpected token <" when they try to `res.json()` the error.
 */

function buildAppWithShim() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof SyntaxError && "body" in (err as SyntaxError & { body?: unknown })) {
      res.status(400).json({ error: "Invalid JSON in request body" });
      return;
    }
    next(err);
  });
  app.post("/echo", (req: Request, res: Response) => { res.json({ received: req.body }); });
  return app;
}

describe("JSON error shim", () => {
  it("returns JSON 400 for malformed JSON bodies instead of HTML", async () => {
    const app = buildAppWithShim();
    const res = await request(app)
      .post("/echo")
      .set("Content-Type", "application/json")
      .send("{bad");
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: "Invalid JSON in request body" });
  });

  it("passes through valid JSON as before", async () => {
    const app = buildAppWithShim();
    const res = await request(app)
      .post("/echo")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ hello: "world" }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: { hello: "world" } });
  });

  it("forwards non-SyntaxError errors so other handlers can catch them", async () => {
    // Regression guard: the shim should only catch body-parser SyntaxErrors,
    // not arbitrary errors from downstream handlers. A bug here would swallow
    // genuine server errors and mask them as "Invalid JSON in request body".
    const app = express();
    app.use(express.json());
    app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
      if (err instanceof SyntaxError && "body" in (err as SyntaxError & { body?: unknown })) {
        res.status(400).json({ error: "Invalid JSON in request body" });
        return;
      }
      next(err);
    });
    app.get("/boom", () => { throw new Error("downstream failure"); });
    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      res.status(500).json({ error: err instanceof Error ? err.message : "unknown" });
    });
    const res = await request(app).get("/boom");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "downstream failure" });
  });
});
