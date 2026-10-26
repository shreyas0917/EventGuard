import { prisma } from "../src/lib/prisma.js";
import { connectKafka } from "../src/lib/kafka.js";
import { initializeProducer } from "../src/kafka/producer.js";
import { processEvent } from "../src/kafka/eventWorker.js";
import { createEvent } from "../src/services/eventService.js";
import { acquireLock, releaseLock } from "../src/services/redisLockService.js";
import {
  isEventCompletedInCache,
  markEventCompletedInCache,
} from "../src/services/redisIdempotencyCache.js";
import {
  claimEventForProcessing,
  getEventStatus,
} from "../src/services/eventClaimService.js";
import { logger } from "../src/lib/logger.js";

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runPhase5Tests() {
  console.log("\nRunning EventGuard Phase 5 - Idempotency + Redis Tests...\n");

  try {
    // Setup
    const kafkaConnected = await connectKafka();
    if (!kafkaConnected) {
      throw new Error("Failed to connect to Kafka");
    }

    await initializeProducer();
    logger.info("Kafka setup complete");

    // Clean up before tests
    await prisma.eventLog.deleteMany();
    await prisma.outboxEvent.deleteMany();
    await prisma.event.deleteMany();
    console.log("✓ Database cleaned");

    // TEST 1: First event processes successfully
    console.log("\n[Test 1] First event processes successfully");
    const event1 = await createEvent({
      eventId: "evt_phase5_001",
      eventType: "IDEMPOTENCY_TEST",
      payload: { test: true },
    });

    await processEvent({
      eventId: "evt_phase5_001",
      eventType: "IDEMPOTENCY_TEST",
      payload: { test: true },
    });

    const completed1 = await prisma.event.findUnique({
      where: { eventId: "evt_phase5_001" },
    });

    if (!completed1 || completed1.status !== "COMPLETED") {
      throw new Error("Event not completed");
    }

    console.log("✓ Event processes successfully on first delivery");

    // TEST 2: Same event delivered twice - only processes once
    console.log("\n[Test 2] Same event delivered twice - processes only once");
    const event2 = await createEvent({
      eventId: "evt_phase5_002",
      eventType: "DUPLICATE_TEST",
      payload: { test: true },
    });

    // First processing
    await processEvent({
      eventId: "evt_phase5_002",
      eventType: "DUPLICATE_TEST",
      payload: { test: true },
    });

    // Get processing count after first delivery
    const logs1 = await prisma.eventLog.findMany({
      where: { eventId: "evt_phase5_002" },
    });
    const completedCount1 = logs1.filter((l) => l.status === "COMPLETED").length;

    // Second delivery (duplicate)
    await processEvent({
      eventId: "evt_phase5_002",
      eventType: "DUPLICATE_TEST",
      payload: { test: true },
    });

    // Get logs after second delivery
    const logs2 = await prisma.eventLog.findMany({
      where: { eventId: "evt_phase5_002" },
    });
    const duplicateCount = logs2.filter((l) => l.status === "DUPLICATE").length;
    const completedCount2 = logs2.filter((l) => l.status === "COMPLETED").length;

    if (completedCount2 !== 1) {
      throw new Error("Event processed more than once");
    }

    if (duplicateCount !== 1) {
      throw new Error("Duplicate delivery not recorded");
    }

    console.log("✓ Duplicate delivery recognized and ignored");
    console.log(`  - Processing count: 1 (expected)`);
    console.log(`  - Duplicate records: 1 (expected)`);

    // TEST 3: Same event delivered 10 times
    console.log("\n[Test 3] Event delivered 10 times - processes only once");
    const event3 = await createEvent({
      eventId: "evt_phase5_003",
      eventType: "MULTI_DUPLICATE_TEST",
      payload: { test: true },
    });

    // Deliver 10 times
    for (let i = 0; i < 10; i++) {
      await processEvent({
        eventId: "evt_phase5_003",
        eventType: "MULTI_DUPLICATE_TEST",
        payload: { test: true },
      });
    }

    const logs3 = await prisma.eventLog.findMany({
      where: { eventId: "evt_phase5_003" },
    });

    const completed3 = logs3.filter((l) => l.status === "COMPLETED").length;
    const duplicate3 = logs3.filter((l) => l.status === "DUPLICATE").length;

    if (completed3 !== 1) {
      throw new Error(`Event processed ${completed3} times instead of 1`);
    }

    if (duplicate3 < 9) {
      throw new Error(`Expected at least 9 duplicates, got ${duplicate3}`);
    }

    console.log("✓ Event delivered 10 times");
    console.log(`  - Processing count: 1 (expected)`);
    console.log(`  - Duplicate records: ${duplicate3} (expected: 9+)`);

    // TEST 4: Redis lock prevents concurrent processing
    console.log("\n[Test 4] Redis lock prevents concurrent processing");
    const event4 = await createEvent({
      eventId: "evt_phase5_004",
      eventType: "CONCURRENCY_TEST",
      payload: { concurrent: true },
    });

    // Acquire lock manually to simulate concurrent access
    const lock1 = await acquireLock("evt_phase5_004", { ttlSeconds: 5 });

    if (!lock1.acquired) {
      throw new Error("Failed to acquire first lock");
    }

    // Try to acquire second lock (should fail)
    const lock2 = await acquireLock("evt_phase5_004", { ttlSeconds: 5 });

    if (lock2.acquired) {
      throw new Error("Second lock should not be acquired while first is held");
    }

    // Release first lock
    await releaseLock(lock1);

    // Now second lock should work
    const lock3 = await acquireLock("evt_phase5_004", { ttlSeconds: 5 });

    if (!lock3.acquired) {
      throw new Error("Lock should be acquirable after release");
    }

    await releaseLock(lock3);

    console.log("✓ Redis locks prevent concurrent access");

    // TEST 5: Redis completed cache works
    console.log("\n[Test 5] Redis completed cache optimization");
    const event5 = await createEvent({
      eventId: "evt_phase5_005",
      eventType: "CACHE_TEST",
      payload: { cache: true },
    });

    // Mark as completed in cache
    await markEventCompletedInCache("evt_phase5_005");

    const inCache = await isEventCompletedInCache("evt_phase5_005");

    if (!inCache) {
      throw new Error("Event should be in completed cache");
    }

    console.log("✓ Redis completed cache working");

    // TEST 6: Event claiming works safely
    console.log("\n[Test 6] Safe PostgreSQL event claiming");
    const event6 = await createEvent({
      eventId: "evt_phase5_006",
      eventType: "CLAIM_TEST",
      payload: { claim: true },
    });

    // Claim event
    const claimResult1 = (await claimEventForProcessing("evt_phase5_006")).outcome;

    if (claimResult1 !== "claimed") {
      throw new Error("First claim should succeed");
    }

    // Try to claim again (should fail)
    const claimResult2 = (await claimEventForProcessing("evt_phase5_006")).outcome;

    if (claimResult2 !== "already-processing") {
      throw new Error(`Second claim should return already-processing, got ${claimResult2}`);
    }

    console.log("✓ Safe event claiming prevents duplicate claims");

    // TEST 7: Multiple events processed independently
    console.log("\n[Test 7] Multiple events processed independently");
    const event7a = await createEvent({
      eventId: "evt_phase5_007a",
      eventType: "MULTI_EVENT_TEST",
      payload: { id: "a" },
    });

    const event7b = await createEvent({
      eventId: "evt_phase5_007b",
      eventType: "MULTI_EVENT_TEST",
      payload: { id: "b" },
    });

    await processEvent({
      eventId: "evt_phase5_007a",
      eventType: "MULTI_EVENT_TEST",
      payload: { id: "a" },
    });

    await processEvent({
      eventId: "evt_phase5_007b",
      eventType: "MULTI_EVENT_TEST",
      payload: { id: "b" },
    });

    // Deliver 7a again
    await processEvent({
      eventId: "evt_phase5_007a",
      eventType: "MULTI_EVENT_TEST",
      payload: { id: "a" },
    });

    // Deliver 7b again
    await processEvent({
      eventId: "evt_phase5_007b",
      eventType: "MULTI_EVENT_TEST",
      payload: { id: "b" },
    });

    const status7a = await getEventStatus("evt_phase5_007a");
    const status7b = await getEventStatus("evt_phase5_007b");

    if (status7a !== "COMPLETED" || status7b !== "COMPLETED") {
      throw new Error("Both events should be COMPLETED");
    }

    const logs7a = await prisma.eventLog.findMany({
      where: { eventId: "evt_phase5_007a" },
    });
    const completed7a = logs7a.filter((l) => l.status === "COMPLETED").length;

    const logs7b = await prisma.eventLog.findMany({
      where: { eventId: "evt_phase5_007b" },
    });
    const completed7b = logs7b.filter((l) => l.status === "COMPLETED").length;

    if (completed7a !== 1 || completed7b !== 1) {
      throw new Error("Each event should process only once");
    }

    console.log("✓ Multiple events processed independently");

    // TEST 8: ProcessedAt timestamp set correctly
    console.log("\n[Test 8] ProcessedAt timestamp set");
    const event8 = await createEvent({
      eventId: "evt_phase5_008",
      eventType: "TIMESTAMP_TEST",
      payload: { time: true },
    });

    await processEvent({
      eventId: "evt_phase5_008",
      eventType: "TIMESTAMP_TEST",
      payload: { time: true },
    });

    const completed8 = await prisma.event.findUnique({
      where: { eventId: "evt_phase5_008" },
    });

    if (!completed8 || !completed8.processedAt) {
      throw new Error("processedAt should be set");
    }

    console.log("✓ ProcessedAt timestamp set correctly");

    // TEST 9: EventLog shows all status transitions
    console.log("\n[Test 9] EventLog shows all transitions");
    const event9 = await createEvent({
      eventId: "evt_phase5_009",
      eventType: "LOG_TEST",
      payload: { log: true },
    });

    await processEvent({
      eventId: "evt_phase5_009",
      eventType: "LOG_TEST",
      payload: { log: true },
    });

    const logs9 = await prisma.eventLog.findMany({
      where: { eventId: "evt_phase5_009" },
      orderBy: { createdAt: "asc" },
    });

    const statuses9 = logs9.map((l) => l.status);

    if (!statuses9.includes("RECEIVED")) {
      throw new Error("RECEIVED not in log");
    }

    if (!statuses9.includes("PROCESSING")) {
      throw new Error("PROCESSING not in log");
    }

    if (!statuses9.includes("COMPLETED")) {
      throw new Error("COMPLETED not in log");
    }

    console.log("✓ EventLog transitions: RECEIVED → PROCESSING → COMPLETED");

    // TEST 10: Concurrent workers accessing same event
    console.log("\n[Test 10] Concurrent workers on same event");
    const event10 = await createEvent({
      eventId: "evt_phase5_010",
      eventType: "CONCURRENT_WORKERS",
      payload: { concurrent: true },
    });

    // Simulate two workers trying to claim the same event
    const worker1Claim = (await claimEventForProcessing("evt_phase5_010")).outcome;
    const worker2Claim = (await claimEventForProcessing("evt_phase5_010")).outcome;

    if (worker1Claim !== "claimed") {
      throw new Error("Worker 1 should claim successfully");
    }

    if (worker2Claim !== "already-processing") {
      throw new Error("Worker 2 should see already-processing");
    }

    console.log("✓ Concurrent workers: only one successfully claims");

    console.log("\n✅ All Phase 5 tests passed!");
    console.log("\nPhase 5 Summary:");
    console.log("- Redis locks prevent concurrent processing");
    console.log("- PostgreSQL event claiming ensures atomicity");
    console.log("- Duplicate deliveries are recognized and ignored");
    console.log("- Multiple events processed independently");
    console.log("- EventLog tracks all state transitions including duplicates");
    console.log("- Exactly-once business effect guaranteed");
  } catch (error) {
    console.error("\n❌ Test failed:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runPhase5Tests();
