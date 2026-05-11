# Discovery A/B Eval Playbook

How to A/B test changes to the discovery agent (prompt restructure, filter
logic, schema changes) against a baseline on a live monitoring stack. Written
for an agent picking up cold — no prior session context required.

## What "A/B testing" means here

The discovery agent uses an LLM with `temperature: 0` but still exhibits
run-to-run variance because:

1. The LLM's tool-call ordering varies between runs.
2. Tool results (Prometheus / Loki / K8s API) can shift between runs.
3. Determinism in the agent's deterministic backfill is exact, but the LLM's
   pre-backfill output is not.

A single eval run is not enough to tell whether a code change improves
discovery. We need N iterations of CONTROL (old code) vs N iterations of
TREATMENT (new code), compared head-to-head.

**A/B = run the same eval script against two server instances (one per code
variant), then compare the resulting `discoveredNames` sets.**

## Prerequisites

| Item | What you need | How to verify |
|---|---|---|
| Corp VPN | MCP host `10.105.101.4:1017` reachable | `nc -z -G 3 10.105.101.4 1017` |
| Stack in DB | Stack 120 (ID `01KRB09YJJW258J18EHFKWAV2B`) in `dops.sqlite` of both worktrees | `sqlite3 dops.sqlite "SELECT id, slug FROM stacks"` |
| `dev/.env` | OpenAI API key + config in both worktrees | `[ -f .worktrees/<name>/dev/.env ]` |
| Baseline file | `data/120/services.yaml.placeholder` (or a curated YAML if you want real recall numbers) | `[ -f data/120/services.yaml.placeholder ]` |
| `node_modules` | Installed in both worktrees (symlinks fine) | `[ -d .worktrees/<name>/node_modules ]` |
| Two worktrees | One on the control branch, one on the treatment branch | `git worktree list` |

If you're on a fresh machine or VPN is down, **fix that first** — none of this works without MCP reachability.

## Quick start (one command)

```bash
# From the repo root (or anywhere — just pass absolute paths):
benchmark/run-ab-eval.sh \
  --control-path   /Users/wli02/Documents/workspace_work/WZ/dops-assistant \
  --treatment-path /Users/wli02/Documents/workspace_work/WZ/dops-assistant/.worktrees/my-feature \
  --stack-id       01KRB09YJJW258J18EHFKWAV2B \
  --iters          5 \
  --label          my-feature-2026-05-11
```

That single command:
1. Checks VPN/MCP reachability
2. Verifies ports 3001/3002 are free
3. Starts control server (port 3001) + treatment server (port 3002) in background
4. Waits up to 90s for both to be healthy + providers connected
5. Runs `discovery-app-eval.ts` against each (5 iterations each = ~15 min × 2 = ~30 min)
6. Compares the JSONL outputs via `analyze-ab.py`
7. Stops both servers cleanly

Expected total runtime: **~30–40 min** for 5 iterations each side on stack 120.

## Output

JSONL + summaries land in the control worktree's `tmp/discovery-app-eval/`:

```
tmp/discovery-app-eval/<label>-CONTROL.jsonl        # per-iter records
tmp/discovery-app-eval/<label>-CONTROL-summary.json  # aggregate stats
tmp/discovery-app-eval/<label>-TREATMENT.jsonl
tmp/discovery-app-eval/<label>-TREATMENT-summary.json
```

The script prints the comparison table to stdout. You can re-run the analysis
later without re-running the eval:

```bash
benchmark/analyze-ab.py \
  tmp/discovery-app-eval/<label>-CONTROL.jsonl \
  tmp/discovery-app-eval/<label>-TREATMENT.jsonl
```

## Reading the results

### Headline numbers (per-side `summarize()`)

```
CONTROL:
  per-iter counts: [70, 70, 72, 72, 72]    ← service count per iteration
  avg services:    71.2                     ← mean across N iters
  median services: 72                       ← robust to outliers
  min/max:         70 / 72
  stdev:           1.10                     ← variance — lower is more deterministic
  avg duration:    178.9s                   ← per-iter wall-clock
  avg tool calls:  176.2
  avg retries:     0.00
```

### Per-iter delta

```
iter | CTRL  | TREAT | Δ
  1  |  62   |  72   | +10  ← treatment wins
  2  |  72   |  72   |  0
  3  |  62   |  64   | +2
```

Look for: does every iter favor treatment? Or just on average? A single
strongly-positive iter can pull up the avg even with a regression.

