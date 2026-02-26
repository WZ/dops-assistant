import { readFileSync } from "fs";
import { parse } from "yaml";
import { ConfigSchema, type Config } from "./schema.js";

function resolveEnvVars(obj: unknown): unknown {
  if (typeof obj === "string") {
    return obj.replace(/\$\{([^}]+)\}/g, (_, expr: string) => {
      const match = expr.match(/^([^:-]+)(?::-([\s\S]*))?$/);
      if (!match) {
        throw new Error(`Invalid env var expression: \${${expr}}`);
      }
      const key = match[1]!;
      const defaultVal = match[2];
      const val = process.env[key];
      if (val !== undefined) return val;
      if (defaultVal !== undefined) return defaultVal;
      throw new Error(`Missing environment variable: ${key}`);
    });
  }
  if (Array.isArray(obj)) {
    return obj.map(resolveEnvVars);
  }
  if (obj !== null && typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => [
        k,
        resolveEnvVars(v),
      ])
    );
  }
  return obj;
}

export function loadConfig(configPath: string): Config {
  const raw = readFileSync(configPath, "utf-8");
  const parsed = parse(raw);
  const resolved = resolveEnvVars(parsed);
  const result = ConfigSchema.safeParse(resolved);
  if (!result.success) {
    throw new Error(
      `Invalid configuration:\n${result.error.issues
        .map((i) => `  ${i.path.join(".")}: ${i.message}`)
        .join("\n")}`
    );
  }
  return result.data;
}
