// deep-investigation-run.mjs — live runner for the deep-investigation eval.
//
// Drives the orchestrator over a batch of incidents against a RUNNING server,
// records each outcome + confirmed cause, and writes a results JSON that
// deep-eval.ts scores. This makes the previously-manual batch reproducible.
//
// Per incident: (1) run a baseline investigation, (2) fire orchestrator_investigate
// on it, (3) auto-continue at operator-pauses (capped), (4) record the outcome.
//
// Usage (server must be running on :3000):
//   node src/eval/deep-investigation-run.mjs <incidents.json> [out.json]
//   MAX_CONTINUES=3 node src/eval/deep-investigation-run.mjs incidents.json /tmp/runs.json
//   npx tsx src/eval/deep-eval.ts --results /tmp/runs.json
//
// incidents.json: [{ "stack": "<label>", "stackId": "<id>", "service": "<name>",
//                    "query": "<incident text>" }]
// Keep the incidents file LOCAL (gitignored) — stack IDs are environment-specific.

import WebSocket from "ws";
import { readFileSync, writeFileSync } from "node:fs";

const HOST = process.env.HOST || "ws://localhost:3000/ws";
const INV_TIMEOUT_MS = 8 * 60_000;
const ORCH_TIMEOUT_MS = 12 * 60_000;
const MAX_CONTINUES = Number(process.env.MAX_CONTINUES || 3);

const incidentsPath = process.argv[2];
const outPath = process.argv[3] || "/tmp/deep-investigation-runs.json";
if (!incidentsPath) {
  console.error("usage: node src/eval/deep-investigation-run.mjs <incidents.json> [out.json]");
  process.exit(2);
}
const incidents = JSON.parse(readFileSync(incidentsPath, "utf8"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runIncident(inc) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${HOST}?stackId=${encodeURIComponent(inc.stackId)}`);
    const rec = { stack: inc.stack, service: inc.service, query: inc.query, phase: "connect", continues: 0 };
    let invId = null;
    let stage = "baseline";
    let invTimer = null, orchTimer = null;
    const done = (extra) => {
      Object.assign(rec, extra);
      try { ws.close(); } catch {}
      clearTimeout(invTimer); clearTimeout(orchTimer);
      resolve(rec);
    };
    ws.on("open", () => {
      rec.phase = "baseline-investigating";
      ws.send(JSON.stringify({ type: "chat", message: `investigate ${inc.service}`, serviceContext: inc.service, immediate: true }));
      invTimer = setTimeout(() => done({ phase: "TIMEOUT-baseline" }), INV_TIMEOUT_MS);
    });
    ws.on("message", (buf) => {
      let m; try { m = JSON.parse(buf.toString()); } catch { return; }
      if (stage === "baseline") {
        if (m.type === "investigation:started" && m.id) invId = m.id;
        else if (m.type === "investigation:complete") {
          invId = m.id || invId;
          rec.investigationId = invId;
          rec.baselineRootCause = (m.report && (m.report.rootCause || m.report.summary)) || "(no rootCause)";
          rec.baselineConfidence = m.report && m.report.confidenceScore;
          clearTimeout(invTimer);
          stage = "orch"; rec.phase = "orchestrating";
          ws.send(JSON.stringify({ type: "orchestrator_investigate", investigationId: invId }));
          orchTimer = setTimeout(() => done({ phase: "TIMEOUT-orchestrator" }), ORCH_TIMEOUT_MS);
        } else if (m.type === "investigation:failed") {
          done({ phase: "baseline-FAILED", error: m.error });
        }
      } else if (stage === "orch") {
        if (m.type === "orchestrator:operator_pause") {
          if (rec.continues < MAX_CONTINUES) {
            rec.continues++;
            ws.send(JSON.stringify({ type: "orchestrator_decision", investigationId: invId, decision: "continue" }));
          } else {
            ws.send(JSON.stringify({ type: "orchestrator_decision", investigationId: invId, decision: "escalate" }));
          }
        } else if (m.type === "orchestrator:complete") {
          const root = (m.causalChain || []).find((l) => l.kind === "root-cause");
          done({
            phase: "complete",
            outcome: m.outcome,
            rootCause: root ? (root.title || root.detail || root.label) : null,
            traceSummary: m.traceSummary,
            stats: m.stats,
          });
        } else if (m.type === "orchestrator:error") {
          done({ phase: "orch-ERROR", error: m.message });
        }
      }
    });
    ws.on("error", (e) => done({ phase: "WS-ERROR", error: String(e && e.message || e) }));
    ws.on("close", () => { if (rec.phase !== "complete" && !rec.phase.startsWith("TIMEOUT") && !rec.phase.includes("ERROR") && !rec.phase.includes("FAILED")) done({ phase: "closed-early" }); });
  });
}

const results = [];
for (const inc of incidents) {
  process.stdout.write(`\n▶ ${inc.stack} / ${inc.service} … `);
  const t0 = Date.now();
  const r = await runIncident(inc);
  r.wallMs = Date.now() - t0;
  results.push(r);
  process.stdout.write(`${r.phase} | outcome=${r.outcome || "-"} | ${(r.wallMs / 1000).toFixed(0)}s\n`);
  if (r.outcome === "confirmed") process.stdout.write(`   ↳ cause: ${r.rootCause}\n`);
  await sleep(2000);
}

writeFileSync(outPath, JSON.stringify(results, null, 2));
console.log("\n=== SUMMARY ===");
for (const r of results) {
  console.log(`${r.stack}/${r.service}: ${r.phase} | ${r.outcome || "-"} | ${r.traceSummary || ""} | ${(r.wallMs / 1000).toFixed(0)}s`);
}
const confirmed = results.filter((r) => r.outcome === "confirmed").length;
console.log(`\nconfirmed ${confirmed}/${results.length} · results → ${outPath}`);
console.log(`score:  npx tsx src/eval/deep-eval.ts --results ${outPath}`);
process.exit(0);
