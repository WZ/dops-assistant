import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { parse, stringify } from "yaml";
import { ulid } from "ulid";
import type { ServiceConfig } from "../config/schema.js";
import type { ServiceRegistryVersion } from "../types/discovery-types.js";

export class ServiceRegistryStore {
  private servicesPath: string;
  private historyDir: string;
  private indexPath: string;

  constructor(servicesPath: string) {
    this.servicesPath = servicesPath;
    this.historyDir = join(dirname(servicesPath), "services-history");
    this.indexPath = join(this.historyDir, "index.yaml");
  }

  load(): ServiceConfig[] {
    if (!existsSync(this.servicesPath)) return [];
    const raw = readFileSync(this.servicesPath, "utf-8");
    const parsed = parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as ServiceConfig[];
  }

  save(services: ServiceConfig[], source: "discovery" | "manual"): string {
    writeFileSync(this.servicesPath, stringify(services, { indent: 2 }));
    mkdirSync(this.historyDir, { recursive: true });
    const id = ulid();
    const versionFile = join(this.historyDir, `${id}-${source}.yaml`);
    writeFileSync(versionFile, stringify(services, { indent: 2 }));
    // Index stores metadata only (not full services array)
    const index = this.readIndex();
    index.push({ id, timestamp: new Date().toISOString(), source, serviceCount: services.length });
    writeFileSync(this.indexPath, stringify(index, { indent: 2 }));
    return id;
  }

  listVersions(): Omit<ServiceRegistryVersion, "services">[] {
    return this.readIndex();
  }

  getVersion(id: string): ServiceConfig[] {
    const index = this.readIndex();
    const entry = index.find((v) => v.id === id);
    if (!entry) throw new Error(`Version not found: ${id}`);
    const files = [`${id}-discovery.yaml`, `${id}-manual.yaml`];
    for (const file of files) {
      const path = join(this.historyDir, file);
      if (existsSync(path)) {
        const raw = readFileSync(path, "utf-8");
        return (parse(raw) as ServiceConfig[]) ?? [];
      }
    }
    throw new Error(`Version file not found for: ${id}`);
  }

  rollback(id: string): void {
    const services = this.getVersion(id);
    this.save(services, "manual");
  }

  private readIndex(): Omit<ServiceRegistryVersion, "services">[] {
    if (!existsSync(this.indexPath)) return [];
    const raw = readFileSync(this.indexPath, "utf-8");
    const parsed = parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as Omit<ServiceRegistryVersion, "services">[];
  }
}
