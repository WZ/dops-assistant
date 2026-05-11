/**
 * Attempt to parse JSON from a string that may be free-form text.
 *
 * Strategies (in order):
 *   1. Direct JSON.parse
 *   2. Strip JSONC comments (// line + / * block * /) then parse
 *   3. Extract JSON from a markdown code block — parse directly,
 *      then fall back to stripping JSONC comments
 *   4. Extract the LAST top-level [...] array or {...} object
 *   5. Extract the FIRST top-level [...] array or {...} object
 *
 * Returns null if all strategies fail.
 *
 * JSONC comment stripping handles a real LLM failure mode observed in prod:
 * the discover agent returned a large JSON array with `/ * StatefulSets * /`
 * section dividers, breaking strict JSON.parse and silently dropping the
 * entire discovery result.
 */
import { quirkHit } from "./quirk-telemetry.js";

export function safeJsonParse(text: string): any | null {
  if (!text?.trim()) return null;

  // 1. Direct parse
  try {
    return JSON.parse(text);
  } catch { /* fall through */ }

  // 2. Strip JSONC-style comments and retry
  try {
    return JSON.parse(stripJsoncComments(text));
  } catch { /* fall through */ }

  // 3. Extract from markdown code block
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch?.[1]) {
    const body = codeBlockMatch[1];
    try {
      return JSON.parse(body);
    } catch { /* fall through */ }
    try {
      return JSON.parse(stripJsoncComments(body));
    } catch { /* fall through */ }
  }

  // 4. Truncated array recovery: LLM hit max_tokens and the JSON array is
  // cut off mid-element. Find the last complete object and close the array.
  // Runs before single-object extraction so we don't pick up a stray inner
  // object from inside a truncated array.
  const truncated = recoverTruncatedJsonArray(text);
  if (truncated) {
    quirkHit("truncation-recovery:array", { recoveredCount: truncated.length });
    return truncated;
  }

  // 4b. Truncated discover-style object recovery: the discover agent emits
  // {"services": [...], "globalProbeRules": [...]}. When the LLM exhausts
  // its output budget mid-service, the bare-array recovery in (4) closes
  // the wrong brace (it closes services with whatever the last `}` happens
  // to be, even if that's a probeRule deep inside an unfinished service).
  // This recovers any complete services that DID serialize before truncation.
  const truncatedObj = recoverTruncatedServicesObject(text);
  if (truncatedObj) {
    quirkHit("truncation-recovery:services-object", { recoveredCount: truncatedObj.services.length });
    return truncatedObj;
  }

  // 5. Extract the LAST top-level {...} object. Agents are instructed to end
  // their response with JSON, so the last complete object is most likely
  // the structured output. Objects are checked before arrays because most
  // agents emit objects; array-emitting agents (discover) are handled by
  // strategies 1-4 above.
  const lastObj = extractLastJsonObject(text);
  if (lastObj) {
    try { return JSON.parse(lastObj); } catch { /* fall through */ }
    try { return JSON.parse(stripJsoncComments(lastObj)); } catch { /* fall through */ }
  }

  // 6. Extract the FIRST top-level {...} object
  const firstObj = extractFirstJsonObject(text);
  if (firstObj) {
    try { return JSON.parse(firstObj); } catch { /* fall through */ }
    try { return JSON.parse(stripJsoncComments(firstObj)); } catch { /* fall through */ }
  }

  // 7. Last-resort: try array extraction. Only reached if the entire text
  // is an array mixed with prose and strategies 1-4 couldn't recover it.
  const lastArr = extractLastJsonArray(text);
  if (lastArr) {
    try { return JSON.parse(lastArr); } catch { /* fall through */ }
    try { return JSON.parse(stripJsoncComments(lastArr)); } catch { /* fall through */ }
  }
  const firstArr = extractFirstJsonArray(text);
  if (firstArr) {
    try { return JSON.parse(firstArr); } catch { /* fall through */ }
    try { return JSON.parse(stripJsoncComments(firstArr)); } catch { /* fall through */ }
  }

  return null;
}

