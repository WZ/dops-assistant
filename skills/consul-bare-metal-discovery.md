---
title: Consul Bare-Metal Service Discovery
services: []
alerts: []
tags:
  - discovery
  - consul
  - bare-metal
  - host-process
  - bigdata
scope:
  - discovery
  - investigation
---
## When to use
This stack runs services on bare-metal hosts (not K8s). They are registered in Consul and export health status via the `consul_health_service_status` metric.

## When investigating a root cause (read this first)
If a service appears down but has **no Kubernetes Deployment / Pod**, that is EXPECTED here — it is a bare-metal Consul service, not a k8s workload. Do NOT report "deployment missing" or "not deployed in the cluster" as the root cause. Its health signal is the Consul metric:
```
max by (service_name) (consul_health_service_status{service_name="<name>",status="passing"})
```
A value of `0` (or no row) means the bare-metal service is failing its Consul health check — that is the real signal to investigate (check the host process, its logs via the bare-metal logLabels, and any upstream it depends on). Only conclude a k8s cause for services that actually have k8s objects.

## Discovery strategy

### Step 1: Find all Consul-registered services
Query:
```
count by (service_name) (consul_health_service_status)
```
Each unique `service_name` is a service. The `node` label (e.g., `host-node-01`) identifies which host runs it.

### Step 2: Build service entries for bare-metal services
For each bare-metal-only service, use this format:
- **name**: the `service_name` value (e.g., `hdfs-datanode`)
- **metrics**: `[{"query": "max by (service_name) (consul_health_service_status{service_name=\"<name>\",status=\"passing\"})", "description": "Consul health (1 if any node passing)"}]`
- **logLabels**: `{"app_host_name": "<name>"}` — typical Loki label key for bare-metal host processes; adjust if the stack's Loki uses a different convention.

### Why the `status="passing"` filter is required
`consul_health_service_status` returns one row per (node × status), i.e. up to 4
rows per service (passing, warning, critical, maintenance). Only the row whose
`status` label matches the service's *current* health has value=1; all others
are 0. Without `status="passing"`, a query like
`consul_health_service_status{service_name="X"}` returns multiple rows with
mixed 0/1 values — the probe and the health poller cannot interpret it.

### probeRules for bare-metal services
Emit at minimum:
```
{ "name": "service_availability",
  "query": "max by (service_name) (consul_health_service_status{service_name=\"<name>\",status=\"passing\"})",
  "threshold": { "op": "lt", "value": 1 },
  "consecutiveTicks": 3,
  "source": "metrics" }
```
Plus a `log_errors` rule using the bare-metal logLabels above.

`pod_restarts` is omitted (no Kubernetes pods) — set
`service.description = "bare-metal Consul service; no pod_restarts rule"`.

### Important: discover ALL Consul services, not just known ones
You MUST run the `consul_health_service_status` query above and include
EVERY `service_name` returned. Do NOT limit discovery to the examples below —
new services are added regularly and won't appear in this list.

Known examples (not exhaustive):
hdfs-datanode, hdfs-namenode, hdfs-journalnode, hdfs-zkfc, impala, impala-catalog,
impala-statestore, hbase, kudu, kudu-tserver, spark, zookeeper, consul, hive-metastore
