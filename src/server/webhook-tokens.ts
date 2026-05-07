/**
 * Webhook token generation + hashing.
 *
 * Token shape: `hook_<32 hex chars>` (16 bytes of crypto random). Operators
 * see the `hook_` prefix in masks (`hook_eeb2278c...`) so they can tell at a
 * glance which secrets in their Grafana config belong to this webhook integration.
 *
 * We store sha256(token) at rest. Webhook tokens are high-entropy random
 * strings, so a fast cryptographic hash is fine — bcrypt would just slow
 * every webhook call without improving the security model. The DB UNIQUE
 * index on `token_hash` provides O(1) auth lookup.
 */

import { randomBytes, createHash } from "node:crypto";
import { ulid } from "ulid";

export const WEBHOOK_TOKEN_PREFIX = "hook_";

export interface GeneratedWebhookToken {
  /** ULID, primary key in webhook_tokens table */
  id: string;
  /** Plaintext token to display to the user ONCE — never persisted */
  token: string;
  /** sha256 of `token`, what we store */
  tokenHash: string;
  /** First 8 chars of the random portion (after `hook_`); rendered alongside the masked tail in the UI */
  prefix: string;
}

export function generateWebhookToken(): GeneratedWebhookToken {
  const random = randomBytes(16).toString("hex"); // 32 hex chars
  const token = `${WEBHOOK_TOKEN_PREFIX}${random}`;
  return {
    id: ulid(),
    token,
    tokenHash: hashWebhookToken(token),
    prefix: random.slice(0, 8),
  };
}

export function hashWebhookToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Format a token for read-only display in the GUI. The prefix is stored
 *  separately so we don't have to keep the plaintext to render the mask. */
export function maskStoredToken(prefix: string): string {
  if (prefix === "legacy") return "legacy…";
  return `${WEBHOOK_TOKEN_PREFIX}${prefix}…`;
}

/** Same shape as Grafana / Slack — a name that's URL-safe-ish, with
 *  obvious normalization so the GUI doesn't accept names that would
 *  surprise the operator at copy-paste time. Permissive enough to match
 *  human-readable labels ("grafana-prod", "Pagerduty Staging"). */
export function isValidTokenName(name: string): boolean {
  if (typeof name !== "string") return false;
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return false;
  return /^[A-Za-z0-9 _.\-]+$/.test(trimmed);
}
