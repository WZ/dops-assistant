/**
 * Attempt to parse JSON from a string that may be free-form text.
 *
 * Tries four strategies in order:
 *   1. Direct JSON.parse
 *   2. Extract JSON from a markdown code block (```json ... ```)
 *   3. Extract the LAST top-level {...} object (agents are instructed to
 *      end their response with JSON, so the last object is most likely
 *      the structured output rather than an embedded snippet)
 *   4. Extract the FIRST top-level {...} object
 *
 * Returns null if all strategies fail.
 */
export function safeJsonParse(text: string): any | null {
  if (!text?.trim()) return null;

  // 1. Direct parse
  try {
    return JSON.parse(text);
  } catch { /* fall through */ }

  // 2. Extract from markdown code block
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch?.[1]) {
    try {
      return JSON.parse(codeBlockMatch[1]);
    } catch { /* fall through */ }
  }

  // 3. Extract the LAST top-level JSON object by scanning braces.
  // Agents are instructed to end with JSON, so the last complete {...}
  // is most likely the structured output we want.
  const lastObj = extractLastJsonObject(text);
  if (lastObj) {
    try {
      return JSON.parse(lastObj);
    } catch { /* fall through */ }
  }

  // 4. Extract the FIRST top-level JSON object
  const firstObj = extractFirstJsonObject(text);
  if (firstObj) {
    try {
      return JSON.parse(firstObj);
    } catch { /* fall through */ }
  }

  return null;
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
