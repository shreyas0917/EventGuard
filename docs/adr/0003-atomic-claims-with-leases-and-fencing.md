# 0003: Claim events with one conditional UPDATE, a lease and a fencing token

**Status:** accepted

## Context

The original claim read the event's status and then updated it. Two workers could both read `RECEIVED` and both "claim": with the Redis lock disabled, 100 concurrent deliveries produced `attemptCount = 100`. Money stayed correct only because of the ledger's UNIQUE constraint. A worker that crashed after claiming also left the event in PROCESSING forever, and a worker that stalled past its lock could still write after another took over.

## Decision

A claim is a single statement:

```sql
UPDATE events
SET status = 'PROCESSING', "attemptCount" = "attemptCount" + 1,
    "claimToken" = $fresh_uuid, "leaseExpiresAt" = now() + lease
WHERE "eventId" = $1 AND (
      status = 'RECEIVED'
   OR (status = 'RETRYING'   AND "nextRetryAt" <= now())
   OR (status = 'PROCESSING' AND "leaseExpiresAt" < now()))   -- abandoned by a crashed worker
```

PostgreSQL re-evaluates the WHERE clause after waiting on the row lock, so exactly one concurrent caller gets `count = 1`.

The claim token is a **fencing token**. Completion, retry scheduling and dead-lettering are all conditional on `status = 'PROCESSING' AND "claimToken" = $token`. A worker whose lease expired and was taken over writes nothing.

DLQ replay claims the FAILED event directly (FAILED → PROCESSING) for one final attempt, so the retry worker or a late Kafka copy cannot run it at the same time.

## Consequences

- One claim per event under any concurrency, with or without Redis (`tests/concurrency/claim-fencing.test.ts`).
- Crashed workers are recovered: the retry worker sweeps PROCESSING events with an expired lease (`EVENT_LEASE_SECONDS`, default 60).
- The lease must comfortably exceed the time one event takes. A worker slower than its lease loses the race safely, because fencing discards its writes.
