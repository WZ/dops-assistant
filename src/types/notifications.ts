export type NotificationSource = "webhook" | "scan" | "scan-run" | "poller" | "k8s-event-poller" | "manual";
export type SeverityLevel = "low" | "medium" | "high" | "critical";

export const ALL_SOURCES: readonly NotificationSource[] = ["webhook", "scan", "scan-run", "poller", "k8s-event-poller", "manual"] as const;
export const ALL_SEVERITIES: readonly SeverityLevel[] = ["low", "medium", "high", "critical"] as const;

export function severityRank(s: SeverityLevel): number {
  return ALL_SEVERITIES.indexOf(s);
}

export interface EmailRecipient {
  id: number;
  address: string;
  label?: string;
  minSeverity: SeverityLevel;
  allowedSources: NotificationSource[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Human-readable rendering of the compact source enum. Used by email templates. */
export function sourceDisplayText(s: NotificationSource): string {
  switch (s) {
    case "webhook": return "Alertmanager webhook";
    case "scan": return "Proactive scan";
    case "scan-run": return "Scan run summary";
    case "poller": return "Health poller";
    case "k8s-event-poller": return "K8s event poller";
    case "manual": return "Manual investigation";
  }
}
