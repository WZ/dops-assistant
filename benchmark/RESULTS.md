# Investigation Agent Robustness Benchmark

**Date:** 2026-03-08
**Branch:** `fix/pr5-review-comments`
**Model:** gpt-oss-120b (self-hosted)
**Service:** ingestion-server
**Prompt:** "investigate on the drop on ingestion rate on 2026-03-03"

## How to Run

```bash
# From project root:
NODE_TLS_REJECT_UNAUTHORIZED=0 npx tsx dev/run-investigation.ts \
  --runs 10 \
  --service ingestion-server \
  --message "investigate on the drop on ingestion rate on 2026-03-03" \
  --force-anomaly
```

The runner (`dev/run-investigation.ts`) executes `InvestigationAgent.investigate()` N times sequentially, collecting per-run telemetry (duration, tokens, tool calls, panel images, errors) and saving individual `report.json` files and a `summary.json`.

`--force-anomaly` bypasses the anomaly-detection phase and feeds a synthetic anomaly directly to the RCA pipeline so results are comparable.

## Results Summary

|                        | Baseline (pre-fix) | Post-fix |
|------------------------|-------------------|----------|
| Conclusive root cause  | 6/10              | **10/10** |
| High confidence        | 5/10              | **10/10** |
| Errors                 | 0                 | 0        |
| Avg duration           | 71.6s             | 93.8s    |
| Avg input tokens       | 90,394            | 97,241   |
| Avg output tokens      | 18,079            | 21,304   |

Token cost increased ~18% due to retries, but conclusive-root-cause rate went from 60% to **100%**.

## Fix Trigger Statistics (Post-fix Run)

| Fix | Trigger Count | Description |
|-----|--------------|-------------|
| Hallucination retry (Fix 1) | 25 events across 10 runs | `<\|constrain\|>json` fake function calls intercepted and retried |
| JSON repair (Fix 2) | 5 recoveries | Truncated JSON (17k-65k chars) repaired by bracket balancing |
| Quality gate (Fix 3) | 4 triggers, 4 successes | Non-conclusive root cause retried with stronger prompt |

### Hallucination retry breakdown
- 14 events at retryCount=0 (first retry)
- 7 events at retryCount=1 (second retry)
- 4 events at retryCount=2 (exhausted, fell through to text)

### JSON repair breakdown
| Original Length | Repaired Length | Savings |
|----------------|----------------|---------|
| 52,112 | 52,114 | Bracket close only |
| 64,706 | 13,921 | 78% reduction (stripped partial entries) |
| 49,745 | 49,747 | Bracket close only |
| 54,671 | 37,214 | 32% reduction |
| 17,667 | 17,669 | Bracket close only |

## Per-Run Quality (Post-fix)

| Run | Conclusive | Confidence | Duration | Root Cause |
|-----|-----------|------------|----------|------------|
| 1 | Yes | high | 70.8s | CPU saturation during peak ingest rate |
| 2 | Yes | high | 139.8s | Transient network partition / Kafka broker outage |
| 3 | Yes | high | 44.0s | Missing Kafka topic (info_log), auto-creation disabled |
| 4 | Yes | high | 39.2s | info_log topic missing / stale metadata |
| 5 | Yes | high | 93.5s | Transient TCP connectivity loss to Kafka brokers |
| 6 | Yes | high | 133.2s | Intermittent network/broker issue on Kafka cluster |
| 7 | Yes | high | 127.7s | Transient info_log topic loss (broker restart / deletion) |
| 8 | Yes | high | 135.3s | Transient network/DNS interruption to Kafka brokers |
| 9 | Yes | high | 88.0s | info_log topic deleted/inaccessible (ACL change / broker issue) |
| 10 | Yes | high | 66.1s | info_log topic/partition unavailable to producer |

## Per-Run Quality (Baseline)

| Run | Conclusive | Confidence | Duration | Root Cause |
|-----|-----------|------------|----------|------------|
| 1 | No | medium | 83.9s | "Not yet identified" |
| 2 | Yes | high | 47.3s | Temporary Kafka topic-availability failure |
| 3 | Yes | high | 115.0s | Transient downstream back-pressure |
| 4 | Yes | high | 40.6s | Synchronous Kafka publish block |
| 5 | Yes | high | 77.1s | Kafka topic info_log unavailable |
| 6 | Yes | medium | 77.6s | Transient back-pressure / queue saturation |
| 7 | No | low | 36.7s | "Not yet determined" |
| 8 | No | high | 44.6s | Investigation plan dump instead of root cause |
| 9 | No | medium | 116.9s | "Unconfirmed — likely transient" |
| 10 | No | high | 76.1s | "Pending — will be locked-in once evidence collected" |

## Fixes Applied

1. **LLM hallucination retry** (`src/llm/openai.ts`): When gpt-oss-120b emits `<|constrain|>json` as a hallucinated function call with zero text content, retry up to 2 times with a nudge message.

2. **JSON repair** (`src/agent/investigation.ts`): `repairTruncatedJson()` closes open strings, strips partial entries, and balances brackets/braces on truncated LLM output.

3. **Token limit increase** (`src/agent/investigation.ts`): `SYNTHESIS_MAX_TOKENS` and `REFLECTION_MAX_TOKENS` raised from 8192 to 16384. Fresh-retry `maxOutputTokens` caps also raised to 16384.

4. **Root cause quality gate** (`src/agent/investigation.ts`): Between synthesis and reflection, detects non-conclusive root causes via regex and retries synthesis with a stronger prompt demanding a best-hypothesis conclusion.

## File Structure

```
benchmark/
  RESULTS.md              # This file
  baseline/
    summary.json          # Pre-fix telemetry
    run-{1..10}/
      report.json         # Individual RCA reports
  post-fix/
    summary.json          # Post-fix telemetry
    benchmark-run.txt     # Raw logs from the benchmark run
    run-{1..10}/
      report.json         # Individual RCA reports
```
