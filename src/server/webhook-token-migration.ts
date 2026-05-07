import type { Database } from "./db.js";
import { WEBHOOK_TOKEN_PREFIX, hashWebhookToken } from "./webhook-tokens.js";
import { ulid } from "ulid";

function legacyTokenPrefix(token: string): string {
  if (token.startsWith(WEBHOOK_TOKEN_PREFIX)) {
    const suffix = token.slice(WEBHOOK_TOKEN_PREFIX.length, WEBHOOK_TOKEN_PREFIX.length + 8);
    if (/^[0-9a-f]{8}$/i.test(suffix)) return suffix.toLowerCase();
  }
  return "legacy";
}

function normalizeLegacyTokenName(name: string): string {
  const cleaned = name.trim().replace(/[^A-Za-z0-9 _.\-]/g, "-").slice(0, 64).trim();
  return cleaned.length > 0 ? cleaned : "legacy-token";
}

/**
 * One-release migration bridge for deprecated YAML webhook tokens. Re-running
 * is safe while operators remove old config fields because lookup is by hash.
 */
export function importLegacyWebhookTokens(db: Database, legacyTokens: Record<string, string> | undefined): number {
  let imported = 0;
  for (const [rawName, rawToken] of Object.entries(legacyTokens ?? {})) {
    const token = rawToken.trim();
    if (!token) continue;
    const tokenHash = hashWebhookToken(token);
    if (db.findWebhookTokenByHash(tokenHash)) continue;
    db.createWebhookToken({
      id: ulid(),
      name: normalizeLegacyTokenName(rawName),
      tokenHash,
      prefix: legacyTokenPrefix(token),
    });
    imported += 1;
  }
  return imported;
}
