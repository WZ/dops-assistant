/**
 * K8sEventPoller — per-stack background poller that detects transient pod
 * crashes by reading k8s events and pod restartCount via the `infrastructure`
 * MCP role. Dispatches investigations on bad-reason events (OOMKilled,
 * CrashLoopBackOff, etc.) or restartCount increments.
 *
 * Mirrors the shape of service-health-poller.ts: per-stack class with
 * start()/stop()/poll() and an in-memory cache.
 *
 * Three degraded states surface via getDegradedReason():
 *   - "infrastructure-role-not-resolved" — no infra MCP wired
 *   - "infrastructure-not-kubernetes"   — infra MCP wired but lacks k8s tools (ECS/Nomad/etc)
 *   - "infrastructure-call-failed"      — k8s tool call threw or timed out
 *
 * The poll() body is filled across tasks 3-7 of the implementation plan.
 */
import { createLogger } from "../logger.js";
import type { MastraProvider } from "../mcp/provider.js";
import { getToolsByRole } from "../mcp/provider.js";
import type { ServiceRegistryStore } from "../services/registry.js";
import type { Database } from "./db.js";
import type { K8sEventsConfig, ServiceConfig } from "../config/schema.js";

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

interface ToolExecutor {
  execute: (args: unknown, context?: { abortSignal?: AbortSignal }) => Promise<unknown>;
}

function findToolByShape(
  tools: Record<string, unknown>,
  matchers: Array<string | RegExp>,
): ToolExecutor | null {
  for (const matcher of matchers) {
    for (const [name, tool] of Object.entries(tools)) {
      const matched = typeof matcher === "string"
        ? name === matcher || name.endsWith(matcher) || name === matcher.replace(/_/g, "-")
        : matcher.test(name);
      if (matched) return tool as ToolExecutor;
    }
  }
  return null;
}

function isProbablyK8s(tools: Record<string, unknown>): { eventsTool: ToolExecutor; podsTool: ToolExecutor } | null {
  const eventsTool = findToolByShape(tools, ["list_events", "get_events", "events_list", /event/i]);
  const podsTool = findToolByShape(tools, ["list_pods", "get_pods", "pods_list", /^pod/i]);
  if (!eventsTool || !podsTool) return null;
  return { eventsTool, podsTool };
}

interface RawK8sEvent {
  reason: string;
  message?: string;
  lastTimestamp?: string;
  firstTimestamp?: string;
  type?: string;
  involvedObject: { kind: string; name: string; uid?: string; namespace?: string };
}

interface RawK8sPod {
  metadata: {
    uid: string;
    namespace?: string;
    name?: string;
    ownerReferences?: Array<{ kind: string; name: string }>;
  };
  status?: {
    containerStatuses?: Array<{
      name: string;
      restartCount: number;
      lastState?: {
        terminated?: { reason?: string; message?: string; finishedAt?: string };
      };
    }>;
  };
}

export function matchRestartsToServices(
  pods: RawK8sPod[],
  services: Set<string>,
  restartCache: Map<string, number>,
): K8sEventHit[] {
  const hits: K8sEventHit[] = [];
  const seenKeys = new Set<string>();

  for (const pod of pods) {
    const uid = pod.metadata.uid;
    // Owner-ref typically points at a ReplicaSet "<deployment>-<hash>"; strip
    // the trailing hash to recover the deployment name. If the owner is some
    // other kind (DaemonSet, StatefulSet) the name is already the workload name.
    const ownerName = pod.metadata.ownerReferences?.[0]?.name ?? pod.metadata.name ?? "";
    const ownerStripped = ownerName.replace(/-[a-f0-9]{6,10}$/, "");
    const service = resolveServiceForName(ownerStripped, services)
      ?? resolveServiceForName(ownerName, services)
      ?? resolveServiceForName(pod.metadata.name ?? "", services);
    const containers = pod.status?.containerStatuses ?? [];

    for (const c of containers) {
      const key = `${uid}:${c.name}`;
      seenKeys.add(key);
      const prev = restartCache.get(key);
      const prevExisted = prev !== undefined;
      restartCache.set(key, c.restartCount);
      if (!service) continue;
      if (!prevExisted) continue;             // first poll seeds cache, never fires
      if (c.restartCount <= prev) continue;   // no change or pod recreated

      const term = c.lastState?.terminated;
      hits.push({
        service,
        podUid: uid,
        reason: term?.reason ?? "Restarted",
        message: term?.message ?? `restartCount ${prev} → ${c.restartCount}`,
        occurredAt: term?.finishedAt ?? new Date().toISOString(),
        source: "restart-count",
        restartCount: c.restartCount,
      });
    }
  }

  // GC cache entries for pods we did not see in this poll.
  for (const key of [...restartCache.keys()]) {
    if (!seenKeys.has(key)) restartCache.delete(key);
  }

  return hits;
}

