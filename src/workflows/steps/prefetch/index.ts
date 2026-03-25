export type { PrefetchStrategy, ToolMap } from "./types.js";
export { findTool, hasTool, callProviderTool } from "./types.js";
export { GrafanaPrefetchStrategy } from "./grafana.js";
export { GenericPrefetchStrategy } from "./generic.js";

import type { ToolMap } from "./types.js";
import type { PrefetchStrategy } from "./types.js";
import { hasTool } from "./types.js";
import { GrafanaPrefetchStrategy } from "./grafana.js";
import { GenericPrefetchStrategy } from "./generic.js";

/**
 * Select the appropriate prefetch strategy based on available tools.
 * Checks if any provider has Grafana-style tools (list_datasources, search_dashboards).
 */
export function selectPrefetchStrategy(toolMaps: ToolMap[]): PrefetchStrategy {
  const hasGrafanaTools = toolMaps.some(({ tools }) =>
    hasTool(tools, "list_datasources") || hasTool(tools, "search_dashboards"),
  );
  return hasGrafanaTools ? new GrafanaPrefetchStrategy() : new GenericPrefetchStrategy();
}
