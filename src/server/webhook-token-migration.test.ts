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

  it("hashes legacy config tokens into the DB without storing plaintext", () => {
    const db = makeDb();
    try {
      const imported = importLegacyWebhookTokens(db, {
        "legacy-secret": "legacy-single",
        primary: "legacy-primary",
      });

      expect(imported).toBe(2);
      expect(db.findWebhookTokenByHash(hashWebhookToken("legacy-single"))?.name).toBe("legacy-secret");
      expect(db.findWebhookTokenByHash(hashWebhookToken("legacy-primary"))?.name).toBe("primary");
      expect(JSON.stringify(db.listWebhookTokens())).not.toContain("legacy-primary");
    } finally {
      db.close();
    }
  });

  it("is idempotent when the same legacy config remains during a restart", () => {
    const db = makeDb();
    try {
      const tokens = { primary: "legacy-primary" };

      expect(importLegacyWebhookTokens(db, tokens)).toBe(1);
      expect(importLegacyWebhookTokens(db, tokens)).toBe(0);
      expect(db.listWebhookTokens()).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
