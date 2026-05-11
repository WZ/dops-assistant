#!/usr/bin/env bash
# Day-7 verdict for the gpt-oss-120b quirk-defense Phase 1 observation window.
# Reads daily snapshots from tmp/quirk-snapshots.jsonl (or an explicit path)
# and applies the decision matrix from
# docs/plans/gpt-oss-quirks-validation.html §7.
#
# Usage:
#   scripts/quirk-tally.sh
#   scripts/quirk-tally.sh path/to/snapshots.jsonl
#
# Snapshot file is JSONL, one line per day, shape:
#   {"ts":"YYYY-MM-DD","uptime":N,"hits":{"<key>":{"count":N,"firstSeenMs":N,"lastSeenMs":N}}}

set -euo pipefail

SNAPSHOT_FILE="${1:-tmp/quirk-snapshots.jsonl}"

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required (brew install jq)" >&2
  exit 1
fi

if [[ ! -f "$SNAPSHOT_FILE" ]]; then
  cat >&2 <<EOF
ERROR: snapshot file not found: $SNAPSHOT_FILE

Expected JSONL shape (one per day):
  {"ts":"YYYY-MM-DD","uptime":N,"hits":{"<key>":{"count":N}}}

Set \$DOPS_HEALTH_URL to the dops-assistant base URL (the deployment
hosting GET /api/health/quirks), then capture a snapshot with:

  DATE=\$(date +%Y-%m-%d)
  mkdir -p tmp
  curl -sSk "\$DOPS_HEALTH_URL/api/health/quirks" \\
    | jq -c --arg ts "\$DATE" '{ts: \$ts, uptime, hits}' \\
    >> tmp/quirk-snapshots.jsonl
EOF
  exit 1
fi

SNAPSHOT_COUNT=$(grep -c . "$SNAPSHOT_FILE" || true)
if [[ "${SNAPSHOT_COUNT:-0}" -eq 0 ]]; then
  echo "ERROR: snapshot file is empty: $SNAPSHOT_FILE" >&2
  exit 1
fi

FIRST_TS=$(jq -r 'select(.ts != null) | .ts' < "$SNAPSHOT_FILE" | head -n1)
LAST_TS=$(jq -r 'select(.ts != null) | .ts' < "$SNAPSHOT_FILE" | tail -n1)
TODAY=$(date +%Y-%m-%d)

PRE_KEEP=(
  "loki-coerce:direction-forced"
  "loki-coerce:limit-bumped"
  "datasource-hints:emitted"
  "deterministic-merge:added"
)

is_pre_keep() {
  local key="$1"
  for pk in "${PRE_KEEP[@]}"; do
    [[ "$key" == "$pk" ]] && return 0
  done
  return 1
}

verdict() {
  local key="$1" count="$2"
  if is_pre_keep "$key"; then
    echo "KEEP (pre-assigned)"
  elif [[ "$count" -eq 0 ]]; then
    echo "DELETE candidate"
  elif [[ "$count" -le 10 ]]; then
    echo "CANARY"
  else
    echo "KEEP"
  fi
}

# Aggregate per-key totals across all snapshot lines.
# Output: lines of "<count>\t<key>", sorted desc by count.
AGGREGATE=$(jq -r '(.hits // {}) | to_entries[] | "\(.value.count)\t\(.key)"' < "$SNAPSHOT_FILE" \
  | awk -F'\t' '{ counts[$2]+=$1 } END { for (k in counts) printf "%d\t%s\n", counts[k], k }' \
  | sort -t $'\t' -k1,1 -nr)

TOTAL=$(awk -F'\t' '{ s += $1 } END { print s+0 }' <<< "$AGGREGATE")

# ---- report ----
{
  echo "# Quirk-defense Phase 1 verdict — $TODAY"
  echo
  echo "## Observation summary"
  echo
  echo "- Snapshots: $SNAPSHOT_COUNT"
  echo "- First: $FIRST_TS"
  echo "- Last: $LAST_TS"
  echo "- Total quirk-fire events: $TOTAL"
  echo
  echo "## Per-quirk results"
  echo
  echo "| Counter key | Total hits | Daily avg | Verdict |"
  echo "|---|---:|---:|---|"
  while IFS=$'\t' read -r COUNT KEY; do
    [[ -z "${KEY:-}" ]] && continue
    DAILY_AVG=$(awk -v c="$COUNT" -v n="$SNAPSHOT_COUNT" 'BEGIN { printf "%.2f", c/n }')
    V=$(verdict "$KEY" "$COUNT")
    echo "| \`$KEY\` | $COUNT | $DAILY_AVG | $V |"
  done <<< "$AGGREGATE"

  echo
  echo "## DELETE candidates (Phase 2 stress queue)"
  echo
  DELETE_ANY=0
  while IFS=$'\t' read -r COUNT KEY; do
    [[ -z "${KEY:-}" ]] && continue
    if ! is_pre_keep "$KEY" && [[ "$COUNT" -eq 0 ]]; then
      echo "- \`$KEY\`"
      DELETE_ANY=1
    fi
  done <<< "$AGGREGATE"
  [[ "$DELETE_ANY" -eq 0 ]] && echo "_(none — every observed quirk fired at least once)_"

  echo
  echo "## CANARY candidates (Phase 2 + Phase 3 ablation)"
  echo
  CANARY_ANY=0
  while IFS=$'\t' read -r COUNT KEY; do
    [[ -z "${KEY:-}" ]] && continue
    if ! is_pre_keep "$KEY" && [[ "$COUNT" -ge 1 ]] && [[ "$COUNT" -le 10 ]]; then
      echo "- \`$KEY\` ($COUNT hits)"
      CANARY_ANY=1
    fi
  done <<< "$AGGREGATE"
  [[ "$CANARY_ANY" -eq 0 ]] && echo "_(none)_"

  echo
  echo "## Confirmed KEEP"
  echo
  echo "### Pre-assigned (no ablation needed)"
  for pk in "${PRE_KEEP[@]}"; do
    echo "- \`$pk\`"
  done
  echo
  echo "### Observed high-rate (>10 hits total, not pre-assigned)"
  KEEP_ANY=0
  while IFS=$'\t' read -r COUNT KEY; do
    [[ -z "${KEY:-}" ]] && continue
    if ! is_pre_keep "$KEY" && [[ "$COUNT" -gt 10 ]]; then
      echo "- \`$KEY\` ($COUNT hits)"
      KEEP_ANY=1
    fi
  done <<< "$AGGREGATE"
  [[ "$KEEP_ANY" -eq 0 ]] && echo "_(none)_"

  echo
  echo "## Caveats"
  echo
  echo "- Observed window: $SNAPSHOT_COUNT days (Phase 1 target was 7)."
  echo "- \"Daily avg\" is total hits / snapshot count, not actual call rate."
  echo "- DELETE candidates here have 0 hits in the window. Phase 2 stress test"
  echo "  should still try to provoke each one before removing the defense."
  echo "- Quirk keys from the inventory that never appeared in any snapshot are"
  echo "  not listed in the per-quirk table — they implicitly belong to DELETE"
  echo "  candidates pending Phase 2."
  echo "- Full decision matrix: docs/plans/gpt-oss-quirks-validation.html §7"
}
