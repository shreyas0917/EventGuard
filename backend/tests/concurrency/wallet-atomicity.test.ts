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

  it("a failed credit leaves neither a ledger row nor a balance change", async () => {
    await expect(creditWallet("no_such_user", 10, "evt_orphan")).rejects.toThrow(/Wallet not found/);
    expect(await prisma.walletTransaction.count()).toBe(0);
  });
});
