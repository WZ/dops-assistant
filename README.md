# dops-assistant

An agentic DevOps assistant that connects to Grafana via MCP, performs autonomous root cause analysis, and serves as a conversational ops assistant through a terminal CLI.

## Features

- **Agentic RCA** — 6-phase investigation pipeline: anomaly detection, planning, parallel evidence gathering (metrics + logs + infra), timeline correlation, chain-of-thought synthesis, and self-validation
- **Conversational assistant** — ask questions and get metric values, log excerpts, dashboard links, and ad-hoc Grafana panels
- **Intent routing** — classifies user messages and routes to the investigation agent or conversation agent
- **Service auto-discovery** — discovers services from Consul/Prometheus, probes for RED metrics and Loki log labels
- **Panel capture** — automatically screenshots relevant dashboard panels and attaches them to reports

---

## Architecture

```mermaid
graph TD
    CLI[CLI - Ink terminal UI] --> IR[Intent Router]
    IR -- question --> CA[Chat Agent]
    IR -- investigate --> IA[Investigation Agent - 6 phase RCA]
    CA --> LLM[LLM Client]
    IA --> LLM
    DA[Discovery Agent] --> LLM
    LLM --> MCP[MCP Client]
    CLI --> Mem[Conversation Memory]
    MCP --> G[Grafana MCP Server - Prometheus / Loki / Dashboards / Alerts]
```

---

## RCA Investigation Pipeline

The investigation agent runs a 6-phase pipeline applying agentic design patterns:

```mermaid
flowchart TD
    A[User: investigate service-x] --> B[Intent Router]
    B --> C[Phase 1: Anomaly Detection]
    C --> D{Anomaly?}
    D -- No --> E[No anomaly - done]
    D -- Yes --> F[Phase 1.5: Planning]
    F --> G[Phases 2+3+4 in parallel]
    G --> G1[Metric Deep Dive]
    G --> G2[Log Correlation]
    G --> G3[Infra Health Check]
    G --> G4[Panel Capture]
    G1 --> H[Build Event Timeline]
    G2 --> H
    G3 --> H
    G4 --> H
    H --> I[Phase 5: Synthesis]
    I --> J[Phase 6: Reflection]
    J --> K{Issues?}
    K -- No --> L[Final RCA Report]
    K -- Yes --> M[Apply corrections] --> L
```

**Phase breakdown:**

| Phase | Name | Pattern | What it does |
|-------|------|---------|--------------|
| 1 | Anomaly Detection | Tool use | Queries dashboards and metrics via MCP to confirm the anomaly |
| 1.5 | Planning | Planning | Generates hypotheses and focus areas to guide evidence gathering |
| 2 | Metric Deep Dive | Domain knowledge | Runs PromQL queries with service-specific metrics, compares against baselines |
| 3 | Log Correlation | Domain knowledge | Queries Loki with service log labels, captures error patterns and sample lines |
| 4 | Infra Health | Domain knowledge | Checks pod restarts, OOMKill, resource pressure via Prometheus |
| 4+ | Panel Capture | Deterministic | Screenshots relevant dashboard panels with the anomaly time range |
| — | Timeline | Programmatic | Merges all observations into a chronological event timeline (no LLM) |
| 5 | Synthesis | Chain-of-thought | CORRELATE → HYPOTHESIZE → VALIDATE → CONCLUDE reasoning chain |
| 6 | Reflection | Self-critique | Validates evidence consistency, calibrates confidence, applies corrections |

Phases 2, 3, 4, and panel capture run **in parallel**. Phases 1.5, 5, and 6 are pure reasoning (no tool calls).

---

## Demo Examples

> The examples below use a fictional **StreamFlow** data processing platform with services like `stream-ingest`, `etl-pipeline`, and `warehouse-writer`.

### Example 1 — Investigating a throughput drop

