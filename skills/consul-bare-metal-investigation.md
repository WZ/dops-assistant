---
title: Consul Bare-Metal Service Investigation
services: []
alerts: []
appliesToServiceMetric: consul_health_service_status
healthySignal: 'max by (service_name) (consul_health_service_status{service_name="$service",status="passing"})'
identityHint: '$service is registered in Consul (identity metric consul_health_service_status) — it has NO Kubernetes Deployment by design. Investigate its Consul health (status="critical") and host process FIRST; do not form k8s hypotheses for it.'
incompatibleClaims: 'kubernetes|k8s deployment|scaled to zero|scaled to 0|zero replicas|0 replicas|namespace'
tags:
  - investigation
  - rca
  - consul
  - bare-metal
  - host-process
scope:
  - investigation
---
## When to use
This runbook applies ONLY to services registered in Consul on bare-metal hosts —
identified by the `consul_health_service_status` metric. It is injected into an
investigation only when the incident service is Consul-tracked and this skill is
enabled. If the incident service is a Kubernetes workload (it has a
`kube_deployment_*` metric), this runbook does not apply — investigate its
deployment/pod state instead.

## The health signal
A bare-metal Consul service has **no Kubernetes Deployment/Pod by design** — do NOT
report "deployment missing / not deployed in the cluster". Its health is the Consul
check, which emits one row per (node × status). Read it aggregated:
```
max by (service_name) (consul_health_service_status{service_name="<name>",status="passing"})
```
- value `1` → the service is **passing** its Consul health check (healthy on this axis).
- value `0` (or no passing row) → it is **failing** — confirm via the critical row:
```
max by (service_name) (consul_health_service_status{service_name="<name>",status="critical"})
```
A critical value of `1` is direct evidence the bare-metal service is down/unhealthy.

## Healthy ≠ a root cause
If the passing value is `1` and the critical value is `0`, the Consul service is
**healthy** — do not manufacture a Consul cause. Either the incident is on a
different axis (the host process is up but a dependency or the data plane is
degraded — investigate that) or there is no live incident, in which case
**conclude inconclusive**. Never confirm "Consul health failing" for a service
whose passing row reads `1`.

## To CONFIRM a failing Consul service (so the test verifies, not "absent")
When you hypothesize the service is failing its Consul check, attach a checkable
prediction whose metric the gather can reduce to a single value. Use the
aggregated passing form so the evidence comes back as one number, not mixed rows:
```json
{"kind":"metric-threshold","metric":"consul_health_service_status","op":"<","value":1}
```
Then `query` it — the gather must run the AGGREGATED query
`max by (service_name) (consul_health_service_status{service_name="<name>",status="passing"})`
so it returns a single value. If that value is `< 1` (i.e. `0`), the `test` returns
**satisfied** → you can `conclude` "bare-metal Consul service failing its health
check". A bare `consul_health_service_status{...}` selector (no `status` filter, no
aggregation) returns multiple 0/1 rows the keystone cannot reduce — it will always
come back "couldn't verify". Always predict/gather the aggregated passing form.

Once confirmed, deepen the cause: investigate the host process, its logs via the
bare-metal logLabels, and any upstream dependency it relies on — but the failing
Consul health check is itself a valid, grounded root cause to report.
