// Ground-truth fetcher for F2. Queries each labeled service's REAL health via
// grafana-mcp, using the investigation skills' declared healthySignal /
// failureSignal (so it's consistent with what the engine's health-gate + floor
// evaluate). Emits {service: "healthy"|"unhealthy"|"unknown"} JSON for
// `deep-eval.ts --ground-truth`.
//
// Usage (server NOT required — connects its own MCP client):
//   npx tsx src/eval/deep-investigation-groundtruth.mts <stackDir> > gt.json
//   (stackDir = the data/<dir> whose providers.yaml + service set you ran)
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { createMcpProvider } from "../mcp/provider.js";
import { queryInstantValue } from "../server/prometheus-query.js";
import { SkillStore } from "../skills/store.js";

const stackDir = process.argv[2] || "default";
const prov = (parseYaml(readFileSync(`data/${stackDir}/providers.yaml`, "utf-8")) as any[]).find((p) => p.name === "grafana-mcp");
if (!prov) { console.error(`no grafana-mcp provider in data/${stackDir}/providers.yaml`); process.exit(1); }
const provider = createMcpProvider({ name: prov.name, roles: prov.roles, mcpServer: prov.mcpServer } as any, 30000);

const store = new SkillStore({ dir: "skills", maxPerQuery: 50, maxCharsPerSkill: 4000 });
await store.loadAll();
const skills = store.getAllForScope("investigation").filter((s) => s.healthySignal);

const here = dirname(fileURLToPath(import.meta.url));
const labels = JSON.parse(readFileSync(resolve(here, "fixtures/deep-investigation-labels.json"), "utf-8")).labels as Array<{ service: string }>;

const out: Record<string, string> = {};
for (const { service } of labels) {
  let state = "unknown";
  for (const sk of skills) {
    const hv = await queryInstantValue([provider], sk.healthySignal!.replaceAll("$service", service)).catch(() => null);
    if (hv === null) continue; // this skill's signal doesn't apply to this service
    if (hv >= 1) { state = "healthy"; break; }
    // healthySignal present but not healthy → confirm via failureSignal
    if (sk.failureSignal) {
      const fv = await queryInstantValue([provider], sk.failureSignal.replaceAll("$service", service)).catch(() => null);
      state = fv !== null && fv >= 1 ? "unhealthy" : "unknown";
    } else {
      state = "unhealthy";
    }
    break;
  }
  out[service] = state;
}
console.log(JSON.stringify(out, null, 2));
await provider.client.disconnect().catch(() => {});
process.exit(0);