### Set analysis

- **Consistent set** (intersection across all iters): the services found in
  EVERY iteration. Higher is better.
- **Union** (any iter): the services found in AT LEAST one iter.
- **Hard regressions** (`CONTROL consistent − TREATMENT union`): services
  the control always finds that the treatment never finds.
  **A non-zero count is a red flag.**
- **New consistent finds**: services treatment finds in every iter that
  control never finds. Clean win.
- **Partial regressions** (in SOME control iters, in NO treatment iters):
  worth inspecting — could be intentional filter-correctness improvements
  OR could be regressions. Manual review needed.

### Frequency table

Per-service detection rate. Useful for understanding *which* services moved.
The pattern from the 2026-05-11 kill-test:

```
service                              CTRL   TREAT  Δ
openebs-jiva-csi-controller          0/5     4/5  +4 ← treatment more often
prometheus-server                    0/5     4/5  +4 ← treatment more often
loki                                 1/5     4/5  +3 ← treatment more often
```

These movements identify which specific filters / queries the change affected.

### Verdict

The script ends with a one-paragraph summary identifying the winner. Trust
this only after you've checked the inputs (set analysis, regressions).

## Common gotchas

### VPN drops mid-eval

Symptoms: `failed to connect with SSE transport` in server logs; eval iters
finish in ~10s with 0 services discovered.

Recovery: kill both servers (`pkill -f tsx.*src/server`), wait for VPN, restart from scratch. Partial eval data is discardable — run the full 5-iter set again.

### Stack 180 unreachable

Stack 180's MCP host (`10.106.2.180`) has historically been less reliable
than stack 120's (`10.105.101.4`). Default to stack 120 unless you specifically need 180.

### Servers don't bind to ports

Symptoms: `npm run web` is alive (PID exists) but `lsof -i :3001` shows
nothing.

Cause: the server is in MCP-reconnect storm for an unreachable stack. Prune
unreachable stacks from the worktree's `dops.sqlite` before starting:

```bash
sqlite3 .worktrees/my-feature/dops.sqlite \
  "DELETE FROM stacks WHERE slug NOT IN ('120', 'default');"
```

### Empty baseline produces success-rate = 0

The script defaults to `services.yaml.placeholder` (an empty services array).
With this baseline, every discovered service counts as a "false positive" so
`success` is always `false` and `recall` is 0. **That's expected.** What
matters is the `discoveredNames` array, not the recall number, when using
the placeholder.

For real recall/precision numbers, create a curated baseline:

```bash
# Run once from the control side to capture an authoritative set:
npx tsx scripts/discovery-app-eval.ts \
  --app-url http://localhost:3000 \
  --stack-id 01KRB09YJJW258J18EHFKWAV2B \
  --baseline data/120/services.yaml.placeholder \
  --iterations 1 \
  --round capture-baseline \
  --out-dir tmp/discovery-app-eval

# Convert the JSONL → baseline YAML:
node -e '
const fs = require("fs");
const lines = fs.readFileSync("tmp/discovery-app-eval/capture-baseline.jsonl", "utf8").trim().split("\n");
const names = JSON.parse(lines[0]).discoveredNames || [];
const yaml = `services:\n${names.sort().map(n => `  - name: ${n}\n    metrics: [{query: up, description: placeholder}]\n    logLabels: {}\n    probeRules: []`).join("\n")}\nglobalProbeRules: []\n`;
fs.writeFileSync("data/120/services-baseline.yaml", yaml);
console.log(`Wrote ${names.length} services`);
'
```

Then pass `--baseline data/120/services-baseline.yaml` to subsequent runs.

### LLM under-enumeration floor

Empirical observation: ~1 in 5 iterations, the LLM short-circuits and only
finds ~62 services on stack 120 instead of the typical 72. This is **not** a
code regression — it's LLM variance. The 5-iter approach averages this out.
If you see one outlier per side and the other 4 are at the ceiling, that's
expected.

### Iter-1 differs from iters 2–5

Sometimes the first iter has different characteristics (cold MCP connections,
provider tool inventory cached differently). If iter-1 looks anomalous,
consider running 6 iters and discarding iter-1.

## Manual orchestration (when the script breaks)

If `run-ab-eval.sh` fails for an environmental reason, here's the manual
equivalent. Each step is independent.

### 1. Verify prerequisites

