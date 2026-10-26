import { prisma } from "../lib/prisma.js";

/**
 * Independent cross-checks of the money invariants. Strictly read-only: a discrepancy
 * in a ledger needs a human decision, so this reports and never corrects.
 */

export interface WalletMismatch {
  userId: string;
  balance: string;
  ledgerSum: string;
}

export interface ReconciliationReport {
  checkedAt: string;
  ok: boolean;
  walletsChecked: number;
  /** Wallets whose stored balance differs from SUM(credits) - SUM(debits) */
  walletBalanceMismatches: WalletMismatch[];
  /** COMPLETED PAYMENT_SUCCESS events that do not have exactly one ledger row */
  completedPaymentsWithoutSingleCredit: Array<{ eventId: string; credits: number }>;
  /** Ledger rows whose event is missing or not COMPLETED */
  ledgerEntriesWithoutCompletedEvent: Array<{ eventId: string; eventStatus: string | null }>;
  /** Events created without an outbox row: they can never be published */
  eventsWithoutOutbox: Array<{ eventId: string; status: string }>;
}

const SAMPLE_LIMIT = 100;

export async function runReconciliation(): Promise<ReconciliationReport> {
  const [walletCount, walletBalanceMismatches, completedPaymentsWithoutSingleCredit, ledgerEntriesWithoutCompletedEvent, eventsWithoutOutbox] =
    await Promise.all([
      prisma.wallet.count(),
      prisma.$queryRaw<WalletMismatch[]>`
        SELECT w."userId", w.balance::text AS balance, COALESCE(l.total, 0)::text AS "ledgerSum"
        FROM wallets w
        LEFT JOIN (
          SELECT "walletId", SUM(CASE WHEN type = 'CREDIT' THEN amount ELSE -amount END) AS total
          FROM wallet_transactions GROUP BY "walletId"
        ) l ON l."walletId" = w.id
        WHERE w.balance <> COALESCE(l.total, 0)
        ORDER BY w."userId"
        LIMIT ${SAMPLE_LIMIT}`,
      prisma.$queryRaw<Array<{ eventId: string; credits: number }>>`
        SELECT e."eventId", COUNT(t.id)::int AS credits
        FROM events e
        LEFT JOIN wallet_transactions t ON t."eventId" = e."eventId"
        WHERE e.status = 'COMPLETED' AND e."eventType" = 'PAYMENT_SUCCESS'
        GROUP BY e."eventId"
        HAVING COUNT(t.id) <> 1
        LIMIT ${SAMPLE_LIMIT}`,
      prisma.$queryRaw<Array<{ eventId: string; eventStatus: string | null }>>`
        SELECT t."eventId", e.status::text AS "eventStatus"
        FROM wallet_transactions t
        LEFT JOIN events e ON e."eventId" = t."eventId"
        WHERE e."eventId" IS NULL OR e.status <> 'COMPLETED'
        ORDER BY t."createdAt"
        LIMIT ${SAMPLE_LIMIT}`,
      prisma.$queryRaw<Array<{ eventId: string; status: string }>>`
        SELECT e."eventId", e.status::text AS status
        FROM events e
        LEFT JOIN outbox_events o ON o."eventId" = e."eventId"
        WHERE o.id IS NULL
        ORDER BY e."createdAt"
        LIMIT ${SAMPLE_LIMIT}`,
    ]);

  return {
    checkedAt: new Date().toISOString(),
    ok:
      walletBalanceMismatches.length === 0 &&
      completedPaymentsWithoutSingleCredit.length === 0 &&
      ledgerEntriesWithoutCompletedEvent.length === 0 &&
      eventsWithoutOutbox.length === 0,
    walletsChecked: walletCount,
    walletBalanceMismatches,
    completedPaymentsWithoutSingleCredit,
    ledgerEntriesWithoutCompletedEvent,
    eventsWithoutOutbox,
  };
}
