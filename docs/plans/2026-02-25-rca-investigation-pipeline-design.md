# RCA Investigation Pipeline Design

**Goal:** Add autonomous root cause analysis to dops-assistant so that when an anomaly is detected (or a user asks), the agent investigates across metrics, logs, and infra — then produces a structured report explaining *why* something is broken, not just that it is.

**Architecture:** A new `InvestigationAgent` runs a fixed 5-phase pipeline (anomaly → metrics → logs → infra → synthesis). Phases 2-4 run in parallel. The pipeline is triggered automatically when the scheduler detects an anomaly, and on-demand when a user's Slack message is classified as an investigation request.

**Tech Stack:** Reuses existing `LlmClient`, `McpClient`, `withTimeout`, `withRetry`. New structured JSON schemas per phase. Slack Block Kit for output formatting.

---

## Pipeline Phases

```
Phase 1: Anomaly Detection      → AnomalyAssessment   (existing type, reused)
Phase 2: Metric Deep-Dive       → MetricFindings       (run in parallel)
Phase 3: Log Correlation        → LogFindings          (run in parallel)
Phase 4: Infra Health           → InfraFindings        (run in parallel)
Phase 5: Root Cause Synthesis   → RcaReport
```

Each phase has its own system prompt and structured JSON output schema. Phase 5 receives all prior findings as context and synthesizes the final report.

---

## Types

```typescript
// src/agent/rca-types.ts

type MetricFindings = {
  observations: string[];   // key metric values with timestamps
  baseline: string;         // normal range for comparison
  anomalyWindow: string;    // when the anomaly started
};

type LogFindings = {
  errorPatterns: string[];  // recurring error messages
  stackTraces: string[];    // relevant stack traces
  firstOccurrence: string;  // ISO timestamp
};

type InfraFindings = {
  podHealth: string[];      // restarts, OOMKilled, CrashLoopBackOff
  nodeHealth: string[];     // CPU/memory pressure
  recentEvents: string[];   // k8s events
};

type RcaReport = {
  service: string;
  severity: "low" | "medium" | "high" | "critical";
  summary: string;                  // 1-2 sentence TL;DR
  rootCause: string;                // what's actually wrong
  evidence: {
    metrics: string[];
    logs: string[];
    infra: string[];
  };
  recommendedActions: string[];     // ordered, most impactful first
  confidence: "low" | "medium" | "high";
  investigatedAt: string;           // ISO timestamp
};
```

---

## Slack Output

```
🔴 [critical] payments-api — High error rate detected

Root Cause
Database connection pool exhausted (pool_size=10, active=10, waiting=47)

Evidence
• Metrics: error_rate jumped from 0.2% → 18% at 14:32 UTC
• Logs: "connection timeout after 30s" repeated 340x in last 5 min
• Infra: payments-api pod restarted 3x in last 10 min (OOMKilled)

Recommended Actions
1. Scale connection pool or add read replica
2. Restart payments-api pods to clear stuck connections
3. Check DB node CPU — currently at 94%

Confidence: high  |  Investigated at 14:37 UTC
```

---

## Guided Triage (Conversational RCA)

An `IntentClassifier` (single LLM call, no tools) determines if a Slack message is an investigation request or a regular question.

- `investigation` → `InvestigationAgent.investigate(service)`
- `question` → existing `AgentCore.run(mode: "conversational")` (unchanged)

The agent asks **at most 2 clarifying questions** before proceeding. If the user doesn't respond, it investigates everything and notes the uncertainty in `confidence`.

**Config addition:**
```yaml
agent:
  investigationTriggerPhrases:    # optional, has sensible defaults
    - "investigate"
    - "why is"
    - "what's wrong"
    - "is down"
    - "is slow"
```

---

## Integration Points

### Scheduler path (proactive)
```
Scheduler.checkService()
  → AgentCore.run(mode: "proactive")               [existing — unchanged]
  → AnomalyAssessment.isAnomaly === true
  → InvestigationAgent.investigate(service, anomaly)
  → RcaReport
  → sendAnomalyAlert(webhook, { ...alert, rca })
```

### Slack path (on-demand)
```
SlackBot.handleMessage()
  → IntentClassifier.classify(text)
  → "investigation" → InvestigationAgent.investigate(service)
  → "question"      → AgentCore.run(mode: "conversational")
  → formatRcaBlocks(report) or plain text reply
```

### New files
```
src/agent/investigation.ts       InvestigationAgent class + 5-phase pipeline
src/agent/rca-types.ts           RcaReport, MetricFindings, LogFindings, InfraFindings
src/agent/intent.ts              IntentClassifier
src/agent/rca-prompts.ts         Per-phase system prompts + JSON schemas
src/notifications/rca-blocks.ts  Slack Block Kit formatter for RcaReport
```

### Modified files
```
src/scheduler/scheduler.ts           Trigger InvestigationAgent after anomaly
src/interfaces/slack.ts              Route via IntentClassifier
src/notifications/slack-webhook.ts   Add optional rca field to AnomalyAlert
src/config/schema.ts                 Add investigationTriggerPhrases to AgentSchema
```

---

## Error Handling & Confidence

**Phase failures are non-fatal.** Missing data contributes an empty finding; Phase 5 notes the gap and downgrades confidence:

| Evidence available | Confidence |
|---|---|
| All 3 types, cause consistent | `high` |
| 2 of 3 types, suggestive | `medium` |
| 1 type only, or contradictory | `low` |

**Timeouts:** Phases 2/3/4 run with individual `withTimeout` wrapping. Total budget: `3 × toolExecutionMs` (no new config needed).

**Deduplication:** RCA investigations respect the existing `AlertDeduplicator` cooldown. On-demand Slack investigations bypass deduplication.

---

## What Is Not Changing

- `AgentCore` — untouched
- `McpClient`, `LlmClient` — reused directly by `InvestigationAgent`
- Existing prompts and `AnomalyAssessment` type — reused in Phase 1
- Scheduler cron loop and alert deduplication — unchanged
