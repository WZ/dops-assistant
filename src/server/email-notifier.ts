/**
 * EmailNotifier — per-recipient-filtered investigation notifications over SMTP.
 *
 * Delivery is async and parallelized across recipients with Promise.allSettled
 * so a slow or failing recipient never blocks others. All failures are logged;
 * none are thrown. Email is advisory — the web UI is the source of truth.
 */

import type { Transporter } from "nodemailer";
import { createLogger } from "../logger.js";
import type { RcaReport } from "../types/rca-types.js";
import { type EmailRecipient, type NotificationSource, severityRank } from "../types/notifications.js";
import { renderSubject, renderBody, renderTextFallback } from "./email-templates/investigation-notification.js";
import { renderScanRunSubject, renderScanRunHtml, renderScanRunText } from "./email-templates/scan-run-notification.js";
import type { ScanRunSummary } from "./slack-notifier.js";

const logger = createLogger();

export interface EmailNotifierDeps {
  isGloballyEnabled: () => boolean;
  listEnabledRecipients: () => EmailRecipient[];
  transport: Transporter;
  config: {
    from: string;
    appBaseUrl: string;
    retry: { attempts: number; backoffMs: number[] };
  };
}

const RETRYABLE_CODES = new Set(["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ESOCKET"]);

export function isRetryableSmtpError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; responseCode?: number };
  if (e.code === "EENVELOPE") return false;
  if (typeof e.code === "string" && RETRYABLE_CODES.has(e.code)) return true;
  if (typeof e.responseCode === "number") {
    if (e.responseCode === 535) return false;
    if (e.responseCode >= 400 && e.responseCode < 500) return true;
    if (e.responseCode >= 500) return false;
  }
  return false;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function sendWithRetry(
  deps: EmailNotifierDeps,
  recipient: EmailRecipient,
  investigationId: string,
  envelope: { from: string; to: string; subject: string; html: string; text: string },
): Promise<boolean> {
  const { attempts, backoffMs } = deps.config.retry;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await deps.transport.sendMail(envelope);
      logger.info({ investigationId, to: recipient.address, attempt }, "email sent");
      return true;
    } catch (err) {
      const retryable = isRetryableSmtpError(err);
      const lastAttempt = attempt === attempts;
      if (!retryable || lastAttempt) {
        logger.error({ err, investigationId, to: recipient.address, attempt, retryable }, "email failed");
        return false;
      }
      const delay = backoffMs[attempt - 1] ?? 0;
      await sleep(delay);
    }
  }
  return false;
}

export async function notifyEmail(
  deps: EmailNotifierDeps,
  investigationId: string,
  report: RcaReport,
  source: NotificationSource,
): Promise<void> {
  if (!deps.isGloballyEnabled()) return;

  const recipients = deps.listEnabledRecipients();
  // Unknown severities (LLM drift, schema skew) would rank -1 via indexOf and
  // silently drop every notification. Fail open to critical rank instead — an
  // unknown severity is itself worth surfacing.
  const reportRank = severityRank(report.severity);
  const effectiveRank = reportRank === -1 ? severityRank("critical") : reportRank;
  if (reportRank === -1) {
    logger.warn({ investigationId, severity: report.severity }, "unknown report severity, treating as critical for filter");
  }
  const matches = recipients.filter(
    (r) =>
      effectiveRank >= severityRank(r.minSeverity) &&
      r.allowedSources.includes(source),
  );

  if (matches.length === 0) {
    logger.debug({ investigationId, severity: report.severity, source }, "no matching email recipients");
    return;
  }

  const subject = renderSubject(report);
  const html = renderBody(report, investigationId, deps.config.appBaseUrl, source);
  const text = renderTextFallback(report, investigationId, deps.config.appBaseUrl, source);

  await Promise.allSettled(
    matches.map((r) =>
      sendWithRetry(deps, r, investigationId, {
        from: deps.config.from,
        to: r.address,
        subject,
        html,
        text,
      }),
    ),
  );
}

/**
 * Send run-level scan summary emails. Mirrors notifyEmail but filters on the
 * "scan-run" source and uses the scan-run template. Fire-and-forget per
 * recipient; per-recipient failures don't block other recipients.
 */
export async function notifyEmailScanRun(
  deps: EmailNotifierDeps,
  summary: ScanRunSummary,
): Promise<void> {
  if (!deps.isGloballyEnabled()) return;
  const recipients = deps.listEnabledRecipients().filter((r) =>
    r.allowedSources.includes("scan-run"),
  );
  if (recipients.length === 0) return;

  const subject = renderScanRunSubject(summary);
  const html = renderScanRunHtml(summary, deps.config.appBaseUrl);
  const text = renderScanRunText(summary, deps.config.appBaseUrl);

  await Promise.allSettled(
    recipients.map((r) =>
      sendWithRetry(deps, r, summary.runId, {
        from: deps.config.from,
        to: r.address,
        subject,
        html,
        text,
      }),
    ),
  );
}

export interface DiscoveryEmailSummary {
  id: string;
  stackId: string;
  serviceName: string;
  changeKind: "addition" | "removal";
  message: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function notifyEmailDiscovery(
  deps: EmailNotifierDeps,
  summary: DiscoveryEmailSummary,
): Promise<{ ok: boolean; error?: string }> {
  if (!deps.isGloballyEnabled()) return { ok: true };
  const recipients = deps.listEnabledRecipients().filter((r) =>
    r.allowedSources.includes("periodic-discovery"),
  );
  if (recipients.length === 0) return { ok: true };

  const verb = summary.changeKind === "addition" ? "found a new service" : "suggests removing a service";
  const subject = `Discovery ${verb}: ${summary.serviceName}`;
  const text = [
    summary.message,
    "",
    `Stack: ${summary.stackId}`,
    `Service: ${summary.serviceName}`,
    `Change: ${summary.changeKind}`,
    `Open: ${deps.config.appBaseUrl.replace(/\/+$/, "")}/settings`,
  ].join("\n");
  const html = `
    <div style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.5;">
      <p>${escapeHtml(summary.message)}</p>
      <dl>
        <dt>Stack</dt><dd>${escapeHtml(summary.stackId)}</dd>
        <dt>Service</dt><dd>${escapeHtml(summary.serviceName)}</dd>
        <dt>Change</dt><dd>${escapeHtml(summary.changeKind)}</dd>
      </dl>
      <p><a href="${escapeHtml(deps.config.appBaseUrl.replace(/\/+$/, ""))}/settings">Open settings</a></p>
    </div>
  `;

  const results = await Promise.all(
    recipients.map((r) =>
      sendWithRetry(deps, r, summary.id, {
        from: deps.config.from,
        to: r.address,
        subject,
        html,
        text,
      }),
    ),
  );
  return results.every(Boolean)
    ? { ok: true }
    : { ok: false, error: "one or more discovery emails failed" };
}
