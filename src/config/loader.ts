import { readFileSync } from "fs";
import { parse } from "yaml";
import { ConfigSchema, type Config } from "./schema.js";

function resolveEnvVars(obj: unknown): unknown {
  if (typeof obj === "string") {
    return obj.replace(/\$\{([^}]+)\}/g, (_, expr: string) => {
      // Support ${VAR:-default} syntax
      const sepIdx = expr.indexOf(":-");
      const key = sepIdx >= 0 ? expr.slice(0, sepIdx) : expr;
      const defaultVal = sepIdx >= 0 ? expr.slice(sepIdx + 2) : undefined;

      const val = process.env[key];
      // For ${VAR:-default}: use default when val is unset or empty (bash semantics)
      if (defaultVal !== undefined) {
        return (val !== undefined && val !== "") ? val : defaultVal;
      }
      // For ${VAR}: original behavior — only throw on undefined
      if (val === undefined) {
        throw new Error(`Missing environment variable: ${key}`);
      }
      return val;
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
