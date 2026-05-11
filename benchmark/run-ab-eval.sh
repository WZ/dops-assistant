#!/usr/bin/env bash
# run-ab-eval.sh — automated A/B eval between two dops-assistant variants.
#
# Spawns two `npm run web` servers (one for control, one for treatment),
# runs `discovery-app-eval.ts` against each, then diffs the results.
#
# Usage:
#   benchmark/run-ab-eval.sh \
#     --control-path /path/to/control-worktree \
#     --treatment-path /path/to/treatment-worktree \
#     --stack-id 01KRB09YJJW258J18EHFKWAV2B \
#     --baseline data/120/services.yaml.placeholder \
#     --iters 5 \
#     --label my-ab-test
#
# Outputs:
#   tmp/discovery-app-eval/<label>-CONTROL-summary.json + .jsonl
#   tmp/discovery-app-eval/<label>-TREATMENT-summary.json + .jsonl
#   stdout: head-to-head comparison table
#
# Prerequisites:
#   - Corp VPN up (MCP host 10.105.101.4 reachable)
#   - Stack 120 (or whatever --stack-id you pass) in dops.sqlite of BOTH worktrees
#   - dev/.env in BOTH worktrees (OPENAI_API_KEY etc)
#   - node_modules in both (symlinks are fine)
#   - Both worktrees can run `npm run web` independently
#
# See benchmark/README.md for the full setup playbook.

set -euo pipefail

# ── defaults ──────────────────────────────────────────────────────────────
CONTROL_PATH=""
TREATMENT_PATH=""
STACK_ID=""
BASELINE=""
ITERS=5
LABEL="ab-$(date +%Y%m%d-%H%M%S)"
CONTROL_PORT=3001
TREATMENT_PORT=3002
MCP_HOST="10.105.101.4"
MCP_PORT=1017
OUT_DIR=""
SKIP_VPN_CHECK=0
SKIP_HEALTH_CHECK=0

usage() {
  sed -n '2,30p' "$0"
  exit 1
}

# ── arg parsing ───────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --control-path)    CONTROL_PATH="$2"; shift 2 ;;
    --treatment-path)  TREATMENT_PATH="$2"; shift 2 ;;
    --stack-id)        STACK_ID="$2"; shift 2 ;;
    --baseline)        BASELINE="$2"; shift 2 ;;
    --iters)           ITERS="$2"; shift 2 ;;
    --label)           LABEL="$2"; shift 2 ;;
    --control-port)    CONTROL_PORT="$2"; shift 2 ;;
    --treatment-port)  TREATMENT_PORT="$2"; shift 2 ;;
    --mcp-host)        MCP_HOST="$2"; shift 2 ;;
    --out-dir)         OUT_DIR="$2"; shift 2 ;;
    --skip-vpn-check)  SKIP_VPN_CHECK=1; shift ;;
    --skip-health-check) SKIP_HEALTH_CHECK=1; shift ;;
    -h|--help) usage ;;
    *) echo "ERROR: unknown arg $1"; usage ;;
  esac
done

# ── validate ──────────────────────────────────────────────────────────────
[ -z "$CONTROL_PATH" ]   && { echo "ERROR: --control-path required"; exit 2; }
[ -z "$TREATMENT_PATH" ] && { echo "ERROR: --treatment-path required"; exit 2; }
[ -z "$STACK_ID" ]       && { echo "ERROR: --stack-id required"; exit 2; }
[ -d "$CONTROL_PATH" ]   || { echo "ERROR: control path not found: $CONTROL_PATH"; exit 2; }
[ -d "$TREATMENT_PATH" ] || { echo "ERROR: treatment path not found: $TREATMENT_PATH"; exit 2; }

# Default baseline: a placeholder empty services.yaml. Real recall numbers
# require a curated baseline; for the +N services / variance analysis the
# placeholder is enough.
if [ -z "$BASELINE" ]; then
  BASELINE="$CONTROL_PATH/data/${STACK_ID##*-}/services.yaml.placeholder"
  if [ ! -f "$BASELINE" ]; then
    BASELINE="$CONTROL_PATH/data/120/services.yaml.placeholder"
  fi
fi
[ -f "$BASELINE" ] || { echo "ERROR: baseline not found: $BASELINE"; exit 2; }

