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
}

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
  createdAt: string;
}

export const DEFAULT_STACK_SLUG = "default";

// Extend Express.Request with stack context
declare global {
  namespace Express {
    interface Request {
      stackId: string;
      stackContext: any; // Will be properly typed as StackContext after Phase 2
    }
  }
}
