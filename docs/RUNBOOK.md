# Runbook

How to diagnose EventGuard incidents with the signals it emits. Each section matches an alert in [`observability/alerts.yml`](../observability/alerts.yml).

## Where to look

| Signal | How |
|---|---|
| Dashboard | `docker compose --profile observability up -d`, then http://localhost:3000 ("EventGuard: pipeline overview") |
| Metrics | `GET /metrics` on the API (`:3001`) and on the consumer (`:9464` inside the Compose network) |
| Logs | One JSON object per line. HTTP lines carry `requestId`; pipeline lines carry `eventId` (and `partition` and `offset` for Kafka deliveries, or `trigger: "retry-worker"` for sweeps). |
| Event history | `GET /api/events/:eventId/history` (admin) lists every transition and duplicate, with the guard that stopped it |
| Ledger consistency | `GET /api/admin/reconciliation` (admin, read-only) |

To follow one payment end to end, filter logs by the HTTP `requestId` to find the `eventId` it created. Then filter by that `eventId` across the API and consumer processes.

```bash
docker compose logs backend | grep '"eventId":"evt_pay_XXXX"'
```

## DeadLetterQueueNotEmpty

An event failed `maxAttempts` (3) times and is parked.

1. `GET /api/dlq` and `GET /api/dlq/:eventId`: the `reason` holds the last error. The event history shows each `FAILED_ATTEMPT`.
2. Typical causes: the wallet does not exist yet ("Wallet not found"), or an invalid payload.
3. Fix the cause, then `POST /api/dlq/:eventId/replay`. A replay is one immediate, fenced attempt: success completes the event and resolves the DLQ row; failure returns it to PENDING with the new reason.
4. If the event must not be applied at all, use `POST /api/dlq/:eventId/resolve` with a reason (no money moves).

## OutboxStalled

The oldest PENDING outbox row is more than a minute old, so events are recorded but not reaching Kafka.

1. `eventguard_outbox_publish_failures_total` rising: Kafka is unreachable. Rows stay PENDING with exponential backoff (up to 60 s) and publish on their own when Kafka returns. Check broker health.
2. No failures but a growing backlog: the outbox worker is not running (API process down?). Check `/health/ready` and the API logs.
3. Payments are not lost meanwhile: after `STALE_RECEIVED_SECONDS` the API's recovery sweep processes RECEIVED events directly from the database.

## ConsumerLagGrowing

The consumer group is falling behind the topic.

1. Is the consumer alive? `GET :9464/health` inside the network, and `docker compose logs backend | grep eventguard-consumer`.
2. Is each event slow? Check `eventguard_event_processing_duration_seconds` p95. A slow PostgreSQL (lock waits on a hot wallet) or Redis shows up here.
3. Many `eventguard_redis_lock_errors_total`: see below. Deliveries are being retried, not processed.

## RedisLockErrors

The consumer cannot reach Redis, or Redis is not answering within `REDIS_COMMAND_TIMEOUT_MS`.

- Effect: deliveries fail with `RedisLockError` and their offsets are not committed, so Kafka redelivers them. **No money moves and nothing is lost.**
- When Redis recovers, processing resumes without a restart. A lock left behind by a timed-out command expires after `REDIS_LOCK_TTL_SECONDS`, and the recovery sweep picks up any event a delivery skipped because of it.

## ReconciliationDiscrepancy

Balances, ledger, events or outbox disagree. **Do not "fix" balances automatically.**

1. `GET /api/admin/reconciliation` lists each finding by type:
   - `walletBalanceMismatches`: balance ≠ ledger sum. Usually a direct SQL write that bypassed the application.
   - `ledgerEntriesWithoutCompletedEvent`: a ledger row with no completed event. Same cause, or a restore of one table without the others.
   - `completedPaymentsWithoutSingleCredit`: should be impossible (UNIQUE ledger + single-transaction completion). Treat it as a bug and preserve the evidence.
   - `eventsWithoutOutbox`: an event inserted outside `createEvent()`. It will be picked up by the stale-RECEIVED sweep.
2. Correct the data with a reviewed, audited change. The job only reports.

## ApiErrorRate

More than 1% of requests return 5xx.

1. Dashboard panel "HTTP responses by status" shows which routes are failing.
2. Pick a failing request's `X-Request-ID` (returned on every response) and filter the logs by `requestId`. The error line carries the stack.
3. `GET /health/ready` shows whether PostgreSQL, Redis or Kafka is the dependency at fault.
