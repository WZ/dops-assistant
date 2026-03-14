import pino from "pino";

const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

const MAX_TOOL_RESPONSE_CHARS = 1500;
const MAX_QUERY_TOOL_RESPONSE_CHARS = 12000;
const MAX_TOOL_RESULT_CHARS = 8000;

/**
 * Truncate oversized tool responses to prevent context bloat.
 * Applies tool-specific extraction for known verbose tools before
 * falling back to generic character-limit truncation.
 */
export function truncateToolResponse(text: string, toolName: string): string {
  // Tool-specific extraction — return only what the LLM needs
  if (toolName === "get_dashboard_by_uid") {
    try {
      const data = JSON.parse(text);
      const panels = (data.dashboard?.panels ?? data.panels ?? []) as Array<{
        id: number; title: string; type: string;
      }>;
      return JSON.stringify({
        title: data.dashboard?.title ?? data.title,
        uid: data.dashboard?.uid ?? data.meta?.slug,
        panels: panels.map((p) => ({ id: p.id, title: p.title, type: p.type })),
      });
    } catch { /* fall through */ }
  }

  if (toolName === "search_dashboards") {
    try {
      const parsed = JSON.parse(text);
      const list = Array.isArray(parsed) ? parsed : parsed?.dashboards ?? [];
      // Only uid + title, cap at 20 dashboards
      return JSON.stringify(
        (list as Array<{ uid: string; title: string }>).slice(0, 20).map((d) => ({ uid: d.uid, title: d.title })),
      );
    } catch { /* fall through */ }
  }

  // Compact Prometheus responses: extract metric name + value pairs, drop verbose labels
  if (toolName === "query_prometheus") {
    try {
      const parsed = JSON.parse(text);
      const results = parsed?.data ?? [];
      if (Array.isArray(results) && results.length > 0) {
        const compact = results.slice(0, 30).map((r: { metric: Record<string, string>; value?: [number, string]; values?: Array<[number, string]> }) => {
          const { __name__, job, instance, ...rest } = r.metric;
          const key = __name__ || Object.values(rest).filter(Boolean).join("/") || "";
          if (r.value) {
            return { m: key, instance, v: r.value[1], t: r.value[0] };
          }
          if (r.values) {
            // Range query: preserve sampled data points so the LLM can see the shape.
            // Downsample to ~50 points max to fit in context while keeping trend visible.
            const vals = r.values;
            const step = Math.max(1, Math.floor(vals.length / 50));
            const sampled = vals.filter((_, i) => i % step === 0 || i === vals.length - 1);
            let min = Infinity, max = -Infinity, sum = 0;
            for (const [, v] of vals) {
              const n = parseFloat(v);
              if (n < min) min = n;
              if (n > max) max = n;
              sum += n;
            }
            return {
              m: key, instance,
              min: min.toFixed(0),
              max: max.toFixed(0),
              avg: (sum / vals.length).toFixed(0),
              points: vals.length,
              // Include actual [timestamp, value] pairs so LLM sees level changes
              values: sampled.map(([ts, v]) => [new Date(ts * 1000).toISOString(), parseFloat(v).toFixed(0)]),
            };
          }
          return { m: key, raw: r };
        });
        const compactJson = JSON.stringify({ data: compact, hints: parsed.hints });
        if (compactJson.length < text.length) return compactJson;
      }
    } catch { /* fall through */ }
  }

  // Compact Loki log responses: drop verbose labels, keep timestamp + line + level
  if (toolName === "query_loki_logs") {
    try {
      const parsed = JSON.parse(text);
      const data = parsed?.data ?? [];
      if (Array.isArray(data) && data.length > 0) {
        const compact = data
          .map((entry: { timestamp?: string; line?: string; labels?: Record<string, string> }) => {
            const line = (entry.line ?? "").trim().slice(0, 300);
            if (!line) return null;
            const level = entry.labels?.level ?? entry.labels?.severity ?? entry.labels?.loglevel;
            return {
              line,
              ...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
              ...(level ? { level } : {}),
            };
          })
          .filter((e): e is { line: string; timestamp?: string; level?: string } => e !== null);
        const compactJson = JSON.stringify({ data: compact, totalEntries: data.length });
        if (compactJson.length < text.length) return compactJson;
      }
    } catch { /* fall through */ }
  }

  // Query tools get a higher truncation limit — their data is the core evidence
  const queryTools = new Set(["query_prometheus", "query_loki_logs", "get_dashboard_panel_queries"]);
  const limit = queryTools.has(toolName) ? MAX_QUERY_TOOL_RESPONSE_CHARS : MAX_TOOL_RESPONSE_CHARS;
  if (text.length <= limit) return text;

  logger.debug({ toolName, originalLen: text.length, truncatedTo: limit }, "Truncating tool response");
  return text.slice(0, limit) + `\n... [truncated, ${text.length - limit} chars omitted]`;
}

