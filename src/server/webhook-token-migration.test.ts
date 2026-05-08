import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "./db.js";
import { hashWebhookToken } from "./webhook-tokens.js";
import { importLegacyWebhookTokens } from "./webhook-token-migration.js";

describe("importLegacyWebhookTokens", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeDb(): Database {
    const dir = mkdtempSync(join(tmpdir(), "webhook-token-migration-"));
    tempDirs.push(dir);
    return new Database(join(dir, "test.sqlite"));
  }

  // The default stack id is just an opaque string at this layer — the
  // migration writes whatever caller passes through, and lookup-by-hash is
  // scoped to the same stack. Using a literal here keeps the tests
  // self-contained without spinning up StackManager.
  const DEFAULT_STACK = "stack-default";

  it("hashes legacy config tokens into the DB without storing plaintext, scoped to the default stack", () => {
    const db = makeDb();
    try {
      const imported = importLegacyWebhookTokens(db, {
        "legacy-secret": "legacy-single",
        primary: "legacy-primary",
      }, DEFAULT_STACK);

      expect(imported).toBe(2);
      expect(db.findWebhookTokenByHash(hashWebhookToken("legacy-single"), DEFAULT_STACK)?.name).toBe("legacy-secret");
      expect(db.findWebhookTokenByHash(hashWebhookToken("legacy-primary"), DEFAULT_STACK)?.name).toBe("primary");
      expect(JSON.stringify(db.listWebhookTokens(DEFAULT_STACK))).not.toContain("legacy-primary");
    } finally {
      db.close();
    }
  });

  it("is idempotent when the same legacy config remains during a restart", () => {
    const db = makeDb();
    try {
      const tokens = { primary: "legacy-primary" };

      expect(importLegacyWebhookTokens(db, tokens, DEFAULT_STACK)).toBe(1);
      expect(importLegacyWebhookTokens(db, tokens, DEFAULT_STACK)).toBe(0);
      expect(db.listWebhookTokens(DEFAULT_STACK)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("scopes imported tokens so a different stack can't authenticate with the same hash", () => {
    const db = makeDb();
    try {
      // Legacy yaml tokens are imported into the default stack only.
      // A different stack id must NOT resolve the same hash — that's the
      // privilege boundary that prevents stack-A's operator from firing
      // alerts at stack-B's webhook URL using their own token.
      expect(importLegacyWebhookTokens(db, { primary: "legacy-secret-token" }, "stack-default")).toBe(1);

      const hash = hashWebhookToken("legacy-secret-token");
      expect(db.findWebhookTokenByHash(hash, "stack-default")?.name).toBe("primary");
      expect(db.findWebhookTokenByHash(hash, "stack-east")).toBeNull();
    } finally {
      db.close();
    }
  });
});
