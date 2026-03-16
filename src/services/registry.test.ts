// src/services/registry.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ServiceRegistryStore } from "./registry.js";

describe("ServiceRegistryStore", () => {
  let dir: string;
  let store: ServiceRegistryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "registry-test-"));
    store = new ServiceRegistryStore(join(dir, "services.yaml"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("load() returns empty array when file does not exist", () => {
    expect(store.load()).toEqual([]);
  });

  it("load() reads existing services.yaml", () => {
    const yaml = "- name: svc1\n  metrics: []\n  logLabels: {}\n";
    writeFileSync(join(dir, "services.yaml"), yaml);
    const result = store.load();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("svc1");
  });

  it("save() writes services.yaml and creates version snapshot", () => {
    const services = [{ name: "svc1", metrics: [], logLabels: {} }];
    const versionId = store.save(services, "discovery");
    expect(versionId).toBeTruthy();
    const loaded = store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe("svc1");
  });

  it("listVersions() returns version history", () => {
    store.save([{ name: "a", metrics: [], logLabels: {} }], "discovery");
    store.save([{ name: "a", metrics: [], logLabels: {} }, { name: "b", metrics: [], logLabels: {} }], "manual");
    const versions = store.listVersions();
    expect(versions).toHaveLength(2);
    expect(versions[0].source).toBe("discovery");
    expect(versions[0].serviceCount).toBe(1);
    expect(versions[1].source).toBe("manual");
    expect(versions[1].serviceCount).toBe(2);
  });

  it("getVersion() returns services for a specific version", () => {
    const id = store.save([{ name: "svc1", metrics: [], logLabels: {} }], "discovery");
    const services = store.getVersion(id);
    expect(services).toHaveLength(1);
    expect(services[0].name).toBe("svc1");
  });

  it("rollback() restores a previous version and creates new history entry", () => {
    const id1 = store.save([{ name: "a", metrics: [], logLabels: {} }], "discovery");
    store.save([{ name: "b", metrics: [], logLabels: {} }], "manual");
    store.rollback(id1);
    const current = store.load();
    expect(current).toHaveLength(1);
    expect(current[0].name).toBe("a");
    const versions = store.listVersions();
    expect(versions).toHaveLength(3);
  });

  it("getVersion() throws for unknown id", () => {
    expect(() => store.getVersion("nonexistent")).toThrow();
  });
});