function recoverTruncatedJsonArray(text: string): any[] | null {
  const start = text.indexOf("[");
  if (start < 0) return null;
  let candidate = text.slice(start);
  if (!/^\[\s*\{/.test(candidate)) return null;
  const lastBrace = candidate.lastIndexOf("}");
  if (lastBrace < 2) return null;
  candidate = candidate.slice(0, lastBrace + 1) + "]";
  try { return JSON.parse(stripJsoncComments(candidate)); } catch { /* fall through */ }
  try { return JSON.parse(candidate); } catch { /* fall through */ }
  return null;
}

/**
 * Recover a truncated discover-agent object of the shape
 *   {"services": [ {...}, {...}, ...truncated... ], ...}
 *
 * Scans the `services` array with depth + string tracking and finds the
 * boundary between fully-serialized service objects and the partial one
 * the LLM was emitting when it hit max_tokens. Returns
 *   { services: <complete entries>, globalProbeRules: [] }
 * on success, or null if no recoverable prefix exists.
 *
 * `globalProbeRules` is intentionally always set to `[]` here — by the time
 * the LLM has truncated inside `services`, it has not yet emitted the
 * `globalProbeRules` block at all. Returning `[]` is safe: the discover
 * step's caller treats empty globals as "fall through to config defaults".
 */
function recoverTruncatedServicesObject(
  text: string,
): { services: unknown[]; globalProbeRules: unknown[] } | null {
  // Look for the discover agent's specific object shape. Anchored to a
  // top-level "services" key — anything else is somebody else's JSON and
  // shouldn't be mangled by this recovery.
  const arrayStartMatch = text.match(/"services"\s*:\s*\[/);
  if (!arrayStartMatch || arrayStartMatch.index === undefined) return null;
  const arrayStart = arrayStartMatch.index + arrayStartMatch[0].length;
  const objectStart = findEnclosingObjectStart(text, arrayStartMatch.index);
  if (objectStart < 0) return null;

  let depth = 1; // we're now positioned right after the opening `[`
  let inString = false;
  let escape = false;
  // Position immediately after the close of the most recent depth==1 service
  // object — i.e., a safe truncation boundary.
  let lastGoodEnd = -1;

  for (let i = arrayStart; i < text.length; i++) {
    const c = text[i]!;
    if (escape) { escape = false; continue; }
    if (inString) {
      if (c === "\\") { escape = true; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === "{" || c === "[") { depth++; continue; }
    if (c === "}" || c === "]") {
      depth--;
      if (depth === 1 && c === "}") {
        // Just closed a top-level service object inside the array.
        lastGoodEnd = i + 1;
      }
      if (depth === 0) {
        // The services array closed cleanly — not a truncation case for
        // this recovery path. Let strategies further down the chain handle it.
        return null;
      }
      continue;
    }
  }

  if (lastGoodEnd < 0) return null;

  const reconstructed = text.slice(objectStart, lastGoodEnd) + "]}";
  try {
    const parsed = JSON.parse(stripJsoncComments(reconstructed));
    if (!parsed || typeof parsed !== "object") return null;
    const services = Array.isArray(parsed.services) ? parsed.services : [];
    if (services.length === 0) return null;
    return { services, globalProbeRules: [] };
  } catch {
    return null;
  }
}

function findEnclosingObjectStart(text: string, beforeIndex: number): number {
  const objectStack: number[] = [];
  let inString = false;
  let escape = false;

  for (let i = 0; i < beforeIndex; i++) {
    const c = text[i]!;
    if (escape) { escape = false; continue; }
    if (inString) {
      if (c === "\\") { escape = true; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === "{") {
      objectStack.push(i);
      continue;
    }
    if (c === "}") {
      objectStack.pop();
    }
  }

  if (inString || objectStack.length === 0) return -1;
  return objectStack[objectStack.length - 1]!;
}

/**
 * Strip JSONC-style comments (// line and / * block * /) from text while
 * respecting string boundaries — never touches characters inside JSON strings.
 * Also strips trailing commas before `]` and `}` which LLMs sometimes produce.
 */
function stripJsoncComments(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    const next = text[i + 1];

    // Handle JSON string literals — copy through verbatim, including escaped chars.
    if (ch === '"') {
      out += ch;
      i++;
      while (i < n) {
        const c = text[i]!;
        out += c;
        i++;
        if (c === "\\" && i < n) {
          out += text[i]!;
          i++;
          continue;
        }
        if (c === '"') break;
      }
      continue;
    }

    // Line comment: // ... \n
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < n && text[i] !== "\n") i++;
      continue;
    }

    // Block comment: /* ... */
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n - 1 && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }

    out += ch;
    i++;
  }
  // Strip trailing commas: ,] or ,} with optional whitespace in between.
  return out.replace(/,(\s*[\]}])/g, "$1");
}

