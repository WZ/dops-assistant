/**
 * Capture README screenshots from a running demo server.
 *
 * Usage:
 *   # with the demo server running on :3100
 *   npx tsx scripts/capture-screenshots.ts
 *
 * Environment:
 *   DEMO_URL  base URL of the running demo server (default: http://localhost:3100)
 *   OUT_DIR   where to write PNGs (default: docs/img/screenshots)
 *
 * Output: PNG files sized 1440x900 in dark mode, with the demo banner visible.
 */

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const DEMO_URL = process.env["DEMO_URL"] ?? "http://localhost:3100";
const OUT_DIR = process.env["OUT_DIR"] ?? "docs/img/screenshots";

interface Shot {
  slug: string;
  path: string;                 // relative to DEMO_URL, e.g. "/" or "/investigations/<id>"
  waitSelector?: string;        // wait for this selector before snapping
  clickSelector?: string;       // optional first-action (e.g. open a dropdown)
  pause?: number;               // extra wait in ms after load
  fullPage?: boolean;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,            // 1x keeps the PNGs well under 1MB each,
                                     // which renders at full quality on GitHub
                                     // without bloating the README cache.
    colorScheme: "dark",
  });
  const page = await ctx.newPage();

  // The app stores theme preference in localStorage; pre-seed it so the
  // first paint is already dark (avoids a flash of light mode in the capture).
  await page.addInitScript(() => {
    try { localStorage.setItem("theme", "dark"); } catch { /* ignore */ }
  });

  // Resolve investigation + scan-run IDs. Try the live API first (live demo
  // server); fall back to reading the static .json snapshots produced by
  // export-static.ts (GitHub Pages / static-bundle test).
  async function getJson<T>(liveUrl: string, staticUrl: string): Promise<T> {
    for (const url of [liveUrl, staticUrl]) {
      try {
        const r = await page.request.get(url);
        if (!r.ok()) continue;
        const body = await r.text();
        if (body.startsWith("<")) continue;   // Pages 404 → HTML fallback
        return JSON.parse(body) as T;
      } catch { /* try next */ }
    }
    throw new Error(`could not fetch JSON from ${liveUrl} or ${staticUrl}`);
  }

  const invs = await getJson<{ rows: Array<{ id: string; service: string; status: string }> }>(
    `${DEMO_URL}/api/investigations?limit=50`,
    `${DEMO_URL}/api/investigations.json`,
  );
  const paymentsInv = invs.rows.find((i) => i.service === "payments-worker" && i.status === "complete");
  const runningInv = invs.rows.find((i) => i.status === "running");
  if (!paymentsInv) throw new Error("payments-worker investigation not seeded — run `npm run seed:demo` first");
  if (!runningInv) throw new Error("running investigation not seeded");

  const scanRuns = await getJson<{ runs: Array<{ id: string; hitsDispatched: number }> }>(
    `${DEMO_URL}/api/scan/runs?limit=10`,
    `${DEMO_URL}/api/scan/runs.json`,
  );
  const hitRun = scanRuns.runs.find((r) => r.hitsDispatched > 0);
  if (!hitRun) throw new Error("scan run with dispatched hits not seeded");

  const shots: Shot[] = [
    // The hero: Ops Desk with service catalog + investigation log + scan strip + events
    { slug: "01-ops-desk", path: "/", pause: 1200, waitSelector: "body" },

    // Completed investigation detail (payments-worker / critical / rich RCA)
    { slug: "02-investigation-detail", path: `/investigations/${paymentsInv.id}`, pause: 1500 },

    // The /investigations list page with filter bar + severity breakdown
    { slug: "03-investigations-list", path: "/investigations", pause: 1000 },

    // Service detail — Investigations tab (Metrics tab renders empty cards
    // without a real Prometheus backend; the Investigations tab shows the
    // service's incident history, which is fully seeded and rich).
    { slug: "04-service-detail", path: "/services/payments-worker?tab=investigations", pause: 1200 },

    // Scan run detail with phase stepper + linked investigations
    { slug: "05-scan-run-detail", path: `/scan/runs/${hitRun.id}`, pause: 1200 },

    // Settings → Notifications (seed enables email so this section isn't empty)
    { slug: "06-notifications", path: "/settings/notifications", pause: 1000 },

    // Frozen "in-flight" investigation — phase rail mid-stream. Useful for
    // showing the streaming UI but relatively sparse content-wise, so we
    // keep it last and treat it as optional.
    { slug: "07-investigation-running", path: `/investigations/${runningInv.id}`, pause: 1500 },
  ];

  for (const shot of shots) {
    const url = `${DEMO_URL}${shot.path}`;
    console.log(`[capture] ${shot.slug} ← ${url}`);
    await page.goto(url, { waitUntil: "networkidle", timeout: 15_000 });
    if (shot.waitSelector) {
      try { await page.waitForSelector(shot.waitSelector, { timeout: 8_000 }); } catch { /* best effort */ }
    }
    if (shot.clickSelector) {
      try { await page.click(shot.clickSelector); } catch { /* best effort */ }
    }
    if (shot.pause) await page.waitForTimeout(shot.pause);
    const out = join(OUT_DIR, `${shot.slug}.png`);
    await page.screenshot({ path: out, fullPage: shot.fullPage ?? false });
    console.log(`[capture]   → ${out}`);
  }

  await browser.close();
  console.log(`[capture] done. ${shots.length} screenshots in ${OUT_DIR}/`);
}

main().catch((err) => {
  console.error("[capture] failed:", err);
  process.exit(1);
});