# Output dir defaults to control-path/tmp
[ -z "$OUT_DIR" ] && OUT_DIR="$CONTROL_PATH/tmp/discovery-app-eval"
mkdir -p "$OUT_DIR"

CONTROL_ROUND="${LABEL}-CONTROL"
TREATMENT_ROUND="${LABEL}-TREATMENT"

# ── preflight ─────────────────────────────────────────────────────────────
echo "═══════════════════════════════════════════════════════════════════"
echo "  A/B Discovery Eval — ${LABEL}"
echo "═══════════════════════════════════════════════════════════════════"
echo "  control:   $CONTROL_PATH (port $CONTROL_PORT)"
echo "  treatment: $TREATMENT_PATH (port $TREATMENT_PORT)"
echo "  stack-id:  $STACK_ID"
echo "  baseline:  $BASELINE"
echo "  iters:     $ITERS each side"
echo "  out-dir:   $OUT_DIR"
echo "  rounds:    $CONTROL_ROUND, $TREATMENT_ROUND"
echo ""

# VPN reachability
if [ "$SKIP_VPN_CHECK" = "0" ]; then
  echo "[preflight] checking MCP host ${MCP_HOST}:${MCP_PORT} ..."
  if ! nc -z -G 3 "$MCP_HOST" "$MCP_PORT" >/dev/null 2>&1; then
    echo "ERROR: MCP host ${MCP_HOST}:${MCP_PORT} unreachable. Check corp VPN."
    echo "       Use --skip-vpn-check to override (not recommended)."
    exit 3
  fi
  echo "[preflight] ✓ MCP host reachable"
fi

# Port availability
for port in "$CONTROL_PORT" "$TREATMENT_PORT"; do
  if lsof -i ":$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "ERROR: port $port already in use. Kill the occupant or pass --control-port / --treatment-port."
    lsof -i ":$port" -sTCP:LISTEN 2>&1 | tail -3
    exit 3
  fi
done
echo "[preflight] ✓ ports $CONTROL_PORT + $TREATMENT_PORT free"

# ── start servers ────────────────────────────────────────────────────────
CONTROL_LOG="/tmp/abeval-control-${LABEL}.log"
TREATMENT_LOG="/tmp/abeval-treatment-${LABEL}.log"
CONTROL_PID_FILE="/tmp/abeval-control-${LABEL}.pid"
TREATMENT_PID_FILE="/tmp/abeval-treatment-${LABEL}.pid"

cleanup() {
  echo ""
  echo "[cleanup] stopping servers ..."
  [ -f "$CONTROL_PID_FILE" ] && kill "$(cat $CONTROL_PID_FILE)" 2>/dev/null || true
  [ -f "$TREATMENT_PID_FILE" ] && kill "$(cat $TREATMENT_PID_FILE)" 2>/dev/null || true
  # Also kill any orphaned tsx children
  pkill -f "tsx.*src/server/index.ts" 2>/dev/null || true
  sleep 1
  echo "[cleanup] done. server logs preserved at: $CONTROL_LOG, $TREATMENT_LOG"
}
trap cleanup EXIT INT TERM

echo ""
echo "[1/4] starting control server (port $CONTROL_PORT) ..."
(
  cd "$CONTROL_PATH"
  PORT="$CONTROL_PORT" CONFIG_PATH=dev/config.yaml nohup npm run web > "$CONTROL_LOG" 2>&1 &
  echo $! > "$CONTROL_PID_FILE"
)

echo "[1/4] starting treatment server (port $TREATMENT_PORT) ..."
(
  cd "$TREATMENT_PATH"
  PORT="$TREATMENT_PORT" CONFIG_PATH=dev/config.yaml nohup npm run web > "$TREATMENT_LOG" 2>&1 &
  echo $! > "$TREATMENT_PID_FILE"
)

# ── wait for ready ────────────────────────────────────────────────────────
echo "[2/4] waiting for both servers to be ready (up to 90s) ..."
READY=0
for i in $(seq 1 30); do
  sleep 3
  CTL_HEALTH=$(curl -s -m 2 "http://localhost:${CONTROL_PORT}/api/health" 2>/dev/null || echo "")
  TRT_HEALTH=$(curl -s -m 2 "http://localhost:${TREATMENT_PORT}/api/health" 2>/dev/null || echo "")
  if echo "$CTL_HEALTH" | grep -q "healthy" && echo "$TRT_HEALTH" | grep -q "healthy"; then
    READY=1
    echo "[2/4] ✓ both servers ready after ${i}×3s ($((i*3))s)"
    break
  fi
