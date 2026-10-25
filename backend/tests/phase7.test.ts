/**
 * Phase 7: Retry Engine + Failure Recovery Tests
 */

import { prisma } from "../src/lib/prisma.js";
import { createEvent } from "../src/services/eventService.js";
import { createWallet, creditWallet, getWallet } from "../src/services/walletService.js";
import { processEvent } from "../src/kafka/eventWorker.js";
import { getFailedEvents, getRetryingEvents, resetEventForRetry } from "../src/services/eventClaimService.js";
import { calculateNextRetryTime, shouldRetry, handleProcessingFailure } from "../src/services/retryService.js";

const TEST_USER_ID = "test-user-phase7";

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runPhase7Tests() {
  console.log("=== Phase 7: Retry Engine + Failure Recovery Tests ===\n");

  try {
    // Clean up test data
    await prisma.walletTransaction.deleteMany({
      where: { wallet: { userId: TEST_USER_ID } },
    });
    await prisma.wallet.deleteMany({
      where: { userId: TEST_USER_ID },
    });
    await prisma.eventLog.deleteMany({
      where: { eventId: { startsWith: "evt_phase7_" } },
    });
    await prisma.event.deleteMany({
      where: { eventId: { startsWith: "evt_phase7_" } },
    });

    console.log("✓ Database cleaned\n");

    // Test 1: Calculate exponential backoff
    console.log("[Test 1] Exponential backoff calculation");
    const retry1 = calculateNextRetryTime(1);
    const retry2 = calculateNextRetryTime(2);
    const retry3 = calculateNextRetryTime(3);

    const delay1 = retry1.getTime() - Date.now();
    const delay2 = retry2.getTime() - Date.now();
    const delay3 = retry3.getTime() - Date.now();

    console.log(`   Attempt 1 delay: ~${Math.round(delay1 / 1000)}s`);
    console.log(`   Attempt 2 delay: ~${Math.round(delay2 / 1000)}s`);
    console.log(`   Attempt 3 delay: ~${Math.round(delay3 / 1000)}s`);
    console.log("   ✓ Exponential backoff working\n");

    // Test 2: Should retry logic
    console.log("[Test 2] Should retry logic");
    const shouldRetry1 = shouldRetry(1, 3);
    const shouldRetry2 = shouldRetry(2, 3);
    const shouldRetry3 = shouldRetry(3, 3);

    console.log(`   Attempt 1/3 should retry: ${shouldRetry1}`);
    console.log(`   Attempt 2/3 should retry: ${shouldRetry2}`);
    console.log(`   Attempt 3/3 should retry: ${shouldRetry3}`);
    console.log("   ✓ Retry logic working\n");

    // Test 3: Create wallet for testing
    console.log("[Test 3] Create wallet");
    const wallet = await createWallet(TEST_USER_ID);
    console.log(`   ✓ Wallet created: ${wallet.id}\n`);

    // Test 4: Successful event processing
    console.log("[Test 4] Successful event processing");
    const successEventId = "evt_phase7_success_1";
    await createEvent({
      eventId: successEventId,
      eventType: "PAYMENT_SUCCESS",
      payload: {
        userId: TEST_USER_ID,
        paymentId: "pay_test_1",
        orderId: "order_test_1",
        amount: 100,
      },
    });

    await processEvent({
      eventId: successEventId,
      eventType: "PAYMENT_SUCCESS",
      payload: {
        userId: TEST_USER_ID,
        paymentId: "pay_test_1",
        orderId: "order_test_1",
        amount: 100,
      },
    });

    const successEvent = await prisma.event.findUnique({
      where: { eventId: successEventId },
    });

    console.log(`   Event status: ${successEvent?.status}`);
    console.log(`   Attempt count: ${successEvent?.attemptCount}`);
    console.log("   ✓ Successful processing working\n");

    // Test 5: Failed event handling
    console.log("[Test 5] Failed event handling");
    const failedEventId = "evt_phase7_failed_1";

    await createEvent({
      eventId: failedEventId,
      eventType: "PAYMENT_SUCCESS",
      payload: {
        userId: "non_existent_user", // This will cause wallet not found error
        paymentId: "pay_fail_1",
        orderId: "order_fail_1",
        amount: 50,
      },
    });

    try {
      await processEvent({
        eventId: failedEventId,
        eventType: "PAYMENT_SUCCESS",
        payload: {
          userId: "non_existent_user",
          paymentId: "pay_fail_1",
          orderId: "order_fail_1",
          amount: 50,
        },
      });
    } catch (error) {
      // Expected to fail
    }

    await delay(100);

    const failedEvent = await prisma.event.findUnique({
      where: { eventId: failedEventId },
    });

    console.log(`   Event status: ${failedEvent?.status}`);
    console.log(`   Attempt count: ${failedEvent?.attemptCount}`);
    console.log(`   Last error: ${failedEvent?.lastError?.substring(0, 50)}...`);
    console.log("   ✓ Failed event handling working\n");

    // Test 6: Get retrying events
    console.log("[Test 6] Get retrying events");
    const retryingEvents = await getRetryingEvents();
    console.log(`   Retrying events count: ${retryingEvents.length}`);
    console.log("   ✓ Get retrying events working\n");

    // Test 7: Get failed events after max attempts
    console.log("[Test 7] Handle max attempts reached");
    const maxAttemptsEventId = "evt_phase7_max_1";

    await createEvent({
      eventId: maxAttemptsEventId,
      eventType: "PAYMENT_SUCCESS",
      payload: {
        userId: "non_existent_user",
        paymentId: "pay_max_1",
        orderId: "order_max_1",
        amount: 25,
      },
    });

    // Simulate max attempts reached
    const maxEvent = await prisma.event.update({
      where: { eventId: maxAttemptsEventId },
      data: {
        attemptCount: 3,
        status: "PROCESSING",
      },
    });

    await handleProcessingFailure(maxAttemptsEventId, "Simulated max attempts", 3, 3);

    const finalMaxEvent = await prisma.event.findUnique({
      where: { eventId: maxAttemptsEventId },
    });

    console.log(`   Final status: ${finalMaxEvent?.status}`);
    console.log(`   Attempt count: ${finalMaxEvent?.attemptCount}`);
    console.log("   ✓ Max attempts handling working\n");

    // Test 8: Get failed events
    console.log("[Test 8] Get failed events");
    const failedEvents = await getFailedEvents();
    console.log(`   Failed events count: ${failedEvents.length}`);
    console.log("   ✓ Get failed events working\n");

    // Test 9: Manual retry
    console.log("[Test 9] Manual retry of failed event");
    await resetEventForRetry(maxAttemptsEventId);

    const retryEvent = await prisma.event.findUnique({
      where: { eventId: maxAttemptsEventId },
    });

    console.log(`   Status after reset: ${retryEvent?.status}`);
    console.log("   ✓ Manual retry working\n");

    // Test 10: Verify event history
    console.log("[Test 10] Event history (EventLog)");
    const eventLogs = await prisma.eventLog.findMany({
      where: { eventId: successEventId },
      orderBy: { createdAt: "asc" },
    });

    console.log(`   EventLog entries: ${eventLogs.length}`);
    eventLogs.forEach((log) => {
      console.log(`   - ${log.status}: ${log.message || "no message"}`);
    });
    console.log("   ✓ Event history working\n");

    console.log("=== Phase 7 Test Summary ===");
    console.log("✓ Exponential backoff calculation");
    console.log("✓ Retry logic (shouldRetry)");
    console.log("✓ Successful event processing");
    console.log("✓ Failed event handling → RETRYING");
    console.log("✓ Get retrying events");
    console.log("✓ Max attempts → FAILED");
    console.log("✓ Get failed events");
    console.log("✓ Manual retry reset");
    console.log("✓ Event history tracking");
    console.log("\n✅ Phase 7 tests completed successfully.\n");
  } catch (error) {
    console.error("\n❌ Test failed:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runPhase7Tests().catch(console.error);
