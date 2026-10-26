# 0001: Publish events through a transactional outbox

**Status:** accepted

## Context

An event must reach Kafka if and only if it was recorded. Writing the event row and then calling `producer.send()` has two failure windows: the API crashes after the commit and the event is never published, or the publish succeeds and the commit rolls back, so consumers act on an event that does not exist.

## Decision

The API writes `Event`, `EventLog` and an `OutboxEvent (PENDING)` row in one PostgreSQL transaction and never talks to Kafka on the request path. An outbox worker publishes PENDING rows and marks them PUBLISHED.

Publishing is leased: a worker claims a batch with `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING`, stamping `lockedUntil`. Concurrent publishers (several API replicas, or overlapping cycles) get disjoint rows. A publish failure keeps the rows PENDING and pushes `lockedUntil` out with exponential backoff (1 s, 2 s, 4 s … 60 s), so a Kafka outage does not turn into a hot retry loop.

## Consequences

- No event is lost or invented: the outbox row commits or rolls back with the event.
- An event can be published **more than once**: a worker that publishes and then crashes before marking the row leaves it to be re-published when the lease expires. This is accepted because consumers are idempotent (ADR 0002 and 0003), and it is tested (`tests/failure/recovery.test.ts`).
- Delivery latency includes the poll interval (500 ms by default; a full batch triggers the next cycle immediately).

## Alternatives considered

- **Publish inside the request, then commit:** the dual-write problem above.
- **Change data capture (Debezium):** removes polling, but adds Kafka Connect to operate. Out of scope for one service.
