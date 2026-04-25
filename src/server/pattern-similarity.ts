export interface PatternRowForSimilarity {
  id: string;
  service: string;
  symptom: string;
  root_cause: string;
  severity: string;
  recommended_actions: string | null;
  source_investigation_id: string | null;
  created_at: string;
}

export interface PatternSimilarityScore {
  score: number;
  rootCauseOverlap: number;
  symptomOverlap: number;
  severityDistance: number;
  isMatch: boolean;
}

export interface PatternClusterOccurrence extends PatternRowForSimilarity {
  similarityScore: number;
}

export interface PatternCluster {
  seed: PatternRowForSimilarity;
  clusterId: string;
  recurrenceCount: number;
  firstSeen: string | null;
  lastSeen: string | null;
  occurrences: PatternClusterOccurrence[];
  dedupedRecommendedActions: string[];
  matchBasis: {
    strategy: "same_service_root_cause_overlap_v1";
    serviceScoped: true;
    severity: "exact_or_adjacent";
    rootCauseThreshold: number;
    symptomBoost: boolean;
  };
}

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "because", "by", "for",
  "from", "had", "has", "have", "in", "into", "is", "it", "of", "on",
  "or", "over", "that", "the", "this", "to", "under", "was", "were",
  "with", "without", "due", "during",
]);

const ROOT_CAUSE_THRESHOLD = 0.45;
const STRONG_ROOT_CAUSE_THRESHOLD = 0.6;
const DISTANT_SEVERITY_ROOT_CAUSE_THRESHOLD = 0.82;

const SEVERITY_RANK: Record<string, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function normalizeToken(token: string): string {
  if (token.length <= 3) return token;
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith("ed") && token.length > 4) return token.slice(0, -2);
  if (token.endsWith("ing") && token.length > 5) return token.slice(0, -3);
  if (token.endsWith("s") && token.length > 4) return token.slice(0, -1);
  return token;
}

export function tokenizePatternText(text: string | null | undefined): string[] {
  const seen = new Set<string>();
  const tokens = (text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_./:-]+/g, " ")
    .split(/\s+/)
    .map((token) => token.replace(/^[./:-]+|[./:-]+$/g, ""))
    .filter(Boolean)
    .map(normalizeToken)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));

  const out: string[] = [];
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

function overlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const bSet = new Set(b);
  let hits = 0;
  for (const token of a) {
    if (bSet.has(token)) hits += 1;
  }
  return hits / Math.min(a.length, b.length);
}

function severityDistance(a: string, b: string): number {
  const left = SEVERITY_RANK[a.toLowerCase()] ?? SEVERITY_RANK.medium;
  const right = SEVERITY_RANK[b.toLowerCase()] ?? SEVERITY_RANK.medium;
  return Math.abs(left - right);
}

export function scorePatternSimilarity(
  seed: PatternRowForSimilarity,
  candidate: PatternRowForSimilarity,
): PatternSimilarityScore {
  if (seed.id === candidate.id) {
    return {
      score: 1,
      rootCauseOverlap: 1,
      symptomOverlap: 1,
      severityDistance: 0,
      isMatch: true,
    };
  }

  const rootCauseOverlap = overlap(
    tokenizePatternText(seed.root_cause),
    tokenizePatternText(candidate.root_cause),
  );
  const symptomOverlap = overlap(
    tokenizePatternText(seed.symptom),
    tokenizePatternText(candidate.symptom),
  );
  const distance = severityDistance(seed.severity, candidate.severity);
  const severityBoost = distance === 0 ? 0.1 : distance === 1 ? 0.04 : 0;
  const symptomBoost = rootCauseOverlap >= ROOT_CAUSE_THRESHOLD ? symptomOverlap * 0.15 : 0;
  const score = Math.min(1, rootCauseOverlap * 0.85 + symptomBoost + severityBoost);

  const isSeverityCompatible = distance <= 1
    ? rootCauseOverlap >= ROOT_CAUSE_THRESHOLD
    : rootCauseOverlap >= DISTANT_SEVERITY_ROOT_CAUSE_THRESHOLD;
  const isMatch = isSeverityCompatible && (
    rootCauseOverlap >= ROOT_CAUSE_THRESHOLD ||
    (rootCauseOverlap >= STRONG_ROOT_CAUSE_THRESHOLD && symptomOverlap > 0)
  );

  return {
    score,
    rootCauseOverlap,
    symptomOverlap,
    severityDistance: distance,
    isMatch,
  };
}

export function dedupeRecommendedActions(rows: PatternRowForSimilarity[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const row of rows) {
    for (const action of (row.recommended_actions ?? "").split(";")) {
      const trimmed = action.trim().replace(/\s+/g, " ");
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(trimmed);
    }
  }

  return out;
}

export function buildPatternCluster(
  seed: PatternRowForSimilarity,
  candidates: PatternRowForSimilarity[],
): PatternCluster {
  const occurrences = candidates
    .map((candidate) => ({ candidate, score: scorePatternSimilarity(seed, candidate) }))
    .filter(({ score }) => score.isMatch)
    .map(({ candidate, score }) => ({
      ...candidate,
      similarityScore: Number(score.score.toFixed(4)),
    }))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));

  return {
    seed,
    clusterId: `cluster_${seed.id}`,
    recurrenceCount: occurrences.length,
    firstSeen: occurrences.length ? occurrences[occurrences.length - 1]!.created_at : null,
    lastSeen: occurrences.length ? occurrences[0]!.created_at : null,
    occurrences,
    dedupedRecommendedActions: dedupeRecommendedActions(occurrences),
    matchBasis: {
      strategy: "same_service_root_cause_overlap_v1",
      serviceScoped: true,
      severity: "exact_or_adjacent",
      rootCauseThreshold: ROOT_CAUSE_THRESHOLD,
      symptomBoost: true,
    },
  };
}
