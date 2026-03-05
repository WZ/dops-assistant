# RCA Evidence Enrichment Design

**Date:** 2026-03-02
**Status:** Approved

## Problem

The RCA report collects metric/log/infra findings but surfaces no concrete evidence to the user. The CLI renderer (`formatRcaText`) silently drops all `evidence` fields. Reports lack raw log samples, Loki search terms, and Grafana dashboard links.

## Goal

Enrich RCA reports with actionable evidence: raw log lines, reusable Loki queries, and Grafana panel URLs — so a human can immediately reproduce and verify findings.

## Scope

CLI only. Slack mode is deprecated for now.

## Design

### 1. Type changes (`rca-types.ts`)

`LogFindings` gains:
- `logSamples: string[]` — up to 5 raw log lines pulled from Loki
- `lokiSearchTerms: string[]` — ready-to-use Loki queries (e.g. `{job="ingestion"} |= "exception"`)

`RcaReport` gains:
- `dashboardLinks: string[]` — Grafana panel URLs relevant to the anomaly
- `panelImages: ImageAttachment[]` — panel screenshots (already handled by `saveAndOpenImages`)

### 2. Prompt changes (`rca-prompts.ts`)

`LOG_CORRELATION_PROMPT`:
- Instruct LLM to pull actual raw log lines from Loki (up to 5 per error pattern)
- Instruct LLM to generate reusable Loki search terms a human can paste directly

`METRIC_DEEP_DIVE_PROMPT`:
- Instruct LLM to construct and include the Grafana dashboard panel URL when calling `get_panel_image`

`RCA_SYNTHESIS_PROMPT`:
- Collect `dashboardLinks` from metric findings into the final report

JSON schemas (`LOG_FINDINGS_SCHEMA`, `RCA_REPORT_SCHEMA`) updated to match.

### 3. CLI renderer changes (`App.tsx` — `formatRcaText`)

Render all evidence fields:

```
🔴 RCA Report: ingestion-service
Severity: high | Confidence: medium
Root cause: ...
Summary: ...

Evidence:
  Metrics:
    • error rate spiked to 45% at 14:32 UTC (baseline <1%)
  Logs:
    • [14:31:05] ERROR NullPointerException at Ingester.java:142
  Loki search terms:
    • {job="ingestion"} |= "NullPointerException"
  Dashboard links:
    • https://grafana/d/I61GVQVZk?panelId=31

Actions:
  1. Restart ingestion pods
```

Panel images continue to use the existing `saveAndOpenImages` path.

## Files to change

- `src/agent/rca-types.ts`
- `src/agent/rca-prompts.ts`
- `src/agent/investigation.ts` (wire `panelImages` into `RcaReport`)
- `src/interfaces/cli/App.tsx` (`formatRcaText`)
