import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { parse, stringify } from "yaml";
import { ulid } from "ulid";
import type { ServiceConfig, ProbeMetricRule } from "../config/schema.js";
import type { ServiceRegistryVersion } from "../types/discovery-types.js";

/**
 * Persisted shape of services.yaml as of Slice A (2026-04-22). Discovery
 * writes both `services` (per-service config, including per-service
 * `probeRules`) and `globalProbeRules` (top-level stack-aware rules written
 * after discovery introspects the Prometheus label key).
 *
 * Legacy flat-array files (pre-Slice-A) are transparently converted by
 * `loadFile()` into this shape with `globalProbeRules: []`. The next write
 * upgrades them to the object shape.
 */
export interface RegistryFile {
  services: ServiceConfig[];
  globalProbeRules: ProbeMetricRule[];
}

/**
 * On-disk shape inverted from a flat `ServiceConfig[]` to
 * `{services, globalProbeRules}`. Public API preserved byte-for-byte
 * (`load`, `save`, `getVersion`, `rollback`, `listVersions`) so existing
 * call sites in routes.ts, scan-scheduler.ts, service-health-poller.ts,
 * and agents.ts don't need to change. Every write internally carries
 * `globalProbeRules` forward so a legacy-style `save(services)` caller
 * cannot clobber the discovery-written top-level rules.
 */
export class ServiceRegistryStore {
  private servicesPath: string;
  private historyDir: string;
  private indexPath: string;

  constructor(servicesPath: string) {
    this.servicesPath = servicesPath;
    this.historyDir = join(dirname(servicesPath), "services-history");
    this.indexPath = join(this.historyDir, "index.yaml");
  }

  // ── File-level read/write (private) ──────────────────────────────────────

