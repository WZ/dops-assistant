---
title: Investigate Kafka Consumer Lag
services: [kafka-brokers, kafka-consumers]
alerts: [KafkaConsumerLagHigh, KafkaConsumerGroupLag]
tags: [kafka, consumer, lag, backpressure, rebalance]
---

## When to use
Consumer lag is increasing or consumer group is falling behind.

## Investigation steps
1. Check partition reassignment status — lag spikes during rebalances are expected
2. Query `kafka_consumergroup_lag` by topic and consumer group
3. Check consumer pod memory/CPU — OOM kills cause rebalances
4. Check producer throughput — sudden spikes overwhelm consumers
5. Look for "CommitFailedException" in consumer logs — indicates rebalance timeout

## Known gotchas
- During rolling restarts, lag spikes for ~5 min are normal
- The `__consumer_offsets` topic lag is noise — ignore it
