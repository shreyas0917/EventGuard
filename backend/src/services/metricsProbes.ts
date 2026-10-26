import type { Admin } from "kafkajs";
import { prisma } from "../lib/prisma.js";
import { getKafka } from "../lib/kafka.js";
import { logger } from "../lib/logger.js";
import { config } from "../config/index.js";
import type { StateProbes } from "../lib/metrics.js";
import { getLastReconciliationReport } from "../workers/reconciliationWorker.js";

let admin: Admin | null = null;

async function kafkaAdmin(): Promise<Admin> {
  if (!admin) {
    const created = getKafka().admin();
    await created.connect();
    admin = created;
  }
  return admin;
}

/** Scrape-time readings of state that lives in PostgreSQL and Kafka. */
export const stateProbes: StateProbes = {
  async outbox() {
    const [row] = await prisma.$queryRaw<Array<{ pending: number; age: number | null }>>`
      SELECT COUNT(*)::int AS pending,
             EXTRACT(EPOCH FROM (NOW() - MIN("createdAt")))::float AS age
      FROM "outbox_events" WHERE "status" = 'PENDING'`;
    return { pending: row?.pending ?? 0, oldestPendingAgeSeconds: row?.age ?? 0 };
  },

  async deadLetterOpen() {
    return prisma.deadLetterEvent.count({ where: { status: { not: "RESOLVED" } } });
  },

  async eventsByStatus() {
    const groups = await prisma.event.groupBy({ by: ["status"], _count: { _all: true } });
    return Object.fromEntries(groups.map((g) => [g.status, g._count._all]));
  },

  async consumerLag() {
    try {
      const kafka = await kafkaAdmin();
      const [latest, committed] = await Promise.all([
        kafka.fetchTopicOffsets(config.kafka_topic),
        kafka.fetchOffsets({ groupId: config.kafka_consumer_group, topics: [config.kafka_topic] }),
      ]);
      const committedByPartition = new Map(
        (committed[0]?.partitions ?? []).map((p) => [p.partition, Number(p.offset)])
      );
      return latest.reduce((lag, p) => {
        const end = Number(p.high);
        const done = committedByPartition.get(p.partition) ?? -1;
        // -1 = nothing committed yet: everything from the start of the log is pending
        return lag + Math.max(0, end - (done >= 0 ? done : Number(p.low)));
      }, 0);
    } catch (error) {
      logger.warn("[Metrics] Could not read consumer lag", { error: error instanceof Error ? error.message : error });
      admin = null;
      return null;
    }
  },

  reconciliationDiscrepancies() {
    const report = getLastReconciliationReport();
    if (!report) return null;
    return {
      wallet_balance_mismatch: report.walletBalanceMismatches.length,
      completed_payment_without_single_credit: report.completedPaymentsWithoutSingleCredit.length,
      ledger_entry_without_completed_event: report.ledgerEntriesWithoutCompletedEvent.length,
      event_without_outbox: report.eventsWithoutOutbox.length,
    };
  },
};
