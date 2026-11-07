import crypto from "crypto";
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { bearer, tokenFor } from "../helpers/tokens.js";

// Enable webhook processing for this file only (before src/config is imported)
const WEBHOOK_SECRET = "whsec_vitest_0123456789abcdef";
const KEY_SECRET = "rzp_key_secret_vitest";
Object.assign(process.env, {
  RAZORPAY_KEY_ID: "rzp_test_vitest",
  RAZORPAY_KEY_SECRET: KEY_SECRET,
  RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
});

// Razorpay's REST API is the only thing faked: orders belong to user_wh and every
// payment is captured for ₹500. Database, Redis and the HTTP stack are real.
vi.mock("../../src/lib/razorpay.js", () => ({
  initializeRazorpay: () => true,
  isRazorpayConfigured: () => true,
  getRazorpayKeySecret: () => KEY_SECRET,
  getRazorpay: () => ({
    // An order whose id contains NOOWNER has no userId in its notes; every other order belongs to user_wh.
    orders: { fetch: async (id: string) => ({ id, notes: id.includes("NOOWNER") ? {} : { userId: "user_wh" } }) },
    payments: { fetch: async (id: string) => ({ id, status: "captured", amount: 50000, currency: "INR" }) },
  }),
}));

const { connectRedis, closeRedis } = await import("../../src/lib/redis.js");
const { prisma } = await import("../../src/lib/prisma.js");
const { createApp } = await import("../../src/app.js");
const { processEvent } = await import("../../src/kafka/eventWorker.js");
const paymentService = await import("../../src/services/paymentService.js");
const db = await import("../helpers/db.js");

const app = createApp();

/**
 * A payment webhook shaped like live Razorpay: no event_id in the body. `paymentNotes`
 * defaults to the owner on the payment entity; pass [] to model a live payload where the
 * owner is only on the order (resolved via orders.fetch).
 */
function webhookBody(
  event: "payment.captured" | "payment.failed",
  paymentId: string,
  orderId: string,
  paymentNotes: unknown = { userId: "user_wh" }
) {
  return JSON.stringify({
    entity: "event",
    account_id: "acc_vitest",
    event,
    contains: ["payment"],
    payload: {
      payment: {
        entity: {
          id: paymentId,
          entity: "payment",
          amount: 50000,
          currency: "INR",
          status: event === "payment.captured" ? "captured" : "failed",
          order_id: orderId,
          notes: paymentNotes,
        },
      },
    },
    created_at: 1_700_000_000,
  });
}

function sendWebhook(rawBody: string, deliveryId: string) {
  const signature = crypto.createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");
  return request(app)
    .post("/api/webhooks/razorpay")
    .set("Content-Type", "application/json")
    .set("X-Razorpay-Signature", signature)
    .set("X-Razorpay-Event-Id", deliveryId)
    .send(rawBody);
}

function verifyCheckout(orderId: string, paymentId: string) {
  const signature = crypto.createHmac("sha256", KEY_SECRET).update(`${orderId}|${paymentId}`).digest("hex");
  return request(app)
    .post("/api/payments/verify")
    .set(bearer(tokenFor("user_wh", "user")))
    .send({ orderId, paymentId, signature });
}

const statusesOf = (results: PromiseSettledResult<request.Response>[]) =>
  results.map((r) => (r.status === "fulfilled" ? r.value.status : -1));

async function deliverEventAndExpectOneCredit(eventId: string) {
  const event = await prisma.event.findUniqueOrThrow({ where: { eventId } });
  await db.concurrently(50, () => processEvent({ eventId, eventType: event.eventType, payload: event.payload }));
  expect(await prisma.walletTransaction.count({ where: { eventId } })).toBe(1);
  expect(await db.walletBalance("user_wh")).toBe("500.00");
  expect(await db.ledgerViolations()).toEqual([]);
}

beforeAll(async () => {
  expect(await connectRedis()).toBe(true);
});
afterAll(async () => {
  await closeRedis();
  await prisma.$disconnect();
});
beforeEach(async () => {
  await db.resetState();
  await db.seedWallet("user_wh");
});

describe("duplicate webhook deliveries over HTTP", () => {
  it("100 simultaneous copies of one signed delivery: all acknowledged, one payment, one event", async () => {
    const body = webhookBody("payment.captured", "pay_WHDUP00001", "order_WHDUP00001");

    const results = await db.concurrently(100, () => sendWebhook(body, "evt_rzp_dup_1"));

    // Every copy gets a 2xx so Razorpay stops retrying; none is mistaken for a bad signature
    expect(statusesOf(results).every((s) => s === 200)).toBe(true);
    expect(await prisma.webhookEvent.count()).toBe(1);
    expect((await prisma.webhookEvent.findFirstOrThrow()).status).toBe("PROCESSED");
    expect(await prisma.payment.count()).toBe(1);
    expect(await prisma.event.count()).toBe(1);
    expect(await prisma.outboxEvent.count()).toBe(1);

    await deliverEventAndExpectOneCredit("evt_pay_WHDUP00001");
  });

  it("checkout verify and webhooks racing for one payment produce one event and one credit", async () => {
    const orderId = "order_WHRACE0001";
    const paymentId = "pay_WHRACE00001";
    const body = webhookBody("payment.captured", paymentId, orderId);

    // 50 verify calls interleaved with 50 webhook deliveries (Razorpay retries get new delivery ids)
    const results = await db.concurrently(100, (i) =>
      i % 2 === 0 ? verifyCheckout(orderId, paymentId) : sendWebhook(body, `evt_rzp_race_${i}`)
    );

    expect(statusesOf(results).every((s) => s === 200 || s === 201)).toBe(true);
    const verifyResponses = results.filter((_, i) => i % 2 === 0).map((r) => (r as PromiseFulfilledResult<any>).value);
    expect(verifyResponses.every((r) => r.body.event?.eventId === `evt_${paymentId}`)).toBe(true);

    expect(await prisma.payment.count()).toBe(1);
    expect((await prisma.payment.findFirstOrThrow()).status).toBe("PAID");
    expect(await prisma.event.count()).toBe(1);
    expect(await prisma.outboxEvent.count()).toBe(1);
    expect(await prisma.webhookEvent.count({ where: { status: "PROCESSED" } })).toBe(50);

    await deliverEventAndExpectOneCredit(`evt_${paymentId}`);
  });
});

