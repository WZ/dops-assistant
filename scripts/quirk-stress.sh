#!/usr/bin/env bash
# Phase 2 stress runner for the gpt-oss-120b quirk-defense validation plan.
# Resets /api/health/quirks, drives N discoveries via the existing
# discovery-app-eval harness, then reads the counter to produce a per-quirk
# hit table.
#
# Usage (env DOPS_HEALTH_URL = base URL of the dops-assistant deploy):
#
#   DOPS_HEALTH_URL=http://localhost:3000 scripts/quirk-stress.sh \
#     --stack-id <STACK_ULID> \
#     --baseline path/to/services-baseline.yaml \
#     [--iterations 5] [--round baseline] [--out-dir tmp/quirk-stress]
#
# Output:
#   <out-dir>/<round>-quirk-report.md      human-readable per-quirk table
#   <out-dir>/<round>-after.json           raw counter snapshot
#   <out-dir>/<round>.jsonl                per-iteration eval results (from app-eval)
#   <out-dir>/<round>-summary.json         eval summary (recall/precision/etc, from app-eval)

set -euo pipefail

DOPS_HEALTH_URL="${DOPS_HEALTH_URL:-http://localhost:3000}"
ITERATIONS=5
ROUND="baseline"
OUT_DIR="tmp/quirk-stress"
STACK_ID=""
BASELINE=""
TIMEOUT_MS="600000"

usage() {
  sed -n '2,18p' "$0" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --iterations) ITERATIONS="$2"; shift 2 ;;
    --round) ROUND="$2"; shift 2 ;;
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    --stack-id) STACK_ID="$2"; shift 2 ;;
    --baseline) BASELINE="$2"; shift 2 ;;
    --timeout-ms) TIMEOUT_MS="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "ERROR: unknown arg: $1" >&2; usage ;;
  esac
done

if [[ -z "$STACK_ID" ]]; then echo "ERROR: --stack-id is required" >&2; exit 1; fi
if [[ -z "$BASELINE" ]]; then echo "ERROR: --baseline is required" >&2; exit 1; fi
if [[ ! -f "$BASELINE" ]]; then echo "ERROR: baseline not found: $BASELINE" >&2; exit 1; fi

if ! command -v jq >/dev/null 2>&1; then echo "ERROR: jq required" >&2; exit 1; fi
if ! command -v npx >/dev/null 2>&1; then echo "ERROR: npx required" >&2; exit 1; fi

mkdir -p "$OUT_DIR"
REPORT="$OUT_DIR/${ROUND}-quirk-report.md"
COUNTERS_AFTER="$OUT_DIR/${ROUND}-after.json"

# Verify the server is reachable AND has the quirk endpoint (PR #207).
if ! curl -fsS --max-time 5 "$DOPS_HEALTH_URL/api/health/quirks" >/dev/null 2>&1; then
  cat >&2 <<EOF
ERROR: cannot reach $DOPS_HEALTH_URL/api/health/quirks

Either the server is not running, or this build predates PR #207.
Start a local server with the quirkHit telemetry in:
  CONFIG_PATH=dev/config.yaml npm run web
EOF
  exit 1
fi

echo "→ Resetting quirk counter at $DOPS_HEALTH_URL"
curl -fsS -X POST "$DOPS_HEALTH_URL/api/health/quirks/reset" >/dev/null

START_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "→ Running $ITERATIONS discoveries (round=$ROUND, stack=$STACK_ID)"
echo "  baseline: $BASELINE"

# Let app-eval drive discovery. Non-zero exit (some iterations failing) is
# expected during stress — keep going so we can still capture counters.
EVAL_EXIT=0
npx tsx scripts/discovery-app-eval.ts \
  --iterations "$ITERATIONS" \
  --round "$ROUND" \
  --out-dir "$OUT_DIR" \
  --app-url "$DOPS_HEALTH_URL" \
  --stack-id "$STACK_ID" \
  --baseline "$BASELINE" \
  --timeout-ms "$TIMEOUT_MS" \
  || EVAL_EXIT=$?

END_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

echo "→ Capturing post-run quirk counter"
curl -fsS "$DOPS_HEALTH_URL/api/health/quirks" > "$COUNTERS_AFTER"

# Per-quirk hit categorization for the stress report. Thresholds:
#   0          : did not fire under this stress
#   1-2        : rare (potential DELETE, advance to ablation)
#   3-9        : occasional (CANARY)
#   ≥10        : frequent (KEEP — defense is exercised)
{
  echo "# Quirk stress report — $ROUND"
  echo
  echo "- App: $DOPS_HEALTH_URL"
  echo "- Stack: $STACK_ID"
  echo "- Baseline: $BASELINE"
  echo "- Iterations: $ITERATIONS"
  echo "- Window: $START_TS → $END_TS"
  echo "- App-eval exit: $EVAL_EXIT"
  echo
  echo "## Per-quirk hits"
  echo
  echo "| Counter key | Hits | Per-iter avg | Note |"
  echo "|---|---:|---:|---|"

  jq -r --argjson n "$ITERATIONS" '
    (.hits // {})
    | to_entries
    | sort_by(-.value.count)[]
    | "| `\(.key)` | \(.value.count) | "
      + ((.value.count / $n) | tostring | .[0:5])
      + " | "
      + (if .value.count == 0 then "no fire under stress"
         elif .value.count <= 2 then "rare — advance to ablation"
         elif .value.count < 10 then "occasional — keep observing"
         else "frequent — defense is exercised" end)
      + " |"
  ' "$COUNTERS_AFTER"

  TOTAL=$(jq '[(.hits // {}) | to_entries[] | .value.count] | add // 0' "$COUNTERS_AFTER")
  DISTINCT=$(jq '(.hits // {}) | length' "$COUNTERS_AFTER")

  echo
  echo "## Summary"
  echo
  echo "- Total fire events: $TOTAL across $DISTINCT distinct keys"
  echo "- Raw counters: \`$COUNTERS_AFTER\`"
  echo "- Per-iteration eval: \`$OUT_DIR/${ROUND}.jsonl\` (recall, precision, missing/extra services)"
  echo "- Eval summary: \`$OUT_DIR/${ROUND}-summary.json\`"
  echo
  echo "## Interpretation"
  echo
  echo "Cross-reference this table with the production observation snapshots"
  echo "in \`tmp/quirk-snapshots.jsonl\`. A defense is a strong DELETE candidate"
  echo "only if BOTH columns show zero hits over the respective windows."
  echo
  echo "See \`docs/plans/gpt-oss-quirks-validation.html\` §7 for the full decision matrix."
} | tee "$REPORT"

echo
echo "Report: $REPORT"
exit "$EVAL_EXIT"
