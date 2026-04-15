import pino, { type Logger, type LoggerOptions } from "pino";

/**
 * Shared pino factory. All server-side modules should use this instead of
 * instantiating pino directly so that timestamp format, level, and any other
 * cross-cutting log config stays in one place.
 *
 * Logs use ISO timestamps by default (`"time":"2026-04-14T07:32:17.508Z"`)
 * rather than pino's default integer epoch milliseconds, which are unreadable
 * in raw kubectl/docker log output.
 */
export function createLogger(name?: string, extra?: LoggerOptions): Logger {
  return pino({
    level: process.env["LOG_LEVEL"] ?? "info",
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(name ? { name } : {}),
    ...extra,
  });
}
