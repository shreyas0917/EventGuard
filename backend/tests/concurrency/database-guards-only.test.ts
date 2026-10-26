import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";

/**
 * Redis is an optimisation, not the guarantee. These tests switch the Redis lock
 * and completed cache off (every worker "acquires" the lock, the cache always
 * misses) and show PostgreSQL alone still yields exactly one claim and one credit.
 */
vi.mock("../../src/services/redisLockService.js", () => ({
  RedisLockError: class RedisLockError extends Error {},
  acquireLock: async (eventId: string) => ({ key: `lock:${eventId}`, token: "bypassed", acquired: true }),
  releaseLock: async () => true,
  isLockHeld: async () => false,
}));
vi.mock("../../src/services/redisIdempotencyCache.js", () => ({
  isEventCompletedInCache: async () => false,
  markEventCompletedInCache: async () => {},
  clearEventCompletedCache: async () => {},
}));

const { prisma } = await import("../../src/lib/prisma.js");
const { processEvent } = await import("../../src/kafka/eventWorker.js");
const db = await import("../helpers/db.js");

const DELIVERIES = 100;

afterAll(() => prisma.$disconnect());
beforeEach(() => db.resetState());

describe("PostgreSQL guards with Redis disabled", () => {
  it(`${DELIVERIES} competing workers: exactly one claims the event and one credit is written`, async () => {
    await db.seedWallet("user_pg");
    const message = await db.seedPaymentEvent("evt_pg_1", "user_pg", 99.99);

    const results = await db.concurrently(DELIVERIES, () => processEvent(message));

    expect(results.filter((r) => r.status === "rejected")).toEqual([]);

    const event = await prisma.event.findUniqueOrThrow({ where: { eventId: "evt_pg_1" } });
    expect(event.status).toBe("COMPLETED");
    // An atomic claim lets exactly one worker move the event to PROCESSING
    expect(event.attemptCount).toBe(1);
    expect(await prisma.eventLog.count({ where: { eventId: "evt_pg_1", status: "PROCESSING" } })).toBe(1);

    expect(await prisma.walletTransaction.count({ where: { eventId: "evt_pg_1" } })).toBe(1);
    expect(await db.walletBalance("user_pg")).toBe("99.99");
    expect(await db.ledgerViolations()).toEqual([]);
  });

  it("many events delivered 3 times each still produce one credit per event", async () => {
    const EVENTS = 60;
    await db.seedWallet("user_pg_many");
    const messages = [];
    for (let i = 0; i < EVENTS; i++) {
      messages.push(await db.seedPaymentEvent(`evt_pg_many_${i}`, "user_pg_many", 10));
    }

    const results = await db.concurrently(EVENTS * 3, (i) => processEvent(messages[i % EVENTS]));

    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    expect(await prisma.walletTransaction.count()).toBe(EVENTS);
    expect(await db.walletBalance("user_pg_many")).toBe((EVENTS * 10).toFixed(2));
    const attempts = await prisma.event.findMany({ select: { attemptCount: true } });
    expect(attempts.every((e) => e.attemptCount === 1)).toBe(true);
    expect(await db.ledgerViolations()).toEqual([]);
  });
});
