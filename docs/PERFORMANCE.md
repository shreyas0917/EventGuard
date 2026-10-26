# Performance

Measured results, with the conditions they were measured under. Nothing here is a target or an estimate. Rerun them with [`scripts/perf/run-loadtest.sh`](../scripts/perf/run-loadtest.sh).

## Environment

All runs were on one developer laptop, with every component on the same machine:

| | |
|---|---|
| CPU | Intel Core i5-1135G7 (4 cores / 8 threads, 2.4 GHz base) |
| Memory | 19.7 GB |
| OS | Windows 11 (10.0.22621), Docker Desktop 4.82 on WSL2 |
| Stack | PostgreSQL 16, Redis 7, Kafka 3.8 (single KRaft broker, 3 partitions), from `docker-compose.test.yml` |
| Application | Compiled API and consumer (`node dist/…`, Node 24), one process each, on the host |
| Load generator | k6 0.54 in Docker, on the same machine |
| Background load | Other workloads were running (a local LLM server, IDE, Docker VM). Windows reported 90–100% CPU before runs. |

These are **lower-bound, single-node numbers**. Database, broker, application and load generator compete for four cores, so they say little about a tuned deployment. They are useful for relative comparisons (serial vs concurrent consumer) and for checking correctness under load.

## What a run measures

- **HTTP ingest** (k6): `POST /api/events` at a constant arrival rate, each request a unique `PAYMENT_SUCCESS` spread over 50 wallets. 10% of requests are immediately re-sent with the same `eventId` (a client retry) and must get `409`. A separate **storm** sends one `eventId` from 100 virtual users at the same moment; exactly one may create it.
- **End-to-end** (database, after the run): for each event, `processedAt − createdAt`, from the API's commit to the commit of the wallet credit. This includes the outbox poll, Kafka and the consumer. Throughput is completed events over the window from the first creation to the last completion.
- **Money invariants**, read in one consistent snapshot: one ledger row per completed event (never more), every wallet's balance equal to its ledger sum, and the storm event credited exactly once.

## Results

| Run | Load | Consumer | HTTP p50 / p95 / p99 | HTTP errors | Processing throughput | End-to-end p50 / p95 / p99 | Credits | Invariants |
|---|---|---|---|---|---|---|---|---|
| `lt20` | 20 /s for 60 s | concurrent (3 × 10) | 21 / 466 / 598 ms | 0 of 1,473 | 19.9 events/s (keeps up) | **357 / 663 / 1,158 ms** | 1,201 for 1,201 events | hold |
| `lt50b` | 50 /s for 60 s | concurrent (3 × 10) | 169 / 534 / 850 ms | 0 of 3,421 | 43.7 events/s | 9.4 / 11.0 / 11.4 s | 3,002 for 3,002 events | hold |
| `lt100c` | 100 /s for 60 s | concurrent (3 × 10) | 147 / 514 / 756 ms | 0 of 6,766 | **65.7 events/s** | 27.5 / 32.5 / 33.0 s | 6,002 for 6,002 events | hold |
| `lt100serial2` | 100 /s for 60 s | serial (1 × 1) | 122 / 649 / 975 ms | 0 of 6,726 | **12.0 events/s** | 278.6 / 435.6 / 438.1 s | 5,985 for 5,985 events | hold |

In every run:
- every client retry was refused with `409` and **none was accepted** (122, 269, 614 and 591 retries respectively);
- the 100-way storm created **exactly one** event, credited **once**;
- every event was processed by the Kafka consumer, with **0** handled by the recovery sweep and **0** consumer errors;
- no wallet's balance differed from its ledger.

### Reading the numbers

- **Capacity on this machine is roughly 45–65 events/s** of end-to-end processing, varying with background load. Above it, events queue in Kafka, and end-to-end latency at 50/s and 100/s is mostly queueing time: the backlog drains after ingest stops. Well below capacity (`lt20`), a payment goes from API commit to wallet credit in **357 ms at p50 and 663 ms at p95**, with a 1.5 s worst case. That is the outbox poll interval (500 ms) plus Kafka and consumer time.
- **Concurrent consumption made the consumer about 5.5× faster** (12.0 → 65.7 events/s) under identical load. One message at a time spends each event's ~15 sequential Redis/PostgreSQL round trips in series. The concurrent consumer overlaps them across partitions and within each batch, while committing offsets in order ([ADR 0005](adr/0005-at-least-once-consumption-and-recovery.md)).
- **HTTP ingest is not the bottleneck.** 100 requests/s were accepted with zero errors and sub-second p99 latency while processing lagged behind. The transactional outbox decouples the two.

## Hot-wallet stress (in-process)

The `duplicate-delivery` concurrency test delivers N events × 3 copies, all to **one** wallet, simultaneously, inside one process with a 25-connection pool (`STRESS_EVENTS=N npm run test:integration -- duplicate-delivery`):

| Simultaneous deliveries | Result |
|---|---|
| 300 (100 × 3) | All 100 events credited once; balance exact |
| 1,200 (400 × 3), before the statement reordering in [ADR 0004](adr/0004-credit-and-completion-in-one-transaction.md) | Some attempts failed with `Unable to start a transaction in the given time` |
| 1,200 (400 × 3), after it | All credited once; balance exact (2 of 2 runs) |
| 3,000 (1,000 × 3) | 737 credited in the first pass. 263 attempts timed out waiting for a connection and were left `RETRYING` for the retry worker. **Balance = ledger sum (₹921.25 = 737 × 1.25), at most one credit per event.** |

Past the pool's capacity, the system **sheds load into retries, not into wrong balances**.

## Reproducing

```bash
npm run test:infra:up                                          # disposable stack
RATE=100 DURATION=60s bash scripts/perf/run-loadtest.sh        # default, concurrent consumer
RATE=100 DURATION=60s KAFKA_PARTITIONS_CONCURRENCY=1 KAFKA_PROCESSING_CONCURRENCY=1 \
  STALE_RECEIVED_SECONDS=3600 REPORT_WAIT_SECONDS=900 bash scripts/perf/run-loadtest.sh   # serial baseline
```

Each run writes `loadtest/results/<runId>/` with the k6 output (`k6.txt`, `k6-summary.json`), the end-to-end report (`report.md`, `report.json`) and the API and consumer logs. The runner refuses to start k6 unless both the API and the consumer report healthy.

### Runs that were discarded, and why

Recorded so the numbers above can be trusted:

- `lt100` and `lt100b`: the consumer process had crashed at startup ("This server does not host this topic") because it subscribed before the API created the topic. Only the recovery sweep processed events, at about 5.4/s. That exposed a real startup race, now fixed (the consumer creates the topic itself), and the runner now checks consumer health first.
- `lt50`: the runner passed `-e RATE` to k6 without a value, so k6 fell back to its default of 100/s. Fixed by passing explicit values.
- `lt100serial`: the recovery sweep overlapped the measurement (1,095 events) and the report's queries were not taken from one snapshot. Rerun as `lt100serial2` with the sweep pushed out of the window and a single-snapshot report.