/**
 * Derive a service's namespace from its logLabels, since `ServiceSchema` has
 * no explicit namespace field. Discovery typically writes one of these keys.
 */
export function extractNamespace(service: ServiceConfig): string | undefined {
  const labels = service.logLabels ?? {};
  return labels.namespace ?? labels.kubernetes_namespace ?? labels.k8s_namespace ?? undefined;
}

/**
 * Resolve a pod / owner-ref name to a registered service. Mirrors the
 * matching logic in service-health-poller.ts:165-234 (exact-then-longest-prefix).
 */
function resolveServiceForName(name: string, services: Set<string>): string | null {
  if (services.has(name)) return name;
  let best = "";
  for (const svc of services) {
    if ((name.startsWith(svc + "-") || name.startsWith(svc + "_")) && svc.length > best.length) {
      best = svc;
    }
  }
  return best || null;
}

export function matchEventsToServices(
  events: RawK8sEvent[],
  services: Set<string>,
  badReasons: Set<string>,
  ignoreReasons: Set<string>,
): K8sEventHit[] {
  const hits: K8sEventHit[] = [];
  for (const ev of events) {
    if (ignoreReasons.has(ev.reason)) continue;
    if (!badReasons.has(ev.reason)) continue;
    // K8s events come from many object kinds (Pod, Deployment, ReplicaSet,
    // Node, ...); the bad-reason list is meaningful only for Pod-level
    // events. Skip everything else to avoid false-positive prefix matches.
    if (ev.involvedObject.kind !== "Pod") continue;
    const service = resolveServiceForName(ev.involvedObject.name, services);
    if (!service) continue;
    hits.push({
      service,
      podUid: ev.involvedObject.uid ?? `${ev.involvedObject.kind}/${ev.involvedObject.name}`,
      reason: ev.reason,
      message: ev.message ?? "",
      occurredAt: ev.lastTimestamp ?? ev.firstTimestamp ?? new Date().toISOString(),
      source: "event",
    });
  }
  return hits;
}

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
  private restartCache: Map<string, number> = new Map();
  private recentHits: K8sEventHit[] = [];

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
    this.lastTickAt = new Date();
    const tools = await this.resolveInfraTools();
    if (!tools) return;
    // Tasks 4-7 fill in the rest.
  }

  private async resolveInfraTools(): Promise<{ eventsTool: ToolExecutor; podsTool: ToolExecutor } | null> {
    let tools: Record<string, unknown>;
    try {
      tools = await getToolsByRole(this.resolveProviders(), "infrastructure") as Record<string, unknown>;
    } catch {
      this.transitionDegraded("infrastructure-role-not-resolved");
      return null;
    }
    if (!tools || Object.keys(tools).length === 0) {
      this.transitionDegraded("infrastructure-role-not-resolved");
      return null;
    }
    const k8sTools = isProbablyK8s(tools);
    if (!k8sTools) {
      this.transitionDegraded("infrastructure-not-kubernetes");
      return null;
    }
    this.transitionDegraded(null);
    return k8sTools;
  }

  private transitionDegraded(next: DegradedReason | null): void {
    if (this.degradedReason === next) return;
    if (next === null) {
      logger.info({ stackId: this.stackId, from: this.degradedReason }, "K8sEventPoller: recovered");
    } else if (next === "infrastructure-not-kubernetes") {
      logger.info({ stackId: this.stackId }, "K8sEventPoller: infra MCP is not kubernetes — disabling poller for this stack");
    } else {
      logger.warn({ stackId: this.stackId, reason: next }, "K8sEventPoller: degraded");
    }
    this.degradedReason = next;
  }

  getLastTickAt(): Date | null { return this.lastTickAt; }
  getDegradedReason(): DegradedReason | null { return this.degradedReason; }
  getRecentHits(n: number): K8sEventHit[] {
    return this.recentHits.slice(-n).reverse();
  }
}
