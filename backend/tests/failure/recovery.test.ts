import crypto from "crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { bearer, tokenFor } from "../helpers/tokens.js";

const WEBHOOK_SECRET = "whsec_vitest_recovery_0123456789";
Object.assign(process.env, {
  RAZORPAY_KEY_ID: "rzp_test_vitest",
  RAZORPAY_KEY_SECRET: "rzp_key_secret_vitest",
  RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
});

const { connectRedis, closeRedis, getRedis } = await import("../../src/lib/redis.js");
const { prisma } = await import("../../src/lib/prisma.js");
const { config } = await import("../../src/config/index.js");
const { createApp } = await import("../../src/app.js");
const { processEvent } = await import("../../src/kafka/eventWorker.js");
const { runRetryCycle } = await import("../../src/workers/retryWorker.js");
const { claimPendingOutboxBatch } = await import("../../src/services/outboxPublisher.js");
const { runReconciliation } = await import("../../src/services/reconciliationService.js");
const db = await import("../helpers/db.js");
const { sleep } = await import("../helpers/infra.js");

const app = createApp();
const admin = bearer(tokenFor("ops_admin", "admin"));
const originalRetry = { base: config.retry_base_delay_ms, max: config.max_retry_delay_ms };
const originalOutboxLease = config.outbox_lease_seconds;

beforeAll(async () => {
  expect(await connectRedis()).toBe(true);
});
afterAll(async () => {
  await closeRedis();
  await prisma.$disconnect();
});
beforeEach(() => db.resetState());
afterEach(() => {
  config.fail_processing_for_event_id = "";
  config.retry_base_delay_ms = originalRetry.base;
  config.max_retry_delay_ms = originalRetry.max;
  config.outbox_lease_seconds = originalOutboxLease;
});

describe("retry exhaustion and dead-letter replay", () => {
  it("three failed attempts dead-letter the event; a replay after the fix credits exactly once", async () => {
    config.retry_base_delay_ms = 100;
    config.max_retry_delay_ms = 400;
    config.fail_processing_for_event_id = "evt_exhaust";
    await db.seedWallet("user_exhaust");
    const message = await db.seedPaymentEvent("evt_exhaust", "user_exhaust", 70);

    await processEvent(message); // attempt 1
    for (let attempt = 2; attempt <= 3; attempt++) {
      await sleep(450); // past the backoff
      expect(await runRetryCycle()).toBe(1);
    }

    const failed = await prisma.event.findUniqueOrThrow({ where: { eventId: "evt_exhaust" } });
    expect(failed).toMatchObject({ status: "FAILED", attemptCount: 3 });
    expect(await prisma.deadLetterEvent.findUniqueOrThrow({ where: { eventId: "evt_exhaust" } })).toMatchObject({
      status: "PENDING",
      attemptCount: 3,
    });
    expect(await prisma.eventLog.count({ where: { eventId: "evt_exhaust", status: "FAILED_ATTEMPT" } })).toBe(3);
    expect(await prisma.walletTransaction.count()).toBe(0);

    // FAILED is terminal for the retry worker and for Kafka redeliveries
    expect(await runRetryCycle()).toBe(0);
    await processEvent(message);
    expect(await prisma.walletTransaction.count()).toBe(0);

    // The cause is fixed; an operator replays it
    config.fail_processing_for_event_id = "";
    const replay = await request(app).post("/api/dlq/evt_exhaust/replay").set(admin);
    expect(replay.status).toBe(200);

    expect((await prisma.event.findUniqueOrThrow({ where: { eventId: "evt_exhaust" } })).status).toBe("COMPLETED");
    expect((await prisma.deadLetterEvent.findUniqueOrThrow({ where: { eventId: "evt_exhaust" } })).status).toBe(
      "RESOLVED"
    );
    expect(await db.walletBalance("user_exhaust")).toBe("70.00");
    expect(await db.ledgerViolations()).toEqual([]);
  });

  it("a replay that fails again goes straight back to the DLQ with the new reason", async () => {
    config.fail_processing_for_event_id = "evt_replay_fails";
    const message = await db.seedPaymentEvent("evt_replay_fails", "user_none", 5);
    await prisma.event.update({ where: { eventId: message.eventId }, data: { status: "FAILED", attemptCount: 3 } });
    await prisma.deadLetterEvent.create({
      data: { ...message, reason: "original failure", attemptCount: 3, failedAt: new Date() },
    });

    const replay = await request(app).post("/api/dlq/evt_replay_fails/replay").set(admin);
    expect(replay.status).toBe(500);

    expect((await prisma.event.findUniqueOrThrow({ where: { eventId: message.eventId } })).status).toBe("FAILED");
    const dlq = await prisma.deadLetterEvent.findUniqueOrThrow({ where: { eventId: message.eventId } });
    expect(dlq.status).toBe("PENDING");
    expect(dlq.reason).toMatch(/Intentional failure/);
  });
});

