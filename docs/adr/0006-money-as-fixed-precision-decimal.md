# 0006: Keep money as DECIMAL(15,2), guarded by CHECK constraints

**Status:** accepted

## Context

Floating-point amounts are a classic source of ledger drift. The two sound options are integer minor units (paise in a BIGINT) or a fixed-precision decimal type used consistently.

## Decision

Keep `DECIMAL(15,2)` for `wallets.balance`, `wallet_transactions.amount` and `payments.amount`, and make it rigorous:

- **Input:** request validation accepts only positive amounts with at most two decimal places, up to ₹1,000,000 (`validation/schemas.ts`). Sub-paisa precision is rejected, not rounded.
- **Arithmetic:** balances change only through `UPDATE … SET balance = balance + amount` in SQL. PostgreSQL does exact decimal arithmetic, and there is no read-modify-write in JavaScript.
- **Razorpay boundary:** the conversion to paise happens once, at order creation (`Math.round(amount * 100)`), and back once at verification (`paise / 100`).
- **Database invariants** (migration `20261026020000_integrity_constraints`): `amount > 0` on ledger rows and payments, `balance >= 0` on wallets, a closed set of ledger types and statuses, non-negative attempt counters.

## Consequences

- Exactness is guaranteed by PostgreSQL's decimal arithmetic rather than by integer discipline in application code.
- A wallet can never go negative, whatever a future debit path does.
- **Migrating to BIGINT paise was rejected for now.** It rewrites every money column and existing row, for no correctness gain over exact decimals. Revisit it if multiple currencies with different minor units are introduced.
