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
This stack runs services on bare-metal hosts (not K8s). They are registered in Consul and export health status via the `consul_catalog_service_node_healthy` metric.

## Discovery strategy

### Step 1: Find all Consul-registered services ONLY WITH Type=ExternalName
Query:
```
count by (service_name) (consul_catalog_service_node_healthy)
```
Each unique `service_name` is a service. The `node` label (e.g., `blade-198-18-1-10`) identifies which host runs it.

### Step 2: Deduplicate against K8s services
Some services exist in BOTH Consul and K8s (e.g., `ingestion-server`). For any service already discovered via K8s metrics (`kube_deployment_status_replicas`, `kube_pod_info`, etc.), DO NOT add it again from Consul. Prefer the K8s version because it has richer metadata (namespace, pod labels, container metrics).

Only include services from Consul that were NOT found via K8s provider queries.

### Step 3: Build service entries for bare-metal services
For each bare-metal-only service, use this format:
- **name**: the `service_name` value (e.g., `hdfs-datanode`)
- **metrics**: `[{"query": "consul_catalog_service_node_healthy{service_name=\"<name>\"}", "description": "Consul health status"}]`
- **logLabels**: `{"app_fortidata_name": "<name>"}` — this is the Loki label key for this stack

### Important: discover ALL Consul services ONLY WITH Type=ExternalName, not just known ones
You MUST run the `consul_catalog_service_node_healthy` query above and include
EVERY `service_name` returned. Do NOT limit discovery to the examples below —
new services are added regularly and won't appear in this list.

Known examples (not exhaustive):
hdfs-datanode, hdfs-namenode, hdfs-journalnode, hdfs-zkfc, impala, impala-catalog,
hbase, kudu, kudu-tserver, spark, zookeeper, consul, hive-metastore, fazbdregistry
