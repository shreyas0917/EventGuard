# 0002: PostgreSQL, not Redis, is the authority on idempotency

**Status:** accepted

## Context

Duplicates arrive from Kafka redelivery, outbox re-publishes, webhook retries and the browser's verify call racing the webhook. A Redis lock (`SET NX EX`) and a "completed" cache are fast ways to turn duplicates away, but Redis locks can expire mid-processing, survive the worker that took them, or fail open during an outage. A guarantee about money cannot rest on them.

## Decision

Redis is an optimisation and a coordination aid only. Every guarantee is enforced by PostgreSQL:

| Guard | Mechanism |
|---|---|
| One event per id | `events.eventId` UNIQUE (duplicate create → 409) |
| One event per Razorpay payment | canonical `evt_{paymentId}` + `pg_advisory_xact_lock` + `payments.razorpayPaymentId` UNIQUE |
| One processing owner | atomic claim with lease and fencing token (ADR 0003) |
| One credit per event | `wallet_transactions.eventId` UNIQUE, checked inside the completion transaction |
| No impossible ledger state | CHECK constraints (ADR 0006) |

Redis errors are classified as infrastructure failures (`RedisLockError`): the consumer rethrows, the Kafka offset is not committed, and the message is redelivered. Redis commands time out after `REDIS_COMMAND_TIMEOUT_MS` (2 s), so a hung Redis fails deliveries instead of stalling the consumer. The lock is released with an atomic compare-and-delete script, never GET-then-DEL.

## Consequences

- With Redis disabled entirely, 100 competing workers still produce one claim and one credit (`tests/concurrency/database-guards-only.test.ts`).
- Every duplicate costs at least one database round trip when the cache misses.
- A Redis outage pauses processing (deliveries fail and are retried) but never corrupts money.
