import type { PrefetchStrategy } from "./types.js";

export class GenericPrefetchStrategy implements PrefetchStrategy {
  name = "generic";

  async fetchDatasourceHints(): Promise<string> {
    return "";
  }

  async fetchDashboardContext(): Promise<{ dashboardContext: string; panelQueryHints: string }> {
    return { dashboardContext: "", panelQueryHints: "" };
  }

  async fetchLogContext(): Promise<{ logLabelHints: string; workingLogSelectors: string[] }> {
    return { logLabelHints: "", workingLogSelectors: [] };
  }
}