describe("transaction rollback", () => {
  it("a failure inside the credit transaction leaves no ledger row and no COMPLETED status; the retry pays once", async () => {
    config.retry_base_delay_ms = 100;
    const message = await db.seedPaymentEvent("evt_rollback", "user_late_wallet", 25);

    // No wallet yet: the fenced UPDATE to COMPLETED runs first, then the credit throws
    await processEvent(message);

    const event = await prisma.event.findUniqueOrThrow({ where: { eventId: "evt_rollback" } });
    expect(event.status).toBe("RETRYING");
    expect(event.lastError).toMatch(/Wallet not found/);
    expect(await prisma.walletTransaction.count()).toBe(0);
    expect(await prisma.eventLog.count({ where: { eventId: "evt_rollback", status: "COMPLETED" } })).toBe(0);

    await db.seedWallet("user_late_wallet");
    await sleep(200);
    expect(await runRetryCycle()).toBe(1);

    expect((await prisma.event.findUniqueOrThrow({ where: { eventId: "evt_rollback" } })).status).toBe("COMPLETED");
    expect(await db.walletBalance("user_late_wallet")).toBe("25.00");
    expect(await db.ledgerViolations()).toEqual([]);
  });
});

describe("deliveries that meet a lock left by a crashed worker", () => {
  it("the delivery backs off as contention, and the recovery sweep runs the never-claimed event", async () => {
    config.redis_lock_ttl_seconds = 1;
    config.stale_received_seconds = 1;
    try {
      await db.seedWallet("user_ghost");
      const message = await db.seedPaymentEvent("evt_ghost_lock", "user_ghost", 18);

      // A worker took the lock and died before claiming: the key outlives it until its TTL
      await getRedis().set("eventguard:lock:evt_ghost_lock", "dead-worker", "EX", 1, "NX");

      await processEvent(message); // Kafka delivery: looks like contention, offset commits
      expect((await prisma.event.findUniqueOrThrow({ where: { eventId: "evt_ghost_lock" } })).status).toBe("RECEIVED");
      expect(await prisma.walletTransaction.count()).toBe(0);

      // Nothing will redeliver it; the sweep picks up the stale RECEIVED event
      await sleep(1500);
      expect(await runRetryCycle()).toBe(1);
      expect((await prisma.event.findUniqueOrThrow({ where: { eventId: "evt_ghost_lock" } })).status).toBe("COMPLETED");
      expect(await db.walletBalance("user_ghost")).toBe("18.00");
    } finally {
      config.redis_lock_ttl_seconds = 30;
      config.stale_received_seconds = 120;
    }
  });
});

describe("duplicate and late deliveries", () => {
  it("a stale redelivery after completion, even with the Redis cache gone, is recorded as a duplicate", async () => {
    await db.seedWallet("user_stale");
    const message = await db.seedPaymentEvent("evt_stale", "user_stale", 12);
    await processEvent(message);

    await getRedis().flushdb(); // worst case: the fast-path cache is lost
    await processEvent(message);
    await processEvent(message);

    expect(await prisma.walletTransaction.count()).toBe(1);
    expect(await prisma.eventLog.count({ where: { eventId: "evt_stale", status: "DUPLICATE" } })).toBe(2);
    expect(await db.walletBalance("user_stale")).toBe("12.00");
  });
});

