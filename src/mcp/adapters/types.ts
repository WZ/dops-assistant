import type { ServiceConfig } from "../../config/schema.js";

export interface TimeWindow {
  startRfc3339: string;
  endRfc3339: string;
}

export interface LogProviderAdapter {
  /** Discover available label/field names, return a hint string for the LLM */
  getLabelsHint(): Promise<string>;
  /** Find a working log selector for a service */
  getWorkingSelector(service: ServiceConfig, probeWindow?: TimeWindow): Promise<string>;
  /** Prompt fragment telling the LLM how to query logs with this provider */
  getPromptFragment(): string;
}
