import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SkillStore, filterSkillsByScope, DEFAULT_SCOPE } from "./store.js";
import type { Skill, SkillScope } from "./store.js";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const createTempDir = async () => {
  const dir = join(tmpdir(), `skills-test-${randomUUID().slice(0, 8)}`);
  await mkdir(dir, { recursive: true });
  return dir;
};

describe("SkillStore", () => {
  let dir: string;
  let store: SkillStore;

  beforeEach(async () => {
    dir = await createTempDir();
    store = new SkillStore({ dir, maxPerQuery: 3, maxCharsPerSkill: 2000 });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe("loadAll", () => {
    it("loads skills from markdown files with YAML frontmatter", async () => {
      await writeFile(
        join(dir, "kafka-lag.md"),
        `---
title: Investigate Kafka Lag
services: [kafka-brokers]
alerts: [KafkaLagHigh]
tags: [kafka, lag, consumer]
---

## Steps
1. Check consumer group lag
`,
      );

      await store.loadAll();
      const all = store.getAll();
      expect(all).toHaveLength(1);
      expect(all[0]!.id).toBe("kafka-lag");
      expect(all[0]!.title).toBe("Investigate Kafka Lag");
      expect(all[0]!.services).toEqual(["kafka-brokers"]);
      expect(all[0]!.alerts).toEqual(["KafkaLagHigh"]);
      expect(all[0]!.tags).toEqual(["kafka", "lag", "consumer"]);
    });

    it("handles empty directory", async () => {
      await store.loadAll();
      expect(store.getAll()).toHaveLength(0);
    });

    it("handles non-existent directory", async () => {
      const nonExistent = new SkillStore({ dir: "/tmp/does-not-exist-123", maxPerQuery: 3, maxCharsPerSkill: 2000 });
      await nonExistent.loadAll();
      expect(nonExistent.getAll()).toHaveLength(0);
    });
  });

  describe("getById", () => {
    it("returns full skill with body", async () => {
      await writeFile(
        join(dir, "test-skill.md"),
        `---
title: Test Skill
services: []
alerts: []
tags: [test]
---

Body content here`,
      );

      await store.loadAll();
      const skill = store.getById("test-skill");
      expect(skill).toBeDefined();
      expect(skill!.body).toBe("Body content here");
    });

    it("returns undefined for unknown id", async () => {
      await store.loadAll();
      expect(store.getById("nonexistent")).toBeUndefined();
    });
  });

  describe("search", () => {
    beforeEach(async () => {
      await writeFile(
        join(dir, "kafka-lag.md"),
        `---
title: Investigate Kafka Consumer Lag
services: [kafka-brokers, kafka-consumers]
alerts: [KafkaConsumerLagHigh]
tags: [kafka, consumer, lag, backpressure]
---
Steps here`,
      );
      await writeFile(
        join(dir, "high-cpu.md"),
        `---
title: Investigate High CPU Usage
services: []
alerts: [HighCPU]
tags: [cpu, high, usage, performance]
---
Steps here`,
      );
      await store.loadAll();
    });

    it("matches by exact service name", () => {
      const results = store.search({ service: "kafka-brokers" });
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe("kafka-lag");
    });

    it("matches by exact alert name", () => {
      const results = store.search({ alert: "HighCPU" });
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe("high-cpu");
    });

    it("matches by query text with tag overlap", () => {
      const results = store.search({ query: "kafka consumer lag is increasing" });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.id).toBe("kafka-lag");
    });

    it("returns empty for no matches", () => {
      const results = store.search({ service: "unknown-service" });
      expect(results).toHaveLength(0);
    });

    it("respects maxPerQuery limit", () => {
      const results = store.search({ query: "investigate" });
      expect(results.length).toBeLessThanOrEqual(3);
    });
  });

  describe("save", () => {
    it("creates a new skill file", async () => {
      const skill = await store.save(undefined, {
        title: "New Skill",
        services: ["my-service"],
        alerts: [],
        tags: ["test"],
      }, "## Steps\n1. Do something");

      expect(skill.id).toBe("new-skill");
      expect(skill.title).toBe("New Skill");
      expect(skill.body).toBe("## Steps\n1. Do something");

      // Verify it's accessible after save
      const retrieved = store.getById("new-skill");
      expect(retrieved).toBeDefined();
      expect(retrieved!.services).toEqual(["my-service"]);
    });

    it("updates an existing skill by id", async () => {
      await store.save("test-id", {
        title: "Original",
        services: [],
        alerts: [],
        tags: [],
      }, "original body");

      await store.save("test-id", {
        title: "Updated",
        services: ["svc"],
        alerts: [],
        tags: ["updated"],
      }, "updated body");

      const skill = store.getById("test-id");
      expect(skill!.title).toBe("Updated");
      expect(skill!.body).toBe("updated body");
    });

    it("rejects explicit ids that attempt path traversal", async () => {
      await expect(store.save("../../tmp/pwn", {
        title: "Bad Skill",
        services: [],
        alerts: [],
        tags: [],
      }, "body")).rejects.toThrow("Invalid skill id");

      expect(store.getAll()).toHaveLength(0);
    });
  });

  describe("delete", () => {
    it("removes a skill", async () => {
      await store.save("to-delete", {
        title: "To Delete",
        services: [],
        alerts: [],
        tags: [],
      }, "body");

      expect(store.getById("to-delete")).toBeDefined();
      await store.delete("to-delete");
      expect(store.getById("to-delete")).toBeUndefined();
    });

    it("handles deleting non-existent skill gracefully", async () => {
      await expect(store.delete("nonexistent")).resolves.not.toThrow();
    });
  });

  describe("formatForPrompt", () => {
    it("formats skills for prompt injection", async () => {
      await writeFile(
        join(dir, "test.md"),
        `---
title: Test Skill
services: []
alerts: []
tags: []
---
Some body content`,
      );
      await store.loadAll();

      const skills = [store.getById("test")!];
      const formatted = store.formatForPrompt(skills);
      expect(formatted).toContain("## Team Knowledge (Skills)");
      expect(formatted).toContain("### Skill: Test Skill");
      expect(formatted).toContain("Some body content");
    });

    it("truncates long skill bodies", () => {
      const shortStore = new SkillStore({ dir, maxPerQuery: 3, maxCharsPerSkill: 20 });
      const longBody = "A".repeat(100);
      const formatted = shortStore.formatForPrompt([{
        id: "test",
        title: "Test",
        services: [],
        alerts: [],
        tags: [],
        scope: ["investigation"],
        filePath: "/fake",
        body: longBody,
      }]);
      expect(formatted).toContain("...[truncated]");
    });

    it("returns empty string for no skills", () => {
      expect(store.formatForPrompt([])).toBe("");
    });
  });

  describe("scope", () => {
    it("materializes default scope when frontmatter has no scope", async () => {
      await writeFile(
        join(dir, "no-scope.md"),
        `---
title: No Scope Skill
services: []
alerts: []
tags: [test]
---
Body`,
      );
      await store.loadAll();
      const skill = store.getById("no-scope");
      expect(skill).toBeDefined();
      expect(skill!.scope).toEqual(DEFAULT_SCOPE);
    });

    it("parses explicit scope from frontmatter", async () => {
      await writeFile(
        join(dir, "discovery-skill.md"),
        `---
title: Discovery Skill
services: []
alerts: []
tags: [bare-metal]
scope: [discovery]
---
Discovery body`,
      );
      await store.loadAll();
      const skill = store.getById("discovery-skill");
      expect(skill!.scope).toEqual(["discovery"]);
    });

    it("parses multi-scope from frontmatter", async () => {
      await writeFile(
        join(dir, "multi-scope.md"),
        `---
title: Multi Scope
services: []
alerts: []
tags: []
scope: [chat, discovery]
---
Body`,
      );
      await store.loadAll();
      const skill = store.getById("multi-scope");
      expect(skill!.scope).toEqual(["chat", "discovery"]);
    });

    it("falls back to default on invalid scope values", async () => {
      await writeFile(
        join(dir, "bad-scope.md"),
        `---
title: Bad Scope
services: []
alerts: []
tags: []
scope: [nonexistent, bogus]
---
Body`,
      );
      await store.loadAll();
      const skill = store.getById("bad-scope");
      expect(skill!.scope).toEqual(DEFAULT_SCOPE);
    });

    it("filterSkillsByScope returns correct subset", () => {
      const skills: Skill[] = [
        { id: "a", title: "A", services: [], alerts: [], tags: [], scope: ["investigation"], filePath: "", body: "" },
        { id: "b", title: "B", services: [], alerts: [], tags: [], scope: ["discovery"], filePath: "", body: "" },
        { id: "c", title: "C", services: [], alerts: [], tags: [], scope: ["chat", "investigation"], filePath: "", body: "" },
      ];
      expect(filterSkillsByScope(skills, "investigation")).toHaveLength(2);
      expect(filterSkillsByScope(skills, "discovery")).toHaveLength(1);
      expect(filterSkillsByScope(skills, "chat")).toHaveLength(1);
    });

    it("getAllForScope returns matching skills sorted by title", async () => {
      await writeFile(join(dir, "z-skill.md"), `---\ntitle: Zebra Skill\nservices: []\nalerts: []\ntags: []\nscope: [discovery]\n---\nBody`);
      await writeFile(join(dir, "a-skill.md"), `---\ntitle: Alpha Skill\nservices: []\nalerts: []\ntags: []\nscope: [discovery]\n---\nBody`);
      await writeFile(join(dir, "inv-skill.md"), `---\ntitle: Investigation Only\nservices: []\nalerts: []\ntags: []\nscope: [investigation]\n---\nBody`);
      await store.loadAll();

      const discovery = store.getAllForScope("discovery");
      expect(discovery).toHaveLength(2);
      expect(discovery[0]!.title).toBe("Alpha Skill");
      expect(discovery[1]!.title).toBe("Zebra Skill");

      const inv = store.getAllForScope("investigation");
      expect(inv).toHaveLength(1);
      expect(inv[0]!.title).toBe("Investigation Only");
    });

    it("getAllForScope respects maxPerQuery cap", async () => {
      const smallStore = new SkillStore({ dir, maxPerQuery: 1, maxCharsPerSkill: 2000 });
      await writeFile(join(dir, "d1.md"), `---\ntitle: D1\nservices: []\nalerts: []\ntags: []\nscope: [discovery]\n---\nBody`);
      await writeFile(join(dir, "d2.md"), `---\ntitle: D2\nservices: []\nalerts: []\ntags: []\nscope: [discovery]\n---\nBody`);
      await smallStore.loadAll();
      expect(smallStore.getAllForScope("discovery")).toHaveLength(1);
    });

    it("search with scope filters before relevance cap", async () => {
      // Create 4 skills: 3 investigation, 1 chat. All match service "api-gateway"
      for (let i = 0; i < 3; i++) {
        await writeFile(join(dir, `inv-${i}.md`), `---\ntitle: Inv ${i}\nservices: [api-gateway]\nalerts: []\ntags: []\nscope: [investigation]\n---\nBody`);
      }
      await writeFile(join(dir, "chat-skill.md"), `---\ntitle: Chat Skill\nservices: [api-gateway]\nalerts: []\ntags: []\nscope: [chat]\n---\nChat body`);
      await store.loadAll();

      // Without scope filter, maxPerQuery=3 might cap before chat skill
      const chatResults = store.search({ service: "api-gateway", scope: "chat" });
      expect(chatResults).toHaveLength(1);
      expect(chatResults[0]!.id).toBe("chat-skill");
    });

    it("save persists scope in frontmatter", async () => {
      await store.save("scoped", {
        title: "Scoped Skill",
        services: [],
        alerts: [],
        tags: [],
        scope: ["chat", "discovery"],
      }, "Body");

      // Reload from disk
      const fresh = new SkillStore({ dir, maxPerQuery: 3, maxCharsPerSkill: 2000 });
      await fresh.loadAll();
      const skill = fresh.getById("scoped");
      expect(skill!.scope).toEqual(["chat", "discovery"]);
    });

    it("save defaults scope to investigation when not provided", async () => {
      await store.save("no-scope-save", {
        title: "No Scope Save",
        services: [],
        alerts: [],
        tags: [],
      }, "Body");

      const fresh = new SkillStore({ dir, maxPerQuery: 3, maxCharsPerSkill: 2000 });
      await fresh.loadAll();
      const skill = fresh.getById("no-scope-save");
      expect(skill!.scope).toEqual(DEFAULT_SCOPE);
    });

    it("backward compat: existing skills without scope default to investigation", async () => {
      // Simulate an existing skill file without scope field
      await writeFile(
        join(dir, "legacy.md"),
        `---
title: Legacy Runbook
services: [my-service]
alerts: [HighLatency]
tags: [latency]
---
Check dashboards`,
      );
      await store.loadAll();

      // Still found by service search
      const results = store.search({ service: "my-service" });
      expect(results).toHaveLength(1);
      expect(results[0]!.scope).toEqual(DEFAULT_SCOPE);

      // Not found by chat or discovery scope
      const chatResults = store.search({ service: "my-service", scope: "chat" });
      expect(chatResults).toHaveLength(0);
    });
  });
});
