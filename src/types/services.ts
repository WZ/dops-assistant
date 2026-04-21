// src/types/services.ts

export type ServiceHealth = "healthy" | "degraded" | "down" | "unknown";

export interface ServiceMetadata {
  alias?: string;
  tags: string[];
}

export interface ServiceLastInvestigation {
  id: string;
  createdAt: number;
  confidence: number | null;
  status: "running" | "complete" | "failed";
}

export interface ServiceListItem {
  name: string;
  health: ServiceHealth;
  metadata: ServiceMetadata;
  lastInvestigation: ServiceLastInvestigation | null;
}
