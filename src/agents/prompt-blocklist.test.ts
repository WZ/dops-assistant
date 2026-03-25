/**
 * Prompt regression test — ensures no agent prompt contains hardcoded
 * provider-specific tool names. This is Success Criterion 6 encoded as CI.
 *
 * If this test fails, an agent prompt was re-introduced with a provider-specific
 * tool name. Fix: use generic intent descriptions (WHAT not HOW).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const AGENTS_DIR = join(import.meta.dirname, ".");

/** Provider-specific tool names that must NOT appear in agent prompts. */
const BLOCKLIST = [
  "query_prometheus",
  "query_loki_logs",
  "query_loki_stats",
  "query_loki_patterns",
  "list_loki_label_names",
  "list_loki_label_values",
  "list_datasources",
  "get_panel_image",
  "get_dashboard_by_uid",
  "get_dashboard_panel_queries",
  "search_dashboards",
  "find_error_pattern_logs",
];

/** Files that are allowed to reference tool names (routing/lookup code, not prompts). */
const EXEMPT_FILES = [
  "prompt-blocklist.test.ts", // this file
  "shared/",                   // prepare-step quirk handling
];

describe("Agent prompt blocklist", () => {
  const agentFiles = readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .filter((f) => !EXEMPT_FILES.some((ex) => f.includes(ex)));

  for (const file of agentFiles) {
    it(`${file} should not contain hardcoded tool names in prompts`, () => {
      const content = readFileSync(join(AGENTS_DIR, file), "utf-8");

      // Extract string literals that look like prompt/instruction content
      // Match template literals (backtick strings) and regular string literals
      const templateLiterals = content.match(/`[^`]*`/gs) ?? [];
      const instructionAssignments = content.match(/instructions:\s*(?:`[^`]*`|"[^"]*"|'[^']*'|\([^)]*\))/gs) ?? [];
      const allPromptText = [...templateLiterals, ...instructionAssignments].join("\n");

      // Only check files that have prompt-like content
      if (!allPromptText.includes("instructions") && !allPromptText.includes("You are")) {
        return; // Not an agent file with prompts
      }

      const found: string[] = [];
      for (const term of BLOCKLIST) {
        // Match the tool name as a word (not as a substring of a comment about the blocklist)
        if (allPromptText.includes(term)) {
          found.push(term);
        }
      }

      expect(found, `Found hardcoded tool names in ${file} prompts: ${found.join(", ")}`).toEqual([]);
    });
  }
});
