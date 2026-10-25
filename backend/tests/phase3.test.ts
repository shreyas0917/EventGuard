import { prisma } from "../src/lib/prisma.js";

async function runPhase3Tests() {
  console.log("Running EventGuard Phase 3 - Transactional Outbox Tests...\n");

  try {
    // Clean up before tests
    await prisma.eventLog.deleteMany();
    await prisma.outboxEvent.deleteMany();
    await prisma.event.deleteMany();
    console.log("✓ Database cleaned");

    // TEST 1: Create event with full transaction
    console.log("\n[Test 1] Create event with transaction (Event + EventLog + Outbox)");
    const { createEvent } = await import(
      "../src/services/eventService.js"
    );

    const event1 = await createEvent({
      eventId: "evt_phase3_001",
      eventType: "TEST_EVENT",
      payload: { test: true },
    });

    const eventCount = await prisma.event.count();
    const logCount = await prisma.eventLog.count();
    const outboxCount = await prisma.outboxEvent.count();

    if (eventCount === 1 && logCount === 1 && outboxCount === 1) {
      console.log(
        "✓ Transaction created all three records (Event, EventLog, OutboxEvent)"
      );
    } else {
      throw new Error(
        `Expected 1 of each, got: events=${eventCount}, logs=${logCount}, outbox=${outboxCount}`
      );
    }

    // TEST 2: Verify outbox record has correct status
    console.log("\n[Test 2] Verify outbox record has PENDING status");
    const outboxEvent = await prisma.outboxEvent.findUnique({
      where: { eventId: "evt_phase3_001" },
    });

    if (outboxEvent && outboxEvent.status === "PENDING") {
      console.log("✓ Outbox record created with PENDING status");
    } else {
      throw new Error("Outbox record status is not PENDING");
    }

    // TEST 3: Duplicate detection still works
    console.log("\n[Test 3] Duplicate event detection");
    try {
      await createEvent({
        eventId: "evt_phase3_001",
        eventType: "TEST_EVENT",
        payload: { test: true },
      });
      throw new Error("Should have thrown duplicate key error");
    } catch (error: any) {
      if (error.code === "P2002") {
        console.log("✓ Duplicate correctly rejected by UNIQUE constraint");
      } else if (error.message.includes("Should have thrown")) {
        throw error;
      }
    }

    // TEST 4: Verify only ONE outbox record exists
    console.log("\n[Test 4] Verify only ONE outbox record for duplicate attempt");
    const finalOutboxCount = await prisma.outboxEvent.count();
    if (finalOutboxCount === 1) {
      console.log("✓ Only 1 outbox record exists (duplicate was prevented)");
    } else {
      throw new Error(
        `Expected 1 outbox record, found ${finalOutboxCount}`
      );
    }

    // TEST 5: Fetch pending outbox events
    console.log("\n[Test 5] Fetch pending outbox events");
    const {
      getPendingOutboxEvents,
    } = await import("../src/services/eventService.js");

    const pendingEvents = await getPendingOutboxEvents(10);
    if (pendingEvents.length === 1 && pendingEvents[0].status === "PENDING") {
      console.log("✓ Pending outbox events fetched correctly");
    } else {
      throw new Error("Failed to fetch pending outbox events");
    }

    // TEST 6: Mark outbox as published
    console.log("\n[Test 6] Mark outbox event as PUBLISHED");
    const {
      markOutboxAsPublished,
    } = await import("../src/services/eventService.js");

    await markOutboxAsPublished("evt_phase3_001");

    const publishedEvent = await prisma.outboxEvent.findUnique({
      where: { eventId: "evt_phase3_001" },
    });

    if (
      publishedEvent &&
      publishedEvent.status === "PUBLISHED" &&
      publishedEvent.publishedAt
    ) {
      console.log(
        "✓ Outbox event marked as PUBLISHED with timestamp"
      );
    } else {
      throw new Error("Failed to mark outbox as published");
    }

    // TEST 7: Record publishing failure
    console.log("\n[Test 7] Record outbox publishing failure");
    const event2 = await createEvent({
      eventId: "evt_phase3_002",
      eventType: "FAILURE_TEST",
      payload: { test: false },
    });

    const {
      recordOutboxPublishingFailure,
    } = await import("../src/services/eventService.js");

    await recordOutboxPublishingFailure(
      "evt_phase3_002",
      "Simulated Kafka error"
    );

    const failedEvent = await prisma.outboxEvent.findUnique({
      where: { eventId: "evt_phase3_002" },
    });

    if (
      failedEvent &&
      failedEvent.attemptCount === 1 &&
      failedEvent.lastError === "Simulated Kafka error" &&
      failedEvent.status === "PENDING"
    ) {
      console.log(
        "✓ Publishing failure recorded (attempt incremented, error saved, status remains PENDING)"
      );
    } else {
      throw new Error("Failed to record publishing failure correctly");
    }

    // TEST 8: Transaction rollback on failure
    console.log("\n[Test 8] Verify transaction rollback on partial failure");

    // This test demonstrates that if any part of the transaction fails,
    // all changes are rolled back
    const countBefore = await prisma.event.count();

    try {
      await prisma.$transaction(async (tx: any) => {
        await tx.event.create({
          data: {
            eventId: "evt_phase3_003",
            eventType: "ROLLBACK_TEST",
            payload: {},
            status: "RECEIVED",
          },
        });

        // Force an error by trying to create duplicate
        await tx.event.create({
          data: {
            eventId: "evt_phase3_003", // Same ID - will fail
            eventType: "ROLLBACK_TEST",
            payload: {},
            status: "RECEIVED",
          },
        });
      });
    } catch (error: any) {
      if (error.code === "P2002") {
        console.log("✓ Transaction rolled back on error (as expected)");
      }
    }

    const countAfter = await prisma.event.count();

    if (countBefore === countAfter) {
      console.log(
        "✓ No partial write: event count unchanged after failed transaction"
      );
    } else {
      throw new Error(
        `Partial write detected! Before: ${countBefore}, After: ${countAfter}`
      );
    }

    // TEST 9: Multiple outbox events with different statuses
    console.log("\n[Test 9] Multiple outbox events with different statuses");
    await createEvent({
      eventId: "evt_phase3_004",
      eventType: "MULTI_TEST_1",
      payload: {},
    });
    await createEvent({
      eventId: "evt_phase3_005",
      eventType: "MULTI_TEST_2",
      payload: {},
    });

    const allOutbox = await prisma.outboxEvent.findMany({
      orderBy: { createdAt: "asc" },
    });

    const pending = allOutbox.filter((e) => e.status === "PENDING").length;
    const published = allOutbox.filter((e) => e.status === "PUBLISHED").length;

    console.log(`✓ Outbox queue status: ${pending} PENDING, ${published} PUBLISHED`);

    console.log("\n✅ All Phase 3 tests passed!");
    console.log("\nPhase 3 Summary:");
    console.log(
      "- Transactional Outbox pattern implemented correctly"
    );
    console.log("- Event creation now stores: Event + EventLog + OutboxEvent");
    console.log("- All three records created atomically");
    console.log("- Duplicate protection maintained");
    console.log("- Outbox status tracking works");
    console.log("- Ready for Phase 4 (Kafka integration)");
  } catch (error) {
    console.error("\n❌ Test failed:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runPhase3Tests();
