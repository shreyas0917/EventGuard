import crypto from "crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { bearer, tokenFor } from "../helpers/tokens.js";

const RZP_KEY_SECRET = "rzp_test_secret_for_vitest";

// Razorpay double: order_OWNEDBYB01 was created by user_b; every payment is captured for ₹500.
vi.mock("../../src/lib/razorpay.js", () => {
  const client = {
    orders: {
      fetch: async (id: string) => ({ id, notes: { userId: id === "order_OWNEDBYB01" ? "user_b" : "someone" } }),
    },
    payments: {
      fetch: async (id: string) => ({ id, status: "captured", amount: 50000, currency: "INR" }),
    },
  };
  return {
    initializeRazorpay: () => true,
    isRazorpayConfigured: () => true,
    getRazorpay: () => client,
    getRazorpayKeySecret: () => RZP_KEY_SECRET,
  };
});
vi.mock("../../src/lib/prisma.js", async () => await import("../helpers/prismaMock.js"));

const { createApp } = await import("../../src/app.js");
const { prisma, resetPrismaMock } = await import("../helpers/prismaMock.js");

const app = createApp();

function signedCheckout(orderId: string, paymentId: string) {
  const signature = crypto.createHmac("sha256", RZP_KEY_SECRET).update(`${orderId}|${paymentId}`).digest("hex");
  return { orderId, paymentId, signature };
}

beforeEach(() => resetPrismaMock());

describe("POST /api/payments/verify", () => {
  it("refuses to credit a user who does not own the order, even with a valid signature", async () => {
    const res = await request(app)
      .post("/api/payments/verify")
      .set(bearer(tokenFor("user_a", "user")))
      .send(signedCheckout("order_OWNEDBYB01", "pay_STOLEN0001"));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ORDER_OWNERSHIP_MISMATCH");
    expect(prisma.payment.create).not.toHaveBeenCalled();
    expect(prisma.event.create).not.toHaveBeenCalled();
  });

  it("refuses a client-supplied userId that differs from the token", async () => {
    const res = await request(app)
      .post("/api/payments/verify")
      .set(bearer(tokenFor("user_a", "user")))
      .send({ ...signedCheckout("order_OWNEDBYB01", "pay_STOLEN0002"), userId: "user_b" });

    expect(res.status).toBe(403);
    expect(prisma.event.create).not.toHaveBeenCalled();
  });

  it("rejects a forged signature", async () => {
    const res = await request(app)
      .post("/api/payments/verify")
      .set(bearer(tokenFor("user_b", "user")))
      .send({ orderId: "order_OWNEDBYB01", paymentId: "pay_FORGED0001", signature: "0".repeat(64) });

    expect(res.status).toBe(400);
    expect(res.body.verified).toBe(false);
    expect(prisma.event.create).not.toHaveBeenCalled();
  });

  it("credits the order's owner", async () => {
    const res = await request(app)
      .post("/api/payments/verify")
      .set(bearer(tokenFor("user_b", "user")))
      .send(signedCheckout("order_OWNEDBYB01", "pay_GENUINE001"));

    expect(res.status).toBe(201);
    expect(res.body.event.eventId).toBe("evt_pay_GENUINE001");
    expect(prisma.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ payload: expect.objectContaining({ userId: "user_b", amount: 500 }) }),
      })
    );
  });
});
