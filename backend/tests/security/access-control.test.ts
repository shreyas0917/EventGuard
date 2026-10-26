import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { bearer, tokenFor } from "../helpers/tokens.js";

vi.mock("../../src/lib/prisma.js", async () => await import("../helpers/prismaMock.js"));

const { createApp } = await import("../../src/app.js");
const { prisma, resetPrismaMock } = await import("../helpers/prismaMock.js");

const app = createApp();
const WEBHOOK_ID = "3f2c1a9e-8b7d-4c6e-9f1a-2b3c4d5e6f70";

const ADMIN_ROUTES: Array<[method: "get" | "post", path: string]> = [
  ["get", "/api/events"],
  ["post", "/api/events"],
  ["get", "/api/events/evt_1"],
  ["get", "/api/events/evt_1/history"],
  ["get", "/api/events/failed"],
  ["get", "/api/events/retrying"],
  ["post", "/api/events/evt_1/retry"],
  ["get", "/api/outbox"],
  ["get", "/api/outbox/evt_1"],
  ["get", "/api/dlq"],
  ["get", "/api/dlq/evt_1"],
  ["post", "/api/dlq/evt_1/replay"],
  ["post", "/api/dlq/evt_1/resolve"],
  ["get", "/api/dlq/stats/summary"],
  ["get", "/api/webhooks/razorpay"],
  ["get", `/api/webhooks/razorpay/${WEBHOOK_ID}`],
  ["get", "/api/admin/reconciliation"],
];

const USER_ROUTES: Array<[method: "get" | "post", path: string]> = [
  ["get", "/api/auth/me"],
  ["post", "/api/wallets"],
  ["get", "/api/wallets/user_a"],
  ["get", "/api/wallets/user_a/transactions"],
  ["post", "/api/payments/create-order"],
  ["post", "/api/payments/verify"],
];

const userA = tokenFor("user_a", "user");
const admin = tokenFor("ops_admin", "admin");

beforeEach(() => resetPrismaMock());

describe("anonymous callers", () => {
  it.each([...ADMIN_ROUTES, ...USER_ROUTES])("%s %s → 401 with a Bearer challenge", async (method, path) => {
    const res = await request(app)[method](path).send({});
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
    expect(res.headers["www-authenticate"]).toMatch(/^Bearer/);
  });

  it("can still reach public endpoints", async () => {
    expect((await request(app).get("/health")).status).toBe(200);
    // 503 here only means Razorpay is not configured in tests; it is not an auth rejection
    expect((await request(app).get("/api/payments/config")).status).not.toBe(401);
  });

  it("reaches the webhook endpoint, which is guarded by HMAC instead of a bearer token", async () => {
    const res = await request(app).post("/api/webhooks/razorpay").send({ event: "payment.captured" });
    // The webhook handler answers (503 here: no webhook secret in tests); the bearer layer never ran
    expect(res.body.error?.code).not.toBe("UNAUTHENTICATED");
    expect(res.headers["www-authenticate"]).toBeUndefined();
  });
});

describe("role-based authorization", () => {
  it.each(ADMIN_ROUTES)("user token on %s %s → 403", async (method, path) => {
    const res = await request(app)[method](path).set(bearer(userA)).send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it.each(ADMIN_ROUTES)("admin token on %s %s passes authorization", async (method, path) => {
    const res = await request(app)[method](path).set(bearer(admin)).send({});
    expect([401, 403]).not.toContain(res.status);
  });
});

describe("wallet ownership", () => {
  it("a user cannot read another user's wallet or ledger", async () => {
    for (const path of ["/api/wallets/user_b", "/api/wallets/user_b/transactions"]) {
      const res = await request(app).get(path).set(bearer(userA));
      expect(res.status).toBe(403);
    }
    expect(prisma.wallet.findUnique).not.toHaveBeenCalled();
  });

  it("a user can read their own wallet", async () => {
    prisma.wallet.findUnique.mockResolvedValueOnce({
      id: "w1",
      userId: "user_a",
      balance: "100.00",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await request(app).get("/api/wallets/user_a").set(bearer(userA));
    expect(res.status).toBe(200);
    expect(res.body.wallet.userId).toBe("user_a");
  });

  it("an admin can read any wallet", async () => {
    const res = await request(app).get("/api/wallets/user_b").set(bearer(admin));
    expect(res.status).toBe(404); // passes authorization; the mock database is empty
  });

  it("creating a wallet defaults to the caller and refuses other user ids", async () => {
    const own = await request(app).post("/api/wallets").set(bearer(userA)).send({});
    expect(own.status).toBe(201);
    expect(own.body.wallet.userId).toBe("user_a");

    const other = await request(app).post("/api/wallets").set(bearer(userA)).send({ userId: "user_b" });
    expect(other.status).toBe(403);

    const byAdmin = await request(app).post("/api/wallets").set(bearer(admin)).send({ userId: "user_b" });
    expect(byAdmin.status).toBe(201);
    expect(byAdmin.body.wallet.userId).toBe("user_b");
  });
});

describe("payment ownership", () => {
  it("a user cannot create an order on behalf of another user", async () => {
    const res = await request(app)
      .post("/api/payments/create-order")
      .set(bearer(userA))
      .send({ userId: "user_b", amount: 100, description: "ticket" });
    expect(res.status).toBe(403);
  });
});
