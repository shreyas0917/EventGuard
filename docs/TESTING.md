# Testing

EventGuard's claims (one credit per payment, recovery from crashes and outages) are backed by automated tests that run locally and in CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)).

## Suites

| Suite | Command (in `backend/`) | Needs | What it proves |
|---|---|---|---|
| Security | `npm run test:security` | nothing (Prisma and Razorpay replaced by in-memory doubles) | Every route's access rule, token attacks, ownership, input validation, production config guards |
| Concurrency | `npm run test:integration` | the disposable test stack | Duplicate and concurrent deliveries never credit twice; claims are atomic and fenced |
| Failure injection | `npm run test:integration` | the disposable test stack | Recovery from consumer crashes, Redis/PostgreSQL/Kafka outages, outbox publisher crashes, retry exhaustion, rollbacks |
| End-to-end smoke | `bash scripts/smoke-auth.sh` (repo root) | the full dev stack (`docker compose up`) | Auth, ownership and one-credit pipeline against the real running system |
| Load | `bash scripts/perf/run-loadtest.sh` (repo root) | the disposable test stack, Docker for k6 | Throughput, latency percentiles, duplicate storm (see [PERFORMANCE.md](PERFORMANCE.md)) |

## The disposable test stack

Integration, failure and load tests never touch the development database. They use [`docker-compose.test.yml`](../docker-compose.test.yml): a separate Compose project (`eventguard-test`) with its own ports (PostgreSQL 55432, Redis 56379, Kafka 59092) and no named volumes. PostgreSQL keeps its data in tmpfs.

```bash
npm run test:infra:up            # repo root; waits until all three are healthy
cd backend && npm run test:integration
npm run test:infra:down          # repo root
```

Two guards keep it that way:
- The suites refuse to run unless the database name ends in `_test`, because they TRUNCATE tables and FLUSH Redis.
- The helpers that pause and stop containers ([`tests/helpers/infra.ts`](../backend/tests/helpers/infra.ts)) are hard-wired to the `eventguard-test` project.

## Concurrency tests (`tests/concurrency/`)

| Test | Scenario | Asserted invariant |
|---|---|---|
| `duplicate-delivery` | 100 simultaneous deliveries of one payment through the full pipeline | 1 ledger row, balance = amount, `attemptCount` = 1, 99 DUPLICATE log entries |
| `duplicate-delivery` | 100 events × 3 simultaneous deliveries, one wallet | 100 credits, balance = sum, no lost updates |
| `database-guards-only` | Same, with the Redis lock and cache **switched off** | Exactly one claim (`attemptCount` = 1) and one credit from PostgreSQL alone |
| `wallet-atomicity` | 200 concurrent credits of different amounts; 50 credits with one eventId; a credit to a missing wallet | Balance equals the exact sum; UNIQUE rejects 49; failed credit leaves nothing behind |
| `payment-and-ingress` | 100 concurrent verify/webhook calls for one payment; 100 concurrent `POST /api/events` with one id; 8 concurrent DLQ replays | 1 payment, 1 event, 1 outbox row; one 201 and 99 409s; one replay runs, 7 get 409 |
| `webhook-races` | 100 identical signed webhook deliveries over HTTP; verify and webhooks racing; out-of-order captured/failed | All acknowledged with 200; 1 payment, 1 event, 1 credit; a late `payment.failed` never undoes a payment |
| `kafka-competing-consumers` | 100 copies of one message consumed by two independent consumer groups (200 deliveries) | 1 credit, `attemptCount` = 1 |
| `claim-fencing` | Lease expiry, takeover, stale worker writes, backoff gating, exhaustion | A stale worker writes nothing; FAILED and its DLQ row commit together |

Every test that moves money also checks two global invariants: no wallet whose balance differs from its ledger sum, and no completed payment without exactly one ledger row.

## Failure-injection tests (`tests/failure/`)

| Test | Fault injected | Expected recovery |
|---|---|---|
| `consumer-crash` | The consumer **process** is killed (exit 137) right after the credit commits, before the Kafka offset commit | The restarted process gets the redelivery and records a duplicate; still 1 credit |
| `consumer-crash` | The process is killed after claiming, before committing | Nothing paid; the lease expires; the recovery sweep completes it; the later redelivery is a duplicate |
| `consumer-crash` | The consumer process starts before its Kafka topic exists | It creates the topic and becomes healthy instead of crashing (a startup race found by the load test) |
| `infrastructure-outages` | Redis **stopped** | Delivery fails with `RedisLockError` (offset kept); succeeds after restart |
| `infrastructure-outages` | Redis **paused** (hung) | Commands time out within seconds instead of stalling; recovery after unpause, including a lock left behind by a timed-out command |
| `infrastructure-outages` | PostgreSQL **paused** | Query fails after `socket_timeout`; no money moves; redelivery or sweep completes it |
| `infrastructure-outages` | Kafka **stopped** | Outbox keeps the row PENDING with backoff; publishes after restart; consumed and credited once |
| `recovery` | Processing fails 3 times | Event FAILED and dead-lettered atomically; FAILED is terminal; a replay after the fix credits once; a failed replay returns to the DLQ |
| `recovery` | Credit fails inside the completion transaction | Full rollback: no ledger row, no COMPLETED; the retry pays once |
| `recovery` | A redelivery meets a lock left by a crashed worker | Contention commits the offset; the stale-RECEIVED sweep runs the event |
| `recovery` | Outbox publisher dies after publishing, before marking | Row reclaimed after the lease, re-published, duplicate absorbed; concurrent publishers claim disjoint rows |
| `recovery` | Webhook stored just before an API crash | Razorpay's redelivery is processed, not dismissed as a duplicate |
| `recovery` | Ledger row inserted directly with SQL; impossible values | Reconciliation reports it; CHECK constraints reject negative amounts, unknown types and negative balances |

## Writing a new failure test

Use `tests/helpers/infra.ts` (`stopService`, `startService`, `pauseService`, `unpauseService`, `spawnConsumer`), and restore the stack in `finally` or `afterEach`.

A timeout is an ambiguous outcome: the command may still run when the dependency wakes up. Assert the end state after redelivery and recovery, not an intermediate one.
