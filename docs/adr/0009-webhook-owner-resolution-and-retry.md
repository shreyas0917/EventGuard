# 0009: Resolve the payment owner from the order, and retry failed webhooks

**Status:** accepted

## Context

A review found three money bugs in the Razorpay webhook path:

1. `handlePaymentCaptured` read `userId` from the **payment** entity's notes. Live `payment.captured` payloads carry `notes: []`; the owner is only on the **order** (set in `createPaymentOrder`). With no userId, `ensurePaymentSuccessEvent` fabricated `user_<paymentId>`, created the canonical event for that non-existent user, and the credit then dead-lettered with "Wallet not found". A later `/verify` with the real user found the event already existed and changed nothing, so the money never reached anyone.
2. The handlers marked a webhook FAILED on a processing error but the route still answered 200. Razorpay only resends after a non-2xx, so the "reprocess a FAILED delivery" path could never run — a transient database error lost the payment.
3. A user who never called `POST /api/wallets` had no wallet, so a real payment dead-lettered on "Wallet not found".

## Decision

- **Owner resolution.** When the payment notes have no userId, `handlePaymentCaptured` falls back to `fetchOrderOwner(order_id)`. If no owner can be found anywhere, it does **not** create the event: it marks the webhook FAILED and throws. `ensurePaymentSuccessEvent` now requires a non-null userId and throws otherwise — a fabricated owner is never written. The checkout also passes `notes.userId` on the payment as a second safeguard.
- **Retry.** Both handlers rethrow after marking FAILED, so the route answers 500 and Razorpay resends. Duplicates, IGNORED event types, a `payment.failed` for an already-PAID payment, and bad signatures still return 200/401.
- **On-demand wallet.** `creditWalletInTx` creates the wallet with `INSERT ... ON CONFLICT ("userId") DO NOTHING` inside the credit transaction, so a first payment no longer depends on an explicit wallet creation. The ON CONFLICT form is safe under concurrent first payments (a P2002-throwing create could not be caught mid-transaction, which aborts it).
- **No PAID downgrade.** `createOrUpdatePayment` runs under the same `pg_advisory_xact_lock('pay:'||id)` as `ensurePaymentSuccessEvent`, conditional on `status <> 'PAID'`, so a `payment.failed` racing a capture cannot set PAID back to FAILED.

## Consequences

- The webhook can arrive before `/verify` (the common live ordering) and still credit the right user exactly once.
- A transient failure during webhook processing is retried by Razorpay instead of silently lost; the delivery is idempotent, so the resend credits once.
- Payments no longer require a pre-existing wallet.
- These paths are covered by integration tests in `tests/concurrency/webhook-races.test.ts`, `tests/concurrency/wallet-atomicity.test.ts` and `tests/failure/recovery.test.ts`; see [docs/TESTING.md](../TESTING.md).
