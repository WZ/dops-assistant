/**
 * Input validation and sanitization for external data entering the system.
 *
 * Applied at system boundaries:
 *   - Alertmanager webhook payloads
 *   - WebSocket chat messages
 *   - REST API skill creation/updates
 */

import { z } from "zod";

// ── String sanitization ──────────────────────────────────────────────────────

/**
 * Strip control characters (0x00-0x1f) EXCEPT newlines (0x0a) and carriage returns (0x0d).
 * Null bytes (0x00) are always removed.
 */
function stripControlChars(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

export interface ValidateExternalInputOpts {
  maxLength: number;
  allowedPattern?: RegExp;
}

/**
 * Validate and sanitize external string input.
 *
 * - Strips control characters (keeping newlines and carriage returns)
 * - Removes null bytes
 * - Truncates to maxLength
 * - Optionally removes characters not matching allowedPattern
 */
export function validateExternalInput(input: string, opts: ValidateExternalInputOpts): string {
  // Strip control characters (keeps \n and \r)
  let cleaned = stripControlChars(input);

  // Apply allowed pattern filter if provided
  if (opts.allowedPattern) {
    cleaned = cleaned
      .split("")
      .filter((ch) => opts.allowedPattern!.test(ch))
      .join("");
  }

  // Enforce max length
  if (cleaned.length > opts.maxLength) {
    cleaned = cleaned.slice(0, opts.maxLength);
  }

  return cleaned;
}

// ── Zod helper: bounded string that sanitizes control chars ──────────────────

/** Create a Zod string schema that strips control chars and enforces max length. */
function boundedString(maxLength: number) {
  return z.string().transform((val) => validateExternalInput(val, { maxLength }));
}

// ── AlertPayloadSchema ──────────────────────────────────────────────────────

const MAX_LABEL_VALUE_LENGTH = 2000;

const AlertLabelSchema = z.record(
  z.string(),
  z.string().transform((val) => validateExternalInput(val, { maxLength: MAX_LABEL_VALUE_LENGTH })),
);

const AlertSchema = z
  .object({
    status: z.enum(["firing", "resolved"]),
    labels: AlertLabelSchema,
    annotations: AlertLabelSchema.default({}),
    startsAt: z.string().optional(),
    endsAt: z.string().optional(),
  })
  .passthrough();

export const AlertPayloadSchema = z
  .object({
    version: z.string().optional(),
    groupKey: z.string().optional(),
    status: z.enum(["firing", "resolved"]).optional(),
    receiver: z.string().optional(),
    alerts: z.array(AlertSchema).min(1, "alerts array must not be empty").max(50),
  })
  .passthrough();

export type ValidatedAlertPayload = z.infer<typeof AlertPayloadSchema>;

// ── ChatMessageSchema ───────────────────────────────────────────────────────

const MAX_CHAT_MESSAGE_LENGTH = 10_000;

export const ChatMessageSchema = z.object({
  type: z.literal("chat"),
  message: boundedString(MAX_CHAT_MESSAGE_LENGTH),
  serviceContext: boundedString(500).optional(),
});

// ── DeepInvestigateMessageSchema ────────────────────────────────────────────

export const DeepInvestigateMessageSchema = z.object({
  type: z.literal("deep_investigate"),
  investigationId: z.string().max(100),
  message: boundedString(MAX_CHAT_MESSAGE_LENGTH),
});

// ── SkillInputSchema ────────────────────────────────────────────────────────

const MAX_SKILL_TITLE_LENGTH = 500;
const MAX_SKILL_BODY_LENGTH = 50_000;

export const SkillInputSchema = z.object({
  title: boundedString(MAX_SKILL_TITLE_LENGTH),
  services: z.array(boundedString(200)).max(100).optional(),
  alerts: z.array(boundedString(200)).max(100).optional(),
  tags: z.array(boundedString(200)).max(100).optional(),
  body: boundedString(MAX_SKILL_BODY_LENGTH).optional(),
});

export type ValidatedSkillInput = z.infer<typeof SkillInputSchema>;
