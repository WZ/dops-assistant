import type { ProviderConfig } from "../config/schema.js";

export interface StackConfig {
  providers: ProviderConfig[];
}

export interface StackRow {
  id: string;            // ULID
  name: string;          // "US-East Production"
  slug: string;          // "us-east-production"
  config: string;        // JSON-serialized StackConfig
  created_at: string;
  updated_at: string;
  /**
   * ISO timestamp of last activity against this stack — bumped on tool
   * calls, successful polls, webhook invocations, and UI navigation.
   * Defaults to `created_at` for pre-TTL rows (backfilled on migration).
   */
  last_active_at?: string;
  /** ISO timestamp when the stack was marked inactive (30d idle). Null = active. */
  inactive_at?: string | null;
  /** ISO timestamp when the stack was soft-deleted (60d idle). Null = live. */
  deleted_at?: string | null;
}

export type StackStatus = "active" | "inactive";

export interface StackSummary {
  id: string;
  name: string;
  slug: string;
  isDefault: boolean;
  healthSummary?: {
    healthy: number;
    degraded: number;
    down: number;
    unknown: number;
    total: number;
  };
  providerCount: number;
  /**
   * Health rollup of MCP providers for this stack. `ok` counts providers
   * in `connected` status with tools; `error` counts providers the
   * registry has marked unreachable (including the "0 tools = error"
   * case in src/mcp/provider-registry.ts). The dropdown badge reads
   * this — `providerCount` alone hides the difference between "3
   * configured" and "3 configured but all dead". Optional so legacy
   * callers (and stacks that haven't been initialized yet) keep working.
   */
  providerHealth?: {
    ok: number;
    error: number;
    total: number;
  };
  createdAt: string;
  /** "active" normally, "inactive" once the stack has been idle for ~30 days. */
  status: StackStatus;
  /** ISO timestamp of last activity (tool calls, polls, webhook, navigation). */
  lastActiveAt?: string;
}

export const DEFAULT_STACK_SLUG = "default";

// Extend Express.Request with stack context
// Note: StackContext is imported from stack-manager.ts for proper typing
declare global {
  namespace Express {
    interface Request {
      stackId: string;
      stackContext: import("../server/stack-manager.js").StackContext;
    }
  }
}
