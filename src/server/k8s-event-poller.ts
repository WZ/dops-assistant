import { createLogger } from "../logger.js";
import type { MastraProvider } from "../mcp/provider.js";
import type { ServiceRegistryStore } from "../services/registry.js";
import type { Database } from "./db.js";
import type { K8sEventsConfig } from "../config/schema.js";

const logger = createLogger();

export type DegradedReason =
  | "infrastructure-role-not-resolved"
  | "infrastructure-not-kubernetes"
  | "infrastructure-call-failed";

export interface K8sEventHit {
  service: string;
  podUid: string;
  reason: string;
  message: string;
  occurredAt: string;
  source: "event" | "restart-count";
  restartCount?: number;
}

export interface K8sEventPollerDeps {
  providers: MastraProvider[] | (() => MastraProvider[]);
  registryStore: ServiceRegistryStore;
  db: Database;
  stackId: string;
  config: K8sEventsConfig;
  onK8sEvent?: (hit: K8sEventHit) => void;
  getHiddenServices?: () => Set<string>;
}

const RECENT_HITS_CAP = 100;

export class K8sEventPoller {
  private readonly resolveProviders: () => MastraProvider[];
  private readonly registryStore: ServiceRegistryStore;
  private readonly db: Database;
  private readonly stackId: string;
  private readonly config: K8sEventsConfig;
  private readonly onK8sEvent?: (hit: K8sEventHit) => void;
  private readonly getHiddenServices?: () => Set<string>;

  private intervalHandle: ReturnType<typeof setInterval> | undefined;
  private lastTickAt: Date | null = null;
  private degradedReason: DegradedReason | null = null;
  private readonly restartCache: Map<string, number> = new Map();
  private readonly recentHits: K8sEventHit[] = [];

  constructor(deps: K8sEventPollerDeps) {
    this.resolveProviders = typeof deps.providers === "function"
      ? deps.providers
      : () => deps.providers as MastraProvider[];
    this.registryStore = deps.registryStore;
    this.db = deps.db;
    this.stackId = deps.stackId;
    this.config = deps.config;
    this.onK8sEvent = deps.onK8sEvent;
    this.getHiddenServices = deps.getHiddenServices;
  }

  start(): void {
    if (this.intervalHandle) return;
    if (!this.config.enabled) {
      logger.info({ stackId: this.stackId }, "K8sEventPoller: disabled by config");
      return;
    }
    void this.poll().catch((err) =>
      logger.warn({ err, stackId: this.stackId }, "K8sEventPoller: initial poll failed"),
    );
    this.intervalHandle = setInterval(() => {
      void this.poll().catch((err) =>
        logger.warn({ err, stackId: this.stackId }, "K8sEventPoller: poll failed"),
      );
    }, this.config.intervalSeconds * 1000);
  }

  stop(): void {
    if (!this.intervalHandle) return;
    clearInterval(this.intervalHandle);
    this.intervalHandle = undefined;
  }

  async poll(): Promise<void> {
    // Filled in Task 7.
  }

  getLastTickAt(): Date | null { return this.lastTickAt; }
  getDegradedReason(): DegradedReason | null { return this.degradedReason; }
  getRecentHits(n: number): K8sEventHit[] {
    return this.recentHits.slice(-n).reverse();
  }
}
