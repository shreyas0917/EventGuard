import { prisma } from "../../src/lib/prisma.js";
import { getRedis } from "../../src/lib/redis.js";

const TABLES = [
  "event_logs",
  "events",
  "outbox_events",
  "wallet_transactions",
  "wallets",
  "payments",
  "webhook_events",
  "dead_letter_events",
];

/** Empty every table and the test Redis DB so each test starts from a known state. */
export async function resetState(): Promise<void> {
  await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  try {
    await getRedis().flushdb();
  } catch {
    // Redis not connected in this suite
  }
}

export interface LedgerViolation {
  userId: string;
  balance: string;
  ledgerSum: string;
}

/** Wallets whose balance differs from the sum of their ledger entries. Must always be empty. */
export async function ledgerViolations(): Promise<LedgerViolation[]> {
  return prisma.$queryRawUnsafe<LedgerViolation[]>(`
    SELECT w."userId", w.balance::text AS balance,
           COALESCE(SUM(CASE WHEN t.type = 'CREDIT' THEN t.amount ELSE -t.amount END), 0)::text AS "ledgerSum"
    FROM wallets w
    LEFT JOIN wallet_transactions t ON t."walletId" = w.id
    GROUP BY w.id
    HAVING w.balance <> COALESCE(SUM(CASE WHEN t.type = 'CREDIT' THEN t.amount ELSE -t.amount END), 0)
  `);
}

/** Completed PAYMENT_SUCCESS events without exactly one ledger entry. Must always be empty. */
export async function completedEventsWithoutExactlyOneCredit(): Promise<Array<{ eventId: string; credits: number }>> {
  return prisma.$queryRawUnsafe(`
    SELECT e."eventId", COUNT(t.id)::int AS credits
    FROM events e
    LEFT JOIN wallet_transactions t ON t."eventId" = e."eventId"
    WHERE e.status = 'COMPLETED' AND e."eventType" = 'PAYMENT_SUCCESS'
    GROUP BY e."eventId"
    HAVING COUNT(t.id) <> 1
  `);
}

export async function seedWallet(userId: string, balance = 0) {
  return prisma.wallet.create({ data: { userId, balance } });
}

/** Insert an event + outbox row exactly as the API does, without going through HTTP. */
export async function seedPaymentEvent(eventId: string, userId: string, amount: number) {
  const payload = { userId, paymentId: `pay_${eventId}`, orderId: `order_${eventId}`, amount };
  await prisma.$transaction([
    prisma.event.create({ data: { eventId, eventType: "PAYMENT_SUCCESS", payload, status: "RECEIVED" } }),
    prisma.outboxEvent.create({ data: { eventId, eventType: "PAYMENT_SUCCESS", payload, status: "PENDING" } }),
  ]);
  return { eventId, eventType: "PAYMENT_SUCCESS", payload };
}

export async function walletBalance(userId: string): Promise<string> {
  const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
  return wallet.balance.toFixed(2);
}

/** Run `n` copies of `task` at the same instant and collect every outcome. */
export async function concurrently<T>(n: number, task: (i: number) => Promise<T>) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const runs = Array.from({ length: n }, (_, i) => gate.then(() => task(i)));
  release();
  return Promise.allSettled(runs);
}
