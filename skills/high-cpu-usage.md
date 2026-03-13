---
title: Investigate High CPU Usage
services: []
alerts: [HighCPU, NodeCPUHigh]
tags: [cpu, high, usage, load, performance, throttling]
---

## When to use
CPU usage is elevated on one or more nodes or pods.

## Investigation steps
1. Identify which processes/pods are consuming the most CPU
2. Check if it correlates with increased request rate or batch jobs
3. Look for CPU throttling in container metrics (`container_cpu_cfs_throttled_seconds_total`)
4. Check if HPA is scaling — if not, check HPA configuration
5. Review recent deployments that may have introduced CPU-intensive code

## Known gotchas
- CPU "spikes" during CronJob windows (check scheduled jobs first)
- GC pressure in Java services shows as CPU spikes — check heap usage alongside
