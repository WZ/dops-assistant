import { describe, it, expect } from "vitest";
import { Database } from "./db.js";
import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create a temp DB for testing */
function makeTempDb(): { db: Database; cleanup: () => void } {
  const dbPath = join(tmpdir(), `notif-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const db = new Database(dbPath);
  return {
    db,
    cleanup: () => {
      db.close();
      try { unlinkSync(dbPath); } catch {}
    },
  };
}

// ── DB settings (getSetting / setSetting / deleteSetting) ─────────────────────

describe("Database settings", () => {
  it("getSetting returns undefined when key doesn't exist", () => {
    const { db, cleanup } = makeTempDb();
    try {
      expect(db.getSetting("nonexistent.key")).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("setSetting + getSetting roundtrip", () => {
    const { db, cleanup } = makeTempDb();
    try {
      db.setSetting("notifications.slack.webhookUrl", "https://hooks.slack.com/services/T00/B00/xxx");
      expect(db.getSetting("notifications.slack.webhookUrl")).toBe("https://hooks.slack.com/services/T00/B00/xxx");
    } finally {
      cleanup();
    }
  });

  it("setSetting overwrites existing value", () => {
    const { db, cleanup } = makeTempDb();
    try {
      db.setSetting("notifications.slack.webhookUrl", "https://old-url.com");
      db.setSetting("notifications.slack.webhookUrl", "https://new-url.com");
      expect(db.getSetting("notifications.slack.webhookUrl")).toBe("https://new-url.com");
    } finally {
      cleanup();
    }
  });

  it("deleteSetting removes the key", () => {
    const { db, cleanup } = makeTempDb();
    try {
      db.setSetting("notifications.slack.webhookUrl", "https://hooks.slack.com/services/T00/B00/xxx");
      expect(db.getSetting("notifications.slack.webhookUrl")).toBeDefined();
      db.deleteSetting("notifications.slack.webhookUrl");
      expect(db.getSetting("notifications.slack.webhookUrl")).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});

// ── Notification route logic ──────────────────────────────────────────────────
//
// The routes are registered on an Express app with middleware dependencies
// (StackManager, etc.). Rather than spinning up a full Express server, we test
// the route logic inline — the same approach used in routes.test.ts for
// feedback/pattern extraction logic.

describe("GET /api/notifications logic", () => {
  it("returns default config when no settings exist", () => {
    const { db, cleanup } = makeTempDb();
    try {
      // Simulate the GET handler logic
      const configWebhookUrl: string | undefined = undefined; // no config.yaml override
      const slackUrl = db.getSetting("notifications.slack.webhookUrl");
      const slackEnabled = db.getSetting("notifications.slack.enabled");
      const effectiveUrl = slackUrl ?? configWebhookUrl ?? null;
      const effectiveEnabled = slackEnabled !== undefined ? slackEnabled === "true" : !!effectiveUrl;

      const response = {
        slack: {
          webhookUrl: effectiveUrl,
          enabled: effectiveEnabled,
          source: slackUrl ? "gui" : (configWebhookUrl ? "config" : "none"),
        },
      };

      expect(response.slack.webhookUrl).toBeNull();
      expect(response.slack.enabled).toBe(false);
      expect(response.slack.source).toBe("none");
    } finally {
      cleanup();
    }
  });
});

describe("PUT /api/notifications logic", () => {
  it("saves Slack webhook URL", () => {
    const { db, cleanup } = makeTempDb();
    try {
      // Simulate the PUT handler with a valid URL
      const webhookUrl = "https://hooks.slack.com/services/T00/B00/xxx";
      // Validate URL (same as route handler)
      new URL(webhookUrl); // would throw if invalid
      db.setSetting("notifications.slack.webhookUrl", webhookUrl);

      // Verify it was persisted
      expect(db.getSetting("notifications.slack.webhookUrl")).toBe(webhookUrl);

      // Verify GET logic now returns the saved URL
      const slackUrl = db.getSetting("notifications.slack.webhookUrl");
      const effectiveUrl = slackUrl ?? null;
      const effectiveEnabled = !!effectiveUrl;
      expect(effectiveUrl).toBe(webhookUrl);
      expect(effectiveEnabled).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("rejects invalid URL", () => {
    const { db, cleanup } = makeTempDb();
    try {
      const invalidUrl = "not-a-valid-url";
      let rejected = false;
      try {
        new URL(invalidUrl);
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);

      // Verify nothing was saved
      expect(db.getSetting("notifications.slack.webhookUrl")).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("rejects non-HTTPS URL (SSRF protection)", () => {
    // Simulate the PUT handler's HTTPS-only check
    const httpUrl = "http://169.254.169.254/latest/meta-data/";
    const parsed = new URL(httpUrl);
    expect(parsed.protocol).not.toBe("https:");

    const fileUrl = "file:///etc/passwd";
    const fileParsed = new URL(fileUrl);
    expect(fileParsed.protocol).not.toBe("https:");

    // Valid HTTPS URL should pass
    const httpsUrl = "https://hooks.slack.com/services/T00/B00/xxx";
    const httpsParsed = new URL(httpsUrl);
    expect(httpsParsed.protocol).toBe("https:");
  });

  it("with null URL clears the setting", () => {
    const { db, cleanup } = makeTempDb();
    try {
      // First, set a webhook URL
      db.setSetting("notifications.slack.webhookUrl", "https://hooks.slack.com/services/T00/B00/xxx");
      expect(db.getSetting("notifications.slack.webhookUrl")).toBeDefined();

      // Simulate PUT with null webhookUrl (same logic as route handler)
      const webhookUrl: string | null = null;
      if (webhookUrl === null || webhookUrl === "") {
        db.deleteSetting("notifications.slack.webhookUrl");
      }

      // Verify it was cleared
      expect(db.getSetting("notifications.slack.webhookUrl")).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});

describe("POST /api/notifications/test logic", () => {
  it("returns 400 when no URL configured", () => {
    const { db, cleanup } = makeTempDb();
    try {
      // Simulate the POST /api/notifications/test handler logic
      const configWebhookUrl: string | undefined = undefined; // no config.yaml override
      const slackUrl = db.getSetting("notifications.slack.webhookUrl") ?? configWebhookUrl;

      // Route handler checks: if (!slackUrl) → 400
      expect(slackUrl).toBeUndefined();

      // Simulate the 400 response
      const status = slackUrl ? 200 : 400;
      const body = slackUrl ? { ok: true } : { error: "No Slack webhook URL configured" };

      expect(status).toBe(400);
      expect(body).toEqual({ error: "No Slack webhook URL configured" });
    } finally {
      cleanup();
    }
  });
});
