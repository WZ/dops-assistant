/**
 * Attempt to parse JSON from a string that may be free-form text.
 *
 * Tries three strategies in order:
 *   1. Direct JSON.parse
 *   2. Extract JSON from a markdown code block (```json ... ```)
 *   3. Extract the first {...} object in the string
 *
 * Returns null if all strategies fail.
 */
export function safeJsonParse(text: string): any | null {
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

  // 3. Extract first JSON object (first { to last })
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    } catch { /* fall through */ }
  }

  return null;
}
