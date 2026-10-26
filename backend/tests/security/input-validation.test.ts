import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { bearer, tokenFor } from "../helpers/tokens.js";

vi.mock("../../src/lib/prisma.js", async () => await import("../helpers/prismaMock.js"));

const { createApp } = await import("../../src/app.js");
const { prisma, resetPrismaMock } = await import("../helpers/prismaMock.js");

const app = createApp();
const admin = bearer(tokenFor("ops_admin", "admin"));
const userA = bearer(tokenFor("user_a", "user"));

const validPayment = { userId: "user_a", paymentId: "pay_demo_1", orderId: "order_demo_1", amount: 100 };
const createEvent = (body: unknown) => request(app).post("/api/events").set(admin).send(body as object);

beforeEach(() => resetPrismaMock());

describe("POST /api/events", () => {
  it("accepts a well-formed PAYMENT_SUCCESS event", async () => {
    const res = await createEvent({ eventId: "evt_ok_1", eventType: "PAYMENT_SUCCESS", payload: validPayment });
    expect(res.status).toBe(201);
  });

  const invalid: Array<[name: string, body: unknown, path: string]> = [
    ["path-traversal characters in eventId", { eventId: "../../etc/passwd", eventType: "PAYMENT_SUCCESS", payload: validPayment }, "eventId"],
    ["SQL-looking eventId", { eventId: "x' OR '1'='1", eventType: "PAYMENT_SUCCESS", payload: validPayment }, "eventId"],
    ["an over-long eventId", { eventId: "e".repeat(129), eventType: "PAYMENT_SUCCESS", payload: validPayment }, "eventId"],
    ["a lowercase eventType", { eventId: "evt_1", eventType: "payment_success", payload: validPayment }, "eventType"],
    ["a non-object payload", { eventId: "evt_1", eventType: "PAYMENT_SUCCESS", payload: "credit me" }, "payload"],
    ["a missing amount", { eventId: "evt_1", eventType: "PAYMENT_SUCCESS", payload: { ...validPayment, amount: undefined } }, "payload.amount"],
    ["a negative amount", { eventId: "evt_1", eventType: "PAYMENT_SUCCESS", payload: { ...validPayment, amount: -100 } }, "payload.amount"],
    ["a zero amount", { eventId: "evt_1", eventType: "PAYMENT_SUCCESS", payload: { ...validPayment, amount: 0 } }, "payload.amount"],
    ["sub-paisa precision", { eventId: "evt_1", eventType: "PAYMENT_SUCCESS", payload: { ...validPayment, amount: 10.123 } }, "payload.amount"],
    ["an absurd amount", { eventId: "evt_1", eventType: "PAYMENT_SUCCESS", payload: { ...validPayment, amount: 1e12 } }, "payload.amount"],
    ["an amount sent as a string", { eventId: "evt_1", eventType: "PAYMENT_SUCCESS", payload: { ...validPayment, amount: "100" } }, "payload.amount"],
    ["an unknown payload field", { eventId: "evt_1", eventType: "PAYMENT_SUCCESS", payload: { ...validPayment, bonus: 1000 } }, "payload"],
    ["an unknown top-level field", { eventId: "evt_1", eventType: "PAYMENT_SUCCESS", payload: validPayment, status: "COMPLETED" }, ""],
  ];

  it.each(invalid)("rejects %s with 400", async (_name, body, path) => {
    const res = await createEvent(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toContain(path);
    expect(prisma.event.create).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON with 400 instead of a 500", async () => {
    const res = await request(app)
      .post("/api/events")
      .set(admin)
      .set("Content-Type", "application/json")
      .send('{"eventId": "evt_1",');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_JSON");
  });

  it("rejects bodies over the 1 MB limit with 413", async () => {
    const res = await createEvent({ eventId: "evt_big", eventType: "BULK", payload: { blob: "x".repeat(1_100_000) } });
    expect(res.status).toBe(413);
  });
});

describe("pagination and query bounds", () => {
  it.each([
    ["/api/events?limit=1000"],
    ["/api/events?limit=0"],
    ["/api/events?page=0"],
    ["/api/events?limit=abc"],
    ["/api/outbox?limit=101"],
    ["/api/webhooks/razorpay?limit=500"],
    ["/api/webhooks/razorpay?status=DROP_TABLE"],
    ["/api/dlq?status=EVERYTHING"],
    ["/api/webhooks/razorpay/not-a-uuid"],
  ])("GET %s → 400", async (path) => {
    const res = await request(app).get(path).set(admin);
    expect(res.status).toBe(400);
  });

  it("caps an in-range limit and passes it through", async () => {
    const res = await request(app).get("/api/events?limit=50&page=2").set(admin);
    expect(res.status).toBe(200);
    expect(prisma.event.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 50, skip: 50 }));
  });
});

describe("other request bodies", () => {
  it("DLQ resolve requires a meaningful reason", async () => {
    const res = await request(app).post("/api/dlq/evt_1/resolve").set(admin).send({ reason: "" });
    expect(res.status).toBe(400);
  });

  it.each([
    ["a zero amount", { amount: 0, description: "ticket" }],
    ["three decimal places", { amount: 1.005, description: "ticket" }],
    ["a missing description", { amount: 100 }],
    ["an over-long description", { amount: 100, description: "d".repeat(256) }],
    ["an unexpected field", { amount: 100, description: "ticket", currency: "USD" }],
  ])("create-order rejects %s", async (_name, body) => {
    const res = await request(app).post("/api/payments/create-order").set(userA).send(body);
    expect(res.status).toBe(400);
  });

  it.each([
    ["a non-Razorpay order id", { orderId: "1; DROP TABLE payments", paymentId: "pay_ABC123def", signature: "a".repeat(64) }],
    ["a non-Razorpay payment id", { orderId: "order_ABC123def", paymentId: "../pay", signature: "a".repeat(64) }],
    ["a non-hex signature", { orderId: "order_ABC123def", paymentId: "pay_ABC123def", signature: "z".repeat(64) }],
  ])("verify rejects %s", async (_name, body) => {
    const res = await request(app).post("/api/payments/verify").set(userA).send(body);
    expect(res.status).toBe(400);
  });

  it("wallet creation rejects a userId with spaces", async () => {
    const res = await request(app).post("/api/wallets").set(admin).send({ userId: "user a" });
    expect(res.status).toBe(400);
  });
});
