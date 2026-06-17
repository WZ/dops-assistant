---
title: Kubernetes Workload Investigation
services: []
alerts: []
appliesToServiceMetric: kube_
tags:
  - investigation
  - rca
  - kubernetes
  - k8s
scope:
  - investigation
---
## When to use
This runbook applies to Kubernetes workloads — identified by a `kube_deployment_*`
(or `kube_statefulset_*` / `kube_pod_*`) metric. It is injected into an
investigation only when the incident service is k8s-tracked and this skill is
enabled. If the service is a bare-metal Consul service (it has a
`consul_health_service_status` metric, no `kube_*`), this does not apply.

## The health signal — check it FIRST
Read the deployment's replica state before forming any pod-level hypothesis:
```
kube_deployment_spec_replicas{deployment="<name>"}
kube_deployment_status_replicas_available{deployment="<name>"}
kube_deployment_status_replicas_unavailable{deployment="<name>"}
```
- **available == spec, unavailable == 0** → the deployment is **healthy** on its
  primary signal.
- **spec == 0** → scaled to zero — a complete, valid root cause for unavailability
  (predict `kube_deployment_status_replicas < 1`; it reads 0 → confirmed). With
  zero replicas there are **no pods**, so pod-runtime causes (GPU/OOM/readiness)
  do not apply.
- **available < spec / unavailable > 0** → some pods are down — investigate pod
  status, restarts, OOMKills, image pulls, scheduling.

## Healthy ≠ a root cause (read this before confirming)
If `available == spec` and `unavailable == 0`, the workload is **healthy** — do NOT
manufacture a cause. In particular do NOT confirm "CPU throttling", "OOMKilled",
"readiness failing", or "pods crashing" **unless you actually gathered the metric
that shows it**:
```
rate(container_cpu_cfs_throttled_seconds_total{pod=~"<name>.*"}[5m])   # > 0 to claim throttling
rate(kube_pod_container_status_restarts_total{pod=~"<name>.*"}[15m])   # > 0 to claim crashloop
kube_pod_container_status_last_terminated_reason{reason="OOMKilled"}    # to claim OOM
```
If those return no data / zero, the symptom isn't happening — **conclude
inconclusive** ("deployment appears healthy; no incident found"), never a confirm.
A confirm must name a fault for which a gathered observation crossed a threshold.

## To CONFIRM a real k8s incident
Attach a checkable prediction over the metric that shows the fault, e.g.
`{"kind":"metric-threshold","metric":"kube_deployment_status_replicas_unavailable","op":">","value":0}`
for unavailable replicas, or a restart-rate / throttle-rate threshold for the
specific pod-level fault. The `test` move must come back **satisfied** on real,
gathered evidence before you `conclude`.
