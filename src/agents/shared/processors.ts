import pino from "pino";

const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

const MAX_TOOL_RESPONSE_CHARS = 1500;
const MAX_QUERY_TOOL_RESPONSE_CHARS = 12000;
const MAX_TOOL_RESULT_CHARS = 8000;

// ── Response shape detectors ──────────────────────────────────────────────────

/** Detect Prometheus-style time series: array of objects with `metric` + `values`/`value` fields */
function isTimeSeriesData(parsed: unknown): parsed is {
  data: Array<{ metric: Record<string, string>; value?: [number, string]; values?: Array<[number, string]> }>;
  hints?: unknown;
} {
  if (!parsed || typeof parsed !== "object") return false;
  const obj = parsed as Record<string, unknown>;
  const data = obj["data"];
  if (!Array.isArray(data) || data.length === 0) return false;
  const first = data[0] as Record<string, unknown>;
  return (
    typeof first === "object" &&
    first !== null &&
    "metric" in first &&
    typeof first["metric"] === "object" &&
    ("value" in first || "values" in first)
  );
}

/** Detect Loki-style log lines: array with `timestamp`/`line` fields (possibly wrapped in `data`) */
function isLogLineData(parsed: unknown): parsed is {
  data: Array<{ timestamp?: string; line?: string; labels?: Record<string, string> }>;
} {
  if (!parsed || typeof parsed !== "object") return false;
  const obj = parsed as Record<string, unknown>;
  const data = obj["data"];
  if (!Array.isArray(data) || data.length === 0) return false;
  const first = data[0] as Record<string, unknown>;
  return (
    typeof first === "object" &&
    first !== null &&
    ("line" in first || "timestamp" in first) &&
    !("metric" in first)
  );
}

/** Detect dashboard JSON: object with `panels` array (possibly nested under `dashboard`) */
function isDashboardJson(parsed: unknown): parsed is {
  dashboard?: { title?: string; uid?: string; panels?: Array<{ id: number; title: string; type: string }> };
  title?: string;
  uid?: string;
  panels?: Array<{ id: number; title: string; type: string }>;
  meta?: { slug?: string };
} {
  if (!parsed || typeof parsed !== "object") return false;
  const obj = parsed as Record<string, unknown>;
  const panels = (obj["dashboard"] as Record<string, unknown> | undefined)?.["panels"] ?? obj["panels"];
  return Array.isArray(panels);
}

/** Detect search results: array of objects with `uid` and `title` fields */
function isSearchResultList(parsed: unknown): boolean {
  let list: unknown[] | undefined;
  if (Array.isArray(parsed)) {
    list = parsed;
  } else if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    const nested = obj["dashboards"] ?? obj["results"];
    if (Array.isArray(nested)) list = nested;
  }
  if (!list || list.length === 0) return false;
  const first = list[0] as Record<string, unknown> | undefined;
  return (
    typeof first === "object" &&
    first !== null &&
    "uid" in first &&
    "title" in first
  );
}

// ── Compaction helpers ────────────────────────────────────────────────────────

function compactTimeSeries(parsed: {
  data: Array<{ metric: Record<string, string>; value?: [number, string]; values?: Array<[number, string]> }>;
  hints?: unknown;
}): string {
  const compact = parsed.data.slice(0, 30).map((r) => {
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
  return JSON.stringify({ data: compact, hints: parsed.hints });
}

function compactLogLines(parsed: {
  data: Array<{ timestamp?: string; line?: string; labels?: Record<string, string> }>;
}): string {
  const compact = parsed.data
    .map((entry) => {
      const line = (entry.line ?? "").trim().slice(0, 300);
      if (!line) return null;
      const level = entry.labels?.["level"] ?? entry.labels?.["severity"] ?? entry.labels?.["loglevel"];
      return {
        line,
        ...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
        ...(level ? { level } : {}),
      };
    })
    .filter((e): e is { line: string; timestamp?: string; level?: string } => e !== null);
  return JSON.stringify({ data: compact, totalEntries: parsed.data.length });
}

function compactDashboard(parsed: {
  dashboard?: { title?: string; uid?: string; panels?: Array<{ id: number; title: string; type: string }> };
  title?: string;
  uid?: string;
  panels?: Array<{ id: number; title: string; type: string }>;
  meta?: { slug?: string };
}): string {
  const panels = (parsed.dashboard?.panels ?? parsed.panels ?? []) as Array<{
    id: number; title: string; type: string;
  }>;
  return JSON.stringify({
    title: parsed.dashboard?.title ?? parsed.title,
    uid: parsed.dashboard?.uid ?? parsed.meta?.slug,
    panels: panels.map((p) => ({ id: p.id, title: p.title, type: p.type })),
  });
}

function compactSearchResults(parsed: unknown): string {
  let list: Array<{ uid: string; title: string }>;
  if (Array.isArray(parsed)) {
    list = parsed;
  } else {
    const obj = parsed as Record<string, unknown>;
    list = (obj["dashboards"] ?? obj["results"] ?? []) as Array<{ uid: string; title: string }>;
  }
  return JSON.stringify(list.slice(0, 20).map((d) => ({ uid: d.uid, title: d.title })));
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Truncate oversized tool responses to prevent context bloat.
 *
 * Uses a two-tier strategy:
 *   1. Response-shape detection — identify the data format from the payload itself
 *      and apply the appropriate compaction (time series, log lines, dashboard JSON,
 *      search results).  This is tool-name-agnostic.
 *   2. Generic fallback — character-limit truncation, with a higher limit for
 *      query-class tools whose data is the core evidence.
 */
export function truncateToolResponse(text: string, toolName: string): string {
  try {
    const parsed: unknown = JSON.parse(text);

    // Shape detection — order matters: more specific shapes first
    if (isDashboardJson(parsed)) {
      return compactDashboard(parsed);
    }

    if (isTimeSeriesData(parsed)) {
      const compactJson = compactTimeSeries(parsed);
      if (compactJson.length < text.length) return compactJson;
    }

    if (isLogLineData(parsed)) {
      const compactJson = compactLogLines(parsed);
      if (compactJson.length < text.length) return compactJson;
    }

    if (isSearchResultList(parsed)) {
      return compactSearchResults(parsed);
    }
  } catch { /* fall through to generic truncation */ }

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
