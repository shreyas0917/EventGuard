import { describe, it, expect, afterAll, beforeEach } from "vitest";

const { prisma } = await import("../../src/lib/prisma.js");
const { claimEventForProcessing } = await import("../../src/services/eventClaimService.js");
const { completeEvent } = await import("../../src/services/eventCompletionService.js");
const { handleProcessingFailure } = await import("../../src/services/retryService.js");
const db = await import("../helpers/db.js");

afterAll(() => prisma.$disconnect());
beforeEach(() => db.resetState());

async function claim(eventId: string): Promise<string> {
  const result = await claimEventForProcessing(eventId);
  if (result.outcome !== "claimed") throw new Error(`expected a claim, got ${result.outcome}`);
  return result.claimToken;
}

const expireLease = (eventId: string) =>
  prisma.event.update({ where: { eventId }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });

describe("claim leases and fencing tokens", () => {
  it("an active claim cannot be taken; an expired one can", async () => {
    await db.seedWallet("user_lease");
    await db.seedPaymentEvent("evt_lease", "user_lease", 10);

    await claim("evt_lease");
    expect((await claimEventForProcessing("evt_lease")).outcome).toBe("already-processing");

    await expireLease("evt_lease");
    expect((await claimEventForProcessing("evt_lease")).outcome).toBe("claimed");
    expect((await prisma.event.findUniqueOrThrow({ where: { eventId: "evt_lease" } })).attemptCount).toBe(2);
  });

  it("a worker whose lease was taken over cannot complete or credit", async () => {
    await db.seedWallet("user_fence");
    const message = await db.seedPaymentEvent("evt_fence", "user_fence", 40);

    const staleToken = await claim("evt_fence"); // worker A stalls...
    await expireLease("evt_fence");
    const freshToken = await claim("evt_fence"); // ...worker B takes over and finishes
    expect((await completeEvent(message, freshToken)).completed).toBe(true);

    // Worker A wakes up and tries to finish with its old token
    expect((await completeEvent(message, staleToken)).completed).toBe(false);
    expect(await handleProcessingFailure("evt_fence", staleToken, "late failure", message.eventType, message.payload)).toBe(
      "lease-lost"
    );

    const event = await prisma.event.findUniqueOrThrow({ where: { eventId: "evt_fence" } });
    expect(event.status).toBe("COMPLETED");
    expect(await prisma.walletTransaction.count()).toBe(1);
    expect(await db.walletBalance("user_fence")).toBe("40.00");
    expect(await prisma.deadLetterEvent.count()).toBe(0);
  });

  it("a stale worker's failure does not overwrite the new owner's claim", async () => {
    const message = await db.seedPaymentEvent("evt_stale_fail", "user_none", 5);

    const staleToken = await claim("evt_stale_fail");
    await expireLease("evt_stale_fail");
    const freshToken = await claim("evt_stale_fail");

    expect(await handleProcessingFailure("evt_stale_fail", staleToken, "stale", message.eventType, message.payload)).toBe(
      "lease-lost"
    );
    const event = await prisma.event.findUniqueOrThrow({ where: { eventId: "evt_stale_fail" } });
    expect(event.status).toBe("PROCESSING");
    expect(event.claimToken).toBe(freshToken);
  });

  it("a RETRYING event is not claimable until its backoff has elapsed", async () => {
    await db.seedPaymentEvent("evt_backoff", "user_none", 5);
    await prisma.event.update({
      where: { eventId: "evt_backoff" },
      data: { status: "RETRYING", nextRetryAt: new Date(Date.now() + 60_000) },
    });
    expect((await claimEventForProcessing("evt_backoff")).outcome).toBe("retry-scheduled");

    await prisma.event.update({ where: { eventId: "evt_backoff" }, data: { nextRetryAt: new Date(Date.now() - 1) } });
    expect((await claimEventForProcessing("evt_backoff")).outcome).toBe("claimed");
  });

  it("exhausting attempts marks FAILED and opens a dead-letter row in the same transaction", async () => {
    const message = await db.seedPaymentEvent("evt_exhaust", "user_none", 5);
    await prisma.event.update({ where: { eventId: "evt_exhaust" }, data: { attemptCount: 2 } });
    const token = await claim("evt_exhaust"); // attempt 3 of 3

    expect(await handleProcessingFailure("evt_exhaust", token, "boom", message.eventType, message.payload)).toBe("failed");

    const event = await prisma.event.findUniqueOrThrow({ where: { eventId: "evt_exhaust" } });
    expect(event.status).toBe("FAILED");
    const dlq = await prisma.deadLetterEvent.findUniqueOrThrow({ where: { eventId: "evt_exhaust" } });
    expect(dlq).toMatchObject({ status: "PENDING", reason: "boom", attemptCount: 3 });
  });
});
