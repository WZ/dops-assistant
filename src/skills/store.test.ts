import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SkillStore } from "./store.js";
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
        filePath: "/fake",
        body: longBody,
      }]);
      expect(formatted).toContain("...[truncated]");
    });

    it("returns empty string for no skills", () => {
      expect(store.formatForPrompt([])).toBe("");
    });
  });
});
