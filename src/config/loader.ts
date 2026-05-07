import { readFileSync, existsSync, realpathSync } from "fs";
import { dirname, resolve } from "path";
import { parse } from "yaml";
import { ConfigSchema, type Config, type ServiceConfig } from "./schema.js";
import { ServiceRegistryStore } from "../services/registry.js";

function resolveEnvVars(obj: unknown): unknown {
  if (typeof obj === "string") {
    return obj.replace(/\$\{([^}]+)\}/g, (_, expr: string) => {
      // Support ${VAR:-default} syntax (bash semantics)
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

/**
 * Resolves the services.yaml path relative to the config file directory.
 */
export function getServicesFilePath(configPath: string): string {
  const realPath = realpathSync(configPath);
  return resolve(dirname(realPath), "services.yaml");
}

/**
 * Loads services from a separate services.yaml file if it exists.
 */
export function loadServicesFile(configPath: string): ServiceConfig[] {
  const servicesPath = getServicesFilePath(configPath);
  if (!existsSync(servicesPath)) return [];
  const raw = readFileSync(servicesPath, "utf-8");
  const parsed = parse(raw) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed as ServiceConfig[];
}

/**
 * Detect deprecated yaml-managed webhook tokens and refuse to start. Tokens
 * moved to UI-managed (DB-backed) in the Settings → Alert Webhooks tab;
 * silently dropping unknown keys would leave operators with a Grafana that
 * 401s on every alert and no indication why. Run BEFORE schema parsing —
 * Zod strips unknown keys before we'd see them.
 */
function rejectLegacyWebhookYaml(parsed: unknown): void {
  if (!parsed || typeof parsed !== "object") return;
  const wh = (parsed as Record<string, unknown>)["webhook"];
  if (!wh || typeof wh !== "object") return;
  const legacy = wh as Record<string, unknown>;
  const offenders: string[] = [];
  if (typeof legacy["secret"] === "string" && legacy["secret"].length > 0) offenders.push("webhook.secret");
  if (legacy["tokens"] && typeof legacy["tokens"] === "object" && Object.keys(legacy["tokens"] as object).length > 0) {
    offenders.push("webhook.tokens");
  }
  if (offenders.length > 0) {
    throw new Error(
      `yaml-managed webhook tokens are no longer supported. Remove ${offenders.join(" and ")} ` +
      `from your config and regenerate equivalents in Settings → Alert Webhooks. ` +
      `Existing Grafana integrations will continue to fail until the new tokens are wired up.`
    );
  }
}

export function loadConfig(configPath: string): Config {
  const raw = readFileSync(configPath, "utf-8");
  const parsed = parse(raw);
  rejectLegacyWebhookYaml(parsed);
  const resolved = resolveEnvVars(parsed);
  const result = ConfigSchema.safeParse(resolved);
  if (!result.success) {
    throw new Error(
      `Invalid configuration:\n${result.error.issues
        .map((i) => `  ${i.path.join(".")}: ${i.message}`)
        .join("\n")}`
    );
  }

  // Merge services from services.yaml (inline config takes precedence)
  const config = result.data;
  const servicesPath = getServicesFilePath(configPath);
  const registryStore = new ServiceRegistryStore(servicesPath);
  const fileServices = registryStore.load();
  if (fileServices.length > 0) {
    const inlineNames = new Set(config.services.map((s) => s.name));
    const extra = fileServices.filter((s) => !inlineNames.has(s.name));
    config.services = [...config.services, ...extra];
  }

  return config;
}