describe("outbox publisher crash", () => {
  it("rows claimed by a publisher that died are reclaimed after the lease, and the re-publish is absorbed", async () => {
    config.outbox_lease_seconds = 1;
    await db.seedWallet("user_outbox");
    const message = await db.seedPaymentEvent("evt_outbox_crash", "user_outbox", 33);

    // Publisher A claims the row, publishes, and dies before marking it PUBLISHED
    expect(await claimPendingOutboxBatch(10)).toHaveLength(1);
    await processEvent(message); // its message reaches a consumer

    // While A's lease holds, nobody else takes the row
    expect(await claimPendingOutboxBatch(10)).toHaveLength(0);

    // After the lease, publisher B reclaims it and publishes again
    await sleep(1200);
    const reclaimed = await claimPendingOutboxBatch(10);
    expect(reclaimed.map((r) => r.eventId)).toEqual(["evt_outbox_crash"]);
    await processEvent(message); // the second copy reaches a consumer

    expect(await prisma.walletTransaction.count()).toBe(1);
    expect(await db.walletBalance("user_outbox")).toBe("33.00");
  });

  it("concurrent publishers claim disjoint rows within a lease", async () => {
    // Default 30 s lease: no claim can expire while the publishers race
    for (let i = 0; i < 200; i++) {
      await db.seedPaymentEvent(`evt_outbox_${i}`, "user_none", 1);
    }

    const results = await db.concurrently(4, () => claimPendingOutboxBatch(60));
    const claimed = results.flatMap((r) => (r.status === "fulfilled" ? r.value.map((row) => row.id) : []));

    expect(claimed).toHaveLength(200);
    expect(new Set(claimed).size).toBe(200);
  });
});

describe("webhook ingress crash", () => {
  it("a delivery stored just before a crash is processed when Razorpay redelivers it", async () => {
    const body = JSON.stringify({
      entity: "event",
      event: "payment.captured",
      payload: {
        payment: {
          entity: { id: "pay_CRASHED0001", amount: 4000, currency: "INR", order_id: "order_CRASHED01", notes: { userId: "user_wh_crash" } },
        },
      },
    });
    // What the first delivery left behind: the record, but no payment or event
    await prisma.webhookEvent.create({
      data: { razorpayEventId: "evt_rzp_crashed", eventType: "payment.captured", paymentId: "pay_CRASHED0001", status: "RECEIVED" },
    });

    const signature = crypto.createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
    const res = await request(app)
      .post("/api/webhooks/razorpay")
      .set("Content-Type", "application/json")
      .set("X-Razorpay-Signature", signature)
      .set("X-Razorpay-Event-Id", "evt_rzp_crashed")
      .send(body);

    expect(res.status).toBe(200);
    expect((await prisma.payment.findFirstOrThrow()).status).toBe("PAID");
    expect(await prisma.event.count({ where: { eventId: "evt_pay_CRASHED0001" } })).toBe(1);
    expect((await prisma.webhookEvent.findFirstOrThrow()).status).toBe("PROCESSED");
  });
});

describe("database invariants", () => {
  it("reconciliation flags a ledger write that bypassed the application", async () => {
    const wallet = await db.seedWallet("user_tampered");
    expect((await runReconciliation()).ok).toBe(true);

    await prisma.walletTransaction.create({
      data: { walletId: wallet.id, eventId: "evt_manual_insert", type: "CREDIT", amount: 500 },
    });

    const report = await runReconciliation();
    expect(report.ok).toBe(false);
    expect(report.walletBalanceMismatches).toEqual([{ userId: "user_tampered", balance: "0.00", ledgerSum: "500.00" }]);
    expect(report.ledgerEntriesWithoutCompletedEvent).toEqual([{ eventId: "evt_manual_insert", eventStatus: null }]);
  });

  it.each([
    ["a negative ledger amount", `INSERT INTO wallet_transactions (id, "walletId", "eventId", type, amount) VALUES (gen_random_uuid(), $1, 'evt_neg', 'CREDIT', -5)`],
    ["an unknown ledger type", `INSERT INTO wallet_transactions (id, "walletId", "eventId", type, amount) VALUES (gen_random_uuid(), $1, 'evt_typ', 'GIFT', 5)`],
    ["a negative balance", `UPDATE wallets SET balance = -1 WHERE id = $1`],
  ])("PostgreSQL rejects %s", async (_name, sql) => {
    const wallet = await db.seedWallet("user_checks");
    await expect(prisma.$executeRawUnsafe(sql, wallet.id)).rejects.toThrow(/check constraint/i);
  });
});