```bash
# VPN
nc -z -G 3 10.105.101.4 1017 && echo OK

# Stacks in both DBs
sqlite3 dops.sqlite "SELECT id, slug FROM stacks"
sqlite3 .worktrees/my-feature/dops.sqlite "SELECT id, slug FROM stacks"
```

### 2. Start control server (port 3001)

```bash
cd /path/to/control-worktree
PORT=3001 CONFIG_PATH=dev/config.yaml nohup npm run web > /tmp/ctl.log 2>&1 &
echo $! > /tmp/ctl.pid
```

### 3. Start treatment server (port 3002)

```bash
cd /path/to/treatment-worktree
PORT=3002 CONFIG_PATH=dev/config.yaml nohup npm run web > /tmp/trt.log 2>&1 &
echo $! > /tmp/trt.pid
```

### 4. Wait for both ready

```bash
for i in {1..30}; do
  sleep 3
  CTL=$(curl -s -m 2 http://localhost:3001/api/health 2>/dev/null | grep -c healthy)
  TRT=$(curl -s -m 2 http://localhost:3002/api/health 2>/dev/null | grep -c healthy)
  [ "$CTL" = "1" ] && [ "$TRT" = "1" ] && { echo "ready"; break; }
done
```

### 5. Verify providers connected (per stack)

```bash
curl -s -H "X-Stack-Id: 01KRB09YJJW258J18EHFKWAV2B" \
  http://localhost:3001/api/providers | python3 -m json.tool
# Expect status: "connected" for grafana-mcp, coroot-mcp, kubernetes-mcp
```

### 6. Run control eval (5 iters)

```bash
npx tsx scripts/discovery-app-eval.ts \
  --app-url http://localhost:3001 \
  --stack-id 01KRB09YJJW258J18EHFKWAV2B \
  --baseline data/120/services.yaml.placeholder \
  --iterations 5 \
  --round my-test-CONTROL \
  --out-dir tmp/discovery-app-eval
```

### 7. Run treatment eval (5 iters)

```bash
npx tsx scripts/discovery-app-eval.ts \
  --app-url http://localhost:3002 \
  --stack-id 01KRB09YJJW258J18EHFKWAV2B \
  --baseline data/120/services.yaml.placeholder \
  --iterations 5 \
  --round my-test-TREATMENT \
  --out-dir tmp/discovery-app-eval
```

### 8. Analyze

```bash
benchmark/analyze-ab.py \
  tmp/discovery-app-eval/my-test-CONTROL.jsonl \
  tmp/discovery-app-eval/my-test-TREATMENT.jsonl
```

### 9. Cleanup

```bash
kill $(cat /tmp/ctl.pid) $(cat /tmp/trt.pid) 2>/dev/null
pkill -f "tsx.*src/server/index.ts" 2>/dev/null
```

## File reference

| File | Purpose |
|---|---|
| `benchmark/README.md` | This file. The playbook. |
| `benchmark/run-ab-eval.sh` | Single-command A/B orchestrator. Bash. |
| `benchmark/analyze-ab.py` | Comparison reporter. Reads two JSONL files, prints the head-to-head. Python 3. |
| `scripts/discovery-app-eval.ts` | The underlying eval tool. Single-side. Used by both `run-ab-eval.sh` and manual mode. |

## Decision rubric: ship or not?

After running the A/B, ship the treatment **only if**:

- [ ] **No hard regressions** (services always-found in control but never in treatment) — required
- [ ] **Avg services ≥ control avg** OR same set with lower stdev (i.e. determinism win) — required
- [ ] **Partial regressions** (some-control, no-treatment) inspected manually and explained — required
- [ ] **No new error patterns** in the eval JSONL (check `terminalPhase` and `error` fields per iter) — required
- [ ] If duration regressed significantly (>30s avg), the win on quality justifies the cost — judgment

If treatment has hard regressions, **do not ship**. If duration regressed
without quality gain, **do not ship**. Mixed signal → run another round to
tighten variance estimate.

## When NOT to A/B

- Pure refactor with no LLM-facing change (e.g. variable renames, dead code
  removal): unit tests are sufficient.
- Prompt-string changes that are 100% additive comments or section reorders
  with no semantic change: unit tests + visual review of the rendered prompt.
- Changes behind a feature flag default-off: A/B with the flag enabled is
  enough; flag-off path is exercised by existing iters.

A/B is for changes that **could plausibly affect the LLM's tool-call pattern
or output**. Prompt content, instruction ordering, tool wiring, filter
logic, schema changes.
