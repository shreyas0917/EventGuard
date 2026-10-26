import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { bearer, tokenFor } from "../helpers/tokens.js";

const { connectRedis, closeRedis } = await import("../../src/lib/redis.js");
const { prisma } = await import("../../src/lib/prisma.js");
const { createApp } = await import("../../src/app.js");
const { ensurePaymentSuccessEvent } = await import("../../src/services/paymentService.js");
const { processEvent } = await import("../../src/kafka/eventWorker.js");
const db = await import("../helpers/db.js");

const app = createApp();
const admin = bearer(tokenFor("ops_admin", "admin"));

beforeAll(async () => {
  expect(await connectRedis()).toBe(true);
});
afterAll(async () => {
  await closeRedis();
  await prisma.$disconnect();
});
beforeEach(() => db.resetState());

describe("payment verify ↔ webhook race", () => {
  it("100 concurrent verify and webhook calls for one payment converge on one event", async () => {
    const results = await db.concurrently(100, (i) =>
      ensurePaymentSuccessEvent({
        razorpayPaymentId: "pay_RACE000001",
        razorpayOrderId: "order_RACE000001",
        userId: "user_race",
        amount: 500,
        source: i % 2 === 0 ? "verify" : "webhook",
      })
    );

    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    const outcomes = results.map((r) => (r as PromiseFulfilledResult<any>).value);
    expect(new Set(outcomes.map((o) => o.eventId))).toEqual(new Set(["evt_pay_RACE000001"]));
    expect(outcomes.filter((o) => o.eventCreated)).toHaveLength(1);

    expect(await prisma.payment.count()).toBe(1);
    expect(await prisma.event.count()).toBe(1);
    expect(await prisma.outboxEvent.count()).toBe(1);

    // ...and delivering that one event many times still pays once
    await db.seedWallet("user_race");
    const event = await prisma.event.findUniqueOrThrow({ where: { eventId: "evt_pay_RACE000001" } });
    await db.concurrently(20, () =>
      processEvent({ eventId: event.eventId, eventType: event.eventType, payload: event.payload })
    );
    expect(await db.walletBalance("user_race")).toBe("500.00");
    expect(await db.ledgerViolations()).toEqual([]);
  });
});

describe("HTTP ingress", () => {
  it("100 concurrent POST /api/events with one eventId: one 201, ninety-nine 409", async () => {
    const body = {
      eventId: "evt_http_dup",
      eventType: "PAYMENT_SUCCESS",
      payload: { userId: "user_http", paymentId: "pay_http", orderId: "order_http", amount: 10 },
    };

    const results = await db.concurrently(100, () => request(app).post("/api/events").set(admin).send(body));
    const statuses = results.map((r) => (r as PromiseFulfilledResult<request.Response>).value.status);

    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(99);
    expect(await prisma.event.count()).toBe(1);
    expect(await prisma.outboxEvent.count()).toBe(1);
  });

  it("concurrent DLQ replays of one event: exactly one runs, the others get 409", async () => {
    await db.seedWallet("user_dlq");
    const message = await db.seedPaymentEvent("evt_dlq_race", "user_dlq", 75);
    await prisma.event.update({ where: { eventId: "evt_dlq_race" }, data: { status: "FAILED", attemptCount: 3 } });
    await prisma.deadLetterEvent.create({
      data: {
        eventId: message.eventId,
        eventType: message.eventType,
        payload: message.payload,
        reason: "seeded failure",
        attemptCount: 3,
        failedAt: new Date(),
      },
    });

    // Stays under the 10/min strict limit on /api/dlq
    const results = await db.concurrently(8, () => request(app).post("/api/dlq/evt_dlq_race/replay").set(admin));
    const statuses = results.map((r) => (r as PromiseFulfilledResult<request.Response>).value.status);

    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(7);
    expect(await db.walletBalance("user_dlq")).toBe("75.00");
    expect((await prisma.deadLetterEvent.findUniqueOrThrow({ where: { eventId: "evt_dlq_race" } })).status).toBe(
      "RESOLVED"
    );
    expect(await db.ledgerViolations()).toEqual([]);
  });
});
