---
title: Consul Bare-Metal Service Discovery
services: []
alerts: []
tags:
  - discovery
  - consul
  - bare-metal
  - host-process
  - fortidata
scope:
  - discovery
---
## When to use
This stack runs services on bare-metal hosts (not K8s). They are registered in Consul and export health status via the `consul_health_service_status` metric.

## Discovery strategy

### Step 1: Find all Consul-registered services
Query:
```
count by (service_name) (consul_health_service_status)
```
Each unique `service_name` is a service. The `node` label (e.g., `blade-198-18-1-10`) identifies which host runs it.

### Step 2: Build service entries for bare-metal services
For each bare-metal-only service, use this format:
- **name**: the `service_name` value (e.g., `hdfs-datanode`)
- **metrics**: `[{"query": "consul_health_service_status{service_name=\"<name>\"}", "description": "Consul health status"}]`
- **logLabels**: `{"app_fortidata_name": "<name>"}` — this is the Loki label key for this stack

### Important: discover ALL Consul services, not just known ones
You MUST run the `consul_health_service_status` query above and include
EVERY `service_name` returned. Do NOT limit discovery to the examples below —
new services are added regularly and won't appear in this list.

Known examples (not exhaustive):
hdfs-datanode, hdfs-namenode, hdfs-journalnode, hdfs-zkfc, impala, impala-catalog,
hbase, kudu, kudu-tserver, spark, zookeeper, consul, hive-metastore, fazbdregistry
