import { prisma } from "../src/lib/prisma.js";
import { createEvent, getEventByEventId, getAllEvents, getEventHistory } from "../src/services/eventService.js";

async function runTests() {
  console.log("Running EventGuard Phase 2 tests...\n");

  try {
    // Clean up before tests
    await prisma.eventLog.deleteMany();
    await prisma.event.deleteMany();
    console.log("✓ Database cleaned");

    // Test 1: Create a new event
    console.log("\n[Test 1] Create a new event");
    const event1 = await createEvent({
      eventId: "evt_test_001",
      eventType: "PAYMENT_SUCCESS",
      payload: { userId: "user_42", amount: 500 },
    });
    console.log("✓ Event created:", event1.eventId);

    // Test 2: Verify event can be retrieved
    console.log("\n[Test 2] Retrieve event by eventId");
    const retrievedEvent = await getEventByEventId("evt_test_001");
    if (retrievedEvent && retrievedEvent.eventId === "evt_test_001") {
      console.log("✓ Event retrieved successfully");
    } else {
      throw new Error("Failed to retrieve event");
    }

    // Test 3: Verify EventLog was created
    console.log("\n[Test 3] Verify EventLog entry was created");
    const history = await getEventHistory("evt_test_001");
    if (history.length > 0 && history[0].status === "RECEIVED") {
      console.log("✓ EventLog entry created with status RECEIVED");
    } else {
      throw new Error("EventLog was not created correctly");
    }

    // Test 4: Duplicate event detection
    console.log("\n[Test 4] Duplicate event detection (should fail)");
    try {
      await createEvent({
        eventId: "evt_test_001",
        eventType: "PAYMENT_SUCCESS",
        payload: { userId: "user_42", amount: 500 },
      });
      throw new Error("Should have thrown duplicate key error");
    } catch (error: any) {
      if (error.code === "P2002") {
        console.log("✓ Duplicate event correctly rejected with UNIQUE constraint");
      } else {
        throw error;
      }
    }

    // Test 5: Verify only ONE event exists in database
    console.log("\n[Test 5] Verify only ONE event in database");
    const allEvents = await getAllEvents(1, 100);
    if (allEvents.total === 1) {
      console.log("✓ Only 1 event exists in database (duplicate was prevented)");
    } else {
      throw new Error(`Expected 1 event, found ${allEvents.total}`);
    }

    // Test 6: Create multiple different events
    console.log("\n[Test 6] Create multiple different events");
    await createEvent({
      eventId: "evt_test_002",
      eventType: "ORDER_CREATED",
      payload: { orderId: "order_1", amount: 1000 },
    });
    await createEvent({
      eventId: "evt_test_003",
      eventType: "USER_REGISTERED",
      payload: { userId: "user_100", email: "test@example.com" },
    });
    console.log("✓ Created 2 additional events");

    // Test 7: Verify pagination
    console.log("\n[Test 7] Verify pagination");
    const page1 = await getAllEvents(1, 2);
    if (page1.events.length === 2 && page1.total === 3 && page1.pages === 2) {
      console.log("✓ Pagination works correctly (page 1 of 2)");
    } else {
      throw new Error("Pagination not working correctly");
    }

    // Test 8: Get non-existent event
    console.log("\n[Test 8] Get non-existent event");
    const nonExistent = await getEventByEventId("evt_does_not_exist");
    if (nonExistent === null) {
      console.log("✓ Non-existent event returns null");
    } else {
      throw new Error("Should return null for non-existent event");
    }

    // Test 9: Concurrent duplicate requests (simulated)
    console.log("\n[Test 9] Concurrent duplicate attempts");
    const promises = Array(5)
      .fill(null)
      .map(() =>
        createEvent({
          eventId: "evt_test_concurrent",
          eventType: "CONCURRENT_TEST",
          payload: { test: true },
        }).catch(() => null)
      );

    const results = await Promise.all(promises);
    const successes = results.filter((r) => r !== null).length;

    if (successes === 1) {
      console.log(
        `✓ Out of 5 concurrent attempts, only 1 succeeded (4 rejected by UNIQUE constraint)`
      );
    } else {
      throw new Error(
        `Expected 1 success, got ${successes} - UNIQUE constraint not working`
      );
    }

    // Verify final state
    const finalCount = await prisma.event.count();
    console.log(`\n✓ Final event count: ${finalCount}`);

    console.log("\n✅ All tests passed!");
  } catch (error) {
    console.error("\n❌ Test failed:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runTests();
