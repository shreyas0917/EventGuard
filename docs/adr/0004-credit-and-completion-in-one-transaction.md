# 0004: Commit the wallet credit and COMPLETED in one transaction

**Status:** accepted

## Context

Originally the credit committed in one transaction and the event was marked COMPLETED in another. A crash between them left a credited event still PROCESSING, so every recovery path had to tolerate the gap.

## Decision

`completeEvent()` runs one interactive transaction:

1. Fenced `UPDATE events SET status = 'COMPLETED' … WHERE claimToken = $token`. This takes the event's row lock until commit; if it matches nothing, the claim was lost and the function returns without writing.
2. Look for an existing ledger row for the event. If one exists (an earlier attempt already paid), skip the credit.
3. Insert the event logs and resolve any open DLQ row.
4. **Last:** insert the ledger row and `UPDATE wallets SET balance = balance + amount`.

The balance update is deliberately the final statement. It is the only one that waits on a potentially hot row (many events, one wallet), so the lock is held only until COMMIT. With the update earlier in the transaction, a burst of 400 events × 3 deliveries to one wallet exhausted Prisma's 2 s connection wait (`Unable to start a transaction in the given time`); after reordering, the same burst completes. The transaction also gets an explicit budget (`maxWait` 10 s, `timeout` 20 s) instead of Prisma's defaults. The same budget (`TX_OPTIONS` in `lib/prisma.ts`) applies to every interactive transaction: event ingress, payment convergence, credits and failure handling. With the defaults, 53 of 100 concurrent verify/webhook calls on a loaded machine failed this way. With the budget, a burst becomes queueing latency instead of errors.

## Consequences

- A crash leaves the credit and COMPLETED both committed or both absent. There is no "credited but not completed" state.
- Very large bursts against a single wallet (3,000 simultaneous deliveries in one process with a 25-connection pool) still exceed the connection wait for some attempts. Those attempts are recorded as failed attempts and retried with backoff; the ledger and balances stay consistent throughout (measured, see `docs/PERFORMANCE.md`).
