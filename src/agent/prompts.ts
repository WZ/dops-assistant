/**
 * Returns a string with the current time and timezone for prompt context.
 * Lets the LLM convert user-relative times ("yesterday afternoon") to UTC for Grafana queries
 * and present results in the user's local timezone.
 */
export function getTimeContext(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = new Date();
  const local = now.toLocaleString("en-US", { timeZone: tz, dateStyle: "full", timeStyle: "long" });
  const offsetMin = now.getTimezoneOffset(); // minutes behind UTC (negative = ahead)
  const sign = offsetMin <= 0 ? "+" : "-";
  const absMin = Math.abs(offsetMin);
  const offsetStr = `${sign}${String(Math.floor(absMin / 60)).padStart(2, "0")}:${String(absMin % 60).padStart(2, "0")}`;
  return `Current time: ${local} (${tz}, UTC${offsetStr}). Current epoch ms: ${now.getTime()}`;
}
