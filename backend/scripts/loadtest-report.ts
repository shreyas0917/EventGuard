/**
 * End-to-end results of one load-test run, read from the database.
 *
 * k6 measures the HTTP side; this measures what a user actually waits for: the time
 * from the API committing an event to the wallet credit committing (outbox, Kafka and
 * consumer included), sustained processing throughput, and whether every money
 * invariant held. Only events of the given run (eventId prefix lt_<runId>_) count.
 *
 *   npx tsx scripts/loadtest-report.ts <runId> [--wait-seconds 180] [--out report.json]
 */
import os from "os";
import { writeFileSync } from "fs";
import { Prisma, PrismaClient } from "@prisma/client";

const runId = process.argv[2];
if (!runId) {
  console.error("usage: tsx scripts/loadtest-report.ts <runId> [--wait-seconds N] [--out file.json]");
  process.exit(2);
}
const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const waitSeconds = Number(arg("--wait-seconds", "180"));
const outFile = arg("--out", "");

const prisma = new PrismaClient();
const prefix = `lt_${runId}_%`;
const walletPrefix = `lt_${runId}_user_%`;

async function statusCounts(): Promise<Record<string, number>> {
  const rows = await prisma.$queryRaw<Array<{ status: string; n: number }>>`
    SELECT status::text, COUNT(*)::int AS n FROM events WHERE "eventId" LIKE ${prefix} GROUP BY status`;
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

async function main() {
  // Wait for the pipeline to drain: every event of the run in a terminal state
  const deadline = Date.now() + waitSeconds * 1000;
  let counts = await statusCounts();
  while (Date.now() < deadline && (counts.RECEIVED || counts.PROCESSING || counts.RETRYING)) {
    await new Promise((r) => setTimeout(r, 1000));
    counts = await statusCounts();
  }

  // Every figure below comes from ONE snapshot. Separate statements against a pipeline that
  // is still processing can disagree (an event completing between two queries) and raise
  // a false invariant violation, or hide a real one.
  const snapshot = await prisma.$transaction(
    async (tx) => {
      const snapshotCounts = Object.fromEntries(
        (
          await tx.$queryRaw<Array<{ status: string; n: number }>>`
            SELECT status::text, COUNT(*)::int AS n FROM events WHERE "eventId" LIKE ${prefix} GROUP BY status`
        ).map((r) => [r.status, r.n])
      ) as Record<string, number>;
    const [latency] = await tx.$queryRaw<
      Array<{ p50: number; p95: number; p99: number; max: number; avg: number; n: number }>
    >`
      SELECT
        percentile_cont(0.50) WITHIN GROUP (ORDER BY ms) AS p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY ms) AS p95,
        percentile_cont(0.99) WITHIN GROUP (ORDER BY ms) AS p99,
        MAX(ms) AS max, AVG(ms) AS avg, COUNT(*)::int AS n
      FROM (
        SELECT EXTRACT(EPOCH FROM ("processedAt" - "createdAt")) * 1000 AS ms
        FROM events WHERE "eventId" LIKE ${prefix} AND status = 'COMPLETED'
      ) t`;

    const [window] = await tx.$queryRaw<
      Array<{ ingestSeconds: number; drainSeconds: number; firstCreated: Date; lastProcessed: Date }>
    >`
      SELECT
        EXTRACT(EPOCH FROM (MAX("createdAt") - MIN("createdAt")))::float AS "ingestSeconds",
        EXTRACT(EPOCH FROM (MAX("processedAt") - MIN("createdAt")))::float AS "drainSeconds",
        MIN("createdAt") AS "firstCreated", MAX("processedAt") AS "lastProcessed"
      FROM events WHERE "eventId" LIKE ${prefix}`;

    const [ledger] = await tx.$queryRaw<
      Array<{ ledgerRows: number; eventsWithLedger: number; maxCreditsPerEvent: number; duplicatesAbsorbed: number }>
    >`
      SELECT
        (SELECT COUNT(*)::int FROM wallet_transactions WHERE "eventId" LIKE ${prefix}) AS "ledgerRows",
        (SELECT COUNT(DISTINCT "eventId")::int FROM wallet_transactions WHERE "eventId" LIKE ${prefix}) AS "eventsWithLedger",
        (SELECT COALESCE(MAX(c), 0)::int FROM (SELECT COUNT(*) c FROM wallet_transactions WHERE "eventId" LIKE ${prefix} GROUP BY "eventId") x) AS "maxCreditsPerEvent",
        (SELECT COUNT(*)::int FROM event_logs WHERE "eventId" LIKE ${prefix} AND status = 'DUPLICATE') AS "duplicatesAbsorbed"`;

    const [wallets] = await tx.$queryRaw<Array<{ wallets: number; mismatched: number; balanceTotal: string; ledgerTotal: string }>>`
      SELECT COUNT(*)::int AS wallets,
             COUNT(*) FILTER (WHERE w.balance <> COALESCE(l.total, 0))::int AS mismatched,
             COALESCE(SUM(w.balance), 0)::text AS "balanceTotal",
             COALESCE(SUM(l.total), 0)::text AS "ledgerTotal"
      FROM wallets w
      LEFT JOIN (SELECT "walletId", SUM(amount) total FROM wallet_transactions GROUP BY "walletId") l ON l."walletId" = w.id
      WHERE w."userId" LIKE ${walletPrefix}`;

    const storm = await tx.$queryRaw<Array<{ events: number; credits: number }>>`
      SELECT (SELECT COUNT(*)::int FROM events WHERE "eventId" = ${`lt_${runId}_storm`}) AS events,
             (SELECT COUNT(*)::int FROM wallet_transactions WHERE "eventId" = ${`lt_${runId}_storm`}) AS credits`;
      return { snapshotCounts, latency, window, ledger, wallets, storm };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 120_000, maxWait: 30_000 }
  );
  const { latency, window, ledger, wallets, storm } = snapshot;
  counts = snapshot.snapshotCounts;

  const completed = counts.COMPLETED ?? 0;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const invariantsHold =
    ledger.maxCreditsPerEvent <= 1 &&
    ledger.eventsWithLedger === completed &&
    wallets.mismatched === 0 &&
    storm[0]?.events === 1 &&
    storm[0]?.credits === 1;

  const report = {
    runId,
    measuredAt: new Date().toISOString(),
    events: { total, byStatus: counts },
    endToEndLatencyMs: {
      p50: round(latency.p50), p95: round(latency.p95), p99: round(latency.p99),
      max: round(latency.max), avg: round(latency.avg), samples: latency.n,
    },
    throughput: {
      ingestWindowSeconds: round(window.ingestSeconds),
      drainWindowSeconds: round(window.drainSeconds),
      completedPerSecond: round(completed / Math.max(window.drainSeconds, 1e-9)),
    },
    money: {
      ledgerRows: ledger.ledgerRows,
      eventsWithLedgerRow: ledger.eventsWithLedger,
      maxCreditsPerEvent: ledger.maxCreditsPerEvent,
      walletsChecked: wallets.wallets,
      walletsWithBalanceMismatch: wallets.mismatched,
      walletBalanceTotal: wallets.balanceTotal,
      ledgerTotal: wallets.ledgerTotal,
      duplicateDeliveriesAbsorbed: ledger.duplicatesAbsorbed,
      stormEvent: storm[0],
      invariantsHold,
    },
    environment: {
      cpu: os.cpus()[0]?.model,
      logicalCores: os.cpus().length,
      memoryGb: round(os.totalmem() / 1024 ** 3),
      os: `${os.type()} ${os.release()}`,
      node: process.version,
      note: process.env.LOADTEST_ENV_NOTE ?? "",
    },
  };

  console.log(`# Load test ${runId}\n`);
  console.log(`| Metric | Value |\n|---|---|`);
  console.log(`| Events | ${total} (${Object.entries(counts).map(([s, n]) => `${s} ${n}`).join(", ")}) |`);
  console.log(`| End-to-end latency p50 / p95 / p99 | ${report.endToEndLatencyMs.p50} / ${report.endToEndLatencyMs.p95} / ${report.endToEndLatencyMs.p99} ms |`);
  console.log(`| End-to-end latency max | ${report.endToEndLatencyMs.max} ms |`);
  console.log(`| Processing throughput | ${report.throughput.completedPerSecond} events/s over ${report.throughput.drainWindowSeconds} s |`);
  console.log(`| Ledger rows / events with a credit | ${ledger.ledgerRows} / ${ledger.eventsWithLedger} (max ${ledger.maxCreditsPerEvent} per event) |`);
  console.log(`| Wallets with balance ≠ ledger | ${wallets.mismatched} of ${wallets.wallets} |`);
  console.log(`| Duplicate deliveries absorbed | ${ledger.duplicatesAbsorbed} |`);
  console.log(`| Storm event: rows / credits | ${storm[0]?.events} / ${storm[0]?.credits} |`);
  console.log(`| **Money invariants hold** | **${invariantsHold ? "yes" : "NO"}** |`);
  console.log(`\nEnvironment: ${report.environment.cpu}, ${report.environment.logicalCores} logical cores, ${report.environment.memoryGb} GB RAM, ${report.environment.os}, Node ${report.environment.node}. ${report.environment.note}`);

  if (outFile) writeFileSync(outFile, JSON.stringify(report, null, 2));
  await prisma.$disconnect();
  process.exit(invariantsHold ? 0 : 1);
}

function round(n: number | null | undefined) {
  return n == null ? null : Math.round(Number(n) * 100) / 100;
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