  /**
   * Read a registry file and normalize to RegistryFile. Forward-compat with
   * the legacy flat-array shape: pre-Slice-A files parse as `ServiceConfig[]`
   * and convert to `{services, globalProbeRules: []}`. Corrupt / non-existent
   * files collapse to the empty RegistryFile so callers never see undefined.
   */
  private loadFile(path: string = this.servicesPath): RegistryFile {
    if (!existsSync(path)) return { services: [], globalProbeRules: [] };
    const raw = readFileSync(path, "utf-8");
    const parsed = parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      // Legacy flat-array shape (pre-Slice-A).
      return { services: parsed as ServiceConfig[], globalProbeRules: [] };
    }
    if (parsed && typeof parsed === "object") {
      const obj = parsed as { services?: unknown; globalProbeRules?: unknown };
      return {
        services: Array.isArray(obj.services) ? (obj.services as ServiceConfig[]) : [],
        globalProbeRules: Array.isArray(obj.globalProbeRules)
          ? (obj.globalProbeRules as ProbeMetricRule[])
          : [],
      };
    }
    return { services: [], globalProbeRules: [] };
  }

  private writeFile(file: RegistryFile): void {
    writeFileSync(this.servicesPath, stringify(file, { indent: 2 }));
  }

  private dedupeServices(services: ServiceConfig[]): ServiceConfig[] {
    // Deduplicate by name — keep the first occurrence (which has richer data
    // when discovery queries overlap, e.g. deployments + scrape targets).
    const seen = new Set<string>();
    return services.filter((s) => {
      const key = s.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // ── Public API: services ─────────────────────────────────────────────────

  /** Current services. Signature preserved from pre-Slice-A. */
  load(): ServiceConfig[] {
    return this.loadFile().services;
  }

  /**
   * Write the services array. The current file's `globalProbeRules` are
   * read and carried forward — routes.ts-driven saves (metadata edits,
   * renames, rollback) cannot silently wipe the discovery-written top-level
   * rules. For atomic combined writes, prefer `saveAll()`.
   */
  save(services: ServiceConfig[], source: "discovery" | "manual"): string {
    const deduped = this.dedupeServices(services);
    const current = this.loadFile();
    const next: RegistryFile = {
      services: deduped,
      globalProbeRules: current.globalProbeRules,
    };
    this.writeFile(next);
    return this.writeVersion(next, source);
  }

  // ── Public API: globalProbeRules ─────────────────────────────────────────

  /**
   * Discovery-written, stack-aware global probe rules. Empty on legacy
   * files or when discovery has never run. The probe treats empty as "fall
   * through to the hardcoded `ProbeSchema.metrics` defaults" (tier 4 of
   * the four-track evaluator).
   */
  loadGlobalRules(): ProbeMetricRule[] {
    return this.loadFile().globalProbeRules;
  }

  /**
   * Write global probe rules. The current services array is preserved so a
   * direct write to globals cannot clobber per-service config.
   */
  saveGlobalRules(rules: ProbeMetricRule[], source: "discovery" | "manual"): string {
    const current = this.loadFile();
    const next: RegistryFile = { services: current.services, globalProbeRules: rules };
    this.writeFile(next);
    return this.writeVersion(next, source);
  }

  // ── Public API: atomic combined read/write ───────────────────────────────

  /**
   * Atomic snapshot of both services and global probe rules. Used by the
   * scan probe so a tick reads a consistent view even if discovery runs
   * mid-tick.
   */
  loadAll(): RegistryFile {
    return this.loadFile();
  }

  /**
   * Atomic combined write — preferred over back-to-back `save()` +
   * `saveGlobalRules()` for discovery, which writes both in a single pass.
   * Produces one version history entry instead of two.
   */
  saveAll(file: RegistryFile, source: "discovery" | "manual"): string {
    const next: RegistryFile = {
      services: this.dedupeServices(file.services),
      globalProbeRules: file.globalProbeRules,
    };
    this.writeFile(next);
    return this.writeVersion(next, source);
  }

  // ── Public API: history ──────────────────────────────────────────────────

  listVersions(): Omit<ServiceRegistryVersion, "services">[] {
    return this.readIndex();
  }

  /**
   * Services array from a historic snapshot. Pre-Slice-A version files are
   * flat-array `ServiceConfig[]`; the forward-compat reader normalizes them.
   * Signature preserved for `GET /api/services/versions/:id`.
   */
  getVersion(id: string): ServiceConfig[] {
    return this.getVersionFile(id).services;
  }

  /**
   * Full historic RegistryFile. New in Slice A — callers that need both
   * services and the globals-as-of-that-version use this directly.
   * Pre-Slice-A versions have `globalProbeRules: []`.
   */
  getVersionFile(id: string): RegistryFile {
    const index = this.readIndex();
    const entry = index.find((v) => v.id === id);
    if (!entry) throw new Error(`Version not found: ${id}`);
    const files = [`${id}-discovery.yaml`, `${id}-manual.yaml`];
    for (const file of files) {
      const path = join(this.historyDir, file);
      if (existsSync(path)) return this.loadFile(path);
    }
    throw new Error(`Version file not found for: ${id}`);
  }

  /**
   * Restore services from a historic snapshot and create a new version
   * entry tagged as "manual". Current `globalProbeRules` are carried
   * forward via `save()` — historic snapshots from before Slice A have no
   * globals, and rolling back to [] would silently wipe the discovery-
   * written top-level rules.
   */
  rollback(id: string): void {
    const historic = this.getVersionFile(id);
    this.save(historic.services, "manual");
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private writeVersion(file: RegistryFile, source: "discovery" | "manual"): string {
    mkdirSync(this.historyDir, { recursive: true });
    const id = ulid();
    const versionFile = join(this.historyDir, `${id}-${source}.yaml`);
    writeFileSync(versionFile, stringify(file, { indent: 2 }));
    const index = this.readIndex();
    index.push({
      id,
      timestamp: new Date().toISOString(),
      source,
      serviceCount: file.services.length,
    });
    writeFileSync(this.indexPath, stringify(index, { indent: 2 }));
    return id;
  }

  private readIndex(): Omit<ServiceRegistryVersion, "services">[] {
    if (!existsSync(this.indexPath)) return [];
    const raw = readFileSync(this.indexPath, "utf-8");
    const parsed = parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as Omit<ServiceRegistryVersion, "services">[];
  }
}