describe("webhook before verify with empty payment notes", () => {
  it("resolves the owner from the order and credits that user once, nothing dead-lettered", async () => {
    // Live shape: payment.captured notes are [], the owner is only on the order.
    const body = webhookBody("payment.captured", "pay_EMPTY00001", "order_EMPTY0001", []);

    const res = await sendWebhook(body, "evt_rzp_empty_1");
    expect(res.status).toBe(200);

    expect((await prisma.payment.findFirstOrThrow()).userId).toBe("user_wh");
    const event = await prisma.event.findUniqueOrThrow({ where: { eventId: "evt_pay_EMPTY00001" } });
    expect((event.payload as any).userId).toBe("user_wh");

    await deliverEventAndExpectOneCredit("evt_pay_EMPTY00001");
    expect(await prisma.deadLetterEvent.count()).toBe(0);
  });

  it("creates no event and marks the webhook FAILED when the order has no owner either", async () => {
    const body = webhookBody("payment.captured", "pay_NOOWNER0001", "order_NOOWNER01", []);

    const res = await sendWebhook(body, "evt_rzp_noowner_1");
    // Non-2xx so Razorpay retries / a later verify can supply the owner
    expect(res.status).toBe(500);

    expect(await prisma.event.count()).toBe(0);
    expect(await prisma.outboxEvent.count()).toBe(0);
    expect(await prisma.payment.count()).toBe(0);
    expect(await prisma.deadLetterEvent.count()).toBe(0);
    expect((await prisma.webhookEvent.findFirstOrThrow()).status).toBe("FAILED");
  });
});

describe("webhook processing failure is retried", () => {
  it("answers 500 and FAILs on a processing error, then 200 and one credit on resend", async () => {
    const spy = vi
      .spyOn(paymentService, "ensurePaymentSuccessEvent")
      .mockRejectedValueOnce(new Error("transient DB error"));

    const body = webhookBody("payment.captured", "pay_RETRY00001", "order_RETRY0001");

    // First delivery fails during processing -> 500 so Razorpay will resend
    const first = await sendWebhook(body, "evt_rzp_retry_1");
    expect(first.status).toBe(500);
    expect((await prisma.webhookEvent.findFirstOrThrow()).status).toBe("FAILED");
    expect(await prisma.event.count()).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);

    // Razorpay resends the same delivery id -> the real implementation runs this time
    const second = await sendWebhook(body, "evt_rzp_retry_1");
    expect(second.status).toBe(200);
    expect((await prisma.webhookEvent.findFirstOrThrow()).status).toBe("PROCESSED");

    await deliverEventAndExpectOneCredit("evt_pay_RETRY00001");
    expect(await prisma.deadLetterEvent.count()).toBe(0);
  });
});

describe("payment.failed racing payment.captured for the same payment", () => {
  it("always settles PAID with exactly one credit, over 20 concurrent races", async () => {
    for (let n = 0; n < 20; n++) {
      const paymentId = `pay_RACE4_${n}`;
      const orderId = `order_RACE4_${n}`;
      const captured = webhookBody("payment.captured", paymentId, orderId);
      const failed = webhookBody("payment.failed", paymentId, orderId);

      await db.concurrently(2, (i) =>
        i === 0 ? sendWebhook(captured, `evt_cap_${n}`) : sendWebhook(failed, `evt_fail_${n}`)
      );

      // A failure webhook must never win the race and leave the payment FAILED
      expect((await prisma.payment.findUniqueOrThrow({ where: { razorpayPaymentId: paymentId } })).status).toBe("PAID");
    }

    // One canonical event per captured payment; deliver one end to end -> one credit
    expect(await prisma.event.count()).toBe(20);
    await deliverEventAndExpectOneCredit("evt_pay_RACE4_0");
  });
});

describe("out-of-order webhooks", () => {
  it("payment.failed arriving after payment.captured does not undo the payment", async () => {
    await sendWebhook(webhookBody("payment.captured", "pay_ORDER00001", "order_ORDER0001"), "evt_rzp_ooo_1").expect(200);
    await sendWebhook(webhookBody("payment.failed", "pay_ORDER00001", "order_ORDER0001"), "evt_rzp_ooo_2").expect(200);

    expect((await prisma.payment.findFirstOrThrow()).status).toBe("PAID");
    await deliverEventAndExpectOneCredit("evt_pay_ORDER00001");
  });

  it("payment.captured arriving after payment.failed promotes the payment and credits once", async () => {
    await sendWebhook(webhookBody("payment.failed", "pay_ORDER00002", "order_ORDER0002"), "evt_rzp_ooo_3").expect(200);
    expect((await prisma.payment.findFirstOrThrow()).status).toBe("FAILED");
    expect(await prisma.event.count()).toBe(0);

    await sendWebhook(webhookBody("payment.captured", "pay_ORDER00002", "order_ORDER0002"), "evt_rzp_ooo_4").expect(200);
    expect((await prisma.payment.findFirstOrThrow()).status).toBe("PAID");
    await deliverEventAndExpectOneCredit("evt_pay_ORDER00002");
  });
});