/**
 * Find the last balanced top-level {...} object in the text by scanning
 * backwards from the last '}'.
 */
function extractLastJsonObject(text: string): string | null {
  let end = text.lastIndexOf("}");
  while (end !== -1) {
    const start = findMatchingOpen(text, end);
    if (start !== -1) {
      const candidate = text.slice(start, end + 1);
      // Quick sanity: must look like a JSON object (has a colon for key:value)
      if (candidate.includes(":") && candidate.length > 10) {
        return candidate;
      }
    }
    end = text.lastIndexOf("}", end - 1);
  }
  return null;
}

/**
 * Find the last balanced top-level [...] array in the text by scanning
 * backwards from the last ']'.
 */
function extractLastJsonArray(text: string): string | null {
  let end = text.lastIndexOf("]");
  while (end !== -1) {
    const start = findMatchingOpenBracket(text, end);
    if (start !== -1) {
      const candidate = text.slice(start, end + 1);
      if (candidate.length > 2) return candidate;
    }
    end = text.lastIndexOf("]", end - 1);
  }
  return null;
}

/**
 * Find the first balanced top-level [...] array in the text.
 */
function extractFirstJsonArray(text: string): string | null {
  let start = text.indexOf("[");
  while (start !== -1) {
    const end = findMatchingCloseBracket(text, start);
    if (end !== -1) {
      const candidate = text.slice(start, end + 1);
      if (candidate.length > 2) return candidate;
    }
    start = text.indexOf("[", start + 1);
  }
  return null;
}

/**
 * Find the first balanced top-level {...} object in the text.
 */
function extractFirstJsonObject(text: string): string | null {
  let start = text.indexOf("{");
  while (start !== -1) {
    const end = findMatchingClose(text, start);
    if (end !== -1) {
      const candidate = text.slice(start, end + 1);
      if (candidate.includes(":") && candidate.length > 10) {
        return candidate;
      }
    }
    start = text.indexOf("{", start + 1);
  }
  return null;
}

/** From a '}' at `end`, walk backwards tracking brace depth to find the matching '{'. */
function findMatchingOpen(text: string, end: number): number {
  let depth = 0;
  let inString = false;

  for (let i = end; i >= 0; i--) {
    const ch = text[i]!;

    if (ch === '"' && (i === 0 || text[i - 1] !== "\\")) {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === "}") depth++;
    else if (ch === "{") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** From a '{' at `start`, walk forward tracking brace depth to find the matching '}'. */
function findMatchingClose(text: string, start: number): number {
  let depth = 0;
  let inString = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;

    if (ch === "\\" && inString) {
      i++; // skip escaped char
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** From a ']' at `end`, walk backwards tracking bracket depth to find the matching '['. */
function findMatchingOpenBracket(text: string, end: number): number {
  let depth = 0;
  let inString = false;
  for (let i = end; i >= 0; i--) {
    const ch = text[i]!;
    if (ch === '"' && (i === 0 || text[i - 1] !== "\\")) {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "]") depth++;
    else if (ch === "[") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** From a '[' at `start`, walk forward tracking bracket depth to find the matching ']'. */
function findMatchingCloseBracket(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\\" && inString) { i++; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
