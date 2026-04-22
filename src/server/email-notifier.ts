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
): Promise<void> {
  const { attempts, backoffMs } = deps.config.retry;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await deps.transport.sendMail(envelope);
      logger.info({ investigationId, to: recipient.address, attempt }, "email sent");
      return;
    } catch (err) {
      const retryable = isRetryableSmtpError(err);
      const lastAttempt = attempt === attempts;
      if (!retryable || lastAttempt) {
        logger.error({ err, investigationId, to: recipient.address, attempt, retryable }, "email failed");
        return;
      }
      const delay = backoffMs[attempt - 1] ?? 0;
      await sleep(delay);
    }
  }
}

export async function notifyEmail(
  deps: EmailNotifierDeps,
  investigationId: string,
  report: RcaReport,
  source: NotificationSource,
): Promise<void> {
  if (!deps.isGloballyEnabled()) return;

  const recipients = deps.listEnabledRecipients();
  const matches = recipients.filter(
    (r) =>
      severityRank(report.severity) >= severityRank(r.minSeverity) &&
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