/** Check whether the quote at position i is escaped by counting preceding backslashes. */
function isEscaped(s: string, i: number): boolean {
  let backslashes = 0;
  let j = i - 1;
  while (j >= 0 && s[j] === '\\') { backslashes++; j--; }
  return backslashes % 2 === 1;
}

/** Close unmatched { and [ brackets in order. */
function balanceBrackets(s: string): string {
  const stack: string[] = [];
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '"' && !isEscaped(s, i)) {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }
  let result = s;
  while (stack.length > 0) {
    const opener = stack.pop()!;
    result += opener === "{" ? "}" : "]";
  }
  return result;
}

/**
 * Attempt to repair a truncated JSON string by closing open strings, arrays, and objects.
 * Returns the original string if repair fails.
 */
export function repairTruncatedJson(text: string): string {
  try {
    JSON.parse(text);
    return text; // Already valid
  } catch {
    // Continue to repair
  }

  let repaired = text.trimEnd();

  // Strip Markdown code fences (e.g. ```json ... ```) that models sometimes wrap around JSON
  repaired = repaired.replace(/^```(?:json|jsonc)?\s*\n?/i, "").replace(/\n?```\s*$/, "");

  // Extract from first { or [ if there's non-JSON preamble
  const firstBrace = repaired.search(/[{[]/);
  if (firstBrace > 0) {
    repaired = repaired.slice(firstBrace);
  }

  // Remove trailing comma
  repaired = repaired.replace(/,\s*$/, "");

  // If we're inside a string (odd number of unescaped quotes), close it
  let inString = false;
  for (let i = 0; i < repaired.length; i++) {
    if (repaired[i] === '"' && !isEscaped(repaired, i)) {
      inString = !inString;
    }
  }
  if (inString) {
    repaired = repaired.replace(/\\$/, "");
    repaired += '"';
  }

  // Try balancing brackets first (preserves the most data)
  const balanced = balanceBrackets(repaired);
  try {
    JSON.parse(balanced);
    return balanced;
  } catch {
    // Balancing alone wasn't enough — try removing the last partial entry
  }

  // Strip trailing partial key-value pair and try again
  const lastComma = repaired.lastIndexOf(",");
  if (lastComma > 0) {
    const candidate = repaired.slice(0, lastComma);
    const candidateBalanced = balanceBrackets(candidate);
    try {
      JSON.parse(candidateBalanced);
      return candidateBalanced;
    } catch {
      // Still not parseable
    }
  }

  return text; // Unrepairable
}

/** Strip base64 blobs and truncate oversized tool results before sending to LLM */
export function sanitizeToolResult(text: string): string {
  // Strip inline base64 data URIs
  let cleaned = text.replace(/data:[a-z]+\/[a-z+.-]+;base64,[A-Za-z0-9+/=\s]{100,}/g, "[base64 image removed]");
  // Strip raw base64 blobs (>200 chars of contiguous base64)
  cleaned = cleaned.replace(/[A-Za-z0-9+/=]{200,}/g, "[large blob removed]");
  if (cleaned.length > MAX_TOOL_RESULT_CHARS) {
    cleaned = cleaned.slice(0, MAX_TOOL_RESULT_CHARS) + "\n...[truncated]";
  }
  return cleaned;
}
