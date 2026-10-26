# 0005: Consume at-least-once from the earliest offset, and sweep what delivery misses

**Status:** accepted

## Context

A message's offset is committed only after it has been processed, which gives at-least-once delivery. Two gaps remained:

1. The consumer subscribed with `fromBeginning: false`. A group with no committed offset starts at the *latest* message: a new deployment, or a crash on the group's very first message, silently skips events already in the topic.
2. A delivery that finds the Redis lock held treats it as contention and commits its offset, assuming the holder will do the work. If the holder was a worker that crashed before claiming, or a `SET NX` that timed out on the client but still landed, nobody ever runs the event. The development database had three events in exactly this state: published by the outbox, never processed.

## Decision

- Consumers start from the earliest offset when a group has none (`KAFKA_FROM_BEGINNING`, default `true`). Replaying history is safe because every effect is idempotent.
- Consumption is concurrent but commits stay ordered. All partitions are consumed in parallel (`KAFKA_PARTITIONS_CONCURRENCY`, 3). Each partition's batch is processed in concurrent chunks (`KAFKA_PROCESSING_CONCURRENCY`, 10), and offsets are resolved strictly in order, only up to the first failure. The failed message and the rest of its chunk are redelivered; re-running a message that had succeeded is a duplicate the guards absorb. The measured effect is in `docs/PERFORMANCE.md`.
- The consumer process creates the topic itself (idempotently) before subscribing. It used to rely on the API process having done so, and when both started together it could crash with "This server does not host this topic".
- The retry worker in the API process is also a recovery sweeper. Each pass runs:
  - RETRYING events whose backoff elapsed;
  - PROCESSING events whose lease expired (crashed worker);
  - RECEIVED events older than `STALE_RECEIVED_SECONDS` (default 120): delivered but never claimed.
- Infrastructure errors (Redis down or hung, PostgreSQL unreachable) propagate out of the batch handler before that message's offset is resolved, so Kafka redelivers it.
- Business failures (missing wallet, invalid payload) are recorded under the claim's fence as RETRYING with exponential backoff. After `maxAttempts` (3) the event is FAILED and a DLQ row is opened in the same transaction.

## Consequences

- PostgreSQL is the source of truth for what still needs doing; Kafka is the fast path. Even if Kafka is unavailable for longer than the stale threshold, payments are still credited, by the sweeper.
- The failure suites exercise each path with real processes and real outages (`tests/failure/`).
