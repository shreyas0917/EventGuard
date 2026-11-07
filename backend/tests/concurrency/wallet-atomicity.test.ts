import { describe, it, expect, afterAll, beforeEach } from "vitest";

const { prisma } = await import("../../src/lib/prisma.js");
const { creditWallet } = await import("../../src/services/walletService.js");
const db = await import("../helpers/db.js");

afterAll(() => prisma.$disconnect());
beforeEach(() => db.resetState());

describe("wallet credit atomicity", () => {
  it("200 concurrent credits with different eventIds lose no updates", async () => {
    await db.seedWallet("user_atomic");
    // Amounts 0.01 .. 2.00, so a single lost update would show in the total
    const amounts = Array.from({ length: 200 }, (_, i) => (i + 1) / 100);

    const results = await db.concurrently(200, (i) => creditWallet("user_atomic", amounts[i], `evt_atomic_${i}`));

    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    const expectedCents = amounts.reduce((sum, a) => sum + Math.round(a * 100), 0);
    expect(await db.walletBalance("user_atomic")).toBe((expectedCents / 100).toFixed(2));
    expect(await prisma.walletTransaction.count()).toBe(200);
    expect(await db.ledgerViolations()).toEqual([]);
  });

  it("50 concurrent credits with the same eventId apply once; the rest are rejected by the UNIQUE constraint", async () => {
    await db.seedWallet("user_same");

    const results = await db.concurrently(50, () => creditWallet("user_same", 42, "evt_same"));

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(49);
    expect(rejected.every((r) => String(r.reason?.message).includes("Unique constraint"))).toBe(true);
    expect(await db.walletBalance("user_same")).toBe("42.00");
    expect(await db.ledgerViolations()).toEqual([]);
  });

  it("a failed credit (negative amount) rolls back the auto-created wallet and leaves nothing", async () => {
    // The CHECK constraint rejects a non-positive ledger amount; the whole transaction,
    // including the on-demand wallet insert, must roll back.
    await expect(creditWallet("rollback_user", -5, "evt_orphan")).rejects.toThrow();
    expect(await prisma.wallet.findUnique({ where: { userId: "rollback_user" } })).toBeNull();
    expect(await prisma.walletTransaction.count()).toBe(0);
  });

  it("credits a user who has no wallet yet: the wallet is created with the credited balance", async () => {
    const result = await creditWallet("brand_new_user", 125.5, "evt_firstpay");

    expect(result.wallet.userId).toBe("brand_new_user");
    expect(await db.walletBalance("brand_new_user")).toBe("125.50");
    expect(await prisma.walletTransaction.count({ where: { eventId: "evt_firstpay" } })).toBe(1);
    expect(await db.ledgerViolations()).toEqual([]);
  });

  it("50 concurrent first payments to the same new user create one wallet and 50 credits", async () => {
    const results = await db.concurrently(50, (i) => creditWallet("fresh_user", 2, `evt_fresh_${i}`));

    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    expect(await prisma.wallet.count({ where: { userId: "fresh_user" } })).toBe(1);
    expect(await prisma.walletTransaction.count()).toBe(50);
    expect(await db.walletBalance("fresh_user")).toBe("100.00");
    expect(await db.ledgerViolations()).toEqual([]);
  });
});
