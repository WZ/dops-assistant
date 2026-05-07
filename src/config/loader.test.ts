import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "./loader.js";

describe("loadConfig legacy webhook tokens", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads deprecated YAML webhook tokens so startup can migrate them", () => {
    const dir = mkdtempSync(join(tmpdir(), "config-loader-"));
    tempDirs.push(dir);
    const configPath = join(dir, "config.yaml");
    writeFileSync(configPath, `
llm:
  apiKey: test-key
webhook:
  secret: legacy-single
  tokens:
    primary: legacy-primary
    secondary: legacy-secondary
`);

    const config = loadConfig(configPath);

    expect(config.webhook.legacyTokens).toEqual({
      "legacy-secret": "legacy-single",
      primary: "legacy-primary",
      secondary: "legacy-secondary",
    });
  });
});