done
[ "$READY" = "1" ] || { echo "ERROR: servers didn't come up in 90s. Check $CONTROL_LOG / $TREATMENT_LOG"; exit 4; }

# Provider connectivity check
if [ "$SKIP_HEALTH_CHECK" = "0" ]; then
  echo "[2/4] verifying stack $STACK_ID providers on both servers ..."
  for port in "$CONTROL_PORT" "$TREATMENT_PORT"; do
    PROVIDERS=$(curl -s -m 10 -H "X-Stack-Id: $STACK_ID" "http://localhost:${port}/api/providers" 2>/dev/null)
    ERRORS=$(echo "$PROVIDERS" | python3 -c "import json,sys; data=json.load(sys.stdin); print(sum(1 for p in data if p.get('status')=='error'))" 2>/dev/null || echo "?")
    OK=$(echo "$PROVIDERS" | python3 -c "import json,sys; data=json.load(sys.stdin); print(sum(1 for p in data if p.get('status')=='connected'))" 2>/dev/null || echo "?")
    echo "[2/4]   port $port: $OK connected, $ERRORS errors"
    if [ "$OK" = "0" ] || [ "$ERRORS" != "0" ]; then
      echo "WARNING: provider connectivity issues on port $port. Eval may produce empty results."
      echo "         (Use --skip-health-check to ignore.)"
    fi
  done
fi

# ── run evals ─────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EVAL_SCRIPT="$CONTROL_PATH/scripts/discovery-app-eval.ts"
[ -f "$EVAL_SCRIPT" ] || { echo "ERROR: eval script not found at $EVAL_SCRIPT"; exit 5; }

echo ""
echo "[3/4] running CONTROL eval (${ITERS} iters, ~${ITERS}×3 min each) ..."
(cd "$CONTROL_PATH" && npx tsx "$EVAL_SCRIPT" \
  --app-url "http://localhost:${CONTROL_PORT}" \
  --stack-id "$STACK_ID" \
  --baseline "$BASELINE" \
  --iterations "$ITERS" \
  --round "$CONTROL_ROUND" \
  --out-dir "$OUT_DIR" 2>&1 | tail -10)

echo ""
echo "[3/4] running TREATMENT eval (${ITERS} iters) ..."
(cd "$TREATMENT_PATH" && npx tsx "$EVAL_SCRIPT" \
  --app-url "http://localhost:${TREATMENT_PORT}" \
  --stack-id "$STACK_ID" \
  --baseline "$BASELINE" \
  --iterations "$ITERS" \
  --round "$TREATMENT_ROUND" \
  --out-dir "$OUT_DIR" 2>&1 | tail -10)

# ── analyze ───────────────────────────────────────────────────────────────
echo ""
echo "[4/4] comparing results ..."
CONTROL_JSONL="${OUT_DIR}/${CONTROL_ROUND}.jsonl"
TREATMENT_JSONL="${OUT_DIR}/${TREATMENT_ROUND}.jsonl"
[ -f "$CONTROL_JSONL" ] || { echo "ERROR: control jsonl not produced: $CONTROL_JSONL"; exit 6; }
[ -f "$TREATMENT_JSONL" ] || { echo "ERROR: treatment jsonl not produced: $TREATMENT_JSONL"; exit 6; }

python3 "$SCRIPT_DIR/analyze-ab.py" "$CONTROL_JSONL" "$TREATMENT_JSONL"

echo ""
echo "═══════════════════════════════════════════════════════════════════"
echo "  A/B complete. Artifacts:"
echo "    $CONTROL_JSONL"
echo "    $TREATMENT_JSONL"
echo "  Summaries:"
echo "    ${OUT_DIR}/${CONTROL_ROUND}-summary.json"
echo "    ${OUT_DIR}/${TREATMENT_ROUND}-summary.json"
echo "═══════════════════════════════════════════════════════════════════"
