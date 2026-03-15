// src/cli/assertions.ts

export type AssertionResult = {
  field: string;
  expected: unknown;
  actual: unknown;
  pass: boolean;
};

type AssertionOperator =
  | { in: unknown[] }
  | { gte: number }
  | { lte: number }
  | { not_empty: true }
  | { contains: string };

export function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  let current: unknown = obj;
  for (const key of path.split(".")) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function evaluateOperator(actual: unknown, operator: AssertionOperator): boolean {
  if ("in" in operator) {
    return (operator.in as unknown[]).includes(actual);
  }
  if ("gte" in operator) {
    return typeof actual === "number" && actual >= operator.gte;
  }
  if ("lte" in operator) {
    return typeof actual === "number" && actual <= operator.lte;
  }
  if ("not_empty" in operator) {
    if (Array.isArray(actual)) return actual.length > 0;
    if (typeof actual === "string") return actual.length > 0;
    return false;
  }
  if ("contains" in operator) {
    return typeof actual === "string" && actual.includes(operator.contains);
  }
  return false;
}

function isOperator(value: unknown): value is AssertionOperator {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && ["in", "gte", "lte", "not_empty", "contains"].includes(keys[0]!);
}

export function evaluateAssertions(
  data: Record<string, unknown>,
  assertions: Record<string, unknown>,
): AssertionResult[] {
  const results: AssertionResult[] = [];

  for (const [field, expected] of Object.entries(assertions)) {
    const actual = getNestedValue(data, field);

    if (isOperator(expected)) {
      results.push({
        field,
        expected,
        actual,
        pass: evaluateOperator(actual, expected),
      });
    } else {
      results.push({
        field,
        expected,
        actual,
        pass: actual === expected,
      });
    }
  }

  return results;
}
