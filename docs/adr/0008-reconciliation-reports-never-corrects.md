# 0008: Reconciliation reports discrepancies and never corrects money

**Status:** accepted

## Context

Invariants enforced in code and constraints can still be bypassed: an operator's ad-hoc SQL, a script writing straight to the ledger, a restore from backup. The development database contained exactly this: test scripts had inserted ledger rows without updating balances or completing events.

## Decision

A read-only reconciliation (`services/reconciliationService.ts`) cross-checks:

- wallet balance = SUM(credits) − SUM(debits) for every wallet;
- each COMPLETED `PAYMENT_SUCCESS` event has exactly one ledger row;
- each ledger row belongs to a COMPLETED event;
- each event has an outbox row.

It runs every `RECONCILIATION_INTERVAL_MS` (5 min) in the API process. It logs findings, exports them as `eventguard_reconciliation_discrepancies{check}`, and is available on demand at `GET /api/admin/reconciliation`. **It never writes.**

## Consequences

- Correcting money is a human decision with an audit trail, not an automatic side effect.
- An alert (`ReconciliationDiscrepancy`) fires on any finding, so drift is noticed within one interval.
