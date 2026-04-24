import type { ScanRunSummary } from "../slack-notifier.js";

/**
 * Subject line for scan-run summary emails. Short, scannable, no emoji
 * (keeps inbox previews clean). Examples:
 *   "[dops] Scan flagged 3 services"
 *   "[dops] Scan completed clean (cron)"
 */
export function renderScanRunSubject(s: ScanRunSummary): string {
  const pluralS = s.hitsDispatched === 1 ? "" : "s";
  return s.hitsDispatched > 0
    ? `[dops] Scan flagged ${s.hitsDispatched} service${pluralS}`
    : `[dops] Scan completed clean (${s.trigger})`;
}

/**
 * HTML body — minimal inline styles, table-free (so it renders fine across
 * mail clients without engineering for Outlook). Inline styles are explicit
 * to avoid relying on the client's default stylesheet.
 */
export function renderScanRunHtml(s: ScanRunSummary, appBaseUrl: string): string {
  const runLink = `${appBaseUrl}/scan/runs/${encodeURIComponent(s.runId)}`;
  const header = s.hitsDispatched > 0
    ? `Scan flagged ${s.hitsDispatched} service${s.hitsDispatched === 1 ? "" : "s"}`
    : "Scan completed clean";
  const list = s.dispatchedServices.length === 0
    ? "<p style=\"margin:8px 0;color:#666\">No services flagged.</p>"
    : `<ul style="margin:8px 0;padding-left:20px">${s.dispatchedServices.map(svc => `<li>${escapeHtml(svc)}</li>`).join("")}</ul>`;
  return [
    `<!doctype html>`,
    `<html><body style="font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;padding:16px;color:#222">`,
    `<h2 style="margin:0 0 12px 0;font-size:18px;font-weight:600">${escapeHtml(header)}</h2>`,
    `<p style="margin:4px 0;color:#555;font-size:14px"><strong>Trigger:</strong> ${escapeHtml(s.trigger)}</p>`,
    `<p style="margin:4px 0;color:#555;font-size:14px"><strong>Services probed:</strong> ${s.servicesProbed}</p>`,
    `<p style="margin:4px 0;color:#555;font-size:14px"><strong>Investigations dispatched:</strong> ${s.hitsDispatched}</p>`,
    list,
    `<p style="margin:16px 0 0 0"><a href="${runLink}" style="color:#2563eb;text-decoration:none">View run detail →</a></p>`,
    `</body></html>`,
  ].join("\n");
}

/**
 * Plain-text fallback for clients that don't render HTML. Keep short.
 */
export function renderScanRunText(s: ScanRunSummary, appBaseUrl: string): string {
  const runLink = `${appBaseUrl}/scan/runs/${s.runId}`;
  const list = s.dispatchedServices.length === 0 ? "(none)" : s.dispatchedServices.join(", ");
  return [
    s.hitsDispatched > 0
      ? `Scan flagged ${s.hitsDispatched} service${s.hitsDispatched === 1 ? "" : "s"}`
      : "Scan completed clean",
    `Trigger: ${s.trigger}`,
    `Probed: ${s.servicesProbed}`,
    `Flagged: ${list}`,
    `View: ${runLink}`,
  ].join("\n");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" } as Record<string,string>)[c]!);
}