```
> the stream-ingest throughput dropped to zero around 10:00 UTC today, can you investigate

  ▸ Routed to investigation agent (service: stream-ingest)
  ◼ search_dashboards({"query":""})
  ◼ get_dashboard_by_uid({"uid":"stream-overview"})      
  [Detecting anomalies]
  ◼ query_prometheus({"expr":"sum(rate(stream_events_accepted[5m]))"})
  ◼ get_panel_image({"dashboardUid":"stream-overview","panelId":4})
  [Planning investigation]
  [Analyzing metrics, logs & infrastructure]
  ◼ query_prometheus({"expr":"sum(rate(kafka_messages{topic=\"events\"}[5m]))"})
  ◼ query_loki_logs({"query":"{app=\"stream\"}|~ \"error|timeout|disconnect\""})
  ◼ query_prometheus({"expr":"kube_pod_container_restarts{pod=~\"stream-ingest.*\"}"})
  [Building event timeline]
	[Synthesizing root cause]
  [Validating report]
 ╭─────────────────────────────────────────────────────────────────────────────╮
 │ # 🟠 RCA: stream-ingest                                                     │
 │                                                                             │
 │ 🟠 Severity: high  ·  ✅ Confidence: high  ·  🕐 3/5/2026, 10:45 AM         │
 │                                                                             │
 │ ## 📋 Summary                                                               │
 │                                                                             │
 │ Stream ingest throughput dropped to zero at 09:58 UTC. Kafka broker-3       │
 │ became unavailable, halting all message consumption on the events topic.    │
 │ Service recovered at 10:06 UTC after the broker rejoined the cluster.       │
 │                                                                             │
 │ ## 🔍 Root Cause                                                            │
 │                                                                             │
 │ Kafka broker-3 serving the events topic partitions went offline due to      │
 │ a JVM garbage collection pause exceeding the session timeout (45s).         │
 │                                                                             │
 │ ## 📊 Evidence                                                              │
 │                                                                             │
 │ ### 📈 Metrics                                                              │
 │ - stream_events_accepted: 0/s at 09:58 (baseline: 85k/s)                    │
 │ - kafka_messages_in_total{topic="events"}: 0/s at 09:58                     │
 │ - Consumer lag peaked at 12.4M messages at 10:08                            │
 │                                                                             │
 │ ### 📝 Logs                                                                 │
 │ - [09:58:01] ERROR Kafka fetch error: broker-3 not available                │
 │ - [09:58:14] WARN Consumer group rebalance triggered for group stream-cg    │
 │ - [10:06:22] INFO Partition reassignment complete, resuming consumption     │
 │                                                                             │
 │ ### 🖥️ Infrastructure                                                       │
 │ - kafka-broker-3: NotReady (09:57 – 10:05 UTC)                              │
 │ - stream-ingest-pod-2: 1 restart at 10:01 (OOMKilled)                       │
 │                                                                             │
 │ ## 🔗 Dashboard Links                                                       │
 │ - https://grafana.internal/d/stream-overview                                │
 │                                                                             │
 │ ## 🛠️ Recommended Actions                                                   │
 │ 1. Increase Kafka broker-3 heap size or tune GC settings                    │
 │ 2. Raise stream-ingest pod memory limit from 2Gi to 3Gi                     │
 │ 3. Add alerting on consumer lag > 5M for early detection                    │
 ╰─────────────────────────────────────────────────────────────────────────────╯
  📎 Panel image: /tmp/dops-panel-stream-throughput.png (opened)
  📎 Panel image: /tmp/dops-panel-consumer-lag.png (opened)
  12 tool calls · 58k tokens
```

### Example 2 — ETL pipeline error spike

