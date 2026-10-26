# Architecture decision records

Short records of the decisions behind EventGuard's reliability mechanisms: the context, what was decided, and what it costs.

| # | Decision |
|---|---|
| [0001](0001-transactional-outbox.md) | Publish events through a transactional outbox, not directly to Kafka |
| [0002](0002-database-is-the-idempotency-authority.md) | PostgreSQL, not Redis, is the authority on idempotency |
| [0003](0003-atomic-claims-with-leases-and-fencing.md) | Claim events with one conditional UPDATE, a lease and a fencing token |
| [0004](0004-credit-and-completion-in-one-transaction.md) | Commit the wallet credit and COMPLETED in one transaction |
| [0005](0005-at-least-once-consumption-and-recovery.md) | Consume at-least-once from the earliest offset, and sweep what delivery misses |
| [0006](0006-money-as-fixed-precision-decimal.md) | Keep money as DECIMAL(15,2), guarded by CHECK constraints |
| [0007](0007-jwt-roles-and-demo-login.md) | JWT bearer tokens with two roles; demo login stands in for an identity provider |
| [0008](0008-reconciliation-reports-never-corrects.md) | Reconciliation reports discrepancies and never corrects money |
