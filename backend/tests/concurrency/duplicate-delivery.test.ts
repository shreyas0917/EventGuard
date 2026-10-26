import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

const { connectRedis, closeRedis } = await import("../../src/lib/redis.js");
const { prisma } = await import("../../src/lib/prisma.js");
const { processEvent } = await import("../../src/kafka/eventWorker.js");
const db = await import("../helpers/db.js");

const DELIVERIES = 100;

beforeAll(async () => {
  expect(await connectRedis()).toBe(true);
});
afterAll(async () => {
  await closeRedis();
  await prisma.$disconnect();
});
beforeEach(() => db.resetState());

describe("duplicate delivery through the full pipeline (Redis + PostgreSQL)", () => {
  it(`${DELIVERIES} simultaneous deliveries of one payment credit the wallet exactly once`, async () => {
    await db.seedWallet("user_dup");
    const message = await db.seedPaymentEvent("evt_dup_1", "user_dup", 250.75);

    const results = await db.concurrently(DELIVERIES, () => processEvent(message));

    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    expect(await prisma.walletTransaction.count({ where: { eventId: "evt_dup_1" } })).toBe(1);
    expect(await db.walletBalance("user_dup")).toBe("250.75");

    const event = await prisma.event.findUniqueOrThrow({ where: { eventId: "evt_dup_1" } });
    expect(event.status).toBe("COMPLETED");
    expect(event.attemptCount).toBe(1);

    // Every losing delivery is accounted for, with the guard that stopped it
    expect(await prisma.eventLog.count({ where: { eventId: "evt_dup_1", status: "DUPLICATE" } })).toBe(
      DELIVERIES - 1
    );
    expect(await db.ledgerViolations()).toEqual([]);
    expect(await db.completedEventsWithoutExactlyOneCredit()).toEqual([]);
  });

  it("many events, each delivered 3 times at once, credit one wallet without lost updates", async () => {
    const EVENTS = Number(process.env.STRESS_EVENTS ?? 100);
    await db.seedWallet("user_many");
    const messages = [];
    for (let i = 0; i < EVENTS; i++) {
      messages.push(await db.seedPaymentEvent(`evt_many_${i}`, "user_many", 1.25));
    }

    const results = await db.concurrently(EVENTS * 3, (i) => processEvent(messages[i % EVENTS]));

    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    // Name any event that did not complete, with its error, rather than just a count
    expect(
      await prisma.event.findMany({
        where: { status: { not: "COMPLETED" } },
        select: { eventId: true, status: true, lastError: true },
      })
    ).toEqual([]);
    expect(await prisma.walletTransaction.count()).toBe(EVENTS);
    expect(await db.walletBalance("user_many")).toBe((EVENTS * 1.25).toFixed(2));
    expect(await db.ledgerViolations()).toEqual([]);
  });
});