```
> etl-pipeline error rate is spiking, what's going on?

  ▸ Routed to investigation agent (service: etl-pipeline)
  [Detecting anomalies]
  ◼ search_dashboards({"query":""})
  ◼ query_prometheus({"expr":"rate(etl_transform_errors_total[5m])"})
  [Planning investigation]
  [Analyzing metrics, logs & infrastructure]
  ◼ query_loki_logs({"query":"{app=\"etl-pipeline\"} |~ \"exception|error\""})
  ◼ query_prometheus({"expr":"etl_transform_duration_seconds{quantile=\"0.99\"}"})
  [Synthesizing root cause]
  [Validating report]
 ╭─────────────────────────────────────────────────────────────────────────────╮
 │ # 🔴 RCA: etl-pipeline                                                      │
 │                                                                             │
 │ 🔴 Severity: critical  ·  🔷 Confidence: medium  ·  🕐 3/5/2026, 11:20 AM   │
 │                                                                             │
 │ ## 📋 Summary                                                               │
 │                                                                             │
 │ ETL transform error rate jumped from 0.1% to 34% at 11:02 UTC.              │
 │ The warehouse-writer downstream service is returning 503s, causing          │
 │ all write-stage transforms to fail and retry.                               │
 │                                                                             │
 │ ## 🔍 Root Cause                                                            │
 │                                                                             │
 │ warehouse-writer is overwhelmed — its connection pool to the data           │
 │ warehouse is exhausted, returning 503 to etl-pipeline write requests.       │
 │                                                                             │
 │ ## 📊 Evidence                                                              │
 │                                                                             │
 │ ### 📈 Metrics                                                              │
 │ - etl_transform_errors_total: 1,240/s (baseline: 3/s)                       │
 │ - etl_transform_duration_seconds p99: 45s (baseline: 1.2s)                  │
 │                                                                             │
 │ ### 📝 Logs                                                                 │
 │ - [11:02:15] ERROR WriteStage failed: HTTP 503 from warehouse-writer        │
 │ - [11:02:15] ERROR ConnectionPool exhausted: 0/50 available                 │
 │                                                                             │
 │ ## 🛠️ Recommended Actions                                                   │
 │ 1. Scale warehouse-writer replicas from 3 to 6                              │
 │ 2. Increase warehouse-writer connection pool from 50 to 100                 │
 │ 3. Add circuit breaker on etl-pipeline write stage                          │
 ╰─────────────────────────────────────────────────────────────────────────────╯
  8 tool calls · 42k tokens
```

### Example 3 — Conversational query with ad-hoc panel

```
> show me the CPU usage of worker node worker-7

  ▸ Routed to conversation agent
  ◼ create_temp_panel({"title":"CPU usage for worker-7","expr":"100 - (rate(node_cpu_seconds_total{instance=\"worker-7:9100\",mode=\"idle\"}[5m]) * 100)"})

  CPU usage for worker-7 is currently at 67%.
  I created a temporary Grafana panel with the last hour of data.

  📎 Saved: /tmp/dops-panel-cpu-worker-7.png (opened)
  2 tool calls · 4.5k tokens
```

### Example 4 — Quick health check

```
> what's the p99 latency for warehouse-writer?

  ▸ Routed to conversation agent
  ◼ query_prometheus({"expr":"histogram_quantile(0.99, rate(http_request_duration_seconds_bucket{service=\"warehouse-writer\"}[5m]))"})

  The p99 latency for warehouse-writer is 320ms (baseline ~180ms over the last 24h).
  This is elevated but not critical.

  1 tool call · 3.1k tokens
```

---

## CLI Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Enter` | Submit query |
| `Ctrl+A` / `Ctrl+E` | Move cursor to start / end of line |
| `Ctrl+U` | Clear entire line |
| `Ctrl+K` | Kill from cursor to end of line |
| `Ctrl+W` | Delete previous word |
| `Esc` | Clear line |
| `Esc Esc` | Abort current query (double-tap within 500ms) |
| `Up` / `Down` | Navigate input history |
| `Ctrl+L` | Clear message history |
| `Ctrl+D` | Exit |

---

## Getting Started

### Prerequisites

- Node.js 20+
- A running Grafana instance with a service account token
- An OpenAI API key (or compatible endpoint)

### Quick start

```bash
npm install
cp config.yaml.example config.yaml

export OPENAI_API_KEY=sk-...
export GRAFANA_SERVICE_ACCOUNT_TOKEN=glsa_...

# (Optional) Auto-discover services from Consul/Prometheus
npm run discover

# Start the CLI
npm run cli

# Or build and run in production
npm run build && npm start
```

Override config path: `CONFIG_PATH=/path/to/config.yaml`

### Configuration

| Section | Purpose |
|---------|---------|
| `llm` | Model, API key, token limit, optional custom base URL |
| `grafana.mcpServer` | MCP transport (`stdio` or `http`), command/URL, enabled tools |
| `services` | Services to monitor — PromQL queries and Loki log labels per service |
| `discovery` | Auto-discovery settings — `autoRefresh`, `excludeServices`, `consulMetric` |
| `agent` | Max agentic loop iterations, conversation memory size and TTL |

---

## Documentation

- [docs/architecture.md](docs/architecture.md) — component walkthrough and design decisions
- [docs/runbook.md](docs/runbook.md) — Grafana MCP setup, full config reference, tuning, troubleshooting

## License

MIT
