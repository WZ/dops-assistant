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
 * Hits flow: poll → list_events + list_pods → match{Events,Restarts}ToServices
 *           → within-tick dedup → maxEventsPerTick cap → onK8sEvent callback.
 * Cross-detector dedup is enforced upstream by sharedDedup keyed on (stackId, service).
 */
import { createLogger } from "../logger.js";
import type { MastraProvider } from "../mcp/provider.js";
import { getToolsByRole } from "../mcp/provider.js";
import { withTimeoutAndAbort } from "./anomaly-probe.js";
import { eventLog } from "./event-log.js";
import type { ServiceRegistryStore } from "../services/registry.js";
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
 * Parse an MCP tool result into an array of items. Handles the MCP
 * `{ content: [{ type: "text", text }] }` wrapping and direct objects;
 * falls back through `Array → { items: [...] }`. Mirrors `parsePrometheusResult`
 * shape from `service-health-poller.ts`. Never throws — returns [] on parse fail.
 */
function parseToolItems<T>(raw: unknown): T[] {
  if (!raw) return [];
  let parsed: unknown = raw;
  if (typeof raw === "object" && raw !== null && "content" in raw) {
    const content = (raw as { content: unknown[] }).content;
    if (Array.isArray(content) && content.length > 0) {
      const first = content[0] as { type?: string; text?: string };
      if (first.type === "text" && typeof first.text === "string") {
        try { parsed = JSON.parse(first.text); } catch { return []; }
      }
    }
  }
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { return []; }
  }
  if (Array.isArray(parsed)) return parsed as T[];
  if (typeof parsed === "object" && parsed !== null && "items" in parsed) {
    const items = (parsed as { items: unknown }).items;
    if (Array.isArray(items)) return items as T[];
  }
  return [];
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
  private readonly stackId: string;
  // Mutable so reload() can swap in a new effective config (e.g. when the
  // GUI flips `enabled` via PUT /api/scan/settings) without reconstructing
  // the poller and losing the in-memory restart cache.
  private config: K8sEventsConfig;
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

  /**
   * Hot-reload effective config. Stops the running interval (if any), swaps
   * the config, then start()s again. start() respects the new `enabled`
   * flag so flipping it false → true (or vice versa) takes effect without
   * reconstructing the poller. The in-memory restart cache survives the
   * swap so we don't false-fire after a no-op reload.
   *
   * Idempotent: a reload with an unchanged config still stop/start cycles,
   * which is harmless (one extra log line, fresh interval timer).
   */
  reload(newConfig: K8sEventsConfig): void {
    this.stop();
    this.config = newConfig;
    this.start();
  }

  async poll(): Promise<void> {
    const tickStart = new Date();
    const previousTickAt = this.lastTickAt;
    this.lastTickAt = tickStart;

    const tools = await this.resolveInfraTools();
    if (!tools) return;

    const allServices = this.registryStore.load();
    const hidden = this.getHiddenServices?.() ?? new Set<string>();
    const services = allServices.filter((s) => !hidden.has(s.name));
    if (services.length === 0) return;

    const namespaceByService = new Map<string, string>();
    for (const s of services) {
      const ns = extractNamespace(s);
      if (ns) namespaceByService.set(s.name, ns);
    }
    if (namespaceByService.size === 0) {
      logger.debug({ stackId: this.stackId, serviceCount: services.length },
        "K8sEventPoller: no services have a derivable namespace, skipping tick");
      return;
    }

    const namespaces = Array.from(new Set(namespaceByService.values()));
    const sinceTime = previousTickAt && previousTickAt < tickStart
      ? previousTickAt
      : new Date(tickStart.getTime() - this.config.intervalSeconds * 1000);

    // withTimeoutAndAbort never throws — returns undefined on timeout/error.
    // Bounded per-call timeout (default 15s) so a wedged MCP server can't
    // stall the poll indefinitely.
    const [eventsRaw, podsRaw] = await Promise.all([
      withTimeoutAndAbort(
        tools.eventsTool,
        { namespaces, sinceTime: sinceTime.toISOString(), type: "Warning" },
        undefined,
        this.config.queryTimeoutMs,
      ),
      withTimeoutAndAbort(
        tools.podsTool,
        { namespaces },
        undefined,
        this.config.queryTimeoutMs,
      ),
    ]);
    if (eventsRaw === undefined || podsRaw === undefined) {
      this.transitionDegraded("infrastructure-call-failed");
      return;
    }

    const events = parseToolItems<RawK8sEvent>(eventsRaw);
    const pods = parseToolItems<RawK8sPod>(podsRaw);

    const serviceNameSet = new Set(services.map((s) => s.name));
    const badReasons = new Set(this.config.badReasons);
    const ignoreReasons = new Set(this.config.ignoreReasons);

    const eventHits = matchEventsToServices(events, serviceNameSet, badReasons, ignoreReasons);
    const restartHits = matchRestartsToServices(pods, serviceNameSet, this.restartCache);

    // De-dupe within tick by (service, podUid, reason).
    const seen = new Set<string>();
    const allHits: K8sEventHit[] = [];
    for (const hit of [...eventHits, ...restartHits]) {
      const key = `${hit.service}:${hit.podUid}:${hit.reason}`;
      if (seen.has(key)) continue;
      seen.add(key);
      allHits.push(hit);
    }

    // Cap, sorted by occurredAt desc.
    allHits.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
    if (allHits.length > this.config.maxEventsPerTick) {
      logger.warn(
        { stackId: this.stackId, dropped: allHits.length - this.config.maxEventsPerTick, cap: this.config.maxEventsPerTick },
        "K8sEventPoller: tick produced more hits than maxEventsPerTick; dropping oldest",
      );
      allHits.length = this.config.maxEventsPerTick;
    }

    for (const hit of allHits) {
      this.recentHits.push(hit);
      if (this.recentHits.length > RECENT_HITS_CAP) this.recentHits.shift();
      // Audit-trail event: fires BEFORE the onK8sEvent dispatch handler runs
      // sharedDedup, so the activity feed shows every detection (including
      // ones that the dispatcher will suppress as duplicates of an in-flight
      // investigation). Operators can see "we noticed this" even when no
      // investigation is started.
      eventLog.append({
        kind: "k8s_event_detected",
        severity: "warn",
        summary: `k8s · ${hit.reason} · ${hit.service}`,
        stackId: this.stackId,
        service: hit.service,
        meta: {
          reason: hit.reason,
          source: hit.source,
          podUid: hit.podUid,
          ...(hit.restartCount !== undefined ? { restartCount: hit.restartCount } : {}),
        },
      });
      try {
        this.onK8sEvent?.(hit);
      } catch (err) {
        logger.warn({ err, stackId: this.stackId, service: hit.service }, "K8sEventPoller: onK8sEvent callback threw");
      }
    }

    logger.info(
      { stackId: this.stackId, eventHits: eventHits.length, restartHits: restartHits.length, dispatched: allHits.length },
      "K8sEventPoller: poll complete",
    );
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
