import { describe, expect, it } from "vitest";
import {
  buildPatternCluster,
  dedupeRecommendedActions,
  scorePatternSimilarity,
  tokenizePatternText,
  type PatternRowForSimilarity,
} from "./pattern-similarity.js";

const row = (overrides: Partial<PatternRowForSimilarity> = {}): PatternRowForSimilarity => ({
  id: "p1",
  service: "payments-api",
  symptom: "5xx spike during deploy",
  root_cause: "Connection pool exhaustion due to leaked database connections",
  severity: "high",
  recommended_actions: "Increase pool max; Audit retry release path",
  source_investigation_id: "inv1",
  created_at: "2026-04-25T12:00:00.000Z",
  ...overrides,
});

describe("pattern similarity", () => {
  it("tokenizes technical root-cause text while dropping filler words", () => {
    expect(tokenizePatternText("The API had 5xx errors due to DB pool exhaustion.")).toEqual(
      expect.arrayContaining(["api", "5xx", "db", "pool", "exhaustion"]),
    );
    expect(tokenizePatternText("The API had 5xx errors")).not.toContain("the");
  });

  it("scores exact-severity root-cause overlap as a match", () => {
    const score = scorePatternSimilarity(row(), row({
      id: "p2",
      root_cause: "Database connection pool exhausted because connections leaked",
      symptom: "Elevated 5xx and latency",
      severity: "high",
    }));
    expect(score.isMatch).toBe(true);
    expect(score.score).toBeGreaterThanOrEqual(0.5);
  });

  it("allows adjacent severity when root-cause overlap is strong", () => {
    const score = scorePatternSimilarity(row(), row({
      id: "p2",
      root_cause: "Leaked database connections exhausted the connection pool",
      severity: "medium",
    }));
    expect(score.isMatch).toBe(true);
  });

  it("rejects weak root-cause overlap even when symptom text has generic overlap", () => {
    const score = scorePatternSimilarity(row(), row({
      id: "p2",
      symptom: "5xx spike during deploy",
      root_cause: "Redis cache eviction caused stale reads",
      severity: "high",
    }));
    expect(score.isMatch).toBe(false);
  });

  it("dedupes semicolon-delimited actions while preserving first spelling", () => {
    expect(dedupeRecommendedActions([
      row({ recommended_actions: "Increase pool max; Audit retry release path" }),
      row({ recommended_actions: " increase pool max ; Add pool saturation alert" }),
    ])).toEqual([
      "Increase pool max",
      "Audit retry release path",
      "Add pool saturation alert",
    ]);
  });

  it("builds a newest-first cluster around the seed and excludes non-matches", () => {
    const seed = row({ id: "seed", created_at: "2026-04-20T00:00:00.000Z" });
    const match = row({
      id: "match",
      root_cause: "Leaked database connections exhausted the connection pool",
      created_at: "2026-04-25T00:00:00.000Z",
    });
    const miss = row({ id: "miss", root_cause: "OOMKilled pod due to memory limit" });
    const cluster = buildPatternCluster(seed, [seed, miss, match]);
    expect(cluster.occurrences.map((o) => o.id)).toEqual(["match", "seed"]);
    expect(cluster.recurrenceCount).toBe(2);
    expect(cluster.firstSeen).toBe("2026-04-20T00:00:00.000Z");
    expect(cluster.lastSeen).toBe("2026-04-25T00:00:00.000Z");
  });
});
